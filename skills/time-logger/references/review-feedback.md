# /time-logger feedback

Applies comments the user left in the Morning Dashboard UI back to their sources of truth
(markdown for time entries and PRs, YAML for todos), then re-renders the store. Paths are
relative to the data home (`~/.local/share/time-logger/`, or `$TIME_LOGGER_DATA_HOME`).

Drains `dashboard/feedback/pending.json`. Three item types:
- `type: "time_entry_comment"` — `{ id, date, heading, comment, submitted_at }` where
  `heading` matches a `### ` block in `time_logs/time_entries_YYYYMMDD.md`.
- `type: "pr_comment"` — `{ id, pr, url, title, comment, submitted_at }` where `pr` is
  `owner/repo#number`.
- `type: "todo_comment"` — `{ id, todo_key, group, ticket, text, comment, submitted_at }` where
  `todo_key` is that item's `id` field in `dashboard.todos_file` (from `capabilities.yml`) —
  the same id `/todo done <id>` uses — and `group`/`ticket`/`text` are its `group` (or
  `project`, if `group` is unset), `id` again if `backend: jira`, and `text` at the time the
  comment was left, for display only.

## Steps

The dashboard's **Apply comments** button runs these steps headlessly via
`dashboard/scripts/feedback-run.sh` for `time_entry_comment` and `todo_comment` items only, with
no outward-facing tools; `pr_comment` items always wait for an interactive run.

1. Read `pending.json`. If empty, say so and stop.

2. **Time-entry comments**: open the matching time-entry file and apply the comment to the
   markdown:
   - Rewording / correction of what happened → rewrite the block body.
   - Hours change → update the block's `(Xh)` and the file's `**Hours**` header (and the
     block's time range if the comment implies a different start).
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

   **Re-snap after editing.** This flow can rewrite start times (directly, or indirectly via a
   split), so once all `time_entry_comment` edits for a given date are applied, run the same
   mechanical snapping pass `dash-refresh.md`'s Draft step uses — don't rely on getting the
   15-minute snap right by hand:
   ```bash
   python3 <data home>/scripts/snap_entry_times.py <data home>/time_logs/time_entries_YYYYMMDD.md
   ```
   (Idempotent — run it once per distinct date touched, after that date's edits are done.)

3. **PR comments**: interpret the note and act via the `gh` CLI (repo/number come from the
   `pr` field):
   - "close this" / "superseded" / "abandon" → **confirm with the user first** (one batch
     confirmation is fine), then close via the API — NOT `gh pr close`, which fails silently
     when run outside a git repo: `gh api -X PATCH repos/<owner/repo>/pulls/<number> -f
     state=closed -q .state` (prints `closed` on success — treat any other output as failure).
   - "add to my todos" / "remind me" / "revisit later" → append a new item to the todos file
     (`state: pending`, `backend: local`, `url:` the PR link — see `../../todo/SKILL.md`'s file
     format), no GitHub action. If no todos file is configured, add it to the latest
     time-entry file's Open Items instead.
   - "comment on the PR: ..." / "reply to reviewer" → post it:
     `gh pr comment <number> -R <owner/repo> -b "<text>"`.
   - "rebase" / "un-draft" / "fix CI" / other code work → do NOT attempt it inside this
     flow; add it to todos and surface it in the report as work to schedule.
   - Anything ambiguous → leave the item unresolved in `pending.json` and ask.
   Closing a PR and posting a GitHub comment are outward-facing — never do either without
   the comment unambiguously asking for it, and never in headless mode.

4. **Todo comments** (only when `dashboard.todos_file` is configured): apply the change with
   `<data home>/scripts/update-todo.mjs <todos_file> <todo_key> ...` — a deterministic patch by
   `id`, not a hand-edit — rather than opening the YAML file yourself. The item may carry
   `evidence` — time entries, PRs, and Slack messages the renderer found citing the todo's id or
   link. It is a hint the user saw before commenting, never a reason to close anything on its
   own.
   - "mark done" / "this is done" / "done — close it" →
     `update-todo.mjs <todos_file> <todo_key> --state done`, plus `--note "done
     2026-09-09, PR snowpackdata/cronos#367 merged"` when `evidence` includes a merged PR or a
     logged time entry, so the proof travels with the item (the script sets `done` to today
     automatically). Never mark done an item the user didn't comment on, however strong its
     evidence.
   - "not done" / "still open" → `--note "<short status>"` only; no `--state` (leave it as-is).
   - Priority change ("bump to HIGH", "deprioritize") → `--priority high` / `--priority low` /
     `--priority none`.
   - "reword: ..." / status update → `--text "<new text>"` (the id, backend, and url are
     untouched — nothing to accidentally clobber, since they're separate fields).
   - "move to [group]" → `--group "<name>"`.
   - "delete" / "not doing this" → `update-todo.mjs <todos_file> <todo_key> --delete`.
   - "create a ticket for this" → outward-facing: confirm with the user first.
   Flags combine in one call (e.g. `--state done --note "..."`); `--note` may repeat.

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
