---
name: todo
description: Slash-command todo list. Run /todo to list open items, /todo <text> to add one, /todo done <id> to complete one, /todo setup to configure project mappings and backends, /todo status to see what's configured. Stores todos in one flat markdown file and routes each new one to a backend (a local line, or a connected system like GitHub Issues) based on which project/repo it belongs to, then merges everything back together when listing — a hybrid local + ticket-system todo list.
summary: "/todo | /todo <text> | /todo done <id> | /todo setup — hybrid local + GitHub Issues todo list, routed by project."
owner: "@jarellano01"
status: development
notes: GitHub Issues backend only for now. Jira/Linear can be added later as a new file in todo-instructions.examples/, same shape as github-issues.md.
argument-hint: "[text to add] | list [project|all] | done <id> | setup | status | help"
disable-model-invocation: true
---

# todo

A quick, frictionless place to put a task, that also knows when a task deserves a real ticket.
Everything lives in one flat markdown file, grouped into `## Pending`, `## In Progress`, and
`## Done`. Most todos just live there. When a todo belongs to a project whose mapping says
otherwise, `/todo add` creates it in that project's backend (currently: a GitHub issue) and
still writes a line in the same flat file — with that issue's id and link — so `/todo list`
always shows one merged list regardless of where each item actually lives, and its state is
re-checked against the backend every time you list.

This skill only runs when you invoke it. All state lives in one **data home**,
`~/.local/share/todo/` (override with `$TODO_DATA_HOME`), regardless of which project you have
open. The skill folder itself holds only code and templates.

The flat file itself defaults to `~/.claude/todos.md` — the same path
[`time-logger`](../time-logger/SKILL.md)'s dashboard reads as `dashboard.todos_file`. If you
also use `time-logger`, todos created here show up on its Overview tab with PR/time-entry
evidence automatically, no extra config. Change `todos_file` in `capabilities.yml` if you'd
rather keep them separate. This skill has no dependency on `time-logger` or its dashboard —
the format below is `/todo`'s own, and `time-logger`'s renderer is written to adapt to it (a
plain `#tag` is enough for it to group by; nothing here exists to satisfy its parser).

## Usage

```
/todo                     list open + in-progress todos for the project you're in (or
                           everything, if you're not inside a mapped project)
/todo <text>               add a todo — auto-routed to a backend by project mapping;
                           flags: --project <name>, --backend local|github, --in-progress
/todo done <id>            mark a todo complete; closes the backend ticket too, after confirming
/todo list [project|all]   list todos; defaults to the auto-detected project, `all`
                           overrides that to show everything regardless of cwd
/todo setup                discover your projects/repos, configure backends, write config
/todo status               what's configured, what backends are enabled, file location
```

`<id>` is whatever `/todo list` prints next to the item: `t042` for a local todo,
`gh:owner/repo#123` for a GitHub-backed one.

## Bootstrap (runs automatically on every invocation)

!`for c in "$HOME/.claude/skills/todo" ".claude/skills/todo" "skills/todo" "."; do if [ -f "$c/scripts/bootstrap.sh" ] && grep -q '^name: todo$' "$c/SKILL.md" 2>/dev/null; then bash "$c/scripts/bootstrap.sh" "$(cd "$c" && pwd -P)"; exit 0; fi; done; echo "skill_dir: NOT FOUND — see Troubleshooting"`

The block above resolves the data home, creates it if missing, and seeds `capabilities.yml` /
`user-preferences.md` from this skill's examples the first time it runs. Read its output before
dispatching: use its `data_home:` and `todos_file:` values wherever this file says `<data
home>` or `<todos file>`. If it reports `capabilities.yml: missing`, tell the user to run
`/todo setup` first, unless the subcommand is `setup` itself.

## Dispatch

The subcommand is `$0`; everything else is `$1..` (`$ARGUMENTS` for the full string).

