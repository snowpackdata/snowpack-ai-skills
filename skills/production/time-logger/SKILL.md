---
name: time-logger
description: Slash-command time logger. Run /time-logger setup, prefetch [date], log [date], submit [date], status, morning, refresh [section], feedback, summary [focus] (standup is an alias), dashboard [build|install|start|open], or /time-logger followed by any free-form question about your time, sources, or dashboard state. Builds a daily context file from Slack, Google Calendar, Claude Code sessions, GitHub, and Granola, drafts time entries from it, reviews them on a local Morning Dashboard, and on request submits them wherever this machine's submit instructions point (Cronos, a synced folder, etc.).
summary: "/time-logger setup | prefetch | log | submit | morning | summary — drafts daily time entries from your tools, with a local review dashboard."
owner: "@jarellano01"
argument-hint: "setup | prefetch [date] | log [date] | submit [date] | status | morning | refresh [section] | feedback | summary [focus] | dashboard [build|install|start|open] | <any question>"
disable-model-invocation: true
---

# time-logger

Reconstructs a workday from wherever you actually did the work — Slack, Google Calendar,
Claude Code sessions, GitHub, Granola — into draft time entries, lets you review them on a
local Morning Dashboard, and optionally submits confirmed entries wherever this machine's
submit instructions say — a billing system, a synced folder, anything.

This skill only runs when you invoke it explicitly. All state lives in one **data home**,
`~/.local/share/time-logger/` (override with `$TIME_LOGGER_DATA_HOME`), regardless of which
project you have open. The skill folder itself holds only code and templates.

## Usage

```
/time-logger setup              probe integrations, collect client config, write capabilities.yml,
                                build the dashboard, optionally install launchd jobs
/time-logger prefetch [date]    pull raw activity for a date from every enabled source
/time-logger log [date]         draft the day's time entries + build the combined file
                                (runs prefetch first if raw data is missing)
/time-logger submit [date]      run the org gate on the draft, then follow this machine's
                                submit instructions after you confirm
/time-logger status             what's configured, what's fetched, dashboard state
/time-logger morning            daily flow: apply dashboard comments, backfill the week,
                                refresh everything, open the dashboard
/time-logger refresh [section]  refresh dashboard data (time_entries, todos, calendar, slack,
                                digest, artifacts, github, or all)
/time-logger feedback           apply comments left in the dashboard UI back to the files
/time-logger summary [focus]    progress summary for any audience/occasion ("Friday standup Slack
                                message", "analytics team review — check past Granola notes");
                                refreshes stale days first, saves the result to summaries/ and
                                the dashboard's Summaries tab. `standup` is an alias.
/time-logger dashboard <cmd>    build | install | uninstall | start | open
/time-logger <question>         ask anything — "hours so far today?", "what's stale?", "what did
                                I do Friday for BGC?" — answered from the data home; it tells
                                you how fresh the data is and offers a refresh when that matters
```

`[date]` defaults to today. Accepts `YYYY-MM-DD`, `today`, `yesterday`, or a weekday
name (meaning the most recent one, e.g. `friday`).

## Bootstrap (runs automatically on every invocation)

!`for c in "$HOME/.claude/skills/time-logger" ".claude/skills/time-logger" "skills/production/time-logger" "."; do if [ -f "$c/scripts/bootstrap.sh" ] && grep -q '^name: time-logger$' "$c/SKILL.md" 2>/dev/null; then bash "$c/scripts/bootstrap.sh" "$(cd "$c" && pwd -P)"; exit 0; fi; done; echo "skill_dir: NOT FOUND — subagents were not (re)installed; see Troubleshooting"`

The block above ran `scripts/bootstrap.sh` before you read this. It: resolves the data home
and creates its tree; migrates data once from the old fixed location (`~/repos/time_logs/`)
if found; installs the six subagents into `~/.claude/agents/` (Claude Code can't discover them
inside a skill folder) and the session scanner into `<data home>/scripts/`; seeds
`capabilities.yml` / `user-preferences.md` from the examples if missing; and syncs + builds the
bundled dashboard into `<data home>/app/dashboard/` whenever its source changed.

Read the bootstrap output before dispatching. Use its `data_home:` and `skill_dir:` values
wherever this file says `<data home>` or `<skill_dir>`. The `today's data:` line is the
freshness summary for today — when a subcommand or question depends on today's activity and
that line shows a source or the draft as missing or hours old, say so before relying on it. If `capabilities.yml` reports
`(not yet run)` or `schema outdated` and the subcommand is anything other than `setup` or
`status`, tell the user to run `/time-logger setup` first and stop.

## Dispatch

The subcommand is `$0`; the optional argument is `$1` (for `summary` and questions, use the whole rest of the string). Full argument string: `$ARGUMENTS`.

