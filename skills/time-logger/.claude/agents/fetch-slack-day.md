---
name: fetch-slack-day
description: Fetches all Slack messages sent by the caller on a specific date and saves them to ~/.local/share/time-logger/raw/slack/YYYY-MM-DD.md, appending only new messages since the last fetch. Invoked by `/time-logger refresh entries` with a target date.
model: haiku
color: yellow
---

> **Data home**: all dynamic data lives under `~/.local/share/time-logger/` — `raw/`, `time_logs/`, `capabilities.yml`, `user-preferences.md`, and `dashboard/{data,feedback,logs}/`. Any relative data path below (e.g. `raw/slack/...`, `time_logs/time_entries_*.md`, `dashboard/data/*.json`) resolves against that directory, NOT the repo. Override the location with `$TIME_LOGGER_DATA_HOME`. Code (the skill, its scripts, and the dashboard app) lives in the skill install and `<data home>/app/`, never in a project repo.

You fetch Slack messages for a single date and write a clean summary file.

The target date will be provided in your task prompt in YYYY-MM-DD format.

## Step 0 — Check capabilities

Read `~/.local/share/time-logger/capabilities.yml`. If the file exists:
- If `slack.enabled` is `false`, write `~/.local/share/time-logger/raw/slack/YYYY-MM-DD.md` containing
  `Slack disabled in capabilities.yml — skipping.` and stop.
- Read `slack.user_id` — use this as the Slack user ID in Step 1.

If the file doesn't exist, proceed and use the user ID embedded in the task prompt (if any),
or ask the user to run setup.

## What to do

1. Read the cache at `~/.local/share/time-logger/raw/slack/.cache/YYYY-MM-DD.json` if it
   exists — shape `{"seen_ts": ["1694300000.123456", ...]}`. Treat a missing or unparsable
   file as `{"seen_ts": []}`. This tracks which messages (by Slack's per-message `ts`, the
   most reliable unique id the search result gives you) have already been written to today's
   raw file in a prior run, so a refresh only pays for what's new.

2. Search Slack for all messages sent by the user on the target date using the `slack_search_public_and_private` MCP tool:
   - `query`: `from:<@SLACK_USER_ID> on:YYYY-MM-DD` (use the user_id from capabilities.yml)
   - `sort`: `timestamp`
   - `sort_dir`: `asc`
   - `limit`: 20
   - `include_context`: false

   This full-day search always runs — there's no way to ask Slack "anything new since X"
   without asking, so this step isn't skippable. What caching skips is the formatting work
   below, not the search itself.

3. If the result contains a pagination cursor, fetch the next page using the `cursor` parameter. Keep paginating until no cursor is returned or you have 60 messages total.

4. Diff against the cache: drop every returned message whose `ts` is already in `seen_ts`.
   - **Nothing new** and the output file already exists — report `No new Slack messages for
     YYYY-MM-DD since last check.` and stop. Don't rewrite the file or touch the cache.
   - **Nothing new** and no output file exists yet (first run with zero messages) — write
     `No messages found.` as the file body and stop.
   - **Otherwise**, continue to Step 5 with just the new messages.

5. Format only the new messages using this style:

```
**HH:MM AM/PM** | [Channel name or "DM → Person Name"]
[Message text]
```

**Formatting rules:**
- Use 12-hour time with AM/PM
- For DMs, use "DM → Person Name" as the channel label
- Collapse purely reactive messages ("yeah", "ok", "one sec", "no worries") into `(brief acknowledgment)` if they add no signal — but preserve any message containing a PR link, ticket ID, decision, status update, or substantive question
- If you hit the 60-message cap with a cursor still available, add a note at the bottom: `> Note: more messages may exist — rerun refresh to get next page`

6. Write the output file at `~/.local/share/time-logger/raw/slack/YYYY-MM-DD.md`:
   - **File doesn't exist yet** — write it fresh with the header below plus the newly
     formatted messages.
     ```
     # Slack Activity — [Weekday], [Month Day], [Year]

     ---

     **HH:MM AM/PM** | [Channel name or "DM → Person Name"]
     [Message text]

     **HH:MM AM/PM** | ...
     ```
   - **File exists** — leave every existing line untouched and append the newly formatted
     messages after the last one (before any trailing `> Note:` pagination line, which should
     move to the new end if still applicable).

7. Update the cache with every message `ts` now captured for the date (existing `seen_ts` plus
   the new ones) and write it back to `~/.local/share/time-logger/raw/slack/.cache/YYYY-MM-DD.json`.

8. Report the number of new messages appended (or that none were found).
