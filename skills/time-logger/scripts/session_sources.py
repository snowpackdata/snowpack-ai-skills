#!/usr/bin/env python3
"""
Provider adapters, normalization, and cross-provider deduplication for coding-agent session
transcripts (Claude Code and Codex). scan_sessions.py is the CLI; this module is the logic.

Why a shared model: Codex can import Claude Code sessions, and a session imported into Codex
and then continued there exists twice on disk — once as the Claude original, once as the Codex
copy with new turns appended. Counting both would bill the shared history twice. Every
transcript is first normalized into the same Transcript/Message shape, then deduplicated across
all of them, and only then filtered to the target day and summarized.

Deduplication policy (see dedupe()):
  * Transcripts are processed in canonical order — Claude before Codex (the original source
    of an import), then earliest first message, then path — so the original always wins and
    a later copy only keeps what is new.
  * A message in a later transcript matches an earlier one by, strongest first:
      id      — the same provider message id (Claude `uuid`); 128-bit random, authoritative.
      exact   — same role, same normalized text (or same content hash for a tool-only line),
                timestamps within 1 second (covers ms truncation/rounding, nothing broader).
      content — same role and normalized text, timestamps differ. Only used when an ordered
                run of such matches is long enough to be strong evidence (see _run_verdict).
  * Matches are grouped into ordered runs: consecutive messages in the later transcript that
    match increasing positions in the same earlier transcript. A run, not a single message,
    is the unit of decision, so a repeated short prompt ("yes", "continue") never makes two
    sessions the same.
  * A run is `confirmed` (messages dropped, provenance recorded), `unresolved` (messages kept,
    reported — never silently merged), or `no evidence` (an isolated short coincidental match;
    treated as unique and not reported).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover — Python < 3.9
    ZoneInfo = None

# Bump when parsing or dedup rules change in a way that should invalidate cached summaries.
SCANNER_VERSION = "2"

PROVIDERS = ("claude", "codex")
PROVIDER_LABELS = {"claude": "Claude Code", "codex": "Codex"}

# A background-task/Monitor notification is injected as plain prose starting with this marker
# (the literal `<task-notification>` tag, if present at all, is nested further inside the body,
# not at the start — a prefix check on that tag alone never matches the real wrapper shape).
TASK_NOTIFICATION_PREFIXES = ("[SYSTEM NOTIFICATION - NOT USER INPUT]", "<task-notification>")

# Claude-Code-infrastructure noise (login/logout notices, context-compaction notices,
# background-task pings) — never work-signal, dropped from excerpts. Matched on the start of
# the message body only, so a real message that mentions one of these in passing is unaffected.
BOILERPLATE_PREFIXES = ("<local-command-stdout>", "<local-command-caveat>") + TASK_NOTIFICATION_PREFIXES

# Of those, a background-task notification is the one kind with zero human action behind it —
# a monitor/subagent waking an otherwise-idle session and the agent replying to it. It must not
# move first/last activity or count as a turn: a monitor firing at 3 AM would otherwise draft
# an entry starting at 3 AM even though nobody was working.
AUTOMATED_PREFIXES = TASK_NOTIFICATION_PREFIXES

# The fan-out recipe dispatches one summarizer worker per fresh session; each dispatch is itself
# a new transcript the next scan would pick up as a "session". Every dispatch prompt starts with
# this tag, so a whole file is identified from its first user message and skipped.
FANOUT_WORKER_PREFIX = "<time-logger-fanout-worker>"

# Codex injects these as role=user messages before the real prompt. They're configuration,
# not anything the person typed — never turns, never excerpts.
CODEX_INSTRUCTION_PREFIXES = (
    "<environment_context>",
    "<user_instructions>",
    "# AGENTS.md instructions for",
    "<permissions instructions>",
)
# The VS Code extension prepends IDE context, then the real request under this heading.
CODEX_IDE_REQUEST_MARKER = "## My request for Codex:"
CODEX_IDE_CONTEXT_PREFIX = "# Context from my IDE"

# session_meta keys that could describe lineage (fork/resume/import). Not assumed to exist —
# only surfaced verbatim in the report as evidence when present, never interpreted.
CODEX_LINEAGE_KEYS = ("forked_from", "forked_from_id", "parent_id", "parent_session_id",
                      "imported_from", "import_source", "origin", "resumed_from")
CODEX_KNOWN_META_KEYS = {"id", "timestamp", "cwd", "originator", "cli_version", "instructions",
                         "base_instructions", "source", "model_provider", "git"}

# Dedup thresholds — see _run_verdict.
EXACT_TS_TOLERANCE = timedelta(seconds=1)
SUBSTANTIAL_TEXT = 40
CONTENT_RUN_MIN_MESSAGES = 3
CONTENT_RUN_MIN_CHARS = 200


# ---------------------------------------------------------------------------------------------
# Paths, config, timezone
# ---------------------------------------------------------------------------------------------

def data_home_dir() -> Path:
    return Path(os.environ.get("TIME_LOGGER_DATA_HOME") or (Path.home() / ".local" / "share" / "time-logger"))


def claude_root() -> Path:
    return Path.home() / ".claude" / "projects"


def codex_home() -> Path:
    env = os.environ.get("CODEX_HOME")
    return Path(env).expanduser() if env else Path.home() / ".codex"


def codex_roots() -> list[Path]:
    """Live sessions are sharded by date under sessions/YYYY/MM/DD/; archived ones sit flat in
    archived_sessions/. Either may be missing — that's normal, not an error."""
    home = codex_home()
    return [home / "sessions", home / "archived_sessions"]


