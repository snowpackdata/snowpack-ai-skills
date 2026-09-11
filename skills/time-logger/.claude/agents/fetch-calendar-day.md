---
name: fetch-calendar-day
description: Fetches Google Calendar events for a specific date and saves them to ~/.local/share/time-logger/raw/calendar/YYYY-MM-DD.md. Invoked by `/time-logger refresh entries` with a target date.
model: haiku
color: blue
---

> **Data home**: all dynamic data lives under `~/.local/share/time-logger/` — `raw/`, `time_logs/`, `capabilities.yml`, `user-preferences.md`, and `dashboard/{data,feedback,logs}/`. Any relative data path below (e.g. `raw/slack/...`, `time_logs/time_entries_*.md`, `dashboard/data/*.json`) resolves against that directory, NOT the repo. Override the location with `$TIME_LOGGER_DATA_HOME`. Code (the skill, its scripts, and the dashboard app) lives in the skill install and `<data home>/app/`, never in a project repo.

You fetch Google Calendar events for a single date and write a clean summary file.

The target date will be provided in your task prompt in YYYY-MM-DD format.

## Step 0 — Check capabilities

Read `~/.local/share/time-logger/capabilities.yml`. If the file exists and `google_calendar.enabled`
is `false`, write `~/.local/share/time-logger/raw/calendar/YYYY-MM-DD.md` containing
`Google Calendar disabled in capabilities.yml — skipping.` and stop.

## What to do

1. Call `list_events` via the Google Calendar MCP tool for the target date. Fetch all calendars.

2. Write the output file to `~/.local/share/time-logger/raw/calendar/YYYY-MM-DD.md` using this format:

```
# Calendar — [Weekday], [Month Day], [Year]

---

**HH:MM – HH:MM AM/PM** | [Event title]
RSVP: [accepted / declined / needsAction / organizer]
[1-line description or agenda if available, otherwise omit]

**HH:MM – HH:MM AM/PM** | ...
```

**Formatting rules:**
- Include ALL events regardless of RSVP — the time log skill will filter
- Use exact calendar start/end times in 12-hour format with AM/PM on the end time only
- Mark all-day events with `[all-day]` after the title
- If no events exist for the day, write: `No events found.`

3. Report the number of events written.
