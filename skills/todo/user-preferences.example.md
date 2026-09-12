# User Preferences — todo

This file is gitignored and machine-specific. `/todo` reads it on every run and writes to it
during `/todo setup`; you can also just edit it by hand.

---

## Projects

Every todo is tagged `#<name>` from this list, matched against the current directory's repo
(folder name or `git remote get-url origin`) when you run `/todo` or `/todo <text>` from
inside a project. `backend` decides where a *new* todo for that project is created; `local`
always works with no further setup. When nothing matches, the todo is tagged `#unfiled` so the
gap is visible instead of silent — add a project entry rather than letting things pile up there.

- **Acme** — backend: local — matches: acme-*, data-platform
- **BigCo** — backend: github — repo: bigco-inc/bigco-app — matches: bigco-*, bigco-app
- **Personal** — backend: local — matches: blog, side-project-*

---

## Corrections log

(corrections from past sessions will be appended here, e.g. "BigCo repo is now
bigco-inc/bigco-monorepo — retag existing bigco-* todos")
