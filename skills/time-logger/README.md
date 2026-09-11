# time-logger

<!-- STATUS:START -->
> ✅ **Production Ready** — used successfully in real work by someone besides the author, or by the author in production. Honor system. Owner: @jarellano01. [What the statuses mean.](../../README.md#skill-status)
<!-- STATUS:END -->

Reconstructs a workday from wherever you actually did the work — Slack, Google Calendar,
Claude Code sessions, GitHub, and Granola meeting notes — into draft time entries, lets you
review them on a local Morning Dashboard, and optionally submits the entries you confirm
wherever this machine's submit instructions point — Cronos, a synced Drive folder, anything.

It only runs when you invoke it. There is no inference from conversation.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill time-logger
```

Then, from any project:

```
/time-logger setup
```

That's the whole install. The skill's first line is a shell bootstrap that runs on every
invocation: it copies the six bundled subagents into `~/.claude/agents/` (Claude Code
doesn't discover agents nested inside a skill folder), places the session-scanner script,
creates the data home with default config, and builds the bundled dashboard into the data
home. Setup then probes which integrations are reachable on your machine, collects your
client-specific values, and writes `capabilities.yml`.

## Usage

```
/time-logger setup              probe integrations, collect client config, build the dashboard
/time-logger refresh entries [date]   pull raw activity for a date from every enabled source,
                                draft the day's time entries, and build the combined file
/time-logger submit [date]      org-gate the draft, confirm, then follow this machine's submit instructions
/time-logger status             what's configured, what's fetched, dashboard state
/time-logger morning            daily flow: apply comments, backfill, refresh, open the dashboard
/time-logger refresh [section]  refresh one dashboard section (entries, todos, calendar, slack,
                                digest, artifacts, github) or all
/time-logger feedback           apply comments left in the dashboard UI
/time-logger summary [focus]    progress summary for any audience; saved to summaries/ and the dashboard (standup = alias)
/time-logger dashboard <cmd>    build | install | uninstall | start | open
/time-logger <question>         ask anything — answered from the data home, with a freshness note
```

`[date]` defaults to today and accepts `YYYY-MM-DD`, `today`, `yesterday`, or a weekday
name (most recent one).

Corrections you give mid-run ("always skip standup", "that project is for Acme") are
appended to `user-preferences.md` in the data home so you never repeat them.

## How it works

1. **Refresh entries** — `/time-logger refresh entries [date]` is the one place raw activity
   gets pulled and drafted (it replaces the old separate `prefetch`/`log` subcommands). One
   small subagent per enabled integration (`fetch-*-day`) pulls one source for the target date
   and writes `raw/{source}/YYYY-MM-DD.md`, running in parallel; for today it always re-checks
   every source, for a past date only what's missing. Two agents cache internally so a repeat
   check is cheap when nothing changed: the Claude-sessions agent reuses a session's cached
   summary when its turn count hasn't moved since the last run, and the Slack agent appends
   only new messages instead of reformatting the whole day. Adding a new integration is a new
   `fetch-*-day` agent writing to a new `raw/{source}/` directory — nothing else changes.
   `generate-time-entry` then discovers whatever `raw/*/YYYY-MM-DD.md` exists and writes
   `time_logs/time_entries_YYYYMMDD.md`: entries at their real start times (snapped to
   15 minutes) with effort-based durations — overlap is allowed and drawn in lanes — with
   plain-prose descriptions, explicit review time for artifacts a session produced, one scope per
   entry. Rerunning a date **merges** with the existing file so your corrections survive.
   A combined file (every raw source + a Recommended Time Log Structure) is built alongside
   it. Nothing leaves the machine until `submit`.
2. **Review** — the Morning Dashboard (sidebar nav; IBM Plex Sans for UI and prose, Plex Mono
   for numbers; dark) shows the week's entries on a timeline;
   comments you leave there queue for `/time-logger feedback`, which edits the markdown and
   re-renders. The Slack tab summarizes recent conversations with follow-ups first and
   self-DMs excluded; raw messages stay behind a toggle.
   The scheduled refresh (and the Refresh button) redoes the above for today every couple of
   hours, so today's draft fills in during the day and can be commented on before it ends —
   caching keeps a refresh where nothing changed fast instead of redoing the same
   summarization work. Each day shows when its draft was last written.
   Anything typed after `/time-logger` that isn't a subcommand is a question: it reads a
   freshness snapshot first, answers from the files, and offers a refresh only when the
   answer depends on today's data being current.
3. **Submit** — reads the draft, runs the org gate, then follows the per-machine
   `submit-instructions.md` named in `capabilities.yml`. The skill has no built-in
   destination: the instructions file decides where entries go, how to detect ones already
   sent, and how clients map to the destination's codes. Two rails are fixed regardless: only
   entries under your org reach the instructions, and nothing is written until you confirm a
   review table. Templates ship in `submit-instructions.examples/` — `cronos.md` (create
   entries via the `snowpack-mcp` connector, never finalize), `synced-folder.md` (one CSV per
   day into a Google Drive / Dropbox folder, for client machines where no connector can be
   installed), and a blank `TEMPLATE.md`.

## Integrations

| Integration | Requires |
|---|---|
| Claude Code sessions | Nothing — always on, reads `~/.claude/projects/` locally |
| GitHub | `gh` CLI installed and authenticated (`gh auth login`) |
| Slack | Slack MCP connector in Claude Code + your Slack member ID |
| Google Calendar | Google Calendar MCP connector in Claude Code |
| Granola | Granola MCP connector in Claude Code |
| Submit destination | Whatever your `submit-instructions.md` needs — e.g. the `snowpack-mcp` connector for Cronos, or a mounted sync folder |
| Dashboard | Node 20+ (`node`, `npm`); launchd jobs are macOS-only |

## Safety notes

- The dashboard server binds to `127.0.0.1` only. Everything it serves (Slack messages,
  calendar, time entries) stays on the machine; nothing is reachable from the network.
- The headless runs (scheduled refresh, morning run, and the dashboard's Refresh / Morning run /
  Apply comments buttons) use an explicit `--allowedTools` list, never
  `bypassPermissions`: file tools, subagents, `node`/`python3`, basic read-only shell,
  read-only `gh`, and the Slack/Calendar/Granola MCP tools. They cannot post to GitHub or
  Slack, change tickets, or run arbitrary shell. PR comments left in the UI stay pending until
  an interactive `/time-logger feedback` run, which confirms before any outward action.
- The Claude-sessions fetcher summarizes every transcript under `~/.claude/projects/`, so on
  a machine used for several clients the raw files and drafts contain all of them. The
  **Orgs** and **Clients** sections of `user-preferences.md` model this: everyone you work
  for is a client (`kind`: internal, client, or personal) under an org. `client.org` in
  `capabilities.yml` names the org this install logs time for. Every entry is tagged
  `[client: Name]`; only clients under that org can reach `submit`, the standup, or the
  digest — work under any other org (personal projects, side clients) stays in the log and
  on the dashboard but never crosses over. The
  dashboard shows hours per org and per client. All of it stays in the local
  data home. The only step that sends anything anywhere is `submit`, and only through this
  machine's submit instructions after you confirm a review table.
- The bootstrap copies six agents into the global `~/.claude/agents/` by fixed names
  (`fetch-*-day`, `generate-time-entry`) and overwrites them on each run.
- The launchd installer creates login items; it only runs when you say yes during setup or
  invoke `/time-logger dashboard install`, and `--uninstall` removes them.

## Summaries

`/time-logger summary <focus>` writes a progress update for whatever the focus names — a Friday
standup Slack message, talking points for a recurring review (it reads that meeting's recent
Granola notes first), a client email — after refetching any stale day in scope. Every result is
saved under `summaries/` with a descriptive title and listed on the dashboard's Summaries tab,
where clicking one shows the full markdown. `standup` still works as an alias, and the
Overview's daily digest is the same flow with a fixed `daily digest` focus, saved as
`YYYY-MM-DD_daily-digest.md` and overwritten through the day.

## Todos

If `dashboard.todos_file` names a markdown list, the Overview tab renders it. Each `- [ ]` line
is either a **Jira** todo (`[PROJ-123]`, linked through `jira_browse_url`) or a **local** one,
and can carry free-form `#tags` (`#slack`, `#pr`, `#reply`) and links. On every render the
dashboard attaches **evidence** to open items: time entries whose ticket or text cites the
todo, PRs that name the ticket or are linked from it (with open / draft / merged / closed
state), and Slack messages that mention either. An item with a merged PR or logged time gets
a ✓ evidence chip. Nothing is closed automatically — the chip is there so you can comment
"done — close it" on the dashboard and let `/time-logger feedback` flip the box, citing the
proof in the completion note.

## Client-specific config

Nothing about a particular engagement is hardcoded. `capabilities.yml` has a `client:` block
(`org`, `slug`, `name`, `jira_browse_url`, `standup_channel_id`), a `dashboard:` block (`port`,
`todos_file`, `launchd`), and a `submit:` block (`instructions` — path to this machine's submit
instructions) that setup fills in; the dashboard reads them at render time.

## Key paths

Everything dynamic lives in the **data home**: `~/.local/share/time-logger/` by default,
or `$TIME_LOGGER_DATA_HOME`. The skill folder is code only and is safe to replace on update.

| Path (inside the data home) | Purpose |
|---|---|
| `capabilities.yml` | Enabled integrations + client config — written by `/time-logger setup` |
| `user-preferences.md` | Standing corrections and client context the generate agent reads every run |
| `submit-instructions.md` | Where and how `submit` sends confirmed entries on this machine — copied from a template by setup |
| `raw/{source}/YYYY-MM-DD.md` | Prefetched source data per date |
| `raw/combined/time-log_YYYY-MM-DD_<slug>.md` | Combined per-day file: raw sections + Recommended Time Log Structure |
| `time_logs/time_entries_YYYYMMDD.md` | Draft time entries per date (what the dashboard and `submit` read) |
| `summaries/YYYY-MM-DD_<slug>.md` | Every progress summary produced by `summary`/`standup`, with frontmatter (title, focus, audience, range) — shown on the Summaries tab. `*_daily-digest.md` is the Overview digest; the newest one is displayed |
| `scripts/scan_sessions.py` | Copied here by the bootstrap; used by the Claude-sessions agent |
| `app/dashboard/` | The built dashboard (synced + built from the skill's `dashboard/` folder) |
| `dashboard/data/*.json` | Rendered store the UI reads |
| `dashboard/feedback/pending.json` | Comments from the UI awaiting `/time-logger feedback` |
| `dashboard/logs/` | build, server, refresh, and morning-run logs |

If you used an earlier version that wrote to `~/repos/time_logs/`, the first run moves that
data into the data home automatically.

None of this is ever committed anywhere — this repo ships the agents, templates, and
dashboard source only.
