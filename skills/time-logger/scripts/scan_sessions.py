#!/usr/bin/env python3
"""
Scan Claude Code JSONL session transcripts for activity on a target date.

Usage: python3 scan_sessions.py YYYY-MM-DD

Output: structured text per session — stats + message excerpts for summarization.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

LOCAL_TZ = datetime.now().astimezone().tzinfo

# Claude-Code-infrastructure noise (login/logout notices, context-compaction notices,
# background-task pings) — syntactically identifiable, never work-signal, safe to drop before
# an excerpt ever costs a token. Matched on the start of the message body specifically (not a
# scan across the whole file) so a real message that happens to mention one of these in passing
# is never affected.
_BOILERPLATE_PREFIXES = ("<local-command-stdout>", "<local-command-caveat>", "<task-notification>")


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

    try:
        with open(filepath) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

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

                turns += 1
                if first_ts is None:
                    first_ts = local_dt
                last_ts = local_dt

                content = obj.get("message", {}).get("content", "")
                text = ""
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text += block.get("text", "")
                elif isinstance(content, str):
                    text = content

                text = text.strip()
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
        "excerpts": cap_excerpts(excerpts),
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


def main():
    if len(sys.argv) < 2:
        print("Usage: scan_sessions.py YYYY-MM-DD", file=sys.stderr)
        sys.exit(1)

    target_date = sys.argv[1]

    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        print(f"No projects dir found at {projects_dir}", file=sys.stderr)
        sys.exit(0)

    day_start_ts = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=LOCAL_TZ).timestamp()
    automation_dir = automation_project_dir()
    cache = load_cache(target_date)

    jsonl_files = list(projects_dir.rglob("*.jsonl"))
    results = []
    skipped_automation = 0
    skipped_stale = 0

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
        result = scan_file(str(fpath), target_date)
        if result:
            results.append(result)

    # Sort by first activity time
    results.sort(key=lambda r: r["first_ts"])

    fmt = "%I:%M %p"
    cached_count = 0
    fresh_count = 0
    for r in results:
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


if __name__ == "__main__":
    main()
