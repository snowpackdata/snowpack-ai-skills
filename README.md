# snowpack-ai-skills

Reusable [Claude Code](https://claude.com/claude-code) skills from
[Snowpack](https://www.snowpack-data.com/). Every skill follows the
[Agent Skills](https://agentskills.io/) format used by [skills.sh](https://www.skills.sh/),
so any of them installs with:

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill {skill-name}
```

Manual fallback, if you'd rather not use the installer:

```bash
git clone https://github.com/snowpackdata/snowpack-ai-skills.git
cp -r snowpack-ai-skills/skills/{skill-name} ~/.claude/skills/{skill-name}
```

Some skills bundle Claude Code subagents (`.claude/agents/*.md`), which Claude Code
can't discover while they sit nested inside an installed skill folder. Those skills'
`SKILL.md` self-installs its subagents to the global `~/.claude/agents/` as a first
step, so `npx skills add` still works normally. See each skill's own `SKILL.md`.

## Skills

<!-- SKILLS-TABLE:START -->
| Status | Skill | Description | Owner | Notes |
|---|---|---|---|---|
| ✅ Production Ready | [`time-logger`](./skills/time-logger) | /time-logger setup \| prefetch \| log \| submit \| morning \| summary — drafts daily time entries from your tools, with a local review dashboard. | @jarellano01 |  |
| 🔍 Ready for Review | [`gather-context`](./skills/gather-context) | Systematically maps an unfamiliar pipeline's declared and tribal context. Use when onboarding onto or auditing a client pipeline. | @auwng | Looking for a second tester. |
| 🔍 Ready for Review | [`plain-style`](./skills/plain-style) | Revises drafted prose to be direct, active, and free of filler. Use to tighten writing before it ships. | @auwng | Looking for a second tester. |
<!-- SKILLS-TABLE:END -->

## Skill status

Skills are published early so people can try them. The status at the top of each
skill's README says how much to trust it:

<!-- STATUS-LEGEND:START -->
- ✅ **Production Ready** — used successfully in real work by someone besides the author, or by the author in production. Honor system.
- 🔍 **Ready for Review** — complete and installable; looking for a second tester before it's called production-ready.
- 🧪 **In Development** — works for the author; nobody else has tested it yet. Expect rough edges.
- 📦 **Archived** — retired to `archive/{name}/`; no longer installable.
<!-- STATUS-LEGEND:END -->

## About this repository

This is a read-only publish target. Its contents are generated automatically from
Snowpack's private source repository on every merge, so pull requests opened here
can't be merged and will be closed. To report a problem or suggest a change, contact
the skill's owner listed above.
