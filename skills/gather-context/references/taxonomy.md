# Taxonomy reference

Condensed from "A Taxonomy for Systematic Pipeline Context-Gathering," an internal
Snowpack Data doc (not publicly accessible) — this file is the complete, self-contained
spec; nothing normative lives only in the source doc.

## Scope boundary

Only run this against something operational today — a process a person or
system actually does right now, however manually. If asked to run it
against something net-new (not yet built), say so and stop. That's
requirements/architecture work, not context recovery.

## The six context types (`scan.py` output maps onto these)

| Type | Recovery method | `scan.py` field |
|---|---|---|
| Declared/explicit | Parse directly, watch for sources disagreeing | `declared_facts`, `disagreements`, `declared_sequences` (execution order from dbt/Airflow) |
| Tribal/tacit | Can't automate — needs a conversation | `gap_candidates` (type: tribal) |
| Distributed/externalized | Query the third-party tool's own API/config, not a code read | `undeclared_dependencies` (backward-trace) |
| Motivational/rationale | Often unrecoverable even from the original decision-maker | `gap_candidates` (type: motivational) |
| Ownership/accountability | Gates recovery of tribal + motivational context | `gap_candidates` (type: ownership) |
| Temporal/freshness | A trust discount on every other type, not its own fact | `release_convention` freshness flags |

## What the script deliberately does NOT judge

- Whether a docstring disagreement is *real* (two modules describing "the
  same thing" differently) — it only groups candidates
  (`cross_reference_candidates`); judging whether they actually conflict is
  yours to do by reading both docstrings.
- Whether an `undeclared_dependency` hit is a real gap or a false positive
  from a generic word matching a filename by coincidence — filter these
  before they go in the report.
- Anything requiring execution (emergent/execution-order or
  silent-latent-defect complexity) — this tool is declared-parse +
  backward-trace only. Say explicitly in the report that this wasn't
  checked; don't let a clean scan read as "no execution-order risk found."
- Parallel-authority complexity (two independently-live systems computing
  "the same" thing) — out of scope for this tool; it needs simultaneous
  access to both systems, not one pipeline in isolation.

## Writing gap questions

Don't ask open-ended "tell me about your pipeline." Build a short,
specific "here's what we can't tell — confirm or correct" list from what
the scan already narrowed down. Where no confirmation is possible, name
the gap and the real candidate answers rather than forcing a weak match.

## Scaling effort

A scan with zero disagreements, zero undeclared dependencies, and no
freshness drift needs a short report. The moment any of those show up,
that's the signal to dig in further — not a shape to sanity-check after
the fact.
