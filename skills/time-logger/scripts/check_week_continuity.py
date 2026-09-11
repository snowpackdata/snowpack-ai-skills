#!/usr/bin/env python3
"""
Per-client continuity check over a multi-day set of eligible time entries, used by the
`submit` flow (specifically `submit-instructions.examples/cronos.md`) when submitting a date
range rather than a single date — this is the check a single-date submit can't do on its own.

Deterministic on purpose: gap/outlier detection is exact-match/arithmetic, cheap and reliable
in code, and unreliable/costly if left to an LLM to eyeball across a week of entries by hand.

Input: a JSON file with a flat list of {date, client, hours} — just the fields this check
needs, not full entry rows (the caller already has those; this only needs enough to compute
per-client daily/weekly totals).

For each client, gaps are checked only within that client's own *active span* — from their
first to their last date with entries in the input — so a client whose engagement genuinely
started or ended partway through the range never gets flagged for days before/after it existed
in the data. A weekday with no entry inside that span is a real, comparable gap; a weekday
outside it isn't a gap, it's just outside scope.

Usage: python3 check_week_continuity.py <rows.json>
"""

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta


def check_continuity(rows: list) -> dict:
    by_client = defaultdict(lambda: defaultdict(float))
    for r in rows:
        by_client[r["client"]][r["date"]] += r["hours"]

    report = {}
    for client, daily in by_client.items():
        dates = sorted(daily)
        total = round(sum(daily.values()), 2)
        avg = total / len(dates) if dates else 0

        flags = []
        if len(dates) >= 2:
            span_start = datetime.strptime(dates[0], "%Y-%m-%d")
            span_end = datetime.strptime(dates[-1], "%Y-%m-%d")
            d = span_start
            while d <= span_end:
                if d.weekday() < 5 and d.strftime("%Y-%m-%d") not in daily:
                    flags.append({"type": "gap", "date": d.strftime("%Y-%m-%d")})
                d += timedelta(days=1)

        for date, hours in daily.items():
            if avg > 0 and (hours > avg * 1.75 or hours < avg * 0.25):
                flags.append({
                    "type": "unusual_daily_total", "date": date,
                    "hours": round(hours, 2), "client_average": round(avg, 2),
                })

        report[client] = {
            "daily_totals": {d: round(h, 2) for d, h in daily.items()},
            "weekly_total": total,
            "flags": sorted(flags, key=lambda f: f["date"]),
        }

    return report


def main():
    if len(sys.argv) < 2:
        print("Usage: check_week_continuity.py <rows.json>", file=sys.stderr)
        sys.exit(1)
    rows = json.load(open(sys.argv[1]))
    print(json.dumps(check_continuity(rows), indent=2))


if __name__ == "__main__":
    main()
