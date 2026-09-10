# Combined daily file

Loaded on demand from `SKILL.md` by `/time-logger log` (and by `morning` / `standup` when they
backfill). One file per day holds every raw source verbatim plus the settled summary of the
generated entries, so anything downstream (a summary, a submit, a human skim) has one
place to look.

Paths below are relative to the data home (`~/.local/share/time-logger/`, or
`$TIME_LOGGER_DATA_HOME`). `<slug>` is `client.slug` from `capabilities.yml`; when it is blank,
drop the `_<slug>` suffix everywhere.

## Build

Write `raw/combined/time-log_YYYY-MM-DD_<slug>.md`:

```
# time-log_YYYY-MM-DD_<slug>

## Slack

[full contents of raw/slack/YYYY-MM-DD.md, or "(no data)" if missing]

## Calendar

[full contents of raw/calendar/YYYY-MM-DD.md, or "(no data)" if missing]

## Claude Sessions

[full contents of raw/claude/YYYY-MM-DD.md, or "(no data)" if missing]

## GitHub

[full contents of raw/github/YYYY-MM-DD.md, or "(no data)" if missing]

## Granola Meeting Notes

[full contents of raw/granola/YYYY-MM-DD.md, or "(no data)" if missing]

## Recommended Time Log Structure

- 7:30 – 9:00 AM  Task name — one-line description  (1.5h)  [client: Snowpack]
- 9:30 – 10:00 AM  Data Standup [meeting]  (0.5h)  [client: Snowpack]
- 5:00 – 6:00 PM  Hotlap telemetry pipeline  (1h)  [client: Personal]
...
Total: Xh (Snowpack 6.5h · Personal 1h)
```

Include a `##` section for every source directory that has a file for the date (Title Case of
any unrecognized directory name); omit sections for sources that don't exist. The Recommended
Time Log Structure is derived from `time_logs/time_entries_YYYYMMDD.md` — one short line per
`###` block with its times, title, and duration, ending with `Total:`. If the entries file
doesn't exist yet, omit that section (a later `log` run adds it).

Rebuilding is idempotent: rerunning for a date overwrites the file. When rebuilding after a
refetch and the entries file hasn't changed, carry the existing Recommended Time Log Structure
section over unchanged.

The combined file stays on this machine. Sending a day's time anywhere is `submit`'s job,
through the machine's submit instructions, never a side effect of `log`.

## Sync the dashboard

After building, refresh the store so the Slack/Calendar panels reflect the new data:

```bash
node ~/.local/share/time-logger/app/dashboard/scripts/render.mjs
```

Skip silently if `dashboard.enabled` is `false` or the app isn't built.