| `$0` | Do |
|---|---|
| *(empty)* or `help` | Print the Usage block above and stop. |
| `setup` | Follow [`references/setup.md`](./references/setup.md) — read it now. |
| `prefetch` | Resolve the date, then run **Prefetch** below. |
| `log` | Resolve the date, then run **Log** below. |
| `submit` | Resolve the date, then run **Submit** below. |
| `status` | Run **Status** below. |
| `morning` | Follow [`references/morning.md`](./references/morning.md). |
| `refresh` | Follow [`references/dash-refresh.md`](./references/dash-refresh.md) with `$1` as the section. |
| `feedback` | Follow [`references/review-feedback.md`](./references/review-feedback.md). |
| `summary` | Follow [`references/summary.md`](./references/summary.md) with the rest of the argument string as the focus. |
| `standup` | Alias — same as `summary Friday standup Slack message — this week and what's next`. |
| `dashboard` | Run **Dashboard** below with `$1` as the action. |
| anything else | Treat the full argument string as a question — follow [`references/ask.md`](./references/ask.md). |

**Resolving the date.** Use the `today:` / `yesterday:` values printed by the bootstrap.
For a weekday name, pick the most recent past occurrence (if today is that weekday, use
today). Normalize to `YYYY-MM-DD` and echo the resolved date back to the user before
doing anything else, e.g. `Resolved "friday" → 2026-09-05`.

## Prefetch

1. Read `<data home>/capabilities.yml`.
2. Spawn, **in parallel**, one subagent per enabled integration, passing the date in the
   task prompt as `YYYY-MM-DD`:

   | capabilities key | subagent |
   |---|---|
   | `claude_sessions` | `fetch-claude-sessions-day` |
   | `slack` | `fetch-slack-day` |
   | `google_calendar` | `fetch-calendar-day` |
   | `github` | `fetch-github-day` |
   | `granola` | `fetch-granola-day` |

   Each writes `<data home>/raw/{source}/YYYY-MM-DD.md` and returns a one-line count. Relay
   those lines to the user as a short table.
3. Stop there — prefetch does not generate. Suggest `/time-logger log <date>` next.

## Log

1. Check which raw files exist: `ls <data home>/raw/*/YYYY-MM-DD.md` (ignore `combined/`).
2. If none exist for the date, run **Prefetch** first and say so.
3. Spawn `generate-time-entry` with the date. It reads every raw file present plus
   `user-preferences.md`, applies the standing rules (real start times snapped to 15 minutes, effort-based
   durations, overlap allowed, artifact/document review time, one scope per entry, one `[client: Name]` tag
   per entry from the Orgs/Clients sections), **merges with an existing file for that date rather
   than overwriting it**, and writes `<data home>/time_logs/time_entries_YYYYMMDD.md`.
   If the agent reports `unknown`-tagged entries, tell the user which ones so they can add a
   match rule to the Clients section.
4. Build the day's combined file (raw sections + Recommended Time Log Structure), upload it if
   the notes API is enabled, and sync the dashboard — follow
   [`references/combined-file.md`](./references/combined-file.md).
5. Show the user the entries verbatim, followed by the agent's one-line summary. Make clear
   these are drafts — nothing has been logged. If the dashboard is served, point them to
   `http://localhost:<dashboard.port>/#/time` to review and comment.
6. Suggest `/time-logger submit <date>` if `submit.instructions` in `capabilities.yml` is set.

## Submit

Sends reviewed entries for one date to wherever this machine is configured to send them. The
skill has no built-in destination: steps 1–4 are fixed safety rails, and everything after them
comes from the instructions file named by `submit.instructions` in `capabilities.yml`
(`<data home>/submit-instructions.md` by default). Templates for common destinations live in
`<skill_dir>/submit-instructions.examples/` — `cronos.md`, `synced-folder.md`, `TEMPLATE.md`.

1. Require `<data home>/time_logs/time_entries_YYYYMMDD.md`. If missing, run **Log** first.
2. Require `submit.instructions` to be non-blank and the file to exist. If blank, say submit
   is disabled on this machine and point to `/time-logger setup`. If the path is set but the
   file is missing, say so and stop — never invent a destination.
3. If `<data home>/dashboard/feedback/pending.json` has unresolved `time_entry_comment` items
   for this date, run the `feedback` flow first so the submit reflects the user's corrections.
4. **Org gate.** Read the Orgs and Clients sections of `user-preferences.md` and `client.org`
   from `capabilities.yml`. Only entries whose `[client: Name]` tag resolves to a client
   under that org are eligible. List every entry under any other org, plus `unknown` and
   untagged ones, in a separate "not submitted" block with its reason. These never reach the
   instructions file, even if asked to "submit everything"; the user must retag the entry
   first. Pass each eligible entry's client `kind` along — the instructions may use it.
5. Read the instructions file and follow it for the eligible entries. It decides how to
   detect entries already submitted (exclude those as `already submitted`), how to map a
   client to the destination's identifier, what the review table shows, and what to write.
   Whatever it says, two rules hold: present a review table (at minimum start, end, hours,
   destination identifier, description) and ask for explicit confirmation before writing
   anything — accept row edits, do not proceed on silence or on anything short of a clear
   yes; and report each write's result plus everything skipped and why.
