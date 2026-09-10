# plain-style

A line-level revision pass for drafted text: cuts passive voice, filler words, redundant
phrases, throat-clearing openers, vague language, comma-strung fragments, fragmented
outlines standing in for real paragraphs, and em dashes, replacing each with direct,
specific, flowing prose. It never changes what a sentence asserts, only how it reads.

Built to be used two ways: directly, on a file or pasted text, and as a subagent other
skills dispatch to from their own final drafting step, so the same eight rules apply
consistently everywhere instead of getting redefined per skill.

## Access

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill plain-style
```

`npx skills add` will ask whether to install globally (available in every Claude Code
project) or just the current one -- global is the usual choice for a general-purpose tool
like this. Manual fallback, works regardless of install method:

```bash
cp -r skills/review/plain-style ~/.claude/skills/
```

## Usage

Directly, in a Claude Code session:

> "Clean up the style of this file: `~/notes/draft.md`"
> "Make this more direct"
> "Cut the filler from this"

From another skill's own instructions, as a final drafting step:

> Dispatch to `apply-style-guide` with the resolved path to
> `plain-style/references/style-guide.md` and the drafted text, noting anything that's
> out of scope (code, diagrams, fixed notices).

See [`SKILL.md`](./SKILL.md) for the exact dispatch contract and the bootstrap step that
installs the bundled subagent.

## The eight rules

See [`references/style-guide.md`](./references/style-guide.md) for the full guide with
before/after examples. In short: no passive voice, no filler words, no redundant phrases,
no throat-clearing sentences, specific language instead of vague language, direct complete
sentences instead of comma-strung fragments, standard flowing paragraphs instead of a
fragmented outline of one-line assertions, and no em dashes. The output is always the
revised text alone, never a summary of what changed.

Explicitly out of scope: code blocks, file paths, identifiers, diagrams, data tables, and
any notice marked as fixed or legal. Those get reproduced exactly, never revised.

## Author

Audris (audris@snowpack-data.com)
