# Todo instructions — GitHub Issues (gh CLI)

Read by `/todo add`, `/todo list`, and `/todo done` for any project mapped to `backend:
github`. Creates and closes real GitHub issues in that project's repo through the `gh` CLI —
these are visible to everyone with access to the repo, so Create and Complete always confirm
first.

## Prerequisites

Run `gh auth status`. If it fails, say the `gh` CLI isn't authenticated on this machine (`gh
auth login`), fall back that project's todo to `local` for this run, and note it — don't block
the whole command on one project's missing auth.

## Mapping

Each project's repo (`owner/repo`) comes from its Projects entry in `user-preferences.md` (the
`repo:` field, written by `/todo setup`). If a project maps to `backend: github` with no `repo:`
recorded, ask once which repo, then append it to that project's line under Remember.

## Create

Show the user the exact title and target repo, e.g. `Create issue in acme/widgets: "Fix login
bug on mobile"?`, and wait for explicit yes. On confirmation:

```bash
gh issue create --repo <owner/repo> --title "<text>" --body ""
```

`gh` prints the created issue's URL — parse the trailing number as `<n>`. Return id
`gh:<owner/repo>#<n>` and that URL for the new item.

## List

For one id `gh:<owner/repo>#<n>`:

```bash
gh issue view <n> --repo <owner/repo> --json state,title,url
```

`state` is `OPEN` or `CLOSED`. Report `CLOSED` as done (this is what lets `/todo list` self-heal
an item the user closed directly on GitHub instead of through `/todo done`); report the current
`title` in case it changed. If the call errors (deleted issue, no access), report that plainly
rather than guessing a state.

## Discover

Read-only — finds issues that exist in this repo but aren't in the file yet, so `/todo
list` can import them. "Yours" means assigned to you **or** authored by you; `gh` can't OR
those in one call, so run both and merge by issue number:

```bash
gh issue list --repo <owner/repo> --state open --assignee @me --json number,title,url
gh issue list --repo <owner/repo> --state open --author @me --json number,title,url
```

Union the two result sets on `number` (an issue matching both counts once). Return each as
`{id: gh:<owner/repo>#<number>, title, url}` for `/todo list` to compare against what's already
tracked. Never write anything here — importing the item is `/todo list`'s job, not this file's.

## Complete

Show the user exactly what will close, e.g. `Close acme/widgets#123 ("Fix login bug on
mobile")?`, and wait for explicit yes. On confirmation:

```bash
gh issue close <n> --repo <owner/repo>
```

## Remember

If this run learned a new project → repo mapping, or corrected one, append it to that
project's line in the Projects section of `user-preferences.md` (`repo:` field) so the next
run doesn't ask again.
