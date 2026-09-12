---
name: todo
description: Slash-command todo list. Run /todo to list open items, /todo <text> to add one, /todo done <id> to complete one, /todo setup to configure project mappings and backends, /todo migrate to convert an old v1 (markdown) file, /todo status to see what's configured. Stores todos in one YAML file and routes each new one to a backend (a local record, or a connected system like GitHub Issues or Jira) based on which project/repo it belongs to, then merges everything back together when listing — a hybrid local + ticket-system todo list.
summary: "/todo | /todo <text> | /todo done <id> | /todo setup — hybrid local + GitHub Issues/Jira todo list, routed by project."
owner: "@jarellano01"
status: development
notes: "v2: YAML store, no dual-format support — see CHANGELOG.md. GitHub Issues and Jira backends ship; Linear can be added later as a new file in todo-instructions.examples/."
argument-hint: "[text to add] | list [project|all] | done <id> | setup | migrate | status | help"
disable-model-invocation: true
---

# todo

A quick, frictionless place to put a task, that also knows when a task deserves a real ticket.
Everything lives in one YAML file, as a flat list of items each carrying its own `state`
(`pending` / `in_progress` / `done`). Most todos just live there. When a todo belongs to a
project whose mapping says otherwise, `/todo add` creates it in that project's backend (a
GitHub issue or Jira issue) and still writes a record in the same file — with that issue's id
and link — so `/todo list` always shows one merged list regardless of where each item actually
lives, and its state is re-checked against the backend every time you list.

This skill only runs when you invoke it. All state lives in one **data home**,
`~/.local/share/todo/` (override with `$TODO_DATA_HOME`), regardless of which project you have
open. The skill folder itself holds only code and templates.

The file itself defaults to `~/.claude/todos.yaml` — the same path
[`time-logger`](../time-logger/SKILL.md)'s dashboard reads as `dashboard.todos_file`. If you
also use `time-logger`, todos created here show up on its Overview tab with PR/time-entry
evidence automatically, no extra config. Change `todos_file` in `capabilities.yml` if you'd
rather keep them separate. This skill has no dependency on `time-logger` or its dashboard —
the schema below is `/todo`'s own, and `time-logger`'s renderer (and its feedback-apply flow,
which edits items deterministically by `id` — see its `update-todo.mjs`) are written to read
and write it.

**v2 note:** this file was markdown through v1; v2 is YAML with no dual-format support. If
`todos_file` still holds a v1 markdown checklist, run `/todo migrate` first — see **Migrate**
below and `CHANGELOG.md`.

## Usage

```
/todo                     list open + in-progress todos for the project you're in (or
                           everything, if you're not inside a mapped project)
/todo <text>               add a todo — auto-routed to a backend by project mapping;
                           flags: --project <name>, --backend local|github|jira, --in-progress
/todo done <id>            mark a todo complete; closes the backend ticket too, after confirming
/todo list [project|all]   list todos; defaults to the auto-detected project, `all`
                           overrides that to show everything regardless of cwd
/todo setup                discover your projects/repos, configure backends, write config
/todo migrate              convert an existing v1 (markdown) file to the v2 YAML schema
/todo status               what's configured, what backends are enabled, file location
```

`<id>` is whatever `/todo list` prints next to the item: `t042` for a local todo,
`gh:owner/repo#123` for a GitHub-backed one, `jira:PROJ-123` for a Jira-backed one.

## Bootstrap (runs automatically on every invocation)

!`for c in "$HOME/.claude/skills/todo" ".claude/skills/todo" "skills/todo" "."; do if [ -f "$c/scripts/bootstrap.sh" ] && grep -q '^name: todo$' "$c/SKILL.md" 2>/dev/null; then bash "$c/scripts/bootstrap.sh" "$(cd "$c" && pwd -P)"; exit 0; fi; done; echo "skill_dir: NOT FOUND — see Troubleshooting"`

The block above resolves the data home, creates it if missing, and seeds `capabilities.yml` /
`user-preferences.md` from this skill's examples the first time it runs. Read its output before
dispatching: use its `data_home:` and `todos_file:` values wherever this file says `<data
home>` or `<todos file>`. If it reports `capabilities.yml: missing`, tell the user to run
`/todo setup` first, unless the subcommand is `setup` itself. If it reports `todos_file: v1
format detected`, tell the user to run `/todo migrate` first, unless the subcommand is `migrate`
itself.

## Dispatch

The subcommand is `$0`; everything else is `$1..` (`$ARGUMENTS` for the full string).

| `$0` | Do |
|---|---|
| *(empty)* | Run **List** below with no explicit filter (`$1` unset) — step 1 of List still auto-detects the project from cwd. |
| `help` | Print the Usage block and stop. |
| `setup` | Follow **Setup** below. |
| `migrate` | Follow **Migrate** below. |
| `list` | Run **List** below; `$1`, if present, is an explicit project filter that overrides auto-detection. |
| `done` | Run **Done** below; `$1` is the id. |
| `status` | Run **Status** below. |
| anything else | Treat the full argument string as the todo text and run **Add** below. Pull `--project <name>`, `--backend local\|github\|jira`, and `--in-progress` out of the string first — they're flags, not part of the text. |

