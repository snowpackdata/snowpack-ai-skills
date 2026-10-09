---
name: fetch-claude-sessions-day
description: Scans coding-agent session transcripts (Claude Code and Codex, deduplicated) for activity on a specific date and saves a summary to ~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md, reusing cached per-session summaries when nothing changed. Invoked by `/time-logger refresh entries` with a target date.
tools: Read, Write, Bash
model: sonnet
color: purple
permissionMode: bypassPermissions
---

> **Data home**: all dynamic data lives under `~/.local/share/time-logger/` — `raw/`, `time_logs/`, `capabilities.yml`, `user-preferences.md`, and `dashboard/{data,feedback,logs}/`. Any relative data path below (e.g. `raw/slack/...`, `time_logs/time_entries_*.md`, `dashboard/data/*.json`) resolves against that directory, NOT the repo. Override the location with `$TIME_LOGGER_DATA_HOME`. Code (the skill, its scripts, and the dashboard app) lives in the skill install and `<data home>/app/`, never in a project repo.

You scan coding-agent JSONL session transcripts — Claude Code and/or Codex, whichever
`capabilities.yml` enables — for activity on a target date and write a structured summary. Both
providers feed this one file; the scanner deduplicates imported, forked, and copied history
across them before you see anything, so every session it prints is distinct activity. The target date will be provided in your task prompt in YYYY-MM-DD format.

---

## Step 0 — Check capabilities

Read `~/.local/share/time-logger/capabilities.yml`. If `claude_sessions.enabled` is `false`
AND `codex_sessions.enabled` is not `true` (a missing `codex_sessions` key means disabled),
write `~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md` containing `Coding-agent sessions
disabled in capabilities.yml — skipping.` and stop. Otherwise the scanner picks the enabled
providers itself.

---

## Step 1 — Run the session scanner

```bash
python3 ~/.local/share/time-logger/scripts/scan_sessions.py YYYY-MM-DD
```

Replace `YYYY-MM-DD` with the target date. The script scans JSONL files under `~/.claude/projects/` and/or `$CODEX_HOME/sessions/` + `archived_sessions/` (default `~/.codex`), drops history one transcript copied from another (a Codex import of a Claude session, a fork, an archive copy), filters to lines timestamped on that date, extracts turn counts, first/last activity times (local time, DST-aware — PDT or PST as the date requires), and message excerpts — all of them for a session, not just the first several: a fixed small cap on excerpts was measured to systematically hide whatever happened after it, which is exactly where a long session's outcome usually is. There's a character-budget safety valve for a genuinely pathological session (excerpts spanning hundreds of KB), which keeps both the start and the end rather than only the start if it ever triggers — a normal day's sessions, even a long one, come in well under it. This full rescan runs every time, even when reusing a cached summary below — it's cheap and is what guarantees nothing is missed, including a session that resumes after being idle for days or one that spans midnight. Two things keep it cheap even on a machine with a lot of history:
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

Each block carries `provider=` (`claude`|`codex`) and `cache_key=`/`digest=`; a block that
continues imported or forked history also has `continues_from=`, and one with ambiguous overlap
has `unresolved_messages=`. The trailer's `STALE_BLOCK=` lines name blocks already in today's
file that must be removed (Step 3).

For each `=== SESSION ===` block from Step 1:

- **`cached=yes`** — copy the block's `effort=` value and its `--- CACHED SUMMARY ---` text
  verbatim into Step 3's output. Do not re-derive or rephrase it, and there are no excerpts to
  read for this block.
- **`cached=no`** — summarize fresh from this run's excerpts:
  - **Repo** — use the block's `repo=` value
  - **Turns** — the total turn count
  - **First / Last** — already in local time
  - **Excerpts** — read ALL of them, in order, not just the first handful. A long session's
    excerpts aren't capped for a reason: the outcome, the decision, or a correction to something
    said earlier is just as likely to sit near the end as the start, and reading them in order
    means a later excerpt that revises or retracts an earlier one is seen and reflected, not
    contradicted. Write the summary:
    - **Typically 2–4 sentences.** But a session that genuinely covers multiple distinct,
      significant threads of work (not just one task with several steps) needs a clause per
      thread, even if that runs longer — compressing two unrelated pieces of real work into one
      generic sentence to hit a length target loses exactly the information the time-entry
      generator needs to split them.
    - What was the task or goal (or goals, if there's more than one distinct thread)?
    - What happened — was it straightforward or did it involve debugging, errors, retries?
    - What was the outcome? Include a real finding surfaced along the way if there is one (a bug
      a review caught, a correction the user or Claude made to an earlier claim, a decision
      reversed) — these are often the most consequential part of a session and easy to compress
      away by only looking at where a session started.
    - **Artifacts**: if the session published or updated a Claude artifact (Artifact tool calls,
      claude.ai/code/artifact URLs in the transcript), name the artifact(s) explicitly in the
      summary (e.g. "published the 'X — Discovery' artifact"). This matters downstream: artifact
      creation implies separate review time by the user that isn't in the transcript, and the
      time-entry generator needs the signal.
  - Assign an effort level based on turn count:
    - `light` — fewer than 15 turns
    - `medium` — 15–50 turns
    - `high` — 50+ turns (also bump to high if there were clear error/fix cycles regardless of count)

**Compose every `cached=no` summary now, in this same reasoning pass, before touching any
file-write tool in Step 3.** Don't interleave "summarize one session, write its block, summarize
the next" — that turns what should be one continuous piece of reasoning into N separate
tool-call round trips, each carrying its own turn-taking overhead on top of the actual writing
time. Hold all of them (cached=yes and cached=no alike) in mind as one complete, ordered set;
Step 3 then applies them in a single pass.

Count `cached=yes` vs `cached=no` blocks for Step 4's report (or use the scanner's own
`CACHED_SESSIONS=`/`FRESH_SESSIONS=` lines).

