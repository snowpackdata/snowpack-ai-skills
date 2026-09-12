# todo

<!-- STATUS:START -->
> 🧪 **In Development** — works for the author; nobody else has tested it yet. Expect rough edges. Owner: @jarellano01. [What the statuses mean.](../../README.md#skill-status)
<!-- STATUS:END -->

A quick, frictionless todo list that also knows when a task deserves a real ticket. Everything
lives in one flat markdown file — most todos just go there, but a todo for a project you've
mapped to a backend (currently GitHub Issues) gets created there instead, and still shows up in
the same merged list. `/todo list` re-checks backend-tracked items live, so a todo closed
directly in GitHub shows as done here too, without you having to say so twice.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill todo
```

Then, from any project:

```
/todo setup
```

Setup discovers your project/repo folders, checks whether the `gh` CLI is authenticated, and
lets you confirm which projects should route new todos to GitHub Issues versus the local file.

## Usage

```
/todo                     list open + in-progress todos (scoped to the current project, if any)
/todo <text>               add one — auto-routed by project; --project, --backend, --in-progress
/todo done <id>            mark complete, closing the backend ticket too, after confirming
/todo list [project|all]   list todos; defaults to the auto-detected project, `all` shows everything
/todo setup                configure projects and backends
/todo status               what's configured, where the flat file lives, open/done counts
```

If you also use [`time-logger`](../time-logger/README.md), todos created here appear on its
Overview dashboard automatically — both skills default to the same flat file
(`~/.claude/todos.md`).

## Author

@jarellano01 — see the PR history for how this evolved.
