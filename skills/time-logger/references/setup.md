# time-logger setup flow

Loaded on demand from `SKILL.md` when the user runs `/time-logger setup`. Run this flow
interactively. All paths below are inside the data home (`~/.local/share/time-logger/`, or
`$TIME_LOGGER_DATA_HOME` — the bootstrap printed the resolved value as `data_home:`).

### 1. Check current state

Read `capabilities.yml` (the bootstrap already created it from the example template if it was
missing, or migrated it from the old `~/repos/time_logs/` location).

- `Last configured: (not yet run)` → announce "Running first-time setup."
- Otherwise → announce "Reconfiguring." and show the current integration statuses.
- If the bootstrap reported `schema outdated`, say the file predates the `client:` /
  `dashboard:` / `submit:` sections and that this run will add them (keep every existing
  value). If an old `integrations.cronos` block is present, drop it — Cronos is now just one
  submit template, chosen in step 4.

### 2. Probe each integration

Run these checks and record what's available:

**Claude sessions** (always enabled if the projects dir exists):
```bash
ls ~/.claude/projects/ 2>/dev/null | wc -l
```
Available if count > 0.

**GitHub** (gh CLI):
```bash
gh auth status 2>&1
```
Available if output contains "Logged in". Extract the username from the output.

**Slack MCP** — call `slack_search_users` with `query: "a"`. Available if no error.

**Google Calendar MCP** — call `list_calendars`. Available if no error.

**Granola MCP** — call `list_meetings` with `time_range: last_30_days`. Available if no error.

**Dashboard** — `node --version` and `npm --version`. Available if both print a version
(Node 20+). Read the `dashboard:` line from the bootstrap output for build status.

### 3. Present findings

Show a table like:
```
Integration       Status       Notes
──────────────────────────────────────────
claude_sessions   available    ~/.claude/projects/ found
slack             available    Slack MCP detected
google_calendar   available    Google Calendar MCP detected
github            available    authenticated as octocat
granola           unavailable  Granola MCP not found
dashboard         available    node v22.1.0 — built at ~/.local/share/time-logger/app/dashboard
```

For anything unavailable, briefly explain what's needed to enable it.

### 4. Confirm and collect config

For each available integration, ask the user: "Enable [name]? (yes/no)" — or, if
reconfiguring, show the current state and ask whether to change it.

If Slack is being enabled and `user_id` is empty, ask:
> "What's your Slack member ID? (Slack → click your name → Profile → ⋮ → Copy member ID)"

Then collect the **client** block (show current values when reconfiguring):
- `org` — the org this install logs time for, e.g. `Snowpack`; must match an entry in the
  Orgs section of `user-preferences.md` (create that entry if it's missing). Required.
- `slug` — short id for combined-file names, e.g. `snowpack`
- `name` — display name shown in the dashboard header
- `jira_browse_url` — ticket-link base, e.g. `https://acme.atlassian.net/browse/`
- `standup_channel_id` — Slack channel whose posts set the standup style

And the **dashboard** block: enabled?, port (default 4680), optional `todos_file` (a markdown
list rendered on the Overview tab; blank hides the panel).

Then the **submit** block. Ask: "How do you submit time on this machine?" and offer:
- **Cronos** — copy `<skill_dir>/submit-instructions.examples/cronos.md`. Probe first by
  calling `list_active_billing_codes` for today; if the tool isn't in this session, say the
  `snowpack-mcp` connector is needed and offer the other options instead.
- **Synced folder** — copy `submit-instructions.examples/synced-folder.md`, then ask for the
  local sync path (e.g. `~/Google Drive/My Drive/Timesheets/<name>/`), file name pattern, and
  columns, and edit the template's Settings section with the answers.
- **Something else** — copy `submit-instructions.examples/TEMPLATE.md` and tell the user to
  fill it in before running submit.
- **Nothing** — leave `submit.instructions` blank; submit is disabled on this machine.

Copy to `<data home>/submit-instructions.md` unless the user names another path. If a file is
already there when reconfiguring, show its first heading and ask before replacing it.

### 5. Write capabilities.yml

Write `capabilities.yml` in the shape of `capabilities.example.yml` (same section order and
comments), filling in every collected value and today's date on the `Last configured` line.
Preserve any existing value the user didn't change.

### 6. Dashboard build and launchd (macOS)

If the dashboard is enabled and the bootstrap reported it as not built or build failed, run:
```bash
bash <skill_dir>/scripts/dashboard-build.sh <skill_dir> --force
```
(`<skill_dir>` is the `skill_dir:` value from the bootstrap output.) The first build installs
dependencies and can take a minute; the log is `dashboard/logs/build.log`.

Then ask: "Install the launchd jobs so the dashboard server stays up and refreshes itself on
weekdays (server keep-alive, a refresh at 7:13/9:13/11:13/1:13/3:13 that refetches today's
sources and redrafts today's entries, and a
once-per-weekday headless morning run at 6:45)? (yes/no)". On yes:
```bash
bash <skill_dir>/scripts/install-launchd.sh
```
It writes `~/Library/LaunchAgents/com.time-logger.*.plist`, loads them, and sets
`dashboard.launchd: true`. Re-running it later re-renders and reloads; `--uninstall` removes
them. If the user declines, mention `/time-logger dashboard start` for a one-off server.

### 7. Confirm completion

Tell the user which integrations are active, where the data home is, whether the dashboard
is built/served, and that `/time-logger prefetch today` is the quickest way to test.