| `$0` | Do |
|---|---|
| *(empty)* | Run **List** below with no explicit filter (`$1` unset) — step 1 of List still auto-detects the project from cwd. |
| `help` | Print the Usage block and stop. |
| `setup` | Follow **Setup** below. |
| `list` | Run **List** below; `$1`, if present, is an explicit project filter that overrides auto-detection. |
| `done` | Run **Done** below; `$1` is the id. |
| `status` | Run **Status** below. |
| anything else | Treat the full argument string as the todo text and run **Add** below. Pull `--project <name>`, `--backend local\|github`, and `--in-progress` out of the string first — they're flags, not part of the text. |

## The flat file format

`/todo` owns this file and this grammar; it doesn't defer to any other tool's conventions.
`time-logger`'s dashboard is one possible *reader* of it (see the note at the top of this file)
and is responsible for adapting to whatever it finds here — not the other way around.

```
## Pending
- [ ] Fix login bug on mobile #kronos (id: t042) (created: 2026-09-11)
- [ ] Add Consultant/Category filters to Entry Review #bgc (id: gh:360-Building-Group-Consulting-Inc/cmp-mono#796) https://github.com/.../pull/796

## In Progress
- [ ] Late entry credit ledger for payouts #bgc (id: gh:.../cmp-mono#799) https://github.com/.../pull/799

## Done
- [x] Update onboarding doc #snowpack (id: t038) (created: 2026-09-01) (done: 2026-09-10)
```

- `## Pending` / `## In Progress` / `## Done` are the only states `/todo` writes; a section
  header is otherwise free text and anything not literally `Done` counts as open. No `###`
  grouping heading is required — a plain `#<project>` tag is enough for anything that reads
  this file to group by, `time-logger`'s dashboard included.
- `#<project>` is the free-form tag that ties a line to a Projects entry in
  `user-preferences.md`; a todo with no matching project is tagged `#unfiled` instead of
  silently going untagged.
- `(id: t###)` — a local todo, `t` + an incrementing number (highest existing `t###` in the
  file, plus one). `(id: gh:owner/repo#N)` — a GitHub issue. A future Jira todo would use the
  bracket ticket form `[PROJ-123]` that `time-logger` already recognizes as a ticket kind —
  don't reuse the bracket form for anything else.
- A plain `https://` link after the id is the backend's canonical URL — that's what makes it
  clickable and, for a GitHub pull/issue link, what lets `time-logger`'s evidence engine match
  it to a PR.

## Add

1. Resolve the **project**: `--project <name>` if given; else match the current working
   directory's repo (name or `git remote get-url origin`) against the `matches:` patterns in
   the Projects section of `user-preferences.md`; else `unfiled`.
2. Resolve the **backend**: `--backend` if given; else the resolved project's `backend:`
   field; else `local`. `unfiled` always means `local`.
3. Read the **configured** instructions for that backend: `local` always works with no file
   (see **Local writes** below); any other backend's instructions live at `<data
   home>/todo-instructions/<backend>.md`, copied there by `/todo setup`. If the file is
   missing, fall back to `local` and say why.
4. Follow that file's **Create** section. It decides what to check first (e.g. `gh auth
   status`), always shows what it's about to create and asks for explicit confirmation before
   any action visible outside this machine (creating a GitHub issue is exactly that — never
   skip the confirmation), and returns the id + url to write into the flat file line.
5. Append the line under `## In Progress` if `--in-progress` was passed, else `## Pending`,
   tagged `#<project>` (or `#unfiled`) — create the state heading if it doesn't exist yet.

**Local writes** (`backend: local`, and `unfiled`): no instructions file needed — just append
the line, tagged `#<project>` or `#unfiled`, with a fresh `t###` id and `(created: <date>)`.

## List

1. Determine scope: `$1` (a project name) if given, else the project auto-detected from cwd
   (same matching as **Add**, step 1), else no filter — show everything. `$1` of `all`
   explicitly overrides auto-detection to show everything, even from inside a mapped project.
2. **Discover** (only when scope resolved to one specific project in step 1 — never for `all`
   or no-match): if that project's backend has a **Discover** section in its instructions file,
   follow it to find items that exist in the backend but aren't in the flat file yet (e.g. a
   GitHub issue filed straight on GitHub, never through `/todo add`). For each one not already
   present under any `(id: ...)` tag anywhere in the file (open or Done — don't reimport
   something already closed out), append a line under `## Pending`, tagged `#<project>`, with
   `(created: <today>)` — same shape as **Add**.
