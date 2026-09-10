# gather-context

<!-- STATUS:START -->
> 🔍 **Ready for Review** — complete and installable; looking for a second tester before it's called production-ready. Owner: @auwng. [What the statuses mean.](../../README.md#skill-status)
<!-- STATUS:END -->

Systematic context-gathering for an unfamiliar operational pipeline — parses what's
declared/parseable, traces backward from downstream consumers to catch what nothing
upstream declares, and turns everything else into a short, specific list of questions for
a person, instead of an open-ended interview.

Consultants ramping up on an unfamiliar client pipeline can't get business and process
context fast enough — gathering it today is ad hoc detective work. This exists to make
that first pass fast, honest about what it actually checked vs. inferred, and repeatable.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill gather-context
```

`npx skills add` will ask whether to install globally (available in every Claude Code
project) or just the current one — global is the usual choice for a general-purpose tool
like this. Manual fallback, works regardless of install method:

```bash
cp -r skills/gather-context ~/.claude/skills/
```

## Usage

In a Claude Code session, just describe what you want in plain language — no slash
command needed:

> "Gather context on the pipeline at `~/repos/some-client-pipeline`"
> "Map this pipeline"
> "What's declared vs. tribal here?"
> "Trace how this business logic/metric definition is implemented across these models"

From there, Claude will:
1. Run the mechanical scan (`scripts/scan.py`) against the target — dbt/Airflow
   execution order, config disagreements, a stack fingerprint, freshness/release-pointer
   checks.
2. Read whatever it needs to (READMEs, code, CLI help) to interpret that raw output and
   reconstruct anything mechanically unparseable — including a process the team declared
   in prose but never formalized into a graph.
3. Ask whether you have any downstream consumer artifacts on hand (a dashboard query, a
   reverse-ETL config) to check for undeclared dependencies. Optional, but worth having
   ready — without one, that risk is reported as unknown, not clean.
4. Decide which diagram(s) the request actually needs — an execution-order ERD by
   default, or a business-category taxonomy view when that's the real question — and
   dispatch the rendering to that view's subagent (see
   [`references/views/`](./references/views/)).
5. Write one file, `process_context_report.md` — flagged internal-Snowpack-use-only at
   the top, not for direct client sharing — a plain-language summary of what the
   pipeline does up top, every finding below it, and the rendered diagram(s), all in
   one place. Written by default to `~/gather-context-reports/<target-name>/`, outside
   the scanned target, so it survives even if the target itself is a temporary clone.
6. If the separate [`plain-style`](../plain-style) skill is installed, pass the finished
   report through it for a line-level style pass. Optional — if `plain-style` isn't
   present, the report is unaffected, and Claude just mentions it once in that run's reply
   rather than installing it or blocking on it.

You can also run the mechanical half directly, no Claude session needed — useful for
scripting or a quick sanity check, though the skill is what actually turns this into
something readable:

```bash
python3 scripts/scan.py declared <path>
python3 scripts/scan.py backward-trace <path> --consumers <file> [<file> ...]
```

## Scope of this build

Targets compute/infra-heavy pipelines (e.g. Python scripts, JSON configs, dated-release
directory conventions) and the two orchestration shapes covered so far — dbt and Airflow
(see [`references/frameworks/`](./references/frameworks) for exactly what's covered per
framework, and how to add another).

Implements:
- **Execution-order extraction** — dbt manifest `depends_on` graphs and Airflow DAG task
  wiring (`>>`, `<<`, `set_downstream`/`set_upstream`, including list-branch fan-out),
  detected by content shape rather than filename, topologically sorted into an actual run
  order. A real cycle is flagged explicitly rather than silently mis-ordered. This is
  mechanically derived from dependency edges, not a docstring-based guess.
- **Stack-identification pass** — a confidence-tagged fingerprint (language manifests,
  dbt/Airflow/Dagster/Prefect markers, a corroborated bespoke-scheduler heuristic) that
  decides whether an empty execution-order result means "uncovered," "declared but not
  mechanically parseable," "known framework, no graph available," or genuinely nothing.
- **Declared-parse** — JSON configs, Python module docstrings/CLI args, and
  release/versioning conventions detected structurally rather than by one pipeline's
  naming: any directory whose children mostly match a known versioning scheme (ISO
  timestamps, dates, semver, git shas, or keyword/pointer-corroborated build numbers),
  plus any pointer symlink inside it under any name (`current`, `latest`, `stable`,
  `prod`, ...).
- **Disagreement detection** — same config key, different value, across non-versioned
  declared sources, with an explicit flag for JSON files that are actually ID-keyed
  lookup tables (data, not settings) so a "0 disagreements" result never silently means
  "nothing was comparable."
- **Freshness checks** — does the pointer symlink target the most recent sibling by that
  convention's own ordering (numeric-aware for semver/build numbers, not a naive string
  sort — `v9.0.0` correctly sorts before `v10.0.0`). Git-sha-named versions are flagged
  as unorderable by name alone rather than guessed at.
- **Backward-trace** — given consumer artifacts (dashboard queries, reverse-ETL configs,
  anything downstream), flag references to things nothing upstream declares. This is the
  direct fix for a real failure mode seen on a past client engagement: a forward-only
  scan of a clean pipeline gave false confidence while a downstream reverse-ETL sync
  silently depended on a field the pipeline's own tooling never touched.
- **Gap surfacing** — tribal/motivational/ownership candidates, handed to the skill to
  turn into a short confirm-or-correct list, not an open-ended interview.
- **Non-blocking fallback + local learnings capture** — when a pipeline's stack isn't
  covered by `scan.py` or `references/frameworks/`, the skill falls through to reading
  code directly instead of reporting a false-clean scan, and captures what it learns
  locally (gitignored, in the target repo) rather than blocking on a round-trip back
  here.
- **Provenance-split reporting** — every finding, and every node/edge in every diagram, is
  marked mechanical vs. inferred vs. unresolved gap.
- **View-agnostic diagramming, built by default** — the skill's own judgment layer stops
  at gathering and interpreting findings; drawing them is delegated to view-specific
  subagents (`.claude/agents/visualize-*`), one per convention doc in
  [`references/views/`](./references/views/):
  - [`erd-view.md`](./references/views/erd-view.md) — the default: an execution-order
    dependency graph, solid edges from mechanically-derived execution order, dashed edges
    from inferred/backward-trace findings, explicit black-box nodes for any
    named-but-unreachable external system.
  - [`taxonomy-view.md`](./references/views/taxonomy-view.md) — for a different question
    entirely: how rows get classified into business categories, and whether that
    classification holds across pipeline stages. Same solid/dashed provenance discipline,
    applied to categories and their isolation rules instead of dependency edges.
  
  Every report includes at least one diagram unless there's genuinely nothing to draw for
  that view. Adding a new view later means adding a new convention doc + subagent pair,
  not changing how the skill itself gathers or interprets findings.

Explicitly NOT implemented (see [`references/taxonomy.md`](./references/taxonomy.md)):
execution-based checks for emergent/silent-latent-defect complexity, and
parallel-authority diffing across two simultaneously-live systems. The skill states
plainly when it hasn't checked them rather than letting a clean scan imply it did.

## Author

Audris (audris@snowpack-data.com)
