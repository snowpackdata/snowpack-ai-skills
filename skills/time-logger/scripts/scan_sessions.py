#!/usr/bin/env python3
"""
Scan Claude Code JSONL session transcripts for activity on a target date.

Usage: python3 scan_sessions.py YYYY-MM-DD

Output: structured text per session — stats + message excerpts for summarization.
"""

import difflib
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

LOCAL_TZ = datetime.now().astimezone().tzinfo

# A background-task/Monitor notification is injected as plain prose starting with this marker
# (the literal `<task-notification>` tag, if present at all, is nested further inside the body,
# not at the start — a prefix check on that tag alone never matches the real wrapper shape).
_TASK_NOTIFICATION_PREFIXES = ("[SYSTEM NOTIFICATION - NOT USER INPUT]", "<task-notification>")

# Claude-Code-infrastructure noise (login/logout notices, context-compaction notices,
# background-task pings) — syntactically identifiable, never work-signal, safe to drop before
# an excerpt ever costs a token. Matched on the start of the message body specifically (not a
# scan across the whole file) so a real message that happens to mention one of these in passing
# is never affected.
_BOILERPLATE_PREFIXES = ("<local-command-stdout>", "<local-command-caveat>") + _TASK_NOTIFICATION_PREFIXES

# Of those, a background-task notification is the one kind with zero human action behind it —
# a monitor/subagent waking an otherwise-idle session and Claude replying to it. Unlike a local
# command (the user ran something themselves) or its stdout, this shouldn't move first/last
# activity or count as a turn at all: a monitor firing at 3 AM would otherwise draft an entry
# that starts at 3 AM even though nobody was working. The other two boilerplate prefixes are
# still real human-initiated activity, just not excerpt-worthy content.
_AUTOMATED_PREFIXES = _TASK_NOTIFICATION_PREFIXES

# The fan-out recipe (fetch-claude-sessions-fanout.md) dispatches one summarize-claude-session
# subagent per fresh file; each dispatch is itself a new Claude Code session transcript, which
# the *next* scan would otherwise pick up as a brand-new "session" needing its own summary —
# pure recursive noise (the automation_project_dir() filter doesn't catch these because they
# run from whatever cwd dispatched them, not a dedicated automation directory). The recipe is
# required to start every such dispatch prompt with this literal tag as its first characters,
# so a whole file can be identified and skipped from a single line, cheaply, the same way
# automation-directory transcripts are skipped before any excerpt costs a token.
_FANOUT_WORKER_PREFIX = "<time-logger-fanout-worker>"


def _sentence_truncate(text: str, limit: int = 400, min_length: int = 200) -> str:
    """Cut at the last sentence boundary before `limit` instead of a blind character cut, so a
    truncated excerpt still ends on a complete thought. Measured on a real 277-excerpt session:
    a blind text[:400] cut off ~20% of messages mid-sentence, silently losing the message's
    actual conclusion. Falls back to the old hard cut when no boundary exists in the window
    (e.g. one long run-on with no punctuation) — never grows past `limit`."""
    if len(text) <= limit:
        return text
    window = text[:limit]
    best = -1
    for m in re.finditer(r"[.!?](?=\s|$)|\n\n", window):
        if m.end() >= min_length:
            best = m.end()
    return text[:best].rstrip() if best > 0 else window


# How many of the most recently kept excerpts to compare a new one against when deduping —
# a near-duplicate (the same content posted twice, e.g. a review re-posted after a small
# revision) is usually close by but not always strictly adjacent, so a small trailing window
# catches more than checking only the immediately preceding excerpt while staying O(n) overall.
_DEDUPE_LOOKBACK = 4
_DEDUPE_SIMILARITY = 0.75


def _dedupe_excerpts(excerpts: list) -> list:
    """Drop an excerpt that's a near-duplicate of one already kept recently. Real sessions do
    this: the same review write-up posted twice after a minor revision, a status check
    reworded but repeating the same finding. That costs the eventual summarizer tokens to read
    twice for zero new information. Deliberately narrow in scope — this only catches near-exact
    text repeats, not a semantic "this is filler" judgment (a status-check sentence that also
    states a real finding stays, since dropping it would lose that finding too)."""
    kept = []
    for e in excerpts:
        if any(difflib.SequenceMatcher(None, e, prev).ratio() >= _DEDUPE_SIMILARITY
               for prev in kept[-_DEDUPE_LOOKBACK:]):
            continue
        kept.append(e)
    return kept