3. Read `<todos file>` and parse every line under a state that isn't literally `Done`.
4. For every line whose id is backend-tracked (not a bare `t###`), **live-check** its current
   status by following that backend's instructions file, **List** section (e.g. `gh issue view
   <owner/repo> <n> --json state,title,url` for GitHub) — this is what keeps the list honest
   without you having to run `/todo done` by hand. If a backend item comes back closed/done,
   move its line to `## Done` with `(done: <today>)` before printing the list, and note it as
   "auto-closed — done in <backend>" in the output.
5. Print open items grouped by state (Pending, then In Progress), each with its id, project
   tag, and link if any — marking any line step 2 just imported as "new" so it's obvious it
   wasn't there before this run. If a project filter was given and nothing matches, say so
   plainly — don't fall back to showing everything.

## Done

1. Find the line by `<id>` (exact match on the `(id: ...)` tag) anywhere under `## Pending` or
   `## In Progress`. Not found → say so and stop.
2. If it's backend-tracked, follow that backend's instructions file, **Complete** section —
   this shows what will happen (e.g. "close cmp-mono#796") and asks for explicit confirmation
   before it happens, same rule as **Add**.
3. Move the line to `## Done`, flip `[ ]` to `[x]`, append `(done: <today>)`.

## Setup

1. Ask (or infer, if the bootstrap output shows `capabilities.yml: missing` is the only issue)
   where the user's project/repo folders live — a common shape is one folder per client/org,
   each holding several git repos (e.g. `~/clients/<name>/<repo>`); default to offering
   `~/clients` if it exists, otherwise ask.
2. For each subfolder that's a git repo (`git -C <dir> remote get-url origin`), derive
   `owner/repo` from the remote URL (strip `git@github.com:`/`https://github.com/` and
   `.git`). Group by the top-level folder name — that's a candidate project.
3. Check `gh auth status`. If it succeeds, `github_issues` can be enabled; note the logged-in
   username.
4. Show the discovered project → repo table and ask the user to confirm or correct it, and for
   each project whether new todos there should go to `local` or `github` (only offer `github`
   for projects with exactly one repo, or ask which repo when a project has several) — this
   writes real routing behavior, so don't guess silently.
5. Write `<data home>/capabilities.yml` (backend toggles) and the `## Projects` section of
   `<data home>/user-preferences.md` (one line per project: name, backend, repo if any,
   `matches:` patterns). Copy `github-issues.md` from `<skill_dir>/todo-instructions.examples/`
   to `<data home>/todo-instructions/github.md` if the backend is enabled.
6. Confirm the `todos_file` path (default `~/.claude/todos.md`); mention the `time-logger`
   interop note above if that skill is also installed.

## Status

Report, compactly: `data_home`, `todos_file` path and whether it exists, enabled backends,
the Projects table, and counts of Pending / In Progress / Done lines in the flat file.

## Troubleshooting

- **`skill_dir: NOT FOUND`** — the bootstrap couldn't find the skill's own files. Expected at
  `~/.claude/skills/todo` (npx install) or `.claude/skills/todo` (project install); if you
  cloned the repo, run from the repo root so `skills/todo` resolves.
- **`capabilities.yml: missing`** — run `/todo setup`.
- **Add says a backend's instructions file is missing** — `/todo setup` didn't finish, or the
  file was deleted from `<data home>/todo-instructions/`. Re-run setup, or copy the template
  from `<skill_dir>/todo-instructions.examples/` by hand.
- **GitHub backend stops on "connector not available"** — `gh auth status` failed on this
  machine; run `gh auth login`, or switch that project to `backend: local` in
  `user-preferences.md`.
- **A GitHub-backed todo never auto-closes** — `/todo list` only re-checks items currently in
  the flat file; if `gh` itself is failing, `list` says so per item rather than guessing.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill todo
```

Then run `/todo setup` from any project. No other install step.
