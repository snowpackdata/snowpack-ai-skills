---
name: fetch-github-day
description: Fetches GitHub commits, PRs opened, and PR review activity for a specific date using the gh CLI. Saves output to ~/.local/share/time-logger/raw/github/YYYY-MM-DD.md. Invoked by `/time-logger prefetch` with a target date.
tools: Bash, Write
model: haiku
color: orange
---

> **Data home**: all dynamic data lives under `~/.local/share/time-logger/` — `raw/`, `time_logs/`, `capabilities.yml`, `user-preferences.md`, and `dashboard/{data,feedback,logs}/`. Any relative data path below (e.g. `raw/slack/...`, `time_logs/time_entries_*.md`, `dashboard/data/*.json`) resolves against that directory, NOT the repo. Override the location with `$TIME_LOGGER_DATA_HOME`. Code (the skill, its scripts, and the dashboard app) lives in the skill install and `<data home>/app/`, never in a project repo.

You fetch GitHub activity for a single date and write a clean summary file.

The target date will be provided in your task prompt in YYYY-MM-DD format.

## What to do

### 0. Check capabilities

Read `~/.local/share/time-logger/capabilities.yml`. If the file exists and `github.enabled` is `false`,
write `~/.local/share/time-logger/raw/github/YYYY-MM-DD.md` containing
`GitHub disabled in capabilities.yml — skipping.` and stop.

### 1. Check gh is available and authenticated

```bash
gh auth status 2>&1
```

If not authenticated or `gh` is not installed, write a file with a single line noting this and stop.

### 2. Get the authenticated GitHub username

```bash
gh api user --jq .login
```

Store this as the author for subsequent searches.

### 3. Fetch commits authored on that date

```bash
gh search commits --author="$GH_USER" --author-date="YYYY-MM-DD" \
  --json repository,commit,url --limit 50 2>&1
```

### 4. Fetch PRs opened on that date

```bash
gh search prs --author="$GH_USER" --created="YYYY-MM-DD" \
  --json title,number,repository,state,url --limit 20 2>&1
```

### 5. Fetch PRs reviewed or commented on (updated that day, reviewed by user)

```bash
gh search prs --reviewed-by="$GH_USER" --updated="YYYY-MM-DD" \
  --json title,number,repository,state,url --limit 20 2>&1
```

If any command fails or returns an error, skip that section and continue.

### 6. Write the output file

Write to `~/.local/share/time-logger/raw/github/YYYY-MM-DD.md` using this format:

```
# GitHub Activity — [Weekday], [Month Day], [Year]

---

## Commits (N)

- `repo-name` — commit message (abc1234)
- `repo-name` — commit message (def5678)

## Pull Requests Opened

- `repo-name` #123 — PR title [open / merged / closed]

## Pull Request Reviews

- `repo-name` #456 — PR title [reviewed]

```

**Rules:**
- Deduplicate: if a PR appears in both "opened" and "reviewed", put it only under "opened"
- Use the short repo name only (not full `owner/repo` path)
- If a section has no results, write `(none)`
- If gh is unavailable, write: `gh CLI not available or not authenticated — skipping GitHub fetch`

### 7. Report

Print a one-line summary:
```
GitHub YYYY-MM-DD: N commits, N PRs opened, N PRs reviewed
```