## The file format

`/todo` owns this file and this schema; it doesn't defer to any other tool's conventions.
`time-logger` is one possible *reader and writer* of it (see the note at the top of this file)
and is responsible for adapting to whatever it finds here — not the other way around.

```yaml
todos:
  - id: t042
    project: kronos
    text: 'Fix login bug on mobile'
    state: pending
    backend: local
    url: null
    group: null
    priority: null
    created: '2026-09-11'
    done: null
    notes: []
  - id: gh:360-Building-Group-Consulting-Inc/cmp-mono#796
    project: bgc
    text: 'Add Consultant/Category filters to Entry Review'
    state: pending
    backend: github
    url: https://github.com/360-Building-Group-Consulting-Inc/cmp-mono/pull/796
    group: null
    priority: null
    created: '2026-09-05'
    done: null
    notes: []
  - id: t038
    project: snowpack
    text: 'Update onboarding doc'
    state: done
    backend: local
    url: null
    group: null
    priority: null
    created: '2026-09-01'
    done: '2026-09-10'
    notes: []
```

- `state` is the only place "done" lives — `pending`, `in_progress`, or `done`, always one of
  those three. There is no section-header classification to get wrong.
- `project` is the free-form tag that ties an item to a Projects entry in
  `user-preferences.md`; a todo with no matching project is tagged `unfiled` instead of
  silently going untagged.
- `id` — a local todo is `t` + an incrementing number (highest existing `t###` in the file,
  plus one). A backend-tracked one is `<backend>:<identifier>` — `gh:owner/repo#N` for GitHub,
  `jira:PROJ-123` for Jira. Every backend instructions file returns ids in this shape; don't
  invent another.
- `url` is the backend's canonical link, or `null` for a local todo — what makes an item
  clickable and, for a GitHub pull/issue link, what lets `time-logger`'s evidence engine match
  it to a PR.
- `group`, `priority`, and `notes` exist for `time-logger`'s dashboard (grouping override,
  priority chip, and appended status/history notes from feedback comments) — `/todo` itself
  only ever writes `group: null`, `priority: null`, `notes: []` on **Add**; it doesn't read or
  set them again afterward. Something else (a person, or `time-logger`'s feedback-apply flow)
  may set them later; `/todo list`/`/todo done` must preserve whatever it finds in those three
  fields untouched unless the operation being performed is specifically about one of them.

Keep the key order and indentation shown above when writing — a small restricted-YAML parser
(not a general YAML library) is what `time-logger` uses to read this file in code, and it
expects this exact shape. See `CHANGELOG.md` for why the schema looks like this.

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
   skip the confirmation), and returns the id + url to write into the new item.
5. Append a new item to `todos:` — `state: pending` (or `in_progress` if `--in-progress` was
   passed), `project` from step 1, `backend` from step 2, `id`/`url` from step 4 (or a fresh
   `t###` + `url: null` for local), `created` today, `group: null`, `priority: null`,
   `notes: []`.

**Local writes** (`backend: local`, and `unfiled`): no instructions file needed — just append
the item with a fresh `t###` id and `url: null`.

## List

1. Determine scope: `$1` (a project name) if given, else the project auto-detected from cwd
   (same matching as **Add**, step 1), else no filter — show everything. `$1` of `all`
   explicitly overrides auto-detection to show everything, even from inside a mapped project.
2. **Discover** (only when scope resolved to one specific project in step 1 — never for `all`
   or no-match): if that project's backend has a **Discover** section in its instructions file,
   follow it to find items that exist in the backend but aren't in the file yet (e.g. a
   GitHub issue filed straight on GitHub, never through `/todo add`). For each one not already
   present under any `id` anywhere in the file (open or done — don't reimport something
   already closed out), append a new item — same shape as **Add**, `created` today.
