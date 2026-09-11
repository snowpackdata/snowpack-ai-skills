---
name: fetch-claude-sessions-day
description: Scans Claude Code session transcripts for activity on a specific date and saves a summary to ~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md, reusing cached per-session summaries when nothing changed. Invoked by `/time-logger refresh entries` with a target date.
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

Replace `YYYY-MM-DD` with the target date. The script scans JSONL files under `~/.claude/projects/`, filters to lines timestamped on that date, extracts turn counts, first/last activity times (in PDT), and message excerpts. This full rescan runs every time, even when reusing a cached summary below — it's cheap and is what guarantees nothing is missed, including a session that resumes after being idle for days or one that spans midnight. Two things keep it cheap even on a machine with a lot of history:
- It skips any file whose mtime predates the target day's local start — a transcript never
  written to on/after that day can't contain a line timestamped that day.
- It skips every transcript under the one project directory that every headless
  `scheduled-refresh.sh` / `morning-run.sh` run (and every subagent either spawns) writes to —
  time-logger running time-logger, which `generate-time-entry` would discard anyway. The
  output's `FILTERED_AUTOMATION=` count is how many were skipped this way.

If the output shows `TOTAL_SESSIONS=0`, write a file noting no sessions were found (mention
the `FILTERED_AUTOMATION` count if nonzero), still write an empty cache (`{"sessions": {}}`,
per Step 2.5) and stop.

The scanner itself decides cache hit vs. miss per session (against
`raw/claude/.cache/YYYY-MM-DD.json`, at minute precision — comparing full timestamps would
false-negative on every unchanged session, since nothing forces this step to reproduce a
cached value byte-for-byte) and tags each block accordingly, so this step never reads that
cache file directly. This is what makes a cache hit actually cheap: a `cached=yes` block never
includes excerpts at all, so reusing it costs no more than reading a few header lines — the
saving is in never seeing the excerpts again, not just in skipping a rewrite.

---

## Step 2 — Reuse or (re)write each session's summary

For each `=== SESSION ===` block from Step 1:

- **`cached=yes`** — copy the block's `effort=` value and its `--- CACHED SUMMARY ---` text
  verbatim into Step 3's output. Do not re-derive or rephrase it, and there are no excerpts to
  read for this block.
- **`cached=no`** — summarize fresh from this run's excerpts:
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
  - Assign an effort level based on turn count:
    - `light` — fewer than 15 turns
    - `medium` — 15–50 turns
    - `high` — 50+ turns (also bump to high if there were clear error/fix cycles regardless of count)

Count `cached=yes` vs `cached=no` blocks for Step 4's report (or use the scanner's own
`CACHED_SESSIONS=`/`FRESH_SESSIONS=` lines).

---

## Step 2.5 — Write the updated cache

Write `~/.local/share/time-logger/raw/claude/.cache/YYYY-MM-DD.json`, one entry per session
found in this run, keyed by its `file=` path: `{"turns": ..., "last_iso": ..., "effort": ...,
"summary": ...}`. For a `cached=yes` block, copy `turns=`, `last_iso=`, `effort=`, and the
cached summary text straight from this run's scanner output — never reconstruct or reformat
`last_iso`, since a value that doesn't match the scanner's own minute-precision string
byte-for-byte will silently miss the cache next time. For a `cached=no` block, write the
`turns=`/`last_iso=` this run just read plus the fresh `effort`/summary you just wrote. Drop
any entry for a file no longer present today (rare, but keeps the cache from growing stale).

---

## Step 3 — Write or update the output file

Target: `~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md`. Every session (skip any with 0
turns) is one block in EXACTLY this format — every field required, no bullet points, no
omitted summaries:

```
## Session: [repo name]
**File**: [full path]
**Turns on this date**: [N]
**First activity**: [H:MM AM/PM PDT]
**Last activity**: [H:MM AM/PM PDT]
**Effort**: [light / medium / high]

[Your 2–4 sentence summary here. Must describe the actual work, not just the repo name.]

---
```

**The file doesn't exist yet** (first run of the day): `Write` it fresh — the `# Claude Code
Sessions — [Weekday], [Month Day], [Year]` header, then one block per session, ordered by
first-activity ascending.

**The file already exists**: do NOT `Write` the whole file again — a full rewrite costs output
tokens for every session's block whether or not it changed, which throws away everything the
cache was supposed to save. `Read` the file once, then touch only what actually changed:
- **`cached=yes` sessions** — leave their block exactly as it is. Do not `Edit` it, do not
  re-type it anywhere, do not include it in your reasoning beyond confirming it's already
  there.
- **`cached=no` session whose `**File**:` path is already in the file** (it grew since the last
  write) — `Edit` just that one block: match on its `**File**: <path>` line through the
  following blank-line-then-`---`, replace with the freshly-summarized block. Never touch any
  other block to make this replacement.
- **`cached=no` session whose `**File**:` path is new to the file** (first time seen today) —
  insert its block in chronological position: anchor an `Edit` on the immediately-preceding
  session's trailing `---` (insert the new block right after it) when that's unambiguous;
  if picking the right neighbor isn't straightforward, append the new block at the end of the
  file instead rather than risk a bad edit — being slightly out of chronological order is
  harmless, corrupting the file is not.
- If a session block exists in the file from a prior run but no longer appears in this run's
  scanner output at all (rare), leave it — never delete retroactively.

---

## Step 4 — Report

```
Found N sessions for YYYY-MM-DD (H unchanged from cache, M re-summarized, A automation-filtered):
  repo-name  — N turns — effort
  ...
```

`H`/`M` are the scanner's `CACHED_SESSIONS=`/`FRESH_SESSIONS=` counts, `A` is
`FILTERED_AUTOMATION=`; omit the automation-filtered clause if it's 0.
