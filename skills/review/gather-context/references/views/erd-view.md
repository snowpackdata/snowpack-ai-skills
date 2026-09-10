# ERD / data-flow diagram — provenance convention

One of several view conventions in `references/views/` (see also
[`taxonomy-view.md`](./taxonomy-view.md)) — each defines the visual grammar for one way of
rendering the findings `gather-context` already gathered. This is the default view: an
execution-order/dependency graph. Rendering it is delegated to the `visualize-erd`
subagent (see `.claude/agents/visualize-erd.md`); SKILL.md step 7 decides which view(s) a
run needs and dispatches to the matching agent(s), rather than rendering inline.

This skill builds an ERD/data-flow diagram by default, as a standard part of every
`gather-context` report — not a special request, and skipped only when there's genuinely
nothing to draw. Building it is still real, per-pipeline judgment work (there's no script
that draws it — see "What this is not" below), so the diagram still needs its own visual
language, applied consistently, so a wrong hand-drawn edge never reads as authoritative as
a real one.

## Why this exists

A diagram is more persuasive than a bullet list, which makes it more dangerous when it's
wrong. The same overconfidence risk that "provenance-split reporting" addresses for the
written report (see SKILL.md's output template — every finding is marked mechanical vs.
inferred vs. unknown) applies just as much to a diagram's edges. Without a visual
distinction, a plausible-but-wrong inferred edge looks exactly as certain as one derived
straight from a dbt manifest or Airflow DAG — worse than no diagram at all, because it
looks checked when it wasn't.

## The convention

**Edges:**
- **Solid edge** — mechanically derived. Comes straight from `scan.py`'s
  `declared_sequences` (a dbt manifest's `depends_on` graph, an Airflow DAG's task
  wiring). No human judgment involved in drawing this edge; it's a direct rendering of
  parsed dependency data.
- **Dashed edge** — inferred. An agent read code, config, or docs by hand and concluded
  this connection exists (e.g. a bespoke in-process scheduler firing a query against a
  table with no declared/parseable link between the two). Annotate the edge with a short
  note on how it was inferred (which file, which function) so it's checkable, not just
  asserted.

**Nodes:**
- **Named, reachable node** — a table, queue, job, or service the agent actually read
  code/config for.
- **Black-box node** — a named-but-unreachable external system (a SaaS tool, a
  microservice with no repo on hand, an integration referenced only by name in a config
  or env var). Draw it explicitly, labeled with what it's called and why it's a
  black box (no repo access, no API credentials, out of engagement scope) — never drop it
  silently the way an unavailable consumer file is dropped from a backward-trace today.

**Provenance banner:**
Every ERD produced under this skill opens with a one-line count, e.g.:

```
Provenance: 3 edges mechanically derived (scan.py) · 7 edges inferred (direct code
reading) · 2 black-box nodes (no repo/API access)
```

A "near-zero mechanical" count is itself a finding worth stating plainly in the
surrounding report — it means the stack wasn't covered by an existing framework
reference (see `references/frameworks/`), not that nothing was found.

## Format

Write it as a Mermaid diagram (a ` ```mermaid ` fence) embedded directly in the report's
"ERD / data-flow diagram" section — plain text, renders natively wherever the report is
viewed (GitHub, an editor, a Claude artifact), no extra tooling or rendering step needed.

## What this is not

This is a documentation convention, not a rendering pipeline — there's no script that
draws the diagram for you. `scan.py`'s output (`declared_sequences`) gives you the solid
edges directly; everything else — including deciding the diagram is worth building at all
in the rare skip case — is manual judgment, same as the rest of this skill's judgment
layer.