def utc_dates_for_local_day(target_date: str) -> set:
    """UTC calendar dates that can contain any instant of the local target day."""
    day = datetime.strptime(target_date, "%Y-%m-%d")
    start = day.replace(tzinfo=LOCAL_TZ)
    end = start + timedelta(days=1)
    return {start.astimezone(timezone.utc).strftime("%Y-%m-%d"),
            (end - timedelta(seconds=1)).astimezone(timezone.utc).strftime("%Y-%m-%d")}


def data_home_dir() -> Path:
    return Path(os.environ.get("TIME_LOGGER_DATA_HOME") or (Path.home() / ".local" / "share" / "time-logger"))


def load_cache(target_date: str) -> dict:
    """The per-session summary cache fetch-claude-sessions-day.md writes after each run,
    keyed by transcript path. Used here only to decide which sessions are unchanged, so their
    excerpts can be omitted from this script's output entirely — the real cost of a "cached"
    session isn't writing a fresh summary, it's the agent reading its excerpts back into
    context, so the saving only materializes if we never print them in the first place."""
    cache_path = data_home_dir() / "raw" / "claude" / ".cache" / f"{target_date}.json"
    try:
        return json.loads(cache_path.read_text()).get("sessions", {})
    except Exception:
        return {}


def automation_project_dir() -> str:
    """The Claude Code project-directory name for <data home>/app/dashboard — where every
    headless scheduled-refresh.sh / morning-run.sh invocation `cd`s to before running `claude
    -p`, and where every subagent it spawns inherits that cwd. Nothing else ever runs there, so
    transcripts under this one project dir are automation noise, never real logged work. Claude
    Code names a project dir by taking the absolute cwd path and replacing both "/" and "." with
    "-" (e.g. /Users/x/.local/share/time-logger/app/dashboard -> -Users-x--local-share-...).
    """
    data_home = Path(os.environ.get("TIME_LOGGER_DATA_HOME") or (Path.home() / ".local" / "share" / "time-logger"))
    app_dir = str((data_home / "app" / "dashboard").resolve())
    return app_dir.replace("/", "-").replace(".", "-")


def scan_file(filepath: str, target_date: str) -> Optional[dict]:
    utc_candidates = utc_dates_for_local_day(target_date)
    turns = 0
    first_ts = None
    last_ts = None
    excerpts = []
    repo = None
    # Set right after an automated-notification turn, consumed by the very next assistant turn
    # (its automatic acknowledgment) — see _AUTOMATED_PREFIXES. Together they're one non-work
    # event, not two turns.
    skip_next_assistant = False

    try:
        with open(filepath) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Claude Code stamps the real, unencoded cwd on (almost) every line — read it
                # opportunistically from whichever line has it first. This is the one reliable
                # way to name the repo: the project-dir folder name only encodes the path with
                # "/" and "." both replaced by "-", so a repo name that itself contains a dash
                # (e.g. "billing-service") can't be recovered from the encoded name alone.
                if repo is None:
                    cwd = obj.get("cwd")
                    if cwd:
                        repo = Path(cwd).name

                ts = obj.get("timestamp", "")
                if not ts:
                    continue
                # Cheap prefilter on the UTC prefix (the local day spans two UTC dates), then
                # decide by LOCAL date so evening work stays on the day it happened instead of
                # sliding into the next file after 5 PM Pacific.
                if ts[:10] not in utc_candidates:
                    continue
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    continue
                local_dt = dt.astimezone(LOCAL_TZ)
                if local_dt.strftime("%Y-%m-%d") != target_date:
                    continue

                t = obj.get("type")
                if t not in ("user", "assistant"):
                    continue

                content = obj.get("message", {}).get("content", "")
                text = ""
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text += block.get("text", "")
                elif isinstance(content, str):
                    text = content
                text = text.strip()

                if t == "user" and text.startswith(_AUTOMATED_PREFIXES):
                    skip_next_assistant = True
                    continue
                if t == "assistant" and skip_next_assistant:
                    skip_next_assistant = False
                    continue
                skip_next_assistant = False

                turns += 1
                if first_ts is None:
                    first_ts = local_dt
                last_ts = local_dt

                if text and not text.startswith(("<command",) + _BOILERPLATE_PREFIXES) and len(text) > 20:
                    excerpts.append(f"[{t}] {_sentence_truncate(text)}")

    except OSError:
        return None

    if turns == 0:
        return None

    return {
        "filepath": filepath,
        "turns": turns,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "repo": repo or Path(filepath).parent.name,
        "excerpts": cap_excerpts(_dedupe_excerpts(excerpts)),
    }


