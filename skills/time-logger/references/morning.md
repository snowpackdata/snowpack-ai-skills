# /time-logger morning

The one-command daily flow. Produces a fully fresh Morning Dashboard at
`http://localhost:<dashboard.port>` (default 4680). Paths are relative to the data home
(`~/.local/share/time-logger/`, or `$TIME_LOGGER_DATA_HOME`).

## Steps

1. **Drain feedback first**: if `dashboard/feedback/pending.json` has unresolved items, run the
   `feedback` flow ([`review-feedback.md`](./review-feedback.md)) before refreshing, so today's
   render reflects yesterday's corrections.

2. **Backfill gaps**: for each weekday from last Monday through yesterday with no
   `time_logs/time_entries_YYYYMMDD.md`, run `/time-logger refresh entries <date>` for that
   date (fetches whatever's missing, drafts, and builds the combined file). Skip company
   holidays if known.

3. **Refresh everything**: run the `refresh` flow ([`dash-refresh.md`](./dash-refresh.md)) with
   `all` — refetches today's sources and redrafts today's entries, writes the daily digest
   (the `summary daily digest` preset, saved under `summaries/`), refreshes the artifact list,
   pulls GitHub PRs, renders the store, and checks the server.

4. **Open it**: `open http://localhost:<port>` (skip when running headless).

5. Give a compact morning brief in the terminal: today's meetings, top "where you left off"
   items, and anything that failed to fetch.

## Headless mode

`dashboard/scripts/morning-run.sh` (installed by `/time-logger dashboard install`) runs this
flow unattended once per weekday via `claude -p` with an **explicit tool allowlist** (file
tools, subagents, `node`/`python3`, basic read-only shell, read-only `gh`, and the
Slack/Calendar/Granola MCP tools) — never `bypassPermissions`. Anything outside the list is
denied. It applies only `time_entry_comment` and `todo_comment` feedback, leaves `pr_comment`
items pending, skips the Artifact section, and takes no outward-facing action (no GitHub
writes, Slack messages, or ticket changes). Its log is `dashboard/logs/morning.log`.
