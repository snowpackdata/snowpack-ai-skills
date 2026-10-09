# Fetching coding-agent session activity (fan-out)

Covers both **Claude Code** and **Codex** transcripts. They feed one unified stream,
`raw/claude/<date>.md` (the folder name is historical; it holds every coding-agent session).
Run this when `integrations.claude_sessions` **or** `integrations.codex_sessions` is enabled in
`capabilities.yml`. The scanner reads those toggles itself, so there's nothing to pass. If both
are disabled, write `raw/claude/<date>.md` containing `Coding-agent sessions disabled in
capabilities.yml — skipping.` and stop.

This replaces spawning a single `fetch-claude-sessions-day` agent. Follow it directly in the
current context; do NOT delegate it to a subagent. It fans out one summarizer per session
itself, and a subagent can't spawn further subagents, so the fan-out only works from a context
(an interactive session, or the top-level headless invocation) that can dispatch subagents.

**Host differences.** In Claude Code, dispatch `summarize-claude-session` via the Agent tool. In
Codex, or any host without named subagents, either use that host's own parallel-worker
mechanism with the same prompt, or summarize each `excerpt_file` yourself, sequentially,
following [`summarize-claude-session.md`](../.claude/agents/summarize-claude-session.md)'s
rules. Every other step is a script call and runs the same in either host.

1. **Discovery + extraction + dedup** (deterministic, no LLM):
   ```bash
   python3 <data home>/scripts/scan_sessions.py <date> --split <scratch dir>
   ```
   Use a scratch dir unique to this run (e.g. `/tmp/time-logger-sessions-<date>-$$`). This
   writes `manifest.json` plus one `session_NNN.txt` excerpt file per session where
   `cached: false`. Each manifest session has `file`, `provider` (`claude`|`codex`), `source`
   (display label), `repo`, `turns`, `first`, `last`, `last_iso`, `cache_key`, `digest`, and
   `cached`. A cached session also has its `effort`/`summary`; a session that continues an
   imported or forked history has `provenance`, and one with ambiguous overlap has
   `unresolved_messages`. The manifest's top level also has `stale_blocks` (step 4) and
   `unresolved` (step 7).

   The scanner already did the hard part. It dropped imported history that a Codex session
   copied from a Claude session (or a fork or archive copy from its original), so a shared
   prefix appears exactly once and a continuation keeps only its new turns. It also excluded
   automation and worker transcripts. Don't second-guess either: every `sessions` entry is
   distinct activity.

2. **Summarize every `cached: false` session.** In Claude Code, dispatch
   `summarize-claude-session` **in parallel, one call per session, in a single message**, and
   give it the session's `excerpt_file`, `turns`, and `provider`. A `cached: true` session needs
   nothing; its `effort`/`summary` are in the manifest.

   **The dispatch prompt's very first characters must be the literal tag
   `<time-logger-fanout-worker>`** (e.g. `<time-logger-fanout-worker> Read the file ...`).
   Each dispatched worker leaves its own transcript, in Claude Code or in Codex, and the scanner
   filters any transcript whose first user message starts with this tag. Skipping the tag puts
   those workers into future days' data.

3. **Assemble one block per session**, in manifest order (first-activity ascending):
   ```
   ## Session: [repo]
   **Source**: [source]
   **File**: [file]
   **Turns on this date**: [turns]
   **First activity**: [first]
   **Last activity**: [last]
   **Effort**: [effort]

   [2-4 sentence summary]

   ---
   ```
   If the session has `provenance.continues_from`, add `**Continues**: imported/forked history
   counted under another session; this block covers only new turns` after `**File**:`. If it
   has `unresolved_messages`, add `**Unresolved overlap**: N message(s) may duplicate another
   session — see scan report` so the time-entry generator can discount it.

4. **Apply all changes to `raw/claude/<date>.md` in one pass** via `apply_session_blocks.py`
   (see that script's usage comment for the operations-JSON shape):
   - `cached: false` sessions: use `replace` if the `**File**:` path is already in the file,
     otherwise `insert_after`/`append`. A `cached: true` session's block is already correct, so
     it gets no operation.
   - **Every `stale_blocks` entry: one `remove` operation** (`anchor_file` = its `file`). These
     blocks would otherwise keep counting: the provider was turned off, the file turned out to
     be a duplicate of another session, or it has no retained activity left for the date.
   - Set `header` (`# Coding Agent Sessions — [Weekday], [Month Day], [Year]`) so the script
     can create the file.

5. **Record the cache in one deterministic write.** Write the fresh summaries as
   `{"<cache_key>": {"effort": "...", "summary": "..."}}` to a scratch JSON file, then:
   ```bash
   python3 <data home>/scripts/scan_sessions.py <date> --record-cache <scratch dir>/manifest.json <summaries.json>
   ```
   The script copies digests and cached summaries straight from the manifest and drops entries
   for sessions no longer present. Don't hand-write the cache file.

6. **Clean up** the scratch dir from step 1.

7. **Report**: `Found N sessions for <date> (X unchanged from cache, Y re-summarized, Z
   automation-filtered, D duplicate messages dropped)`, then one line per session with its
   source/repo/turns/effort. If `unresolved` is non-empty, add one line: `U unresolved
   overlap(s) kept — run scan_sessions.py <date> --report to inspect`.

If `scan_sessions.py --split` itself fails (missing script, bad date), fall back to
`fetch-claude-sessions-day.md`'s procedure for this one run rather than dropping the source.
