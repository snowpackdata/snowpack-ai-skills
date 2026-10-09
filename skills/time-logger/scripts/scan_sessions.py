#!/usr/bin/env python3
"""
Scan coding-agent session transcripts (Claude Code and Codex) for activity on a target date.

Usage:
  scan_sessions.py YYYY-MM-DD                         stats + excerpts per session, to stdout
  scan_sessions.py YYYY-MM-DD --split <out_dir>       manifest.json + one excerpt file per fresh session
  scan_sessions.py YYYY-MM-DD --report [--all-history]
                                                      dry-run counts: discovery, dedup, exclusions,
                                                      unresolved overlaps — no message bodies
  scan_sessions.py YYYY-MM-DD --record-cache <manifest.json> <summaries.json>
                                                      write raw/claude/.cache/<date>.json from the
                                                      manifest plus {cache_key: {effort, summary}}
Options (any mode): --providers claude,codex  (default: what capabilities.yml enables)

Which providers are scanned comes from capabilities.yml: integrations.claude_sessions.enabled
(default true) and integrations.codex_sessions.enabled (default false). Both feed one unified
stream, raw/claude/<date>.md — deduplicated across providers before anything is summarized, so
a Claude session imported into Codex contributes its shared history once. See
session_sources.py for the adapters and the dedup policy.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import session_sources as ss  # noqa: E402

FMT = "%-I:%M %p %Z"

# A hard "first N" cap silently hides everything after N — for a long session, that's where
# outcomes and corrections tend to live. Only guard the pathological case with a character
# budget, and keep both ends (first half + last half) if it's ever exceeded.
EXCERPT_CHAR_BUDGET = 150_000


def cap_excerpts(excerpts: list) -> list:
    total = sum(len(e) for e in excerpts)
    if total <= EXCERPT_CHAR_BUDGET:
        return excerpts
    half = EXCERPT_CHAR_BUDGET // 2
    head, head_len = [], 0
    for e in excerpts:
        if head_len + len(e) > half:
            break
        head.append(e)
        head_len += len(e)
    tail, tail_len = [], 0
    for e in reversed(excerpts):
        if tail_len + len(e) > half:
            break
        tail.append(e)
        tail_len += len(e)
    tail.reverse()
    overlap = max(0, len(head) + len(tail) - len(excerpts))
    if overlap:
        tail = tail[overlap:]
    return head + ["[... excerpts omitted: session exceeds the character budget ...]"] + tail


# How many recently kept excerpts a new one is compared against when deduping within a
# session — catches the same write-up posted twice after a small revision. Narrow on purpose:
# near-exact text repeats only, not a semantic "this is filler" judgment.
_DEDUPE_LOOKBACK = 4
_DEDUPE_SIMILARITY = 0.75


def dedupe_excerpts(excerpts: list) -> list:
    import difflib
    kept = []
    for e in excerpts:
        if any(difflib.SequenceMatcher(None, e, prev).ratio() >= _DEDUPE_SIMILARITY
               for prev in kept[-_DEDUPE_LOOKBACK:]):
            continue
        kept.append(e)
    return kept


def cache_path(target_date: str) -> Path:
    return ss.data_home_dir() / "raw" / "claude" / ".cache" / f"{target_date}.json"


def load_cache(target_date: str) -> dict:
    """Per-session summary cache for the date. Used here only to decide which sessions are
    unchanged, so their excerpts are never printed — the real cost of a cached session was the
    agent reading its excerpts back, so the saving only counts if they're never emitted."""
    try:
        return json.loads(cache_path(target_date).read_text()).get("sessions", {})
    except Exception:
        return {}


def cache_status(s: "ss.DaySession", cache: dict, last_iso: str):
    """Hit when the entry's digest matches this run's retained activity (digest covers scanner
    version, enabled providers, and every retained message). Entries written before digests
    existed are keyed by file path and match on turns + minute-precision last activity — so an
    unchanged Claude-only day stays a cache hit across the upgrade instead of resummarizing."""
    t = s.transcript
    entry = cache.get(t.cache_key)
    if entry and entry.get("summary") and entry.get("digest") == s.digest:
        return True, entry
    legacy = cache.get(t.path)
    if (legacy and legacy.get("summary") and "digest" not in legacy and t.provider == "claude"
            and not t.duplicates_from and legacy.get("turns") == s.turns
            and legacy.get("last_iso") == last_iso):
        return True, legacy
    return False, entry


