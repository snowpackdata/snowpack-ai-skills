# Fetching Claude Code session activity (fan-out)

Replaces spawning a single `fetch-claude-sessions-day` agent for the **claude** source. Follow
this directly in the current context — do NOT delegate it to a subagent. It fans out one
subagent per session itself, and a subagent cannot spawn further subagents in this runtime, so
the fan-out only works from a context (interactive session, or the top-level headless `claude
-p` invocation) that already has `Agent` tool access.

1. **Discovery + extraction** (deterministic, no LLM — pure filesystem/JSON mechanics):
   ```bash
   python3 <data home>/scripts/scan_sessions.py <date> --split <scratch dir>
   ```
   Use a scratch dir unique to this run (e.g. `/tmp/time-logger-claude-fanout-<date>-$$`) — it's
   disposable input for step 2, not part of the data store. This writes `manifest.json` (one
   entry per session: `file`, `repo`, `turns`, `first`, `last`, `last_iso`, `cached`, and for a
   `cached: true` session its `effort`/`summary` already filled in) plus one `session_NNN.txt`
   excerpt file per session where `cached: false`.

2. **Read `manifest.json`** (small — safe to read directly). For every session where
   `cached: false`, dispatch `summarize-claude-session` **in parallel, one call per session, in
   a single message** — give it that session's `excerpt_file` path and its `turns` count so it
   doesn't recompute what's already known. A `cached: true` session needs no subagent at all —
   copy its `effort`/`summary` from the manifest verbatim.

   **The dispatch prompt's very first characters must be the literal tag
   `<time-logger-fanout-worker>`** (e.g. `<time-logger-fanout-worker> Read the file ...`).
   Every dispatched subagent leaves behind its own tiny transcript, which the *next* scan would
   otherwise treat as a brand-new real session — `scan_sessions.py` specifically checks for
   this tag on a transcript's first user message to filter these back out (see
   `_FANOUT_WORKER_PREFIX` in that script). Skipping the tag silently reintroduces that noise
   into future days' data.

3. **Assemble one block per session**, once every dispatched subagent has returned, in this
   exact format, ordered by first-activity ascending (the manifest is already in that order):
   ```
   ## Session: [repo]
   **File**: [file]
   **Turns on this date**: [turns]
   **First activity**: [first]
   **Last activity**: [last]
   **Effort**: [effort]

   [2-4 sentence summary]

   ---
   ```

4. **Apply all of them to `raw/claude/<date>.md` in one pass** via `apply_session_blocks.py`
   (see that script's own usage comment for the exact operations-JSON shape). Only a session
   that was `cached: false` needs an operation (`replace` if its `**File**:` path is already in
   the file, `insert_after`/`append` if it's new); a `cached: true` session's block is already
   correct in the file and gets no operation. Set `header` (`# Claude Code Sessions —
   [Weekday], [Month Day], [Year]`) so the script can create the file if it doesn't exist yet.

5. **Update `raw/claude/.cache/<date>.json` in one write**: for every session in the manifest,
   keyed by its `file`, write `{"turns", "last_iso", "effort", "summary"}` — the manifest's own
   `last_iso`, plus (for freshly-summarized sessions) the subagent's effort/summary, or (for
   already-cached ones) what was already there. Drop any entry for a file no longer present in
   today's manifest.

6. **Clean up** the scratch dir from step 1.

7. **Report**: `Found N sessions for <date> (X unchanged from cache, Y re-summarized, Z
   automation-filtered)`, then one line per session with its repo/turns/effort — same shape
   `fetch-claude-sessions-day` used to report.

If `scan_sessions.py --split` itself fails (missing script, bad date, no projects dir), fall
back to `fetch-claude-sessions-day.md`'s procedure for this one run rather than dropping the
source entirely.
