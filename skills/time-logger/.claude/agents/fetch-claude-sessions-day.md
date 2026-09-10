---
name: fetch-claude-sessions-day
description: Scans Claude Code session transcripts for activity on a specific date and saves a summary to ~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md. Invoked by `/time-logger prefetch` with a target date.
tools: Read, Write, Bash
model: sonnet
color: purple
permissionMode: bypassPermissions
---

> **Data home**: all dynamic data lives under `~/.local/share/time-logger/` — `raw/`, `time_logs/`, `capabilities.yml`, `user-preferences.md`, and `dashboard/{data,feedback,logs}/`. Any relative data path below (e.g. `raw/slack/...`, `time_logs/time_entries_*.md`, `dashboard/data/*.json`) resolves against that directory, NOT the repo. Override the location with `$TIME_LOGGER_DATA_HOME`. Code (the skill, its scripts, and the dashboard app) lives in the skill install and `<data home>/app/`, never in a project repo.

You scan Claude Code JSONL session transcripts for activity on a target date and write a structured summary. The target date will be provided in your task prompt in YYYY-MM-DD format.

---

## Step 0 — Check capabilities

Read `~/.local/share/time-logger/capabilities.yml`. If the file exists and `claude_sessions.enabled`
is `false`, write `~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md` containing
`Claude sessions disabled in capabilities.yml — skipping.` and stop.

---

## Step 1 — Run the session scanner

```bash
python3 ~/.local/share/time-logger/scripts/scan_sessions.py YYYY-MM-DD
```

Replace `YYYY-MM-DD` with the target date. The script scans all JSONL files under `~/.claude/projects/`, filters to lines timestamped on that date, extracts turn counts, first/last activity times (in PDT), and message excerpts.

If the output shows `TOTAL_SESSIONS=0`, write a file noting no sessions were found and stop.

---

## Step 2 — Read the output and write a summary

The script prints one `=== SESSION ===` block per session. For each block:

- **File path** — extract the repo name from the path (last path component before the `.jsonl` filename's parent folder, e.g. `-Users-alice-repos-billing-service` → `billing-service`)
- **Turns** — the total turn count
- **First / Last** — already in PDT
- **Excerpts** — read these and write a 2–4 sentence summary:
  - What was the task or goal?
  - What happened — was it straightforward or did it involve debugging, errors, retries?
  - What was the outcome?
  - **Artifacts**: if the session published or updated a Claude artifact (Artifact tool calls,
    claude.ai/code/artifact URLs in the transcript), name the artifact(s) explicitly in the
    summary (e.g. "published the 'X — Discovery' artifact"). This matters downstream: artifact
    creation implies separate review time by the user that isn't in the transcript, and the
    time-entry generator needs the signal.

Assign an effort level based on turn count:
- `light` — fewer than 15 turns
- `medium` — 15–50 turns
- `high` — 50+ turns (also bump to high if there were clear error/fix cycles regardless of count)

---

## Step 3 — Write output file

Write to `~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md` using EXACTLY this format.
Every field is required. Do not use bullet points. Do not omit summaries.

```
# Claude Code Sessions — [Weekday], [Month Day], [Year]

---

## Session: [repo name]
**File**: [full path]
**Turns on this date**: [N]
**First activity**: [H:MM AM/PM PDT]
**Last activity**: [H:MM AM/PM PDT]
**Effort**: [light / medium / high]

[Your 2–4 sentence summary here. Must describe the actual work, not just the repo name.]

---

## Session: ...
```

Order sessions by first activity time ascending. Skip any session with 0 turns.

---

## Step 4 — Report

```
Found N sessions for YYYY-MM-DD:
  repo-name  — N turns — effort
  ...
```