class Scan:
    """One deterministic pass: discover, parse, dedupe, filter to the day. No LLM involved."""

    def __init__(self, target_date: str, providers=None, all_history=False):
        self.target_date = target_date
        self.providers = providers if providers is not None else ss.enabled_providers()
        self.tz = ss.resolve_tz()
        self.start, self.end = ss.day_window(target_date, self.tz)
        self.discovery = ss.discover(self.providers, None if all_history else self.start.timestamp())
        transcripts = ss.load(self.discovery.files)
        self.filtered_automation = self.discovery.skipped_automation
        self.filtered_worker = 0
        kept = []
        for t in transcripts:
            if t.is_worker:
                self.filtered_worker += 1
            elif t.is_automation:
                self.filtered_automation += 1
            else:
                kept.append(t)
        self.transcripts = kept
        self.overlaps = ss.dedupe(kept)
        self.sessions = []
        self.duplicate_messages_today = 0
        for t in kept:
            s, dup = ss.day_activity(t, self.start, self.end, self.tz)
            self.duplicate_messages_today += dup
            if s:
                s.excerpts = cap_excerpts(dedupe_excerpts(s.excerpts))
                self.sessions.append(s)
        self.sessions.sort(key=lambda s: s.first)

    def unresolved_today(self):
        return [o for o in self.overlaps
                if o.verdict == "unresolved" and o.first_ts and self.start <= o.first_ts < self.end]

    def stale_blocks(self) -> list:
        """Blocks already in raw/claude/<date>.md that this scan no longer produces, and should
        be removed rather than left contributing: their provider was disabled, their file is now
        a confirmed copy of another session, or the file still exists but has no retained
        activity left for the day. A block whose file simply vanished is left alone (never
        delete retroactively on missing data)."""
        md = ss.data_home_dir() / "raw" / "claude" / f"{self.target_date}.md"
        try:
            text = md.read_text()
        except OSError:
            return []
        current = {s.transcript.path for s in self.sessions}
        loaded = {t.path: t for t in self.transcripts}
        roots = {"claude": [ss.claude_root()], "codex": ss.codex_roots()}
        out = []
        for line in text.splitlines():
            if not line.startswith("**File**: "):
                continue
            path = line[len("**File**: "):].strip()
            if path in current:
                continue
            provider = next((p for p, rs in roots.items()
                             if any(path.startswith(str(r) + "/") for r in rs)), None)
            if provider and provider not in self.providers:
                out.append({"file": path, "reason": f"{provider} sessions disabled"})
            elif path in loaded and loaded[path].duplicates_from:
                out.append({"file": path, "reason": "duplicate of "
                            + ", ".join(sorted(loaded[path].duplicates_from))})
            elif path in loaded:
                out.append({"file": path, "reason": "no retained activity on this date"})
        return out

    def summary_counts(self) -> dict:
        return {
            "total_sessions": len(self.sessions),
            "providers": self.providers,
            "filtered_automation": self.filtered_automation,
            "filtered_fanout_worker": self.filtered_worker,
            "skipped_stale_mtime": self.discovery.skipped_stale,
            "duplicate_messages_dropped": self.duplicate_messages_today,
            "unresolved_overlaps": len(self.unresolved_today()),
        }


def _session_fields(s, cache):
    t = s.transcript
    last_iso = s.last.replace(second=0, microsecond=0).isoformat()
    cached, entry = cache_status(s, cache, last_iso)
    fields = {
        "file": t.path,
        "provider": t.provider,
        "source": ss.PROVIDER_LABELS[t.provider],
        "repo": t.repo or Path(t.path).parent.name,
        "turns": s.turns,
        "first": s.first.strftime(FMT),
        "last": s.last.strftime(FMT),
        "last_iso": last_iso,
        "cache_key": t.cache_key,
        "digest": s.digest,
        "cached": cached,
    }
    if t.also_in or t.duplicates_from:
        fields["provenance"] = {
            "also_in": sorted(t.also_in),
            "continues_from": sorted(t.duplicates_from),
            "duplicate_messages_dropped_today": s.duplicate_messages_today,
        }
    if s.unresolved_messages_today:
        fields["unresolved_messages"] = s.unresolved_messages_today
    return fields, entry


