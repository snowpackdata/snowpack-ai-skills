#!/usr/bin/env python3
"""Snap every time-entry heading's start to the nearest 15 minutes; end = snapped start +
duration. This is the mechanical enforcement of the "start snapped to the nearest 15
minutes" rule stated in generate-time-entry.md Step 3 and review-feedback.md, which is
otherwise left entirely to model judgment and applied inconsistently (raw session/Slack
timestamps like 7:43 or 8:34 slip through, especially on merge/append runs).

Never snaps the end independently -- the (Xh) duration is effort-based and authoritative,
so end is always derived as snapped_start + duration. Also recomputes the file's **Span**
header (earliest snapped start - latest derived end); **Hours** and **Clients** are left
untouched since durations don't move. Only `### ` heading lines are touched; bodies and
`## Open Items` are never rewritten. Idempotent -- running this on an already-snapped file
is a no-op.

Usage: snap_entry_times.py /path/to/time_entries_YYYYMMDD.md
"""
import re
import sys

HEAD = re.compile(
    r'^(### )(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[–—-]\s*'
    r'(\d{1,2}):(\d{2})\s*(AM|PM)?'
    r'(\s*[–—-]\s*.*?\((\d+(?:\.\d+)?)h\).*)$',
    re.IGNORECASE,
)
SPAN = re.compile(r'^\*\*Span\*\*:\s*.*$')


def to_dec(h, m, mer):
    h, m = int(h), int(m or 0)
    if mer:
        mer = mer.upper()
        if mer == 'PM' and h != 12:
            h += 12
        if mer == 'AM' and h == 12:
            h = 0
    return h + m / 60.0


def fmt(dec):
    dec %= 24
    h24 = int(dec)
    m = int(round((dec - h24) * 60))
    if m == 60:
        h24 += 1
        m = 0
    mer = 'AM' if h24 < 12 else 'PM'
    h12 = h24 % 12 or 12
    return f"{h12}:{m:02d}", mer


def snap_heading(line):
    """Return (new_line, start_dec, end_dec). start/end are None if line isn't a time heading."""
    m = HEAD.match(line)
    if not m:
        return line, None, None
    pre, sh, sm, smer, eh, em, emer, tail, dur = m.groups()
    end_mer = emer or smer
    end = to_dec(eh, em, end_mer)
    start_mer = smer or emer  # a start with no AM/PM inherits the end's
    start = to_dec(sh, sm, start_mer)
    if start >= end:
        # e.g. "11:30 - 12:30 PM": naive inheritance reads the bare start as PM too,
        # putting it at or after the end. Entries never span >12h, so the real start
        # was actually the earlier (AM) reading.
        start -= 12
    snapped = round(start / 0.25) * 0.25
    new_end = snapped + float(dur)
    (s_t, s_mer), (e_t, e_mer) = fmt(snapped), fmt(new_end)
    sep = '–'
    rng = f"{s_t} {sep} {e_t} {e_mer}" if s_mer == e_mer else f"{s_t} {s_mer} {sep} {e_t} {e_mer}"
    return f"{pre}{rng}{tail}", snapped, new_end


def main():
    if len(sys.argv) != 2:
        print("usage: snap_entry_times.py <path>", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]

    with open(path) as f:
        lines = f.read().split('\n')

    out = []
    starts, ends = [], []
    for ln in lines:
        if ln.startswith('### '):
            new_ln, start, end = snap_heading(ln)
            if start is not None:
                starts.append(start)
                ends.append(end)
            out.append(new_ln)
        else:
            out.append(ln)

    if starts:
        (s_t, s_mer), (e_t, e_mer) = fmt(min(starts)), fmt(max(ends))
        span_line = f"**Span**: {s_t} {s_mer} – {e_t} {e_mer}"
        out = [span_line if SPAN.match(ln) else ln for ln in out]

    with open(path, 'w') as f:
        f.write('\n'.join(out))


if __name__ == '__main__':
    main()