---

## Step 2.5 — Write the updated cache

Write `~/.local/share/time-logger/raw/claude/.cache/YYYY-MM-DD.json`, one entry per session
found in this run, keyed by its `cache_key=`: `{"file": ..., "turns": ..., "last_iso": ...,
"digest": ..., "effort": ..., "summary": ...}`. For a `cached=yes` block, copy every value
straight from this run's scanner output; for a `cached=no` block, copy `file=`/`turns=`/
`last_iso=`/`digest=` and add the `effort`/summary you composed. Never reconstruct a `digest`
or `last_iso` — a value that doesn't match byte-for-byte silently misses the cache next time.
Drop any entry not in this run's output. (The fan-out flow does this with
`scan_sessions.py --record-cache` instead; that's preferred whenever you can write the
summaries to a JSON file first.)

---

## Step 3 — Write or update the output file

Target: `~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md`. Every session (skip any with 0
turns) is one block in EXACTLY this format — every field required, no bullet points, no
omitted summaries:

```
## Session: [repo name]
**Source**: [Claude Code | Codex]
**File**: [full path]
**Turns on this date**: [N]
**First activity**: [H:MM AM/PM TZ]
**Last activity**: [H:MM AM/PM TZ]
**Effort**: [light / medium / high]

[Your 2–4 sentence summary here. Must describe the actual work, not just the repo name.]

---
```

Apply every change from Step 2 in **one pass** via `apply_session_blocks.py`, instead of one
`Edit` tool call per session — an Edit per block is correct but each one is its own tool-call
round trip on top of the actual write; a day with many sessions pays that overhead once per
session for no reason, since every change is already known before you write anything. Only
`cached=no` sessions ever need an operation — a `cached=yes` block is never touched, never
re-typed, and costs nothing here.

Build one JSON operations file (a scratch temp path is fine) and run it in a single call:

```bash
python3 ~/.local/share/time-logger/scripts/apply_session_blocks.py \
  ~/.local/share/time-logger/raw/claude/YYYY-MM-DD.md /tmp/claude-day-ops.json
```

Where the JSON is `{"header": "...", "operations": [...]}` (see the script's own usage comment
for the exact shape):
- **The file doesn't exist yet** (first run of the day): set `header` to
  `# Coding Agent Sessions — [Weekday], [Month Day], [Year]`, and give one `append` operation
  per session, in first-activity-ascending order — the script creates the file from `header`
  when the target path doesn't exist.
- **The file already exists**:
  - **`cached=no` session whose `**File**:` path is already in the file** (it grew since the
    last write) — one `replace` operation, `anchor_file` set to that path, `block` the freshly
    composed block.
  - **`cached=no` session whose `**File**:` path is new to the file** (first time seen today) —
    one `insert_after` operation anchored on the immediately-preceding session's `**File**:`
    path when that's unambiguous, so the new block lands in chronological order; if picking the
    right neighbor isn't straightforward, use `append` instead rather than risk anchoring on the
    wrong block — being slightly out of chronological order is harmless, corrupting the file is
    not.
  - **`cached=yes` sessions** — no operation at all; they're already correct in the file as-is.
  - **Every `STALE_BLOCK=` path** — one `remove` operation (`anchor_file` = that path). Its
    provider was disabled, or it turned out to duplicate another session, or it has no retained
    activity left for the date; leaving it would count it twice or count disabled data.
  - Any other block from a prior run that no longer appears in the scanner output (its file
    vanished) — leave it; never delete retroactively on missing data.

Every `block` you write must be in the exact format above, including the trailing `---`. If
the script reports an error (an `anchor_file` it couldn't find — check for a typo against
Step 1's `file=` lines first), fix the operations file and re-run it rather than falling back
to manual `Edit` calls for everything; a genuinely stuck single operation can still be applied
by hand as a last resort, but don't abandon the batch approach over one bad anchor.

---

## Step 4 — Report

```
Found N sessions for YYYY-MM-DD (H unchanged from cache, M re-summarized, A automation-filtered, D duplicate messages dropped):
  [source] repo-name  — N turns — effort
  ...
```

`H`/`M` are the scanner's `CACHED_SESSIONS=`/`FRESH_SESSIONS=` counts, `A` is
`FILTERED_AUTOMATION=`, `D` is `DUPLICATE_MESSAGES_DROPPED=`; omit a zero clause. If
`UNRESOLVED_OVERLAPS=` is nonzero, add a line saying so and pointing to
`scan_sessions.py YYYY-MM-DD --report`.