def run_stdout(scan: Scan) -> None:
    cache = load_cache(scan.target_date)
    cached_count = fresh_count = 0
    for s in scan.sessions:
        f, entry = _session_fields(s, cache)
        print("=== SESSION ===")
        for k in ("file", "provider", "repo", "turns", "first", "last", "last_iso", "cache_key", "digest"):
            print(f"{k}={f[k]}")
        if "provenance" in f:
            p = f["provenance"]
            if p["continues_from"]:
                print(f"continues_from={';'.join(p['continues_from'])}")
            if p["also_in"]:
                print(f"also_in={';'.join(p['also_in'])}")
        if f.get("unresolved_messages"):
            print(f"unresolved_messages={f['unresolved_messages']}")
        if f["cached"]:
            cached_count += 1
            print("cached=yes")
            print(f"effort={entry['effort']}")
            print("--- CACHED SUMMARY (copy verbatim, do not re-summarize) ---")
            print(entry["summary"])
        else:
            fresh_count += 1
            print("cached=no")
            print("--- EXCERPTS ---")
            for e in s.excerpts:
                print(e)
                print("---")
        print("=== END SESSION ===")
    c = scan.summary_counts()
    print(f"\nPROVIDERS={','.join(scan.providers) or 'none'}")
    print(f"TOTAL_SESSIONS={len(scan.sessions)}")
    print(f"CACHED_SESSIONS={cached_count}")
    print(f"FRESH_SESSIONS={fresh_count}")
    print(f"FILTERED_AUTOMATION={c['filtered_automation']}")
    print(f"SKIPPED_STALE_MTIME={c['skipped_stale_mtime']}")
    print(f"FILTERED_FANOUT_WORKER={c['filtered_fanout_worker']}")
    print(f"DUPLICATE_MESSAGES_DROPPED={c['duplicate_messages_dropped']}")
    print(f"UNRESOLVED_OVERLAPS={c['unresolved_overlaps']}")
    for st in scan.stale_blocks():
        print(f"STALE_BLOCK={st['file']} ({st['reason']})")


