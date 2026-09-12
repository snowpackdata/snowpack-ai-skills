# Changelog — todo

## v2 — YAML store (2026-09-12)

**Breaking.** The flat file (`todos_file`, default `~/.claude/todos.yaml`) is now YAML, not
markdown. There is no dual-format support — v1's markdown checklist is no longer understood by
`/todo` or by `time-logger`'s dashboard. Run `/todo migrate` once to convert an existing v1 file;
see below for what changes and why.

### Why

v1 classified done-vs-open by section header (`## Pending` / `## In Progress` / `## Done`) and
packed id/tag/date/priority into parenthetical suffixes on a markdown checklist line. That made
parsing ambiguous — a file with any other done-heading spelling (`## Completed`, from an older
tool) silently misclassified every finished item as open, with no structural way to detect it.
It also meant any code that needed to change *one specific item* (e.g. `time-logger`'s
feedback-apply flow marking a todo done, or bumping its priority) had to find a `- [ ]` line by
matching against its rendered text and hand-edit prose around it.

v2 replaces that with a flat, structured record per item. `state` is an explicit field, not a
section a line happens to sit under — no more silent misclassification. And because every field
is a key, not part of the rendered text, updating one item is a small, deterministic patch
instead of prose surgery: `time-logger`'s review-feedback flow now shells out to
`update-todo.mjs <file> <id> --state done` rather than finding-and-rewriting a line.

### Schema (v2)

```yaml
# todos.yaml — canonical todo store written by the `todo` skill (schema v2).
# Structure only: a top-level `todos:` sequence of flat items, in this key order, with no
# nested mappings other than `notes`. /todo, its backends, and time-logger's dashboard all
# read this file with a small restricted-YAML parser (see SKILL.md and, in time-logger,
# dashboard/scripts/todo-format.mjs) — avoid multi-line strings, YAML anchors, or flow-style
# collections other than `[]` for an empty `notes`, or those tools may misread it.
todos:
  - id: t042
    project: kronos
    text: 'Fix login bug on mobile'
    state: pending          # pending | in_progress | done
    backend: local          # local | github | jira | ...
    url: null
    group: null             # dashboard-grouping override; null falls back to `project`
    priority: null          # high | medium | low | null
    created: '2026-09-11'
    done: null              # date it was marked done, else null
    notes: []               # short status/history strings, appended not overwritten
```

`id` is now uniformly `<backend>:<opaque>` for anything backend-tracked (`gh:owner/repo#123`,
`jira:PROJ-123`) — v1's Jira bracket form (`[PROJ-123]`) is gone; `time-logger` no longer special-
cases brackets, it reads the `backend` field directly. Local todos keep the bare `t###` form.

### What v1 had that v2 drops

- **Multiple free-form `#tags` per item.** v1 let a hand-edited line carry several tags (e.g.
  `#slack #reply`) beyond its project. v2 has one `project` (surfaced as a single tag) and one
  optional `group` override. Nothing that wrote v1 files (`/todo` itself) ever emitted more than
  one meaningful tag; this drops unused flexibility, not observed behavior.
- **Multiple links per item.** v1 could carry several URLs in a line's free text. v2 has one
  canonical `url`. Same rationale — `/todo` only ever wrote one.

### Migrating

Run `/todo migrate` (see SKILL.md's **Migrate** section). It backs up the existing file to
`<file>.v1.bak-<date>`, converts every line to the schema above, and writes the result to
`todos_file`. It's a one-time, one-directional conversion — after it runs, the backup is the only
copy of the old format; `/todo` does not read markdown again afterward.
