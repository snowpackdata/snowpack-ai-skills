# /time-logger feedback

Applies comments the user left in the Morning Dashboard UI back to the markdown sources of
truth, then re-renders the store. Paths are relative to the data home
(`~/.local/share/time-logger/`, or `$TIME_LOGGER_DATA_HOME`).

Drains `dashboard/feedback/pending.json`. Three item types:
- `type: "time_entry_comment"` — `{ id, date, heading, comment, submitted_at }` where
  `heading` matches a `### ` block in `time_logs/time_entries_YYYYMMDD.md`.
- `type: "pr_comment"` — `{ id, pr, url, title, comment, submitted_at }` where `pr` is
  `owner/repo#number`.
- `type: "todo_comment"` — `{ id, todo_key, group, ticket, text, comment, submitted_at }`
  where `group` is the `### ` section in the `dashboard.todos_file` from `capabilities.yml`
  and `ticket`/`text` identify the `- [ ]` line.

## Steps

The dashboard's **Apply comments** button runs these steps headlessly via
`dashboard/scripts/feedback-run.sh` for `time_entry_comment` and `todo_comment` items only, with
no outward-facing tools; `pr_comment` items always wait for an interactive run.

1. Read `pending.json`. If empty, say so and stop.

2. **Time-entry comments**: open the matching time-entry file and apply the comment to the
   markdown:
   - Rewording / correction of what happened → rewrite the block body.
   - Hours change → update the block's `(Xh)` and the file's `**Hours**` header
     (and time ranges if the comment implies them — keep 15-minute snapping).
   - "Split this" → break into separate blocks, one distinct scope each.
   - "Drop this" → remove the block and adjust the header totals.
   - Follow the standing time-entry style rules (outputs over intermediate errors, no
     time-logger tooling, no self-DMs).
   Where a comment is ambiguous, make the best-guess edit and flag it in the final report
   rather than skipping it. Also log any generalizable correction ("always skip X") to
   `user-preferences.md` per the generate agent's feedback loop.

   **Mark it reviewed once applied.** A dashboard checkbox on each entry lets the user mark it
   reviewed directly, but leaving a comment does *not* mark it reviewed on its own — only
   applying that comment does, since that's the point the loop actually closed. After editing
   the block, add `{"date": "YYYY-MM-DD", "heading": "<heading>"}` to the array in
   `dashboard/feedback/reviewed_entries.json` (create the file as `[]` first if it doesn't
   exist; merge, don't overwrite — read the current array, add the entry, write it back).
   Use the block's **final** heading after your edit (a reworded entry keeps its heading; a
   split adds one entry per resulting block; a dropped entry has nothing to mark — if it had a
   prior reviewed record, remove that entry from the array too, since the block it referred to
   no longer exists).

3. **PR comments**: interpret the note and act via the `gh` CLI (repo/number come from the
   `pr` field):
   - "close this" / "superseded" / "abandon" → **confirm with the user first** (one batch
     confirmation is fine), then close via the API — NOT `gh pr close`, which fails silently
     when run outside a git repo: `gh api -X PATCH repos/<owner/repo>/pulls/<number> -f
     state=closed -q .state` (prints `closed` on success — treat any other output as failure).
   - "add to my todos" / "remind me" / "revisit later" → add an item to the todos file
     (include the PR link), no GitHub action. If no todos file is configured, add it to the
     latest time-entry file's Open Items instead.
   - "comment on the PR: ..." / "reply to reviewer" → post it:
     `gh pr comment <number> -R <owner/repo> -b "<text>"`.
   - "rebase" / "un-draft" / "fix CI" / other code work → do NOT attempt it inside this
     flow; add it to todos and surface it in the report as work to schedule.
   - Anything ambiguous → leave the item unresolved in `pending.json` and ask.
   Closing a PR and posting a GitHub comment are outward-facing — never do either without
   the comment unambiguously asking for it, and never in headless mode.

4. **Todo comments** (only when `dashboard.todos_file` is configured): edit that file,
   finding the `- [ ]` line by `ticket` or the start of `text` within the `group` section.
   The item may carry `evidence` — time entries, PRs, and Slack messages the renderer found
   citing the todo's ticket or links. It is a hint the user saw before commenting, never a
   reason to close anything on its own.
   - "mark done" / "this is done" / "done — close it" → flip to `- [x]` and append a
     completion note with today's date, matching how existing completed items are written.
     If `evidence` includes a merged PR or a logged time entry, cite it in the note
     (`— done 2026-09-09, PR snowpackdata/cronos#367 merged`) so the proof travels with the
     item. Never flip an item the user didn't comment on, however strong its evidence.
   - "not done" / "still open" → leave it, add a short status note after the text.
   - Priority change ("bump to HIGH", "deprioritize") → add/adjust the `**(HIGH)**` /
     `**(LOW)**` marker.
   - "reword: ..." / status update → rewrite the line, preserving ticket ID and links.
   - "move to [group]" → relocate the line to that `### ` section (create it if named).
   - "delete" / "not doing this" → remove the line entirely.
   - "create a ticket for this" → outward-facing: confirm with the user first.

5. **Archive processed items by explicit ID**: re-read `pending.json` fresh at this step
   (the user may have added new comments in the UI while you worked — never archive by type
   or wholesale), append only the IDs you actually applied (with `resolved: true` and
   `resolved_at`) to `dashboard/feedback/archive.json` (create if missing), and remove only
   those IDs from `pending.json`. Unapplied and ambiguous items stay pending.

6. **Sync derived copies**: for each date whose time-entry file was edited, rebuild the
   combined file's `## Recommended Time Log Structure` section
   ([`combined-file.md`](./combined-file.md)). If the edits change
   hours or content the daily digest summarizes, re-run `summary daily digest` so today's
   `summaries/YYYY-MM-DD_daily-digest.md` reflects them.

7. **Re-render**: `node app/dashboard/scripts/render.mjs`. If any PR was closed, also run
   `node app/dashboard/scripts/fetch-github-prs.mjs` first so the panel reflects it.

8. If any edited date falls in the current week, offer to re-run `/time-logger standup`
   since its source data changed.

9. Report: one line per comment — what was asked, what was changed, and any best-guess
   interpretations to double-check.
