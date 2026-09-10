---
name: gather-context
description: Run systematic context-gathering against an operational pipeline or process — parse declared artifacts, backward-trace consumer dependencies, surface tribal/motivational/ownership gaps as a confirm-or-correct list, and produce a provenance-annotated diagram by default (an execution-order ERD, or a business-category taxonomy view when that's the real question being asked). Triggers on "gather pipeline context", "map this pipeline", "what's declared vs. tribal here", "run the context taxonomy on this repo", "trace how this business logic/taxonomy is implemented across these models", or when onboarding onto an unfamiliar client pipeline.
owner: "@auwng"
summary: Systematically maps an unfamiliar pipeline's declared and tribal context. Use when onboarding onto or auditing a client pipeline.
notes: Owner @auwng. Ready for a second tester — promote to skills/production/ once someone besides the author has used it successfully.
---

# Gather Context

Read [`references/taxonomy.md`](./references/taxonomy.md) before starting — it defines
the scope boundary, what the script does and doesn't judge, and the writing style for gap
questions. This skill is the judgment layer on top of `scripts/scan.py`, which does the
mechanical parsing. For framework-specific extraction detail (what dbt/Airflow shapes are
covered today, and what isn't), see [`references/frameworks/`](./references/frameworks/).
Diagram rendering is delegated to view-specific subagents — see
[`references/views/`](./references/views/) and step 7 below. If the separate `plain-style`
skill is installed, the finished report gets a line-level style pass at the end (step 11)
— optional, never required.

## Step 0 — locate this skill's own files, and bootstrap its subagents

`scan.py` has to run regardless of the current working directory or how this skill was
installed. Resolve its path once, before step 2:

```bash
SKILL_DIR=""
for candidate in ~/.claude/skills/gather-context .claude/skills/gather-context; do
  if [ -f "$candidate/scripts/scan.py" ]; then
    SKILL_DIR="$candidate"
    break
  fi
done
SCAN="${SKILL_DIR:+$SKILL_DIR/}scripts/scan.py"
[ -z "$SKILL_DIR" ] && SCAN="scripts/scan.py"  # direct clone, running from skills/review/gather-context/ itself
```

Use `"$SCAN"` in place of `scripts/scan.py` in every invocation below.

This skill also bundles two subagents (`.claude/agents/visualize-erd.md`,
`.claude/agents/visualize-taxonomy.md`) that render step 7's diagram(s). A subagent
nested inside an installed skill folder isn't discoverable by Claude Code — it's only
picked up from a project's own `.claude/agents/` or the global `~/.claude/agents/`. Before
step 7 needs them, check whether they're already reachable and install them if not:

```bash
if [ -n "$SKILL_DIR" ] && [ ! -f ~/.claude/agents/visualize-erd.md ] && [ ! -f .claude/agents/visualize-erd.md ]; then
  mkdir -p ~/.claude/agents
  cp "$SKILL_DIR"/.claude/agents/*.md ~/.claude/agents/
  echo "Installed gather-context's visualize-* subagents to ~/.claude/agents/"
fi
```

If `$SKILL_DIR` is empty (a direct clone, running from `skills/review/gather-context/`
itself), its own `.claude/agents/` is already project-local and discovered normally — skip this
copy.

**Known limitation, confirmed in testing:** installing these files does not make them
dispatchable within the *same* session — the available-agent-type list is fixed when a
session starts, not re-scanned after a mid-session file copy. A dispatch attempt in step 7
against a subagent that was just bootstrapped by this same run will fail with something
like "Agent type 'visualize-erd' not found," even though the file is correctly present on
disk. Step 7's fallback (below) exists specifically to make this a non-event rather than a
blocker — but don't assume a freshly-bootstrapped subagent is actually reachable this run.

**Optional: locate the `plain-style` skill, if it's installed.** Step 11 dispatches the
finished report through `plain-style`'s `apply-style-guide` subagent for a line-level
style pass. This is a genuinely separate, independently-installed skill — it may not be
present, and that's a normal, fully-supported case, not an error:

```bash
STYLE_SKILL_DIR=""
for candidate in ~/.claude/skills/plain-style .claude/skills/plain-style; do
  if [ -f "$candidate/references/style-guide.md" ]; then
    STYLE_SKILL_DIR="$candidate"
    break
  fi
done

if [ -n "$STYLE_SKILL_DIR" ] && [ ! -f ~/.claude/agents/apply-style-guide.md ] && [ ! -f .claude/agents/apply-style-guide.md ]; then
  mkdir -p ~/.claude/agents
  cp "$STYLE_SKILL_DIR"/.claude/agents/*.md ~/.claude/agents/
  echo "Installed plain-style's apply-style-guide subagent to ~/.claude/agents/"
fi
```

If `$STYLE_SKILL_DIR` is empty, `plain-style` isn't installed — skip step 11 entirely, no
error, no note in the report. If it's found, the same same-session dispatch limitation
above applies to `apply-style-guide` too; step 11's own fallback covers it.

## Scope check first

Confirm the target is something operational today, not something being designed. If
there's no operational reality to observe, say so and stop — that's a different exercise.

## Workflow

1. **Get the target path.** Ask for the repo/directory to scan if not given.

2. **Run the declared-artifact scan:**
   ```
   python3 "$SCAN" declared <path>
   ```

3. **Ask if there are known consumer artifacts** — dashboard exports, reverse-ETL
   configs, BI queries, anything downstream that reads from this pipeline but isn't part
   of its own codebase. If yes, run:
   ```
   python3 "$SCAN" backward-trace <path> --consumers <file> [<file> ...]
   ```
   If no consumer artifacts are available, say so explicitly in the final report — don't
   silently skip this section as if it came back clean. A pipeline with no backward-trace
   run has unknown externalized-dependency risk, not zero risk.

4. **Interpret the raw output — this is the part the script can't do:**
   - **Read `detected_stack` and `known_framework_detected` first, before anything
     else** — this is the mechanical fingerprint from `scan.py`'s stack-identification
     pass, and it decides which `references/frameworks/*.md` applies and whether an
     empty `declared_sequences` later means "nothing to report" or "uncovered." Report
     every `detected_stack` entry with its confidence (`high`/`medium`/`low`) plainly. A
     `low`- or `medium`-confidence `bespoke-scheduler` entry is a candidate worth reading,
     not a verdict — same treatment as `disagreements`/`undeclared_dependencies` below,
     never reported with the same certainty as a `high`-confidence `dbt`/`airflow`
     marker. `known_framework_detected` reflects only real, named markers
     (`dbt_project.yml`, `airflow.cfg`/`dags/`, a Dagster/Prefect import+decorator pair)
     — a bespoke-scheduler guess never sets it true, by design.
   - For each `declared_sequences` entry, report the `execution_order` as fact — it's
     derived from real dependency edges (dbt's `depends_on`, Airflow's `>>`/`<<`/
     `set_downstream`), not inferred from prose. If `cycle_detected` is true, say so
     plainly and show the edges rather than picking an order. If a module's docstring
     claims a schedule/trigger (e.g. "runs nightly via the DAG") cross-check it against
     any matching `declared_sequences` entry — that's a disagreement worth surfacing if
     the DAG file doesn't actually wire what the docstring claims.
   - For each `disagreements` entry, state both values plainly; don't guess which one is
     right. Before reporting a low/zero disagreement count as clean, check
     `json_configs_no_scalar_keys` — a JSON file that's actually an ID-keyed lookup table
     (a benchmark/audience/score lookup — data, not settings) flattens to no comparable
     keys at all, the same as a genuinely empty config. If this count is close to (or
     equal to) the total number of `json_configs`, say so explicitly: "0 disagreements"
     here means nothing was comparable, not that everything was checked and agreed.
   - For each `cross_reference_candidates` group, actually read both docstrings/modules
     and judge whether they describe the same process. Only report it as a real conflict
     if they do — the script grouped them by name similarity alone, it didn't check
     meaning.
   - For each `undeclared_dependencies` hit, sanity-check it isn't a false positive (a
     common word or generic filename that happens to match). Drop the noise; keep what
     looks like a genuine external reference nothing upstream declares.
   - For each `gap_candidates` entry (tribal/motivational/ownership), write one short,
     specific question per gap — not "tell me about this pipeline." Use the pattern:
     here's what we found, here's what's missing, here's what we need from you to close
     it.
   - For `release_convention` freshness flags, state plainly what the pointer (whatever
     it's named — `current`, `latest`, `stable`, `prod`) points to vs. the latest version
     by the detected convention, and ask whether that's intentional. If the entry has a
     `note` instead of a `latest_by_convention` (e.g. git-sha-named versions), say
     explicitly that freshness can't be determined from names alone — don't guess.

5. **Read `known_framework_detected` and `root_readme` together — they're the mechanical
   trigger for whether an empty `declared_sequences` means "uncovered," "declared but not
   parseable," "known but no graph available," or "genuinely nothing here." Never let a
   thin result read as "nothing to report" without checking which of these four it
   actually is:**
   - **`known_framework_detected: false`, and either `root_readme` is `null` or reading it
     turns up no process description** — no dbt/Airflow/Dagster/Prefect marker anywhere in
     the tree, and nothing in the repo's own docs describes a process order either. An
     empty `declared_sequences` here means the stack is **uncovered**, not that the
     pipeline has no execution order — the case a bespoke Go scheduler, Temporal, or any
     other genuinely unsupported stack falls into. Fall through to reading the relevant
     code/config directly by hand.
   - **`known_framework_detected: false`, but `root_readme` is present and it *does*
     describe a process order in prose (a workflow narrative, a linked diagram, "first run
     X then Y")** — this is a real, distinct middle ground: the order **is** declared, the
     team just never formalized it into anything `scan.py` can parse into a graph. Don't
     call this "uncovered" (someone did declare it) or "genuinely none" (it exists).
     Reconstruct the order by hand — the README's prose plus each script's own CLI arg
     names/docstrings usually correlate directly (an `--audience_json` input arg matching
     another script's `--output` is a real edge, found by reading, not parsing). Mark it
     **inferred**, and say explicitly in the report that the process is declared but not
     mechanically extractable, as its own category — not folded into "uncovered."
   - **`known_framework_detected: true`, but `declared_sequences` is still empty** — a
     real framework marker was found, but this pass has no mechanical graph for it: either
     a `dbt_project.yml` with no committed `manifest.json` (the project exists, nothing
     compiled it), or a Dagster/Prefect import was detected but this pass only checks
     presence — it doesn't extract an asset/flow graph (see `references/frameworks/`).
     Say plainly which of these two it is; this is narrower than "uncovered," since the
     framework itself is known, there's just no graph available from what's in the repo
     today.
   - **Neither of the above** — `declared_sequences` has real entries (report as usual),
     or `known_framework_detected` is `false`, `root_readme` was read and confirmed to
     describe nothing process-related, and a careful look confirms this pipeline genuinely
     has no scheduler/DAG of any kind (rare; say so plainly).

   In the first three cases, mark anything recovered by hand-reading as **inferred**, not
   mechanical, in the report (see the provenance summary in the output template) — a
   completed, lower-confidence finding, never a blocker.

6. **Capture what you learn from that fallback reading, locally.** The moment you
   hand-recover something reusable against an undocumented stack — a scheduler
   convention, a write-path shape, a naming pattern — write it down immediately, at zero
   cost to whoever's running this:
   - Append it to `.pipeline-context-learnings/<slug>.md` in the *target* repo. Never
     commit this alongside the client's own code — before the first write in a given
     target repo, check its `.gitignore` for `.pipeline-context-learnings/`; if it's
     missing, add the entry and say out loud that you did. A learnings file must never
     land silently in a client's diff.
   - On a fresh run against a repo that already has `.pipeline-context-learnings/`
     content, surface "N uncontributed learnings from past runs here" as a passive
     nudge in the report — never a gate on finishing the current one.
   - Promoting a learning into a maintained `references/frameworks/*.md` entry is a
     separate, later, optional step: open a PR against wherever this skill itself is
     maintained, once someone has time to review it. Never require that round-trip for
     the learning to exist or to be picked up on the next run against the same repo — and
     never promote it without a pass to strip anything client-identifying (real names,
     table/field names, business logic specifics) first, since a promoted reference is
     shared across every future engagement this skill runs against.

7. **Build at least one diagram as a standard part of every report — not a special
   request, not something to wait to be asked for.** This skill stays agnostic to *how*
   the findings get drawn; rendering is delegated to a view-specific subagent per
   [`references/views/`](./references/views/), not done inline here.

   - **Decide which view(s) are needed.** Default to the ERD/execution-order view
     (`erd-view.md`) — that's the right answer for "what runs before what," and for most
     requests. Switch to the taxonomy view (`taxonomy-view.md`) instead — or in addition —
     when the request is really about how rows get classified into business categories and
     whether that classification holds across pipeline stages, not about execution order
     (e.g. "trace how this business logic/metric definition is implemented across these
     models," "what taxonomy applies to these facts"). When it's genuinely ambiguous which
     one fits, ask rather than default silently. Both can run in the same pass — dispatch
     them in parallel (see below), not one after the other.

   - **Assemble each view's input** from what's already been gathered:
     - *For `erd-view.md`*: the `declared_sequences` execution order, the inferred order
       from step 5's fallback reading, confirmed `undeclared_dependencies` from
       backward-trace, and any named-but-unreachable external systems found while reading.
       All of this already exists from steps 4–6 — no new reading needed.
     - *For `taxonomy-view.md`*: this needs a read `scan.py` doesn't do — go find each
       category rows get sorted into (per pipeline stage) and its isolation rule (a
       `WHERE`/`CASE WHEN`, join condition, dimension flag, or timestamp window), reading
       compiled model SQL, metric/semantic-layer definitions, and docs. Frame each category
       around a concrete business scenario, not an abstract label — see `taxonomy-view.md`'s
       "Framing the output" section before assembling this. Tag each one
       mechanical (rule read directly from code/config) or inferred (concluded from other
       reading), note anything referenced only by name with no discoverable rule as a
       black-box category, and note anything filtered out entirely before the next stage
       (rather than mapped forward) as dropped. Also work out any hierarchy (parent/child
       categories within a stage) and stage-to-stage mappings (which downstream category a
       stage's rows land in next) that you can support from what you read.

   - **Dispatch to the matching subagent(s)** (`visualize-erd`, `visualize-taxonomy` —
     install them first per step 0 if not already reachable), each with: the resolved
     absolute path to its convention doc (`$SKILL_DIR/references/views/<view>.md`), and the
     assembled input above. Run multiple requested views as parallel dispatches, not
     sequential ones. Each subagent returns only its provenance banner + Mermaid block (or
     a one-line "nothing to draw" statement) — splice that verbatim into the report, one
     section per view (see the output template below); don't re-derive or edit what a
     subagent returns.

   - **Fall back to rendering inline if dispatch itself isn't available.** Per step 0's
     known limitation, a subagent bootstrapped earlier in this same run may not yet be a
     dispatchable agent type — if the dispatch attempt fails on "agent type not found"
     (rather than the subagent running and reporting a real problem), don't block the
     report or leave the section empty: read that view's convention doc directly yourself
     and render the diagram inline, following it exactly as the subagent would have. Same
     output, same rules, just done in the current context instead of delegated — this is a
     fallback for *this run only*, not a reason to stop dispatching in future runs once the
     subagent is actually reachable (confirmed in testing: as soon as the next turn/request
     — not a full new session — the agent-type registry picks it up and real dispatch
     works normally; this typically only fires once per machine, since `~/.claude/agents/`
     is global).

   - **Skip a given view only when there's genuinely nothing to draw for it** (per its own
     convention doc) — e.g. the ERD view has zero `declared_sequences`, zero
     backward-trace hits, and no inferred edges; the taxonomy view was handed no
     categories at all. Say explicitly why in that view's section rather than silently
     omitting it. This is distinct from a view that was never requested at all (a
     taxonomy-only ask has no reason to attempt the ERD view) — see the output template.

8. **Write a brief, best-effort description of what this pipeline actually does, at the
   top of the report.** Synthesize it from everything already read in the steps above —
   the README, docstrings, CLI help text, code read while reconstructing execution order
   or building the ERD — this is not a fresh research pass, just a summary of what you
   already gathered. A few sentences to a short paragraph: what the pipeline is for, and
   the shape of what it does — not a restatement of every section below it. State plainly
   that it's inferred from reading, not confirmed with anyone on the team. If the target
   has essentially no documentation to synthesize from, say that plainly instead of
   guessing.

9. **Scale the report to what was actually found.** Zero disagreements and zero
   undeclared dependencies means a short report. Several of either means don't compress
   them into one line each — this is where the real risk is.

10. **Write the output doc** (structured, not conversational) using the template below —
    a single `.md` file containing every section, including the process description and
    the rendered Mermaid diagram, not separate outputs to reassemble by hand. Name every
    category the tool didn't check (execution-order, silent-defect, parallel-authority)
    explicitly rather than letting their absence read as "checked and clean." Write it to
    a stable local path *outside* the scanned target (see "Where to write it" below) —
    the target itself may not persist (a temporary clone, a CI checkout, a directory
    someone deletes right after this runs), and the report must survive regardless.
    Confirm the file actually exists at that path — read it back, don't just trust the
    write command's exit code — before doing anything else that could remove the target
    (deleting a clone, etc.).

11. **Pass the written report through `plain-style`, if it's installed.** This is a soft
    dependency — `gather-context` works fully without it. If step 0 found
    `$STYLE_SKILL_DIR`, dispatch to `apply-style-guide` with the resolved path to
    `$STYLE_SKILL_DIR/references/style-guide.md`, the report's full text, and note that the
    internal-use-only notice, every Mermaid block, code block, file path, and the
    provenance banners are out of scope — reproduce those exactly, revise everything else.
    Same inline-fallback rule as step 7's dispatches: if `apply-style-guide` isn't
    dispatchable yet this session (freshly bootstrapped, same known limitation), read
    `style-guide.md` yourself and apply it directly instead of blocking. Overwrite the
    report with the revised text and confirm the write landed the same way step 10 does.
    If `$STYLE_SKILL_DIR` is empty (not installed), skip the dispatch and leave the report
    untouched — never note its absence in the report itself; unlike a skipped
    backward-trace, this doesn't change what the report found, only how it reads. Do say
    so out loud, once, in your conversational reply for this run (not written into the
    report file): something like "plain-style isn't installed, so this report's prose
    skipped the style pass — install it with `npx skills add
    snowpackdata/snowpack-ai-skills --skill plain-style` to get it automatically." This
    is a spoken nudge for whoever's running it right now, not a gate on finishing the
    report and not a permanent record inside it.

## Where to write it

Default: `~/gather-context-reports/<target-basename>/process_context_report.md`
(create the directory if it doesn't exist) — never solely inside the target itself, and
never inside a copy of the target you know will be deleted or is otherwise transient.
This is a plain local path, not gitignored by anything, because it's not inside any repo
to begin with. Deliberately not a dot-directory (`~/.gather-context/`, an earlier version
of this default) — this holds a deliverable someone wants to read and navigate to, not
internal tool config, and a leading dot hides it from Finder/Explorer by default, which
defeats the point.

If the user also wants a copy inside the target repo for convenience (easy to find right
where they're working, easy to share/commit if they choose to), write one there too — but
only after the external copy above is confirmed to exist, and only into a location the
target's own `.gitignore` covers: append the path to `.gitignore` the same way
`.pipeline-context-learnings/` is handled (see step 6), and say out loud that you did.
Never let the report land somewhere it could show up in a diff of the client's own repo.

## Output template

Write `process_context_report.md` per "Where to write it" above:

```markdown
**Internal Snowpack use only — do not share directly with the client.** This report may
contain unfiltered tribal/motivational/ownership gaps, candid disagreement findings, and
inferred judgment calls not yet vetted for external framing.

# Process Context Report — <target>

## What this pipeline does (best-effort synthesis, not verified)
<a few sentences to a short paragraph: what this pipeline is for and the shape of what it
does, synthesized from the README/docstrings/CLI help/code already read during this pass --
not a fresh research pass, and not confirmed with anyone on the team. If there's
essentially no documentation to synthesize from, say that plainly here instead of
guessing.>

## Provenance summary
<one line, e.g. "3 findings mechanically derived (scan.py) · 5 findings inferred (direct
code/doc reading) · 2 gaps unresolved". Every section below should trace back to one of
these buckets -- never let an inferred finding read with the same certainty as a
mechanical one. The same split applies to every diagram below, per whichever
references/views/*.md convention rendered it -- same principle, applied to nodes/edges
instead of bullets.>

## Detected stack
<one entry per detected_stack item: signal, category, confidence, evidence path -- report
low/medium-confidence bespoke-scheduler entries as candidates to verify, not verdicts>
<state known_framework_detected plainly (true/false), and root_readme (path or "none") --
together they decide how to read an empty Execution order section below>

## Execution order
<one entry per declared_sequences item: source, kind, and the execution_order -- label
this "mechanically derived from dbt manifest / Airflow DAG wiring" when declared_sequences
is non-empty>
<if cycle_detected: true, say so explicitly and show the edges -- do not guess an order>
<if declared_sequences is empty, known_framework_detected is false, and root_readme is
null or was read and found to describe no process: say so explicitly -- this means
"uncovered," not "no order exists" -- and report what fallback reading (step 5) found
instead, marked inferred>
<if declared_sequences is empty, known_framework_detected is false, but root_readme (or
other docs) describes a process order in prose: state plainly that the order is DECLARED
but not mechanically parseable -- a distinct category from "uncovered." Give the
reconstructed order (e.g. from CLI arg names correlating across scripts) marked inferred,
and name the doc it came from.>
<if declared_sequences is empty and known_framework_detected is true: say which framework
was found and why no graph is available (no committed manifest, or a framework this pass
only detects the presence of and doesn't extract -- see references/frameworks/) --
narrower than "uncovered," but still no mechanical order to report>
<if declared_sequences is empty, known_framework_detected is false, root_readme was read
and confirmed to describe nothing process-related, and a careful look confirms there's
genuinely no scheduler/DAG at all (rare): "No dbt manifest or DAG wiring found, and
nothing in the repo's own docs describes a process order either -- treat it as tribal
knowledge (see gaps below) rather than assuming there's none.">

## Declared, and disagreeing
<one entry per real disagreement, both values shown, no guess at which is right>
<if json_configs_no_scalar_keys is close to or equal to the total json_configs count: say
so explicitly -- "0 disagreements" here means nothing was comparable (the json files are
ID-keyed lookup tables/data, not scalar config), not that everything was checked and
agreed>

## Externalized dependencies found (backward-trace)
<one entry per confirmed undeclared_dependency, after filtering false positives>
<or: "No consumer artifacts were available to trace — externalized-dependency risk is unknown, not clean.">

## Freshness
<current-vs-latest-dated-release flags, or "no dated-release convention found">

## ERD / data-flow diagram
<omit this section entirely, with a one-line note why, only when step 7 determined the
request is taxonomy-only and this view was never attempted -- that's different from
attempting it and finding nothing to draw. Otherwise: the rendered response (subagent's,
or this run's own inline fallback per step 7 if dispatch wasn't available), verbatim
(provenance banner + Mermaid ```mermaid fence), built by default per step 7 -- see
references/views/erd-view.md. Only if genuinely nothing to draw: "No ERD produced this run
-- nothing to draw: <one-line reason>." Never the default outcome; always name the reason
when it happens.>

## Taxonomy view
<only present when step 7 determined this view was needed -- omit the section entirely
otherwise, don't include it empty. The rendered response (subagent's, or this run's own
inline fallback per step 7 if dispatch wasn't available), verbatim (provenance banner +
Mermaid ```mermaid fence) -- see references/views/taxonomy-view.md. If genuinely nothing
to draw, say so with a one-line reason instead.>

## Gaps needing a person to close (confirm or correct)
- [ ] <specific question 1>
- [ ] <specific question 2>

## Uncontributed learnings
<"N entries in .pipeline-context-learnings/ from this or past runs, not yet promoted to
references/frameworks/" or "none">

## Not checked by this pass
- Execution-order / silent-latent-defect complexity (would need a dark-launch run against shadowed destinations)
- Parallel-authority complexity (needs simultaneous access to more than one live system)
```

## Notes

- The script's `disagreements` and `undeclared_dependencies` are candidates, not
  verdicts — always read them before writing them into the report.
- If the target has no detectable versioning convention at all, `release_convention`
  will be empty — that's a fine and expected result for a non-versioned pipeline, not a
  gap.
- An empty `.pipeline-context-learnings/` is the common, expected case — not a sign
  anything's wrong.
- `detected_stack` fingerprints language/orchestration markers structurally (manifests,
  imports, a corroborated scheduler-filename heuristic) — it does not cover managed cloud
  schedulers declared only in IaC (a Terraform `google_cloud_scheduler_job`, a
  `serverless.yml` schedule trigger) or SaaS/reverse-ETL integrations referenced only by
  name in config/env vars. Say so if either seems relevant to the target; don't let their
  absence from `detected_stack` read as "checked and not present."
- `root_readme` only checks the scanned root's immediate directory for a file named
  `README*` — it says nothing about the content, and it's not recursive (a nested suite's
  own README, e.g. `some_suite/README.md`, doesn't set this). Its only job is to remind the
  interpretation step to actually go read it before concluding a process order is
  genuinely undeclared.
- `json_configs_no_scalar_keys` catches one specific shape (a dict whose every value is
  itself a dict/list — an ID-keyed lookup table), not every way a JSON file can fail to
  yield a comparable scalar. A top-level JSON *list* isn't parsed into `json_configs` at
  all today (`parse_json_file` returns `None` for it) — a real, separate, still-open gap,
  not one this field covers.
- The report's default location is `~/gather-context-reports/`, outside the target, on
  purpose — a report written only inside the scanned target doesn't survive if the target
  is a temporary clone that gets deleted afterward (this happened in practice: a test run
  wrote the report inside a scratch clone, the clone was deleted per its own cleanup step,
  and the report went with it — the only surviving copy was pasted conversation text, not
  a file). Writing outside the target first, and confirming it landed, closes that gap.
- This directory is deliberately not dot-prefixed (an earlier version used
  `~/.gather-context/`) — a leading dot hides it from Finder/Explorer by default, which
  is exactly wrong for a location that holds something a person wants to open and read.
- Diagram rendering used to be inline in this file, scoped to one view (an ERD). It's now
  delegated to view-specific subagents (`references/views/`, `.claude/agents/visualize-*`)
  so this skill's own judgment layer stays agnostic to *how* findings get drawn — adding a
  new view (an ownership map, a sequence diagram) means adding a new convention doc +
  subagent pair, not touching step 7's dispatch logic.
- Confirmed in testing: a subagent this run just bootstrapped (step 0) is not reliably
  dispatchable in that same session — the fix is step 7's inline-rendering fallback, not
  something to "wait out." Don't treat a dispatch failure here as a real problem with the
  target or the findings; it's a session-timing artifact of subagent installation, and the
  fallback produces the same report section regardless.
- `plain-style` is a genuinely optional, separately-installed skill. Its absence is never
  flagged inside the report itself — it changes how the report reads, not what it found —
  but step 11 does mention it once in the conversational reply for that run, so its
  absence doesn't go unnoticed by whoever's actually running it. Install it (see its own
  repo entry) if you want every `gather-context` report to get the same style pass
  automatically.

## Install

```bash
npx skills add snowpackdata/snowpack-ai-skills --skill gather-context
```

Manual fallback (always works): `cp -r skills/review/gather-context ~/.claude/skills/`.

Either way, the Step 0 bootstrap above handles installing the bundled `visualize-*`
subagents to `~/.claude/agents/` the first time step 7 needs them — no separate setup
step.