def _caps_lines() -> list[str]:
    try:
        return (data_home_dir() / "capabilities.yml").read_text().splitlines()
    except OSError:
        return []


def _caps_scalar(lines: list[str], path: tuple[str, ...]) -> Optional[str]:
    """A targeted read of one nested scalar from capabilities.yml (indentation-based) — not a
    general YAML parser; matches build_combined_file.py's approach so no dependency is needed."""
    stack: list[tuple[int, str]] = []
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z0-9_]+):\s*(.*?)\s*$", line)
        if not m:
            continue
        indent = len(m.group(1))
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, m.group(2)))
        if tuple(k for _, k in stack) == path:
            return re.sub(r"\s+#.*$", "", m.group(3)).strip().strip('"').strip("'")
    return None


def enabled_providers() -> list[str]:
    """claude_sessions defaults to enabled (it always was); codex_sessions defaults to disabled,
    so an existing capabilities.yml with no codex key keeps its old behavior exactly."""
    lines = _caps_lines()
    out = []
    claude = _caps_scalar(lines, ("integrations", "claude_sessions", "enabled"))
    if (claude or "true").lower() != "false":
        out.append("claude")
    codex = _caps_scalar(lines, ("integrations", "codex_sessions", "enabled"))
    if (codex or "false").lower() == "true":
        out.append("codex")
    return out


def resolve_tz() -> tzinfo:
    """The user's local zone as a real IANA zone, so a target date's day window is right on
    both sides of a DST change. A fixed offset taken from "now" is wrong for any date across a
    DST boundary from today. Order: $TIME_LOGGER_TZ, settings.timezone in capabilities.yml,
    the system zone (/etc/localtime symlink), $TZ, then the current fixed offset as a last resort."""
    candidates = [os.environ.get("TIME_LOGGER_TZ"),
                  _caps_scalar(_caps_lines(), ("settings", "timezone"))]
    try:
        link = os.readlink("/etc/localtime")
        if "zoneinfo/" in link:
            candidates.append(link.split("zoneinfo/", 1)[1])
    except OSError:
        pass
    candidates.append(os.environ.get("TZ"))
    if ZoneInfo is not None:
        for name in candidates:
            if not name:
                continue
            try:
                return ZoneInfo(name.lstrip(":"))
            except Exception:
                continue
    return datetime.now().astimezone().tzinfo