def run_split(scan: Scan, out_dir: str) -> None:
    """Write one excerpt file per fresh session plus a manifest.json (metadata for every
    session, cached or not). The manifest is small enough for the orchestrator to read
    directly; excerpt files go to subagents instead of the orchestrator's own context."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cache = load_cache(scan.target_date)
    manifest = []
    for i, s in enumerate(scan.sessions):
        entry, cache_entry = _session_fields(s, cache)
        if entry["cached"]:
            entry["effort"] = cache_entry["effort"]
            entry["summary"] = cache_entry["summary"]
        else:
            excerpt_path = out / f"session_{i:03d}.txt"
            excerpt_path.write_text("\n---\n".join(s.excerpts))
            entry["excerpt_file"] = str(excerpt_path)
        manifest.append(entry)
    counts = scan.summary_counts()
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps({
        "target_date": scan.target_date,
        "sessions": manifest,
        "stale_blocks": scan.stale_blocks(),
        "unresolved": [_overlap_json(o) for o in scan.unresolved_today()],
        "cached_sessions": sum(1 for e in manifest if e["cached"]),
        "fresh_sessions": sum(1 for e in manifest if not e["cached"]),
        **counts,
    }, indent=2))
    print(f"wrote {manifest_path}")


def _overlap_json(o) -> dict:
    return {"later": o.later, "earlier": o.earlier, "messages": o.messages, "tier": o.tier,
            "verdict": o.verdict, "reason": o.reason}


def run_report(scan: Scan) -> None:
    """Dry run. Counts and identity evidence only — no message text is printed."""
    d = scan.discovery
    print(f"date={scan.target_date}  tz={scan.tz}  window={scan.start.astimezone(scan.tz).isoformat()} .. {scan.end.astimezone(scan.tz).isoformat()}")
    print(f"providers enabled: {', '.join(scan.providers) or 'none'}")
    print(f"discovered files: " + ", ".join(f"{p}={d.discovered[p]}" for p in ss.PROVIDERS))
    if d.missing_roots:
        print(f"missing roots (normal if unused): {', '.join(d.missing_roots)}")
    print(f"parsed: {len(d.files)}   skipped (mtime before day): {d.skipped_stale}")
    print(f"excluded: automation={scan.filtered_automation}  fanout_worker={scan.filtered_worker}")
    errs = [t for t in scan.transcripts if t.parse_errors or t.truncated_tail]
    if errs:
        print(f"parse issues: {len(errs)} file(s)")
        for t in errs:
            tail = " +incomplete final line" if t.truncated_tail else ""
            print(f"  {t.path}: {t.parse_errors} malformed line(s){tail}")
    by_tier = {}
    for o in scan.overlaps:
        if o.verdict == "confirmed":
            by_tier[o.tier] = by_tier.get(o.tier, 0) + o.messages
    total_msgs = sum(len(t.messages) for t in scan.transcripts)
    dup_msgs = sum(1 for t in scan.transcripts for m in t.messages if m.duplicate_of)
    print(f"messages in parsed files (all dates): {total_msgs}   confirmed duplicates: {dup_msgs}"
          + (f"  by tier: {by_tier}" if by_tier else ""))
    print(f"logical sessions with retained activity on {scan.target_date}: {len(scan.sessions)}")
    for s in scan.sessions:
        t = s.transcript
        extra = []
        if t.duplicates_from:
            extra.append(f"continues {len(t.duplicates_from)} earlier transcript(s)")
        if t.also_in:
            extra.append(f"also copied into {len(t.also_in)}")
        if s.duplicate_messages_today:
            extra.append(f"{s.duplicate_messages_today} duplicate msg(s) dropped today")
        if s.unresolved_messages_today:
            extra.append(f"{s.unresolved_messages_today} unresolved")
        print(f"  [{t.provider}] {t.repo}  turns={s.turns}  {s.first.strftime(FMT)}–{s.last.strftime(FMT)}"
              f"  id={t.session_id}" + (f"  ({'; '.join(extra)})" if extra else ""))
    print(f"duplicate messages dropped on {scan.target_date}: {scan.duplicate_messages_today}")
    unresolved = [o for o in scan.overlaps if o.verdict == "unresolved"]
    print(f"unresolved overlaps (all dates in parsed files): {len(unresolved)}")
    for o in unresolved:
        print(f"  {o.messages} msg(s) [{o.tier}] {o.reason}\n    later:   {o.later}\n    earlier: {o.earlier}")
    confirmed = [o for o in scan.overlaps if o.verdict == "confirmed"]
    if confirmed:
        print("confirmed overlaps:")
        for o in confirmed:
            print(f"  {o.messages} msg(s) [{o.tier}] {o.reason}\n    copy:     {o.later}\n    original: {o.earlier}")
    lineage = [t for t in scan.transcripts if t.lineage or t.unknown_meta_keys]
    if lineage:
        print("codex session_meta lineage / unrecognized keys (evidence only, not interpreted):")
        for t in lineage:
            print(f"  {t.path}: lineage={json.dumps(t.lineage, default=str)} unknown_keys={t.unknown_meta_keys}")
    for st in scan.stale_blocks():
        print(f"stale block to remove: {st['file']} ({st['reason']})")


def record_cache(target_date: str, manifest_file: str, summaries_file: str) -> None:
    """Write the day's cache deterministically, so no agent has to hand-copy digests.
    summaries.json is {cache_key: {"effort": ..., "summary": ...}} for freshly summarized
    sessions; cached sessions carry theirs in the manifest already. Entries for sessions not in
    this manifest are dropped (provider toggled off, deduplicated, or gone)."""
    manifest = json.loads(Path(manifest_file).read_text())
    fresh = json.loads(Path(summaries_file).read_text()) if summaries_file != "-" else {}
    sessions = {}
    missing = []
    for e in manifest["sessions"]:
        src = e if e.get("cached") else fresh.get(e["cache_key"])
        if not src or not src.get("summary"):
            missing.append(e["cache_key"])
            continue
        sessions[e["cache_key"]] = {"file": e["file"], "turns": e["turns"], "last_iso": e["last_iso"],
                                    "digest": e["digest"], "effort": src["effort"], "summary": src["summary"]}
    p = cache_path(target_date)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"scanner_version": ss.SCANNER_VERSION, "sessions": sessions}, indent=2))
    print(f"wrote {p} ({len(sessions)} session(s))")
    if missing:
        print(f"not cached (no summary given): {', '.join(missing)}", file=sys.stderr)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    target_date = args[0]
    try:
        datetime.strptime(target_date, "%Y-%m-%d")
    except ValueError:
        print(f"bad date: {target_date} (expected YYYY-MM-DD)", file=sys.stderr)
        sys.exit(1)
    providers = None
    if "--providers" in args:
        i = args.index("--providers")
        providers = [p for p in args[i + 1].split(",") if p in ss.PROVIDERS]
        del args[i:i + 2]

    if len(args) >= 4 and args[1] == "--record-cache":
        record_cache(target_date, args[2], args[3])
        return
    if len(args) >= 2 and args[1] == "--report":
        run_report(Scan(target_date, providers, all_history="--all-history" in args))
        return
    scan = Scan(target_date, providers)
    if len(args) >= 3 and args[1] == "--split":
        run_split(scan, args[2])
    else:
        run_stdout(scan)


if __name__ == "__main__":
    main()