# A hard "first N" cap silently hides everything after N — for a long session, that's
# specifically where outcomes/decisions/corrections tend to live, not where they're absent.
# Measured against a real 277-excerpt/53KB session: the whole thing is ~13k tokens, nowhere
# close to a context-window problem, so there's no need to cap at all in the normal case —
# only guard the pathological one (a genuinely enormous session) with a character budget, and
# if that budget is ever exceeded, keep both ends (first half + last half of the budget)
# instead of only the start, so a forced truncation doesn't reintroduce the same bias.
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

    # Avoid duplicating an excerpt that ended up in both the head and tail passes.
    overlap = max(0, len(head) + len(tail) - len(excerpts))
    if overlap:
        tail = tail[overlap:]

    return head + ["[... excerpts omitted: session exceeds the character budget ...]"] + tail


def _is_fanout_worker_transcript(filepath: str) -> bool:
    """Peek at just the first user-authored message — cheap, no need to read further — to tell
    whether this whole file is a summarize-claude-session dispatch rather than real work. See
    _FANOUT_WORKER_PREFIX for why this can't be a directory-based check like automation_dir."""
    try:
        with open(filepath) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "user":
                    continue
                content = obj.get("message", {}).get("content", "")
                text = ""
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text += block.get("text", "")
                elif isinstance(content, str):
                    text = content
                return text.strip().startswith(_FANOUT_WORKER_PREFIX)
    except OSError:
        pass
    return False


def collect_results(target_date: str) -> tuple[list, dict, int, int, int]:
    """Deterministic discovery + extraction, shared by both output modes: every session with
    activity on target_date, its excerpts, and whether it's still cache-valid. No LLM
    involved — this is pure filesystem/JSON mechanics."""
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        print(f"No projects dir found at {projects_dir}", file=sys.stderr)
        return [], {}, 0, 0, 0

    day_start_ts = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=LOCAL_TZ).timestamp()
    automation_dir = automation_project_dir()
    cache = load_cache(target_date)

    jsonl_files = list(projects_dir.rglob("*.jsonl"))
    results = []
    skipped_automation = 0
    skipped_stale = 0
    skipped_fanout_worker = 0

    for fpath in jsonl_files:
        # time-logger running time-logger: every headless scheduled-refresh.sh / morning-run.sh
        # invocation, and every subagent it spawns, writes its transcript under this one project
        # dir. It's never real logged work and generate-time-entry discards it anyway — skip it
        # before it costs any I/O or LLM tokens, instead of summarizing then throwing it away.
        # A subagent's transcript lives one level deeper (<project-dir>/<session-id>/subagents/
        # agent-*.jsonl), so this checks the top-level project-dir component of the path, not
        # just the immediate parent — a parent-only check misses every subagent transcript.
        if fpath.relative_to(projects_dir).parts[0] == automation_dir:
            skipped_automation += 1
            continue
        # A transcript never written to on/after the target day's local start can't contain any
        # line timestamped that day — mtime is always >= the timestamp of its last-written line.
        try:
            if fpath.stat().st_mtime < day_start_ts:
                skipped_stale += 1
                continue
        except OSError:
            continue
        if _is_fanout_worker_transcript(str(fpath)):
            skipped_fanout_worker += 1
            continue
        result = scan_file(str(fpath), target_date)
        if result:
            results.append(result)

    results.sort(key=lambda r: r["first_ts"])
    return results, cache, skipped_automation, skipped_stale, skipped_fanout_worker


