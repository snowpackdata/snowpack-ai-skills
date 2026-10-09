#!/usr/bin/env python3
"""
Decide whether a past day's existing raw fetch file can be trusted as complete.

The "past day" fetch policy (see references/dash-refresh.md) skips re-fetching a source when
its raw/{source}/YYYY-MM-DD.md already exists, on the assumption that a closed day's data is
fixed. That assumption only actually holds once whatever last wrote the file did so AFTER that
day's local end (midnight starting the next day) — a fetch that ran mid-day (say, 8:48 PM)
can't know about anything from the remaining hours of that same day, regardless of source: a
Claude session keeps accumulating turns for as long as it stays open, a commit can land at
11 PM, a Slack message can post after the fetch already ran. Re-checking a file written after
the day's end is a safe, cheap no-op; re-checking one written during the day itself is exactly
the case this catches — a stale "complete" snapshot that silently missed the rest of the day.

Usage: day_is_closed.py YYYY-MM-DD path/to/raw/file.md
Prints exactly one of:
  missing — the file doesn't exist; fetch it.
  stale   — the file exists but was written before the day ended; re-fetch it.
  closed  — the file was written after the day ended; safe to skip.
Exit code is always 0 — this is a classifier, not a validity check.
"""
import os
import sys
from datetime import datetime, timedelta


def main():
    if len(sys.argv) != 3:
        print("usage: day_is_closed.py YYYY-MM-DD path/to/raw/file.md", file=sys.stderr)
        sys.exit(2)
    target_date, path = sys.argv[1], sys.argv[2]

    if not os.path.exists(path):
        print("missing")
        return

    # The real IANA zone, not "now"'s fixed offset — across a DST change the two disagree by
    # an hour on exactly where the target day ends.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from session_sources import day_window, resolve_tz
        _, day_end = day_window(target_date, resolve_tz())
    except ImportError:  # older deployed copy without session_sources.py next to it
        local_tz = datetime.now().astimezone().tzinfo
        day_end = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=local_tz) + timedelta(days=1)
    mtime = datetime.fromtimestamp(os.path.getmtime(path), tz=day_end.tzinfo)

    print("closed" if mtime >= day_end else "stale")


if __name__ == "__main__":
    main()
