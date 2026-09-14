# Combined daily file

Loaded on demand by `/time-logger refresh entries` (and by `morning` / `standup` when they
backfill). One file per day holds every raw source verbatim plus the settled summary of the
generated entries, so anything downstream (a summary, a submit, a human skim) has one
place to look.

Paths below are relative to the data home (`~/.local/share/time-logger/`, or
`$TIME_LOGGER_DATA_HOME`). `<slug>` is `client.slug` from `capabilities.yml`; when it is blank,
drop the `_<slug>` suffix everywhere.

## Build

Run the deterministic builder instead of writing the file by hand — every piece of it is
either "copy this file's bytes verbatim" or "strip a fixed prefix off an existing heading
line," which cost real minutes of pure output-token generation for zero judgment when this
used to be hand-assembled on every refresh, even an idempotent no-op one:

```bash
python3 <data home>/scripts/build_combined_file.py YYYY-MM-DD
```

It writes `raw/combined/time-log_YYYY-MM-DD_<slug>.md`: one `##` section per fixed source
(Slack, Calendar, Claude Sessions, GitHub, Granola Meeting Notes — always all five, `client.slug`
read straight from `capabilities.yml`), each holding that source's raw file verbatim or
`(no data)` if it doesn't exist yet, followed by `## Recommended Time Log Structure` — one `- `
bullet per `###` heading in `time_logs/time_entries_YYYYMMDD.md` (copied as-is, not
re-derived) plus a `Total:` line built from that file's own `**Hours**`/`**Clients**` fields.
A day with an entries file but zero entries gets a `(no entries — zero-hours day, no activity
found in any source)` line instead of bullets. If the entries file doesn't exist yet at all,
the whole Recommended Time Log Structure section is omitted (a later `refresh entries` run
adds it) — every other section is always present.

Rebuilding is idempotent by construction (the script always regenerates from current source
state, never diffs against the previous combined file) — rerunning for a date overwrites it.

The combined file stays on this machine. Sending a day's time anywhere is `submit`'s job,
through the machine's submit instructions, never a side effect of `refresh entries`.

## Sync the dashboard

After building, refresh the store so the Slack/Calendar panels reflect the new data:

```bash
node ~/.local/share/time-logger/app/dashboard/scripts/render.mjs
```

Skip silently if `dashboard.enabled` is `false` or the app isn't built.
