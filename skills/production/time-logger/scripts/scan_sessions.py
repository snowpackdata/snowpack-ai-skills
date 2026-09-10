#!/usr/bin/env python3
"""
Scan Claude Code JSONL session transcripts for activity on a target date.

Usage: python3 scan_sessions.py YYYY-MM-DD

Output: structured text per session — stats + message excerpts for summarization.
"""

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

LOCAL_TZ = datetime.now().astimezone().tzinfo


def scan_file(filepath: str, target_date: str) -> Optional[dict]:
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
                if not ts.startswith(target_date):
                    continue

                t = obj.get("type")
                if t not in ("user", "assistant"):
                    continue

                turns += 1
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    continue

                if first_ts is None:
                    first_ts = dt.astimezone(LOCAL_TZ)
                last_ts = dt.astimezone(LOCAL_TZ)

                content = obj.get("message", {}).get("content", "")
                text = ""
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text += block.get("text", "")
                elif isinstance(content, str):
                    text = content

                text = text.strip()
                if text and not text.startswith("<command") and len(text) > 20:
                    excerpts.append(f"[{t}] {text[:400]}")

    except OSError:
        return None

    if turns == 0:
        return None

    return {
        "filepath": filepath,
        "turns": turns,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "excerpts": excerpts[:30],
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: scan_sessions.py YYYY-MM-DD", file=sys.stderr)
        sys.exit(1)

    target_date = sys.argv[1]

    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        print(f"No projects dir found at {projects_dir}", file=sys.stderr)
        sys.exit(0)

    jsonl_files = list(projects_dir.rglob("*.jsonl"))
    results = []

    for fpath in jsonl_files:
        result = scan_file(str(fpath), target_date)
        if result:
            results.append(result)

    # Sort by first activity time
    results.sort(key=lambda r: r["first_ts"])

    fmt = "%I:%M %p"
    for r in results:
        print(f"=== SESSION ===")
        print(f"file={r['filepath']}")
        print(f"turns={r['turns']}")
        print(f"first={r['first_ts'].strftime(fmt)}")
        print(f"last={r['last_ts'].strftime(fmt)}")
        print("--- EXCERPTS ---")
        for e in r["excerpts"]:
            print(e)
            print("---")
        print("=== END SESSION ===")

    print(f"\nTOTAL_SESSIONS={len(results)}")


if __name__ == "__main__":
    main()
