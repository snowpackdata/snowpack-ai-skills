# Framework reference: dbt

## Detection

Any `.json` file whose parsed content has a top-level `nodes` dict where at least one
node has a `depends_on.nodes` list. This is a content-shape check, not a filename check —
`scan.py`'s `_is_dbt_manifest_shape()` doesn't assume the file is named `manifest.json`,
though that's dbt's actual default output name (`target/manifest.json` after a `dbt
compile`/`dbt run`).

## What gets extracted

`parse_dbt_manifest()`:
- Walks every node's `depends_on.nodes` list and builds a `(from, to)` edge for each
  dependency that resolves to another node in the same manifest (source/macro deps that
  don't resolve to a node are skipped — they're not part of the run-order graph).
- Topologically sorts the resulting graph (`_topo_sort`, Kahn's algorithm) into a single
  `execution_order`. A real cycle is reported as `cycle_detected: true` with the raw edges
  shown — never silently resolved into an arbitrary order.
- Reports `node_count` and the raw `edges` list alongside the derived order, so the skill
  can show its work rather than asserting the order as an unexplained fact.

This is mechanically derived from dbt's own dependency graph — not a guess from a model's
name, folder position, or docstring. If a model's description claims an order dbt's
manifest doesn't actually encode, that's a `disagreement` worth surfacing (see SKILL.md),
not something this parser resolves on its own.

## What this does NOT cover

- dbt Cloud-only metadata (job schedules, environments) — this reads the compiled
  `manifest.json` artifact only, not dbt Cloud's API.
- Source freshness / test results — those live in `run_results.json` and `sources.json`,
  which aren't parsed here. If a pipeline needs freshness-check coverage, that's a gap for
  now, not a silent "checked and clean."
- Exposures and semantic layer metrics — out of scope until a concrete case shows they'd
  change what's reported.

## Adding coverage here

If you hit a dbt-adjacent shape this reference doesn't cover (a `run_results.json`
freshness check, an exposure graph), capture what you found as a local learning first
(see SKILL.md's "Capturing learnings" step) — don't block the current run trying to
generalize it. Promote it into this file later, as its own reviewed change.
