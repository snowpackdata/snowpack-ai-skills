# Framework reference: Airflow

## Detection

Any `.py` file whose text contains `"airflow"` or `"DAG("` is a candidate. This is a
cheap textual pre-filter, not the extraction itself — it exists specifically to avoid
false-positiving on unrelated code that happens to use `>>`/`<<` as real bit-shift
operators. Only files that pass this filter get AST-walked by `parse_airflow_dag()`.

## What gets extracted

`parse_airflow_dag()` does best-effort static extraction of task wiring via an
`ast.NodeVisitor`, not by executing the DAG file:
- `a >> b`, `a << b` (including chained and list forms: `a >> [b, c] >> d` — each hop
  gets its own edge, not just the outermost one; see `_chain_stages`' docstring for why
  a naive walk would double-count or miss inner hops).
- `a.set_downstream(b)` / `a.set_upstream(b)`, including list arguments.
- Resolves each Python variable name to its Airflow `task_id` where one is set via a
  `task_id=` keyword on the assignment; falls back to the variable name otherwise.

Same as the dbt path: results feed `_topo_sort` for a single `execution_order`, and a real
cycle is reported explicitly (`cycle_detected: true`, raw edges shown) rather than
resolved into a guessed order.

## What this does NOT cover

- Dynamic task mapping (`.expand(...)`), TaskFlow API (`@task` decorators building the
  graph implicitly rather than through `>>`/`set_downstream`), and Airflow 2.x Datasets /
  schedule-by-dataset triggers. These are increasingly common and currently invisible to
  this parser — a DAG built entirely with TaskFlow decorators will show zero edges here,
  which reads as "no DAG found," not "found but unparseable." Don't let that silence be
  mistaken for a clean result — say so explicitly if a `DAG(` or `airflow` import is
  present but no edges came out.
- Sensors, triggers, and `schedule_interval`/`schedule` cadence — this extracts task
  *order*, not the DAG's own run cadence.

## Adding coverage here

A TaskFlow-style DAG is the most likely next gap (see the note above). If you hit one,
capture it as a local learning first — see SKILL.md's "Capturing learnings" step — then
promote the parser addition here later as its own reviewed change, following the same
"mechanical edges, explicit cycle handling, no guessed order" shape used above.
