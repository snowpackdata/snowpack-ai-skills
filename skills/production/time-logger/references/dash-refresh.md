# /time-logger refresh [section]

Refreshes the JSON data store the Morning Dashboard reads from. Argument: a section name
(`time_entries`, `todos`, `calendar`, `slack`, `digest`, `artifacts`, `github`) or `all` /
empty for everything. `slack` covers both the raw day file and the conversations summary.

Paths are relative to the data home (`~/.local/share/time-logger/`, or
`$TIME_LOGGER_DATA_HOME`). The built app lives at `app/dashboard/` inside it.

## How the store works

- `dashboard/data/*.json` — one file per section, shape `{ generated_at, status, data }`.
- `node app/dashboard/scripts/render.mjs` deterministically re-renders **time_entries, todos,
  calendar, slack, summaries, digest, config** from their sources of truth (`time_logs/*.md`,
  the `dashboard.todos_file` from `capabilities.yml`, `raw/calendar/`, `raw/slack/`,
  `summaries/*.md` — the digest is the newest `*_daily-digest.md` — and `capabilities.yml`)
  AND rebuilds `meta.json` (which the UI polls). It never touches `artifacts.json` or
  `slack_conversations.json`.
- `artifacts.json` (step 4) and `slack_conversations.json` (step 2b) are agent-written. After
  writing either, run the render script again so `meta.json` picks up the new timestamp.

## Steps

1. **Refetch today and redraft** (sections `calendar`, `slack`, `time_entries`, or `all`):
   spawn the fetch agents for every enabled source in parallel for today — not only when the
   raw file is missing; a refresh means *now*. For `time_entries` or `all`, then run
   `generate-time-entry` for today. It merges with the existing draft, so entries the user
   already commented on survive and new work since the last run is appended. This is what
   lets today's draft grow through the day and be commented on before the day ends. Also run
   `generate-time-entry` for any weekday this week that has raw data but no
   `time_logs/time_entries_YYYYMMDD.md`. Skip the combined file and any upload here — those
   belong to `log` and `morning`.

2. **Digest** (section `digest` or `all`): run the `summary` flow with the focus
   `daily digest` — the preset in [`summary.md`](./summary.md) fixes scope, sections, client
   gate, and links, and saves `summaries/YYYY-MM-DD_daily-digest.md` (overwriting today's).
   There is no separate digest spec anymore; `render.mjs` derives `digest.json` from the newest
   `*_daily-digest.md`, so the Overview shows the latest digest and older ones stay browsable
   on the Summaries tab.

2b. **Slack conversations** (section `slack` or `all`): write `dashboard/data/slack_conversations.json`
   — `{ generated_at, status: "ok", data: { range, conversations: [...] } }` — from the last
   3 workdays of `raw/slack/*.md`. Group messages by `target` (a DM, group DM, channel, or
   thread). **Exclude self-DMs** entirely: they are drafts the user had Claude write, not
   conversations. For each remaining group write:
   - `target` (as in the raw file), `kind` (`dm` | `group` | `channel` | `thread`),
     `last_active` (`Tue 3:40 PM` style), `url` (the permalink or channel link if the raw data
     has one, else null), `message_count`
   - `summary`: 1–2 sentences, verdict not transcript — what was being decided or asked, and
     where it landed. Inline markdown; link tickets/PRs per the linking rule.
   - `needs_followup` (bool) and `followup` (one line, or null): true when the last move is
     someone else's question or request to the user that has no reply from them, a promise the
     user made ("I'll send that over") with nothing sent since, or a thread that ends on an
     open decision. Be conservative — a false "follow up" costs more attention than a miss.
   Order `needs_followup` first, then by `last_active` descending. Cap at 20. The UI shows
   follow-ups in their own panel and keeps the raw per-message list behind a toggle.

3. **GitHub PRs** (section `github` or `all`): run
   `node app/dashboard/scripts/fetch-github-prs.mjs` — a deterministic gh CLI script, no agent
   needed. It writes `data/github_prs.json` (all open authored PRs sorted most-neglected first,
   plus PRs closed in the last 7 days). Skip if `integrations.github.enabled` is false.

   **Upload status** (sections `time_entries`, `github`, or `all`): also run
   `node app/dashboard/scripts/fetch-uploads.mjs`. It writes `status: "disabled"` when
   `integrations.notes_api.enabled` is false, which hides the upload chips in the UI.

4. **Artifacts** (section `artifacts` or `all`): call the Artifact tool with
   `action: "list"`, `limit: 50`, and write `dashboard/data/artifacts.json`:
   `{ generated_at, status: "ok", data: { artifacts: [{ title, url, updated }] } }`.
   Skip if the Artifact tool isn't available in this session.

5. **Render**: `node app/dashboard/scripts/render.mjs`.

6. **Server check**: the server is normally kept alive by the `com.time-logger.dash-server`
   launchd job. If `curl -s http://localhost:<port>/data/meta.json` fails and
   `dashboard.launchd` is true, try `launchctl kickstart gui/$(id -u)/com.time-logger.dash-server`.
   If launchd isn't installed, start it in the background:
   `(cd ~/.local/share/time-logger/app/dashboard && nohup node server.mjs >/dev/null 2>&1 &)`.
   If `app/dashboard/dist/` is missing, run
   `bash <skill_dir>/scripts/dashboard-build.sh <skill_dir> --force` first.

7. Report which sections were refreshed and their data dates (call out any section still
   showing an old day). The UI picks up changes automatically within ~5s via meta.json polling.