def day_window(target_date: str, tz: tzinfo) -> tuple[datetime, datetime]:
    """[start, end) of the local calendar day, returned in UTC. Built from date parts, not
    `start + 24h`, so a 23- or 25-hour DST day is measured correctly — and converted to UTC
    because Python subtracts/compares two datetimes sharing one tzinfo by wall clock, which
    would silently turn a 25-hour day back into 24."""
    d = datetime.strptime(target_date, "%Y-%m-%d")
    nd = d + timedelta(days=1)
    start = datetime(d.year, d.month, d.day, tzinfo=tz).astimezone(timezone.utc)
    end = datetime(nd.year, nd.month, nd.day, tzinfo=tz).astimezone(timezone.utc)
    return start, end


def automation_dir() -> Path:
    """<data home>/app/dashboard — where every headless scheduled-refresh.sh / morning-run.sh
    invocation cd's before running, and where every subagent it spawns inherits its cwd.
    Nothing else runs there, so a transcript rooted there is automation, never logged work."""
    return (data_home_dir() / "app" / "dashboard").resolve()


def claude_automation_project_dir() -> str:
    """Claude Code names a project dir by taking the absolute cwd and replacing both "/" and "."
    with "-" (e.g. /Users/x/.local/share/time-logger/app/dashboard -> -Users-x--local-share-...)."""
    return str(automation_dir()).replace("/", "-").replace(".", "-")


# ---------------------------------------------------------------------------------------------
# Normalized model
# ---------------------------------------------------------------------------------------------

@dataclass
class Message:
    role: str                    # "user" | "assistant"
    ts: datetime                 # aware, UTC
    text: str = ""               # displayable text ("" for a tool-only line)
    msg_id: Optional[str] = None
    content_key: str = ""        # identity of a tool-only line (hash of its raw content)
    automated: bool = False      # background-notification turn or its automatic reply
    # Set by dedupe():
    duplicate_of: Optional[str] = None   # path of the transcript this message is a copy of
    unresolved: bool = False

    @property
    def norm(self) -> str:
        return normalize_text(self.text)


@dataclass
class Transcript:
    provider: str
    path: str
    session_id: Optional[str] = None
    cwd: Optional[str] = None
    repo: Optional[str] = None
    messages: list[Message] = field(default_factory=list)
    parse_errors: int = 0
    truncated_tail: bool = False
    lineage: dict = field(default_factory=dict)       # verbatim lineage-looking metadata
    unknown_meta_keys: list[str] = field(default_factory=list)
    is_worker: bool = False
    is_automation: bool = False
    # Set by dedupe():
    also_in: set = field(default_factory=set)         # later transcripts that duplicated this one
    duplicates_from: set = field(default_factory=set) # earlier transcripts this one copies from

    @property
    def cache_key(self) -> str:
        """Stable across a copy or archive move (filename and embedded session id survive both);
        independent of the absolute directory a file happens to sit in."""
        return f"{self.provider}:{self.session_id or ''}:{Path(self.path).stem}"

    def sort_key(self):
        first = min((m.ts for m in self.messages), default=datetime.max.replace(tzinfo=timezone.utc))
        return (PROVIDERS.index(self.provider), first, self.path)


def normalize_text(text: str) -> str:
    """Representation-only normalization for fingerprinting: line endings and whitespace runs
    (block joins differ between providers). Never touches the words themselves."""
    return re.sub(r"\s+", " ", text.replace("\r\n", "\n")).strip()


def _parse_ts(value) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iter_json_lines(path: str, t: Transcript):
    """Yield parsed objects; count malformed lines instead of abandoning the file. A final line
    with no trailing newline that fails to parse is a write in progress, not corruption."""
    with open(path, "rb") as f:
        data = f.read()
    lines = data.split(b"\n")
    last_idx = len(lines) - 1
    for idx, raw in enumerate(lines):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            if idx == last_idx:
                t.truncated_tail = True
            else:
                t.parse_errors += 1
            continue
        if isinstance(obj, dict):
            yield obj


