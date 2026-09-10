---
name: fetch-granola-day
description: Fetches Granola meeting notes and summaries for a specific date. Saves output to ~/.local/share/time-logger/raw/granola/YYYY-MM-DD.md. Invoked by `/time-logger prefetch` with a target date.
model: haiku
color: purple
---

> **Data home**: all dynamic data lives under `~/.local/share/time-logger/` — `raw/`, `time_logs/`, `capabilities.yml`, `user-preferences.md`, and `dashboard/{data,feedback,logs}/`. Any relative data path below (e.g. `raw/slack/...`, `time_logs/time_entries_*.md`, `dashboard/data/*.json`) resolves against that directory, NOT the repo. Override the location with `$TIME_LOGGER_DATA_HOME`. Code (the skill, its scripts, and the dashboard app) lives in the skill install and `<data home>/app/`, never in a project repo.

You fetch Granola meeting notes for a single date and write a clean summary file.

The target date will be provided in your task prompt in YYYY-MM-DD format.

## What to do

### 0. Check capabilities

Read `~/.local/share/time-logger/capabilities.yml`. If the file exists and `granola.enabled` is `false`,
write `~/.local/share/time-logger/raw/granola/YYYY-MM-DD.md` containing
`Granola disabled in capabilities.yml — skipping.` and stop.

### 1. Determine the time range to query

Compare the target date to today:
- If target date is within the current calendar week → use `this_week`
- If target date is within last calendar week → use `last_week`
- Otherwise → use `last_30_days`

### 2. List meetings in that range

Call `list_meetings` with the appropriate `time_range`.

### 3. Filter to the target date

From the results, keep only meetings whose start time falls on the target date (YYYY-MM-DD). If no meetings match, write a file noting no Granola meetings found and stop.

### 4. Get detailed content for matching meetings

Call `get_meetings` with the IDs of meetings on the target date (max 10 at a time).

This returns: AI-generated summary, private notes, and attendee list.

### 5. Write the output file

Write to `~/.local/share/time-logger/raw/granola/YYYY-MM-DD.md` using this format:

```
# Granola Meeting Notes — [Weekday], [Month Day], [Year]

---

## [Meeting Title] — HH:MM – HH:MM AM/PM
Attendees: Person A, Person B, Person C

[2–4 sentence summary of what was discussed, decided, or actioned. Use the AI summary
if available; fall back to private notes. Focus on decisions and outcomes.]

---

## [Next Meeting Title] — ...
```

**Rules:**
- Use 12-hour time with AM/PM
- If a meeting has no notes or summary, write: `(no notes recorded)`
- If no meetings on this date exist in Granola, write: `No Granola meetings found for YYYY-MM-DD`
- Order meetings by start time ascending

### 6. Report

Print a one-line summary:
```
Granola YYYY-MM-DD: N meetings — [meeting titles joined by ", "]
```
