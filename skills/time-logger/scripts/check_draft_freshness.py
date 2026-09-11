#!/usr/bin/env python3
"""
Skip gate for `generate-time-entry`: decides whether a date's draft is already current, so
`references/dash-refresh.md`'s Draft step can skip the ~5 min sonnet reasoning pass when
nothing that would change the draft has actually changed since it was last written.

Same insight as the Claude-sessions summary cache, applied one level up in the pipeline: don't
redo reasoning work whose inputs are unchanged. Measured need: a same-day refresh with a warm
Claude-sessions cache still paid the full draft-generation cost every time, because nothing
gated it (see the "generate-time-entry optimization" report this script implements).

Hashes raw SOURCE CONTENT, never mtime. The Claude-sessions fetcher can rewrite
raw/claude/<date>.md even when every session was a cache hit, so mtime alone would never
signal "unchanged" reliably — this is the same reason scan_sessions.py's cache keys on
turns+last_iso rather than the transcript file's mtime.

Two modes:
  check <date>            -- print a JSON verdict: {"skip": bool, "reason": str, "sources_hash": str}
  record <date>            -- recompute the current hash and persist it as "this draft is caught
                               up to this input state" (run AFTER generate-time-entry writes)

Skip only when ALL of:
  - the entries file already exists for the date
  - the current raw-sources hash matches the hash stored the last time a draft was written
  - there are no unresolved `time_entry_comment` pending-feedback items for the date (a
    correction in flight should still force a run, even if raw sources didn't change)
"""

import hashlib
import json
import os
import sys
from pathlib import Path


def data_home_dir() -> Path:
    return Path(os.environ.get("TIME_LOGGER_DATA_HOME") or (Path.home() / ".local" / "share" / "time-logger"))


def sources_hash(data_home: Path, date: str) -> str:
    """Hash of every raw/{source}/<date>.md file's content, sorted by source name for
    stability. Excludes raw/combined/ -- that's derived output, not an input."""
    h = hashlib.sha256()
    raw_dir = data_home / "raw"
    if not raw_dir.exists():
        return h.hexdigest()
    for source_dir in sorted(raw_dir.iterdir()):
        if not source_dir.is_dir() or source_dir.name == "combined":
            continue
        f = source_dir / f"{date}.md"
        if f.exists():
            h.update(source_dir.name.encode())
            h.update(f.read_bytes())
    return h.hexdigest()


def pending_comment_count(data_home: Path, date: str) -> int:
    pending_path = data_home / "dashboard" / "feedback" / "pending.json"
    try:
        items = json.loads(pending_path.read_text())
    except Exception:
        return 0
    return sum(1 for x in items if isinstance(x, dict) and x.get("type") == "time_entry_comment" and x.get("date") == date)


def state_path(data_home: Path, date: str) -> Path:
    return data_home / "time_logs" / ".state" / f"{date}.json"


def cmd_check(date: str):
    dh = data_home_dir()
    entries_file = dh / "time_logs" / f"time_entries_{date.replace('-', '')}.md"
    cur_hash = sources_hash(dh, date)
    pending = pending_comment_count(dh, date)

    if not entries_file.exists():
        result = {"skip": False, "reason": "no draft exists yet for this date", "sources_hash": cur_hash}
    elif pending > 0:
        result = {"skip": False, "reason": f"{pending} unresolved time_entry_comment item(s) for this date", "sources_hash": cur_hash}
    else:
        try:
            prev = json.loads(state_path(dh, date).read_text()).get("sources_hash", "")
        except Exception:
            prev = ""
        if cur_hash == prev and cur_hash:
            result = {"skip": True, "reason": "raw sources unchanged since the last draft, no pending comments", "sources_hash": cur_hash}
        else:
            result = {"skip": False, "reason": "raw sources changed since the last recorded draft", "sources_hash": cur_hash}

    print(json.dumps(result))


def cmd_record(date: str):
    dh = data_home_dir()
    cur_hash = sources_hash(dh, date)
    sp = state_path(dh, date)
    sp.parent.mkdir(parents=True, exist_ok=True)
    sp.write_text(json.dumps({"sources_hash": cur_hash}))
    print(json.dumps({"recorded": True, "sources_hash": cur_hash}))


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("check", "record"):
        print("Usage: check_draft_freshness.py check|record YYYY-MM-DD", file=sys.stderr)
        sys.exit(1)
    mode, date = sys.argv[1], sys.argv[2]
    (cmd_check if mode == "check" else cmd_record)(date)


if __name__ == "__main__":
    main()