def _cache_status(r: dict, cache: dict) -> tuple[bool, str, Optional[dict]]:
    cache_entry = cache.get(r["filepath"])
    # Minute precision, not the raw isoformat() — the agent that writes the cache reads a
    # `last=` field already rounded to the minute, so comparing at full second/microsecond
    # precision would false-negative on every unchanged session, never hitting the cache.
    last_iso = r["last_ts"].replace(second=0, microsecond=0).isoformat()
    is_cached = bool(
        cache_entry
        and cache_entry.get("turns") == r["turns"]
        and cache_entry.get("last_iso") == last_iso
        and cache_entry.get("summary")
    )
    return is_cached, last_iso, cache_entry


def run_stdout(target_date: str) -> None:
    results, cache, skipped_automation, skipped_stale, skipped_fanout_worker = collect_results(target_date)
    fmt = "%-I:%M %p %Z"
    cached_count = 0
    fresh_count = 0
    for r in results:
        is_cached, last_iso, cache_entry = _cache_status(r, cache)

        print(f"=== SESSION ===")
        print(f"file={r['filepath']}")
        print(f"turns={r['turns']}")
        print(f"first={r['first_ts'].strftime(fmt)}")
        print(f"last={r['last_ts'].strftime(fmt)}")
        print(f"last_iso={last_iso}")
        if is_cached:
            # Unchanged since the cache was last written — the real cost of a "cached" session
            # was never the write, it was the agent reading these excerpts back into context,
            # so the saving only counts if they're never printed at all.
            cached_count += 1
            print("cached=yes")
            print(f"effort={cache_entry['effort']}")
            print("--- CACHED SUMMARY (copy verbatim, do not re-summarize) ---")
            print(cache_entry["summary"])
        else:
            fresh_count += 1
            print("cached=no")
            print("--- EXCERPTS ---")
            for e in r["excerpts"]:
                print(e)
                print("---")
        print("=== END SESSION ===")

    print(f"\nTOTAL_SESSIONS={len(results)}")
    print(f"CACHED_SESSIONS={cached_count}")
    print(f"FRESH_SESSIONS={fresh_count}")
    print(f"FILTERED_AUTOMATION={skipped_automation}")
    print(f"SKIPPED_STALE_MTIME={skipped_stale}")
    print(f"FILTERED_FANOUT_WORKER={skipped_fanout_worker}")


def run_split(target_date: str, out_dir: str) -> None:
    """Discovery+extraction for the fan-out flow: write one excerpt file per fresh session plus
    a manifest.json (metadata for every session, cached or not) — the manifest is small enough
    for the orchestrator to read directly; per-session excerpt files are handed to a subagent
    instead of loaded into the orchestrator's own context."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    results, cache, skipped_automation, skipped_stale, skipped_fanout_worker = collect_results(target_date)

    fmt = "%-I:%M %p %Z"
    manifest = []
    for i, r in enumerate(results):
        is_cached, last_iso, cache_entry = _cache_status(r, cache)
        entry = {
            "file": r["filepath"],
            "repo": r["repo"],
            "turns": r["turns"],
            "first": r["first_ts"].strftime(fmt),
            "last": r["last_ts"].strftime(fmt),
            "last_iso": last_iso,
            "cached": is_cached,
        }
        if is_cached:
            entry["effort"] = cache_entry["effort"]
            entry["summary"] = cache_entry["summary"]
        else:
            excerpt_path = out / f"session_{i:03d}.txt"
            excerpt_path.write_text("\n---\n".join(r["excerpts"]))
            entry["excerpt_file"] = str(excerpt_path)
        manifest.append(entry)

    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps({
        "target_date": target_date,
        "sessions": manifest,
        "total_sessions": len(results),
        "cached_sessions": sum(1 for e in manifest if e["cached"]),
        "fresh_sessions": sum(1 for e in manifest if not e["cached"]),
        "filtered_automation": skipped_automation,
        "skipped_stale_mtime": skipped_stale,
        "filtered_fanout_worker": skipped_fanout_worker,
    }, indent=2))
    print(f"wrote {manifest_path}")


def main():
    if len(sys.argv) < 2:
        print("Usage: scan_sessions.py YYYY-MM-DD [--split <out_dir>]", file=sys.stderr)
        sys.exit(1)

    target_date = sys.argv[1]

    if len(sys.argv) >= 4 and sys.argv[2] == "--split":
        run_split(target_date, sys.argv[3])
    else:
        run_stdout(target_date)


if __name__ == "__main__":
    main()