6. If the instructions had you learn a new client → identifier mapping, append it to
   `user-preferences.md` under "Project / client context" so the next submit doesn't ask.

## Status

Report, compactly:

- The integrations and client tables from `capabilities.yml` (name, enabled, any id/username).
- Which raw sources exist for each of the last 7 days: `ls <data home>/raw/*/ 2>/dev/null`
- The most recent generated files: `ls <data home>/time_logs/ | sort | tail -3`
- Whether all six subagents are installed, and the `dashboard:` line (from the bootstrap output).
- Whether the server answers: `curl -s http://localhost:<dashboard.port>/data/meta.json`
- Pending dashboard comments: length of `<data home>/dashboard/feedback/pending.json`.

## Dashboard

The Morning Dashboard (Vite + React) is bundled in this skill's `dashboard/` folder and built
into `<data home>/app/dashboard/` — never inside the skill folder, which is replaced on every
skill update. Markdown files stay the source of truth; the app reads a JSON store at
`<data home>/dashboard/data/` that `refresh` and `morning` render. Comments left in the UI
queue in `<data home>/dashboard/feedback/pending.json` for `feedback`. The sidebar's **Apply
comments** button runs that flow headlessly for time-entry and todo comments; PR comments wait
for an interactive `/time-logger feedback` because they can require GitHub actions.

| `$1` | Do |
|---|---|
| `build` | `bash <skill_dir>/scripts/dashboard-build.sh <skill_dir> --force` — resync + rebuild. |
| `install` | `bash <skill_dir>/scripts/install-launchd.sh` — load the three launchd jobs (macOS): `com.time-logger.dash-server` (keep-alive), `com.time-logger.dash-refresh` (weekdays 7:13/9:13/11:13/13:13/15:13 — refetches today's sources and redrafts today's entries so they can be commented on during the day), `com.time-logger.morning-run` (6:45 + first wake, once per weekday). Confirm with the user before running — it changes login items. |
| `uninstall` | `bash <skill_dir>/scripts/install-launchd.sh --uninstall`. |
| `start` | One-off server without launchd: `(cd <data home>/app/dashboard && nohup node server.mjs > <data home>/dashboard/logs/server.log 2>&1 &)`, then `refresh all`. |
| `open` | `open http://localhost:<dashboard.port>`. |
| *(empty)* | Print this table and the current `dashboard:` bootstrap line. |

Scheduled runs are automation, not logged work — the generate agent excludes them. Each
scheduled refresh (and the dashboard's Refresh button) also refetches today's enabled sources
and re-runs `generate-time-entry` for today in merge mode, so today's draft grows through the
day and comments left on it queue for `feedback` like any other.

## Feedback (preferences)

Whenever the user corrects something while any subcommand is running — "always skip
standup", "that's client X", "never log the all-hands" — append it to
`<data home>/user-preferences.md` in the matching section, plus a dated line under
"Corrections log". Then continue the subcommand.

## Troubleshooting

- **`skill_dir: NOT FOUND`** — the bootstrap couldn't locate the skill's own files, so it
  couldn't (re)install the subagents. Expected locations are `~/.claude/skills/time-logger`
  (npx install) or `.claude/skills/time-logger` (project install). If you cloned the repo,
  run the skill from the repo root so `skills/production/time-logger` resolves.
- **`agents installed: N/6` with N < 6** — a prior copy failed; re-run any subcommand
  after fixing the location above.
- **`schema outdated`** — `capabilities.yml` predates the `client:` / `dashboard:` sections.
  Run `/time-logger setup`; it keeps every existing value.
- **`dashboard: NOT built — node/npm not on PATH`** — install Node 20+ (e.g. `brew install
  node`), then `/time-logger dashboard build`.
- **`dashboard: BUILD FAILED`** — read `<data home>/dashboard/logs/build.log`.
- **Server not answering** — `/time-logger dashboard start`, or if launchd is installed,
  `launchctl kickstart -k gui/$(id -u)/com.time-logger.dash-server`.
- **Slack fetch returns nothing** — `slack.user_id` in `capabilities.yml` is probably
  empty. Re-run `/time-logger setup`.
- **`submit` says it's disabled or can't find its instructions** — `submit.instructions` in
  `capabilities.yml` is blank or points at a missing file. Run `/time-logger setup` and pick a
  template, or copy one from `<skill_dir>/submit-instructions.examples/` by hand.
- **`submit` stops on a missing tool** (e.g. the Cronos connector) — that check comes from
  your instructions file, not the skill. Connect the tool it names, or switch this machine to
  a different template such as `synced-folder.md`.
- **Data still at `~/repos/time_logs/`** — the migration only runs when the data home has no
  `capabilities.yml` yet. Move the files by hand, or delete the data home's `capabilities.yml`
  and re-run.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill time-logger
```

Then, from any project, run `/time-logger setup`. No other install step — the bootstrap
above handles the subagent, script, and dashboard placement on first use.