3. Read `<todos file>` and collect every item whose `state` isn't `done`.
4. For every item whose `id` is backend-tracked (not a bare `t###`), **live-check** its current
   status by following that backend's instructions file, **List** section (e.g. `gh issue view
   <owner/repo> <n> --json state,title,url` for GitHub) — this is what keeps the list honest
   without you having to run `/todo done` by hand. If a backend item comes back closed/done, set
   its `state: done` and `done: <today>` before printing the list, and note it as "auto-closed —
   done in <backend>" in the output.
5. Print open items grouped by state (Pending, then In Progress), each with its id, project,
   and link if any — marking any item step 2 just imported as "new" so it's obvious it wasn't
   there before this run. If a project filter was given and nothing matches, say so plainly —
   don't fall back to showing everything.

## Done

1. Find the item by `<id>` (exact match on `id`) with `state` not already `done`. Not found →
   say so and stop.
2. If it's backend-tracked, follow that backend's instructions file, **Complete** section —
   this shows what will happen (e.g. "close cmp-mono#796") and asks for explicit confirmation
   before it happens, same rule as **Add**.
3. Set `state: done`, `done: <today>`.

## Migrate

One-time conversion of an existing v1 (markdown) file to the v2 YAML schema. See
`CHANGELOG.md` for why this exists. Idempotent to run twice on an already-v2 file — it's a
no-op if `<todos file>` already parses as v2 YAML.

1. If `<todos file>` doesn't exist, or already parses as the v2 schema (a `todos:` key at the
   top), say there's nothing to migrate and stop.
2. **Back up**: copy `<todos file>` to `<todos file>.v1.bak-<today>` before changing anything.
3. **Convert each checklist line** (v1's grammar: `## Pending` / `## In Progress` / `## Done`
   sections, `- [ ]`/`- [x]` lines, a trailing `#tag`, `(id: ...)`, `(created: ...)`,
   `(done: ...)`, and an optional URL — anything not literally `## Done` counted as open):
   - `state` — from the section (`## Done` → `done`, `## In Progress` → `in_progress`, else
     `pending`), from the checkbox (`[x]` → `done` regardless of section, `[ ]` → keep the
     section's state).
   - `id` — a bare `(id: t###)` stays as-is. `(id: gh:owner/repo#N)` stays as-is. A v1 Jira
     bracket id `[PROJ-123]` becomes `jira:PROJ-123` (drop the brackets, add the `jira:`
     prefix) — this is the one id-shape change; see `CHANGELOG.md`.
   - `project` — the trailing `#tag`.
   - `url` — the trailing `https://` link if present, else `null`.
   - `created` / `done` — from `(created: ...)` / `(done: ...)`, quoted strings.
   - `backend` — infer from the id shape: `t###` → `local`, `gh:...` → `github`, `jira:...` →
     `jira`.
   - `group: null`, `priority: null`, `notes: []` for every migrated item — v1 had no
     equivalent fields to carry over.
4. **Preview** the converted file (or a diff against the backup) and confirm before writing.
5. Write `<todos file>` in the v2 schema. Mention the backup path in the confirmation.

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
4. Check whether an Atlassian MCP connector is available (look for a loaded or ToolSearch-able
   Jira create/list/transition tool). If one is, ask whether the user wants a `jira` backend and,
   if so, its `site` / `cloud_id` (from the connector) and a default `issue_type`; `jira` can be
   enabled with no repo-discovery step since it isn't tied to a git remote.
5. Show the discovered project → repo table and ask the user to confirm or correct it, and for
   each project whether new todos there should go to `local`, `github`, or (if enabled) `jira` —
   only offer `github` for projects with exactly one repo, or ask which repo when a project has
   several; for `jira`, ask the project's `project_key` and, optionally, `epic`/`label` — this
   writes real routing behavior, so don't guess silently.
6. Write `<data home>/capabilities.yml` (backend toggles) and the `## Projects` section of
   `<data home>/user-preferences.md` (one line per project: name, backend, repo/project_key/
   epic/label as applicable, `matches:` patterns). Copy `github-issues.md` and/or `jira.md` from
   `<skill_dir>/todo-instructions.examples/` to `<data home>/todo-instructions/` for each backend
   enabled.
7. Confirm the `todos_file` path (default `~/.claude/todos.yaml`); mention the `time-logger`
   interop note above if that skill is also installed. If a file already exists there and isn't
   v2 YAML, point at `/todo migrate` instead of writing over it.

## Status

Report, compactly: `data_home`, `todos_file` path and whether it exists, enabled backends,
the Projects table, and counts of pending / in-progress / done items in the file.

## Troubleshooting

- **`skill_dir: NOT FOUND`** — the bootstrap couldn't find the skill's own files. Expected at
  `~/.claude/skills/todo` (npx install) or `.claude/skills/todo` (project install); if you
  cloned the repo, run from the repo root so `skills/todo` resolves.
- **`capabilities.yml: missing`** — run `/todo setup`.
- **`todos_file` is still v1 markdown** — run `/todo migrate` before anything else; every other
  command assumes v2 YAML and will misread a v1 file.
- **Add says a backend's instructions file is missing** — `/todo setup` didn't finish, or the
  file was deleted from `<data home>/todo-instructions/`. Re-run setup, or copy the template
  from `<skill_dir>/todo-instructions.examples/` by hand.
- **GitHub backend stops on "connector not available"** — `gh auth status` failed on this
  machine; run `gh auth login`, or switch that project to `backend: local` in
  `user-preferences.md`.
- **Jira backend stops on "connector not available"** — no Atlassian MCP connector is
  configured on this machine; connect one, or switch that project to `backend: local` in
  `user-preferences.md`.
- **A GitHub- or Jira-backed todo never auto-closes** — `/todo list` only re-checks items
  currently in the file; if the connector itself is failing, `list` says so per item rather
  than guessing.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill todo
```

Then run `/todo setup` from any project. No other install step.