def _content_hash(content) -> str:
    return hashlib.sha1(json.dumps(content, sort_keys=True, default=str).encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------------------------
# Claude Code adapter
# ---------------------------------------------------------------------------------------------

def _claude_text(content) -> str:
    if isinstance(content, str):
        return content
    text = ""
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text += block.get("text", "")
    return text


def parse_claude(path: str) -> Transcript:
    """Every top-level `type: user|assistant` line with a timestamp is one turn — including
    tool-use/tool-result lines — which is the scanner's long-standing Claude turn definition,
    kept unchanged so effort ratings and cached summaries stay comparable."""
    t = Transcript(provider="claude", path=path)
    skip_next_assistant = False
    first_user_seen = False
    for obj in _iter_json_lines(path, t):
        if t.cwd is None and obj.get("cwd"):
            t.cwd = obj["cwd"]
        if t.session_id is None and obj.get("sessionId"):
            t.session_id = obj["sessionId"]
        kind = obj.get("type")
        if kind not in ("user", "assistant"):
            continue
        content = (obj.get("message") or {}).get("content", "")
        text = _claude_text(content).strip()
        if kind == "user" and not first_user_seen:
            first_user_seen = True
            if text.startswith(FANOUT_WORKER_PREFIX):
                t.is_worker = True
        ts = _parse_ts(obj.get("timestamp"))
        if ts is None:
            continue
        automated = False
        if kind == "user" and text.startswith(AUTOMATED_PREFIXES):
            automated, skip_next_assistant = True, True
        elif kind == "assistant" and skip_next_assistant:
            automated, skip_next_assistant = True, False
        else:
            skip_next_assistant = False
        t.messages.append(Message(
            role=kind, ts=ts, text=text, msg_id=obj.get("uuid"),
            content_key="" if text else _content_hash(content), automated=automated))
    t.repo = Path(t.cwd).name if t.cwd else Path(path).parent.name
    return t


# ---------------------------------------------------------------------------------------------
# Codex adapter
# ---------------------------------------------------------------------------------------------

def _codex_text(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("input_text", "output_text", "text"):
                parts.append(block.get("text", ""))
    return "\n".join(parts)


def _codex_user_text(text: str) -> Optional[str]:
    """Strip Codex's injected wrappers. Returns None for a message that is entirely injected
    configuration (not a turn); returns the real request for an IDE-wrapped message."""
    s = text.strip()
    if s.startswith(CODEX_INSTRUCTION_PREFIXES):
        return None
    if s.startswith(CODEX_IDE_CONTEXT_PREFIX) and CODEX_IDE_REQUEST_MARKER in s:
        return s.split(CODEX_IDE_REQUEST_MARKER, 1)[1].strip()
    return s


def parse_codex(path: str) -> Transcript:
    """Conversation turns are `response_item` records with `payload.type: message` and role
    user/assistant. `event_msg` user_message/agent_message records are a second representation
    of the same messages (verified 1:1 on real files) and are used only when a file has no
    response_item messages at all. Developer/system messages, reasoning, tool calls/outputs,
    token counts, snapshots, and unknown record types are never turns."""
    t = Transcript(provider="codex", path=path)
    items: list[Message] = []
    events: list[Message] = []
    first_user_seen = False
    skip_next_assistant = False

    def add(bucket, role, text, ts, msg_id=None):
        nonlocal first_user_seen, skip_next_assistant
        if role == "user":
            text = _codex_user_text(text)
            if text is None:
                return
            if not first_user_seen:
                first_user_seen = True
                if text.startswith(FANOUT_WORKER_PREFIX):
                    t.is_worker = True
        else:
            text = text.strip()
        if ts is None:
            return
        automated = False
        if role == "user" and text.startswith(AUTOMATED_PREFIXES):
            automated, skip_next_assistant = True, True
        elif role == "assistant" and skip_next_assistant:
            automated, skip_next_assistant = True, False
        else:
            skip_next_assistant = False
        bucket.append(Message(role=role, ts=ts, text=text, msg_id=msg_id, automated=automated))

    for obj in _iter_json_lines(path, t):
        kind = obj.get("type")
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        ts = _parse_ts(obj.get("timestamp"))
        if kind == "session_meta":
            t.session_id = t.session_id or payload.get("id")
            t.cwd = t.cwd or payload.get("cwd")
            for k in CODEX_LINEAGE_KEYS:
                if payload.get(k) not in (None, "", {}):
                    t.lineage[k] = payload[k]
            t.unknown_meta_keys = sorted(set(payload) - CODEX_KNOWN_META_KEYS - set(CODEX_LINEAGE_KEYS))
        elif kind == "turn_context":
            t.cwd = t.cwd or payload.get("cwd")
        elif kind == "response_item" and payload.get("type") == "message":
            role = payload.get("role")
            if role in ("user", "assistant"):
                add(items, role, _codex_text(payload.get("content")), ts, payload.get("id"))
        elif kind == "event_msg" and payload.get("type") in ("user_message", "agent_message"):
            role = "user" if payload["type"] == "user_message" else "assistant"
            events.append((role, payload.get("message") or "", ts))
    if not items and events:
        first_user_seen = False
        skip_next_assistant = False
        for role, text, ts in events:
            add(items, role, text, ts)
    t.messages = items
    t.repo = Path(t.cwd).name if t.cwd else None
    if t.cwd:
        try:
            t.is_automation = Path(t.cwd).resolve() == automation_dir()
        except OSError:
            pass
    return t


# ---------------------------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------------------------

@dataclass
class Discovery:
    files: list[tuple[str, str]] = field(default_factory=list)   # (provider, path) to parse
    discovered: dict = field(default_factory=lambda: {p: 0 for p in PROVIDERS})
    skipped_stale: int = 0
    skipped_automation: int = 0
    missing_roots: list[str] = field(default_factory=list)


def discover(providers: list[str], min_mtime: Optional[float]) -> Discovery:
    """Find candidate transcripts. A file whose mtime predates the target day's local start
    can't contain a line timestamped that day (mtime >= its last write), so it's skipped before
    any parsing. min_mtime=None disables that prefilter (used by the import-evidence report)."""
    d = Discovery()
    roots = []
    if "claude" in providers:
        roots.append(("claude", claude_root()))
    if "codex" in providers:
        roots.extend(("codex", r) for r in codex_roots())
    auto_dir = claude_automation_project_dir()
    for provider, root in roots:
        if not root.exists():
            d.missing_roots.append(str(root))
            continue
        for fpath in sorted(root.rglob("*.jsonl")):
            d.discovered[provider] += 1
            # Claude: every headless run and every subagent it spawns writes under one project
            # dir. Subagent transcripts sit one level deeper, so check the top-level component.
            if provider == "claude" and fpath.relative_to(root).parts[0] == auto_dir:
                d.skipped_automation += 1
                continue
            if min_mtime is not None:
                try:
                    if fpath.stat().st_mtime < min_mtime:
                        d.skipped_stale += 1
                        continue
                except OSError:
                    continue
            d.files.append((provider, str(fpath)))
    return d


def load(files: list[tuple[str, str]]) -> list[Transcript]:
    out = []
    for provider, path in files:
        try:
            out.append(parse_claude(path) if provider == "claude" else parse_codex(path))
        except OSError:
            continue
    return out


# ---------------------------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------------------------

@dataclass
class Overlap:
    later: str          # transcript path whose messages matched
    earlier: str        # transcript path they matched
    messages: int
    tier: str           # strongest tier present in the run: id | exact | content
    verdict: str        # confirmed | unresolved
    reason: str = ""
    first_ts: Optional[datetime] = None


def _is_template(m: Message) -> bool:
    """Agent-injected boilerplate (command echoes, login caveats, notifications) is byte-identical
    across unrelated sessions — a template, not evidence that two sessions share history."""
    return m.text.startswith(("<command",) + BOILERPLATE_PREFIXES)


def _run_verdict(run: list[tuple[Message, str]]) -> tuple[str, str]:
    """Decide what a run of ordered matches proves. Returns (verdict, reason):
    confirmed (drop as duplicate), unresolved (keep, report), or none (coincidence, ignore)."""
    tiers = {tier for _, tier in run}
    if "id" in tiers:
        return "confirmed", "shared message id"
    text_msgs = [m for m, _ in run if m.norm and not _is_template(m)]
    if not text_msgs:
        # Only tool-only lines or boilerplate matched: a parent and its subagent can share
        # such a record at the same instant. Structural, not a copied history.
        return "none", ""
    chars = sum(len(m.norm) for m in text_msgs)
    roles = {m.role for m in text_msgs}
    if "content" not in tiers:
        if len(text_msgs) >= 2:
            return "confirmed", "same role, text, and timestamp"
        # One message, same text, same second: parallel workers handed the same instruction
        # look exactly like this. Report it, never drop on a single message.
        if len(text_msgs[0].norm) >= SUBSTANTIAL_TEXT:
            return "unresolved", "single message with identical text and timestamp"
        return "none", ""
    # A run that needed the timestamp-free tier must be long, mixed, and substantial.
    if (len(text_msgs) >= CONTENT_RUN_MIN_MESSAGES and roles == {"user", "assistant"}
            and chars >= CONTENT_RUN_MIN_CHARS):
        return "confirmed", f"ordered run of {len(text_msgs)} identical messages (timestamps differ)"
    # One repeated message with a different timestamp — however long — is what re-pasting a
    # prompt or dispatching the same subagent instruction twice looks like. An import copies a
    # whole history, so it can't produce a lone match; treat it as no evidence either way.
    if len(text_msgs) >= 2:
        return "unresolved", "identical text with different timestamps, run too short to prove identity"
    return "none", ""


def dedupe(transcripts: list[Transcript]) -> list[Overlap]:
    """Mark later copies of earlier history as duplicates, in canonical order. Mutates
    messages (duplicate_of / unresolved) and transcripts (also_in / duplicates_from)."""
    transcripts.sort(key=Transcript.sort_key)
    by_id: dict = {}        # msg_id -> (t_idx, m_idx)
    by_content: dict = {}   # (role, norm or content_key) -> [(t_idx, m_idx, ts)]
    overlaps: list[Overlap] = []

    for ti, t in enumerate(transcripts):
        matches: list[Optional[tuple[int, int, str]]] = []
        for m in t.messages:
            hit = None
            if m.msg_id and m.msg_id in by_id:
                sti, smi = by_id[m.msg_id]
                if transcripts[sti].messages[smi].role == m.role:
                    hit = (sti, smi, "id")
            if hit is None:
                key = (m.role, m.norm or m.content_key)
                best = None
                for sti, smi, sts in by_content.get(key, ()):
                    delta = abs(sts - m.ts)
                    tier = "exact" if delta <= EXACT_TS_TOLERANCE else "content"
                    if tier == "content" and (not m.norm or _is_template(m)):
                        continue  # tool-only lines and boilerplate match only by id or exact time
                    cand = (0 if tier == "exact" else 1, delta, sti, smi, tier)
                    if best is None or cand < best:
                        best = cand
                if best is not None:
                    hit = (best[2], best[3], best[4])
            matches.append(hit)

        # Group into ordered runs against a single earlier transcript.
        run: list[int] = []

        def close_run():
            if not run:
                return
            src_ti = matches[run[0]][0]
            pairs = [(t.messages[i], matches[i][2]) for i in run]
            verdict, reason = _run_verdict(pairs)
            src = transcripts[src_ti]
            if verdict == "confirmed":
                for i in run:
                    t.messages[i].duplicate_of = src.path
                t.duplicates_from.add(src.path)
                src.also_in.add(t.path)
            elif verdict == "unresolved":
                for i in run:
                    t.messages[i].unresolved = True
            if verdict in ("confirmed", "unresolved"):
                tiers = {tier for _, tier in pairs}
                strongest = next(x for x in ("id", "exact", "content") if x in tiers)
                overlaps.append(Overlap(later=t.path, earlier=src.path, messages=len(run),
                                        tier=strongest, verdict=verdict, reason=reason,
                                        first_ts=t.messages[run[0]].ts))
            run.clear()

        for i, hit in enumerate(matches):
            if hit is None:
                close_run()
                continue
            if run:
                prev = matches[run[-1]]
                if hit[0] != prev[0] or hit[1] <= prev[1]:
                    close_run()
            run.append(i)
        close_run()

        for mi, m in enumerate(t.messages):
            if m.duplicate_of:
                continue
            if m.msg_id:
                by_id.setdefault(m.msg_id, (ti, mi))
            key = (m.role, m.norm or m.content_key)
            if key[1]:
                by_content.setdefault(key, []).append((ti, mi, m.ts))
    return overlaps


# ---------------------------------------------------------------------------------------------
# Per-day extraction
# ---------------------------------------------------------------------------------------------

def sentence_truncate(text: str, limit: int = 400, min_length: int = 200) -> str:
    """Cut at the last sentence boundary before `limit` instead of a blind character cut, so a
    truncated excerpt still ends on a complete thought. Falls back to the hard cut when no
    boundary exists in the window — never grows past `limit`."""
    if len(text) <= limit:
        return text
    window = text[:limit]
    best = -1
    for m in re.finditer(r"[.!?](?=\s|$)|\n\n", window):
        if m.end() >= min_length:
            best = m.end()
    return text[:best].rstrip() if best > 0 else window


@dataclass
class DaySession:
    transcript: Transcript
    turns: int
    first: datetime        # local
    last: datetime         # local
    excerpts: list[str]
    digest: str
    duplicate_messages_today: int
    unresolved_messages_today: int


def day_activity(t: Transcript, start: datetime, end: datetime,
                 tz: tzinfo) -> tuple[Optional[DaySession], int]:
    """Retained (non-duplicate, non-automated) activity in [start, end). Returns the session
    (or None if nothing retained) and the count of today's messages dropped as duplicates."""
    retained, dup, unresolved = [], 0, 0
    for m in t.messages:
        if not (start <= m.ts < end):
            continue
        if m.duplicate_of:
            dup += 1
            continue
        if m.automated:
            continue
        retained.append(m)
        unresolved += m.unresolved
    if not retained:
        return None, dup
    excerpts = []
    for m in retained:
        if m.text and not m.text.startswith(("<command",) + BOILERPLATE_PREFIXES) and len(m.text) > 20:
            excerpts.append(f"[{m.role}] {sentence_truncate(m.text)}")
    # The digest covers exactly what was retained, plus the scanner version. Enabled providers
    # aren't hashed separately: toggling one changes the digest precisely when it changes what
    # this session retains (e.g. Codex keeping imported history once Claude is off), and leaves
    # an unaffected session's cached summary valid.
    h = hashlib.sha1()
    h.update(f"v{SCANNER_VERSION}|".encode())
    for m in retained:
        h.update(f"{m.role}|{m.ts.isoformat()}|{m.msg_id or ''}|{m.norm or m.content_key}\n".encode())
    return DaySession(
        transcript=t, turns=len(retained),
        first=min(m.ts for m in retained).astimezone(tz),
        last=max(m.ts for m in retained).astimezone(tz),
        excerpts=excerpts, digest=h.hexdigest()[:20],
        duplicate_messages_today=dup, unresolved_messages_today=unresolved,
    ), dup
