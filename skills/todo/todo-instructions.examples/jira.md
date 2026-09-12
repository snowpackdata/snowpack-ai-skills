# Todo instructions — Jira

Read by `/todo add` (Create), `/todo list` (List/Discover), and `/todo done` (Complete) for any
project mapped to `backend: jira`. Creates and resolves real Jira issues — visible to your whole
team, so Create and Complete always confirm first.

## Prerequisites

Requires an Atlassian MCP connector (tool names vary by installation and drift across versions —
don't hardcode one from memory). If the tools aren't already loaded, `ToolSearch` for them by
keyword (e.g. `"jira create issue"`, `"jira transition"`) before first use each session. If no
Atlassian connector is available at all (headless run, or none configured on this machine), say
so, fall back this todo to `local` for the run, and note why — don't block the whole command on
one project's missing connector.

## Mapping

Each project's Jira project key comes from its Projects entry in `user-preferences.md` (the
`project_key:` field, written by `/todo setup`). Two optional per-project fields refine where new
issues land:
- `epic:` — a parent epic key every new issue for that project is created under (omit for a flat
  project with no epic hierarchy).
- `label:` — one label applied to every issue for that project (useful if your team greps/filters
  Jira by label, or several unrelated work streams share one Jira project key and a label is what
  actually distinguishes them).

If a project maps to `backend: jira` with no `project_key:` recorded, ask once, then append it
under Remember. Connection details that don't vary per-project — site URL, cloud id, default
issue type, assignee — live in the `jira:` block of `capabilities.yml`; read them from there,
don't hardcode.

## Create

**1. Gather** (skip anything already known from context): a short, action-oriented title, and a
description from context — the core ask, relevant links (PRs, docs, Slack thread), key technical
details. Ask for missing info only if the description would be meaningless without it.

**2. Confirm** — show a preview and wait for explicit yes:
```
Creating Jira issue in <PROJECT_KEY>:
  Title:  <title>
  Epic:   <epic, if configured>
  Label:  <label, if configured>
  Desc:   <preview>
Proceed? (yes / edit)
```

**3. Create**, using the connector's issue-create tool:
- `projectKey` — from Mapping.
- `issueTypeName` — the default from `capabilities.yml`'s `jira:` block, unless the project needs
  a different one.
- `parent` — the project's `epic:`, if set.
- `summary` — `<title>`.
- `description` — markdown, `contentFormat: markdown`.
- Apply the project's `label:`, if set — immediately after creation via an edit call if the
  create call doesn't accept a `labels` field directly.

**4. Return** id `jira:<PROJECT_KEY>-<n>` (the uniform `<backend>:<opaque>` id grammar every
backend uses) and the browse URL (`<site>/browse/<PROJECT_KEY>-<n>`) for the new item.

## List

For one id `jira:<PROJECT_KEY>-<n>`, look up its current status (by key, or JQL `key =
<PROJECT_KEY>-<n>`) and read `status`/`statusCategory`. Report a `Done`-category status as done —
this is what lets `/todo list` self-heal an item resolved directly in Jira instead of through
`/todo done`. Report the current summary in case it changed. If the lookup errors, say so plainly
rather than guessing.

## Discover

Read-only — finds issues assigned to you in this project that aren't in the file yet:

```
project = <PROJECT_KEY> AND assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC
```

Return each as `{id: jira:<PROJECT_KEY>-<n>, title, url}` for `/todo list` to import; never write
anything here.

## Complete

Show exactly what will resolve, e.g. `Resolve <PROJECT_KEY>-<n> ("<title>")?`, and wait for
explicit yes. On confirmation, find the transition that resolves the issue (a get-transitions
tool) and apply it (a transition-issue tool) — Jira's exact transition name for "done" varies by
workflow, so look it up rather than assuming a fixed name like `Done` exists.

## Remember

If this run learned or corrected a project's `project_key`, `epic`, or `label`, append it to that
project's line in the Projects section of `user-preferences.md` so the next run doesn't ask
again. If your team uses a fixed set of labels across several projects, add a short table to this
file listing them and their meaning, and update Create/Discover above to pick from that registry
rather than inventing new labels ad hoc.
