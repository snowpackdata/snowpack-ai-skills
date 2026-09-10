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
cp -r snowpack-ai-skills/skills/production/{skill-name} ~/.claude/skills/{skill-name}
# or skills/review/{skill-name} — match wherever the skill lives below
```

Some skills bundle Claude Code subagents (`.claude/agents/*.md`), which Claude Code
can't discover while they sit nested inside an installed skill folder. Those skills'
`SKILL.md` self-installs its subagents to the global `~/.claude/agents/` as a first
step, so `npx skills add` still works normally. See each skill's own `SKILL.md`.

## Production Ready

Used successfully by someone besides the author, with a named owner.

<!-- SKILLS-TABLE:PRODUCTION:START -->
| Skill | Description | Owner |
|---|---|---|
| [`time-logger`](./skills/production/time-logger) | /time-logger setup \| prefetch \| log \| submit \| morning \| summary — drafts daily time entries from your tools, with a local review dashboard. | @jarellano01 |
<!-- SKILLS-TABLE:PRODUCTION:END -->

## Ready for Review

Complete and installable, still looking for a second tester.

<!-- SKILLS-TABLE:REVIEW:START -->
| Skill | Description | Notes |
|---|---|---|
| [`gather-context`](./skills/review/gather-context) | Systematically maps an unfamiliar pipeline's declared and tribal context. Use when onboarding onto or auditing a client pipeline. | Owner @auwng. Ready for a second tester — promote to skills/production/ once someone besides the author has used it successfully. |
| [`plain-style`](./skills/review/plain-style) | Revises drafted prose to be direct, active, and free of filler. Use to tighten writing before it ships. | Owner @auwng. Ready for a second tester — promote to skills/production/ once someone besides the author has used it successfully. |
<!-- SKILLS-TABLE:REVIEW:END -->

## About this repository

This is a read-only publish target. Its contents are generated automatically from
Snowpack's private source repository on every merge, so pull requests opened here
can't be merged and will be closed. To report a problem or suggest a change, contact
the skill's owner listed above.
