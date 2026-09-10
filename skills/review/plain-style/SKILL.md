---
name: plain-style
description: Revise drafted text to eliminate passive voice, filler words, redundant phrases, throat-clearing openers, vague language, comma-strung fragments, fragmented outlines standing in for real paragraphs, and em dashes -- replacing each with direct, specific, flowing prose. Returns only the revised text, never a changelog of what was edited. Bundles a reusable `apply-style-guide` subagent other skills can dispatch to as a final drafting step, before their own output is considered finished. Triggers on "clean up the style of this", "make this more direct", "cut the filler from this", "apply the style guide", or when another skill's own instructions call for a style-enforcement pass before finalizing output.
owner: "@auwng"
summary: Revises drafted prose to be direct, active, and free of filler. Use to tighten writing before it ships.
notes: Owner @auwng. Ready for a second tester — promote to skills/production/ once someone besides the author has used it successfully.
---

# Plain Style

A line-level revision pass, not a content review. Read
[`references/style-guide.md`](./references/style-guide.md) for the eight rules this
applies -- this file is the workflow around it.

## Step 0 — locate this skill's own files, and bootstrap its subagent

This skill bundles one subagent (`.claude/agents/apply-style-guide.md`) that does the
actual revision. A subagent nested inside an installed skill folder isn't discoverable by
Claude Code -- it's only picked up from a project's own `.claude/agents/` or the global
`~/.claude/agents/`. Resolve this skill's own location, and install the subagent if it
isn't already reachable:

```bash
SKILL_DIR=""
for candidate in ~/.claude/skills/plain-style .claude/skills/plain-style; do
  if [ -f "$candidate/references/style-guide.md" ]; then
    SKILL_DIR="$candidate"
    break
  fi
done

if [ -n "$SKILL_DIR" ] && [ ! -f ~/.claude/agents/apply-style-guide.md ] && [ ! -f .claude/agents/apply-style-guide.md ]; then
  mkdir -p ~/.claude/agents
  cp "$SKILL_DIR"/.claude/agents/*.md ~/.claude/agents/
  echo "Installed plain-style's apply-style-guide subagent to ~/.claude/agents/"
fi
```

If `$SKILL_DIR` is empty (a direct clone, running from `skills/review/plain-style/`
itself), its own `.claude/agents/` is already project-local and discovered normally --
skip the copy.

**Known limitation, same one `gather-context` already documents:** installing the
subagent does not make it dispatchable within the *same* session -- the available-agent-
type list is fixed when a session starts, not re-scanned after a mid-session file copy. A
dispatch attempt against a subagent just bootstrapped by this same run will fail with
something like "Agent type 'apply-style-guide' not found," even though the file is
correctly present on disk. The fallback below exists specifically for this.

## Workflow

1. **Get the text to revise.** Either a file path or text pasted directly into the
   conversation. If a file path, read it.

2. **Decide what's in scope.** Per `style-guide.md`'s own Scope section: prose --
   paragraphs, list items, sentence-level writing -- is in scope. Code blocks, commands,
   file paths, identifiers, diagrams, data tables, and any notice marked as fixed or legal
   are not; they get reproduced exactly. If the target is a mixed document (a report with
   both prose sections and a Mermaid diagram, say), say so explicitly when dispatching in
   step 3 so the subagent knows what to leave untouched.

3. **Dispatch to `apply-style-guide`**, with: the resolved absolute path to
   `$SKILL_DIR/references/style-guide.md`, the full text to revise, and which parts (if
   any) are out of scope per step 2.

4. **Fall back to revising it yourself if dispatch isn't available.** If the dispatch
   attempt fails on "agent type not found" (rather than the subagent running and reporting
   a real problem), don't block: read `style-guide.md` yourself and apply it directly,
   following the same rules and the same never-change-what-a-sentence-asserts constraint.
   Same output either way, just not delegated this one time.

5. **Return or write back the revised text, and only the revised text.** If the input was
   a file, overwrite it with the revised version and confirm the write landed -- read it
   back, don't just trust the write command's exit code. If the input was pasted text,
   return the revised version directly in the conversation. Either way, never attach a
   summary of what changed, a list of edits, or any commentary about the revision --
   per `style-guide.md`'s own closing rule, the output is the revised text and nothing
   else.

## Notes

- This is a style pass, not an editorial pass. It never adds a claim, drops a caveat, or
  softens a finding -- see `style-guide.md`'s closing paragraph. If applying a rule would
  require guessing at a fact the original text didn't already state, tighten the phrasing
  without inventing the missing specific.
- Designed to be dispatched to by other skills' own final drafting steps, not just invoked
  directly by a user -- see `references/style-guide.md` and
  `.claude/agents/apply-style-guide.md` for the contract any calling skill relies on: hand
  it a resolved convention-doc path plus the text (and what's out of scope), get back only
  the revised text.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill plain-style
```

Manual fallback (always works): `cp -r skills/review/plain-style ~/.claude/skills/`.

Either way, the Step 0 bootstrap above handles installing the bundled
`apply-style-guide` subagent to `~/.claude/agents/` the first time it's needed -- no
separate setup step.
