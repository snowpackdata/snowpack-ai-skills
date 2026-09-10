#!/usr/bin/env python3
"""
scan.py — mechanical half of the pipeline-context-gathering tool.

This script does ONLY what's safe to automate: parse declared/explicit
artifacts, detect mechanical disagreements between them, flag freshness
drift in dated-release conventions, and backward-trace consumer artifacts
against what's actually declared upstream.

It deliberately does NOT try to judge tribal, motivational, ownership, or
semantic (docstring-says-X-but-code-does-Y) context — that requires human
judgment or an LLM reading the surfaced candidates, which is the skill's
job (see skills/gather-context/SKILL.md). This script's output is raw
material for that judgment call, not a finished report.

Scope boundary (see references/taxonomy.md #0): only meant to run against
something operational today. It has no way to detect "this doesn't exist
yet" on its own — that check belongs to whoever points the tool at a path.

Usage:
    scan.py declared <path> [--out FILE]
    scan.py backward-trace <path> --consumers FILE [FILE ...] [--out FILE]

Stdlib only. No third-party dependencies, on purpose — this needs to run
on a fresh, disposable box with nothing pre-installed.
"""

import argparse
import ast
import json
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "__pycache__", "node_modules", "vendor", ".DS_Store"}
# "vendor" added alongside node_modules: a vendored Go/PHP/Ruby dependency
# tree is never a declared fact of the pipeline itself, and without this a
# vendored copy of a real scheduling library (e.g. vendor/.../cron.go) would
# false-positive the bespoke-scheduler heuristic below on someone else's code.
VENV_DIR_RE = re.compile(r"^\.?venv", re.IGNORECASE)
# prefix match, not an exact set -- real repos name virtualenvs all sorts of
# ways (.venv, venv, .venv_rcr, .venv_icp, ...) and a fixed literal list will
# always miss one on a real target (found on a client's ML pipeline: a single
# non-standard venv dir alone was 12k+ files of third-party package noise)


def _is_skip_dir(name: str) -> bool:
    return name in SKIP_DIRS or bool(VENV_DIR_RE.match(name))


README_NAME_RE = re.compile(r"^readme(\.\w+)?$", re.IGNORECASE)


def find_root_readme(root: Path):
    """Cheap, structural: does the scanned root have a README file at all?
    Not a judgment about its content -- just a mechanical pointer so the
    skill knows to actually read it before concluding an empty
    declared_sequences means "genuinely no process order exists." A process
    can be genuinely declared (prose + a linked diagram, e.g.) without being
    machine-parseable into a graph -- that's a real, distinct middle ground
    between "uncovered" and "nothing declared," and this script has no way
    to judge prose content itself, only to point at where it might be."""
    try:
        children = list(root.iterdir())
    except OSError:
        return None
    for c in children:
        if c.is_file() and README_NAME_RE.match(c.name):
            return str(c.relative_to(root))
    return None
CATEGORY_RE = re.compile(r"category=([\w.\-]+)")
L2_RE = re.compile(r"l2=([\w.\-]+)")
IDENTIFIER_TOKEN_RE = re.compile(r"[A-Za-z_][\w]*(?:[./][A-Za-z_][\w]*)+")
_VERSION_KEYWORDS = ("release", "version", "build", "deploy", "snapshot")
_NON_LETTER_RE = re.compile(r"[^a-zA-Z]+")


def _has_version_keyword(name: str) -> bool:
    """Token-prefix match, not a substring search -- 'version' is a
    substring of 'conversion' and a plain regex search on real directory
    names (found on a client engagement: a `conversion_rate_predictions`
    directory, mislabeled as
    a release convention by this exact bug) will false-positive on it. `\\b`
    doesn't fix this either, since underscore counts as a word character in
    regex -- 'release_20260801' has no \\b before '_20260801'."""
    tokens = [t for t in _NON_LETTER_RE.split(name.lower()) if t]
    return any(t.startswith(kw) for t in tokens for kw in _VERSION_KEYWORDS)

# (name, regex, order). Order tells _sort_key how to rank matches to find
# "latest" -- not every convention can be ranked from the name alone.
# Not tied to any one pipeline's naming; these are generic conventions seen
# across engagements (a client's timestamped releases, semver-tagged model
# artifacts, incrementing build dirs, git-sha-named snapshots).
VERSION_PATTERNS = [
    ("iso_timestamp", re.compile(r"^\d{8}T\d{6}Z$"), "lexicographic"),
    ("date", re.compile(r"^\d{4}-\d{2}-\d{2}$"), "lexicographic"),
    ("semver", re.compile(r"^v?\d+\.\d+\.\d+$"), "semver"),
    # requires a letter so it doesn't collide with a directory of plain
    # numeric IDs (e.g. a client's platform IDs) that happen to be 7+ digits
    ("git_sha", re.compile(r"^(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$"), "unorderable"),
    # weakest signal -- a bare numeric/"build-123" dir is common for lots of
    # non-release things, so this one only gets reported when corroborated
    # (see detect_release_convention)
    ("build_number", re.compile(r"^(?:build-|release-)?\d+$"), "numeric"),
]


def _version_sort_key(name, order):
    if order == "lexicographic":
        return name
    if order == "semver":
        return tuple(int(x) for x in re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", name).groups())
    if order == "numeric":
        return int(re.search(r"(\d+)$", name).group(1))
    raise TypeError(f"'{order}' names aren't orderable by name alone")


def _matches_any_version_pattern(name: str) -> bool:
    return any(regex.match(name) for _, regex, _ in VERSION_PATTERNS)


def _is_versioned_path(rel_path: str) -> bool:
    return any(_matches_any_version_pattern(part) for part in Path(rel_path).parts)


def _topo_sort(nodes, edges):
    """Kahn's algorithm. Returns (order_or_None, cycle_detected). A cycle
    means we say so explicitly rather than emitting a silently-wrong order —
    an actual cycle in a declared DAG/manifest is itself a real finding."""
    from collections import deque

    indegree = {n: 0 for n in nodes}
    adj = {n: [] for n in nodes}
    for a, b in edges:
        indegree.setdefault(b, 0)
        adj.setdefault(a, [])
        adj[a].append(b)
        indegree[b] += 1
        indegree.setdefault(a, 0)
        adj.setdefault(b, [])

    queue = deque(sorted(n for n, d in indegree.items() if d == 0))
    remaining = dict(indegree)
    order = []
    while queue:
        n = queue.popleft()
        order.append(n)
        for m in sorted(adj[n]):
            remaining[m] -= 1
            if remaining[m] == 0:
                queue.append(m)
    if len(order) != len(indegree):
        return None, True
    return order, False


def iter_files(root: Path):
    for p in root.rglob("*"):
        if any(_is_skip_dir(part) for part in p.parts):
            continue
        if p.is_file():
            yield p


def iter_dirs(root: Path):
    for p in root.rglob("*"):
        if any(_is_skip_dir(part) for part in p.parts):
            continue
        if p.is_dir():
            yield p


# ---------------------------------------------------------------------------
# declared-artifact parsing
# ---------------------------------------------------------------------------

def load_json(path: Path):
    """Returns parsed data or None on any decode failure. Load once per file
    and pass the result around, rather than re-reading -- a manifest.json can
    be large enough that re-parsing it per check adds up."""
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def parse_json_file(path: Path, root: Path, data=None):
    if data is None:
        data = load_json(path)
    if not isinstance(data, dict):
        return None
    flat = {k: v for k, v in data.items() if isinstance(v, (str, int, float, bool))}
    return {
        "source": str(path.relative_to(root)),
        "kind": "json_config",
        "keys": flat,
        # A dict whose every value is itself a dict/list (an ID-keyed lookup
        # table -- a benchmark_lookup.json, an audience_selection.json --
        # data, not settings) flattens to {} exactly the same as a genuinely
        # empty config. Without this flag, find_disagreements silently has
        # nothing to compare on an entire class of repo and "0 disagreements"
        # reads as checked-and-clean when it's really "nothing was
        # comparable" -- surfaced explicitly instead (see
        # json_configs_no_scalar_keys in run_declared_scan).
        "has_scalar_keys": bool(flat),
        "mtime": path.stat().st_mtime,
    }


def parse_python_file(path: Path, root: Path, tree=None, text=None):
    if text is None:
        text = path.read_text()
    if tree is None:
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return None
    docstring = ast.get_docstring(tree)
    cli_args = sorted(set(re.findall(r"add_argument\(\s*['\"](--?[\w\-]+)['\"]", text)))
    return {
        "source": str(path.relative_to(root)),
        "kind": "python_module",
        "has_docstring": bool(docstring),
        "docstring": docstring,
        "cli_args": cli_args,
        "mtime": path.stat().st_mtime,
    }


# ---------------------------------------------------------------------------
# execution-order parsing -- declared/explicit artifacts that encode SEQUENCE,
# not just individual facts. Mechanically derived, not a docstring-based
# guess: dbt's manifest.json depends_on graph, and Airflow's `>>`/`<<`/
# set_downstream/set_upstream task wiring.
# ---------------------------------------------------------------------------

def _is_dbt_manifest_shape(data) -> bool:
    if not isinstance(data, dict):
        return False
    nodes = data.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        return False
    # require at least one node to actually have a depends_on.nodes list --
    # otherwise this is just some other json file that happens to have a
    # "nodes" key
    return any(
        isinstance(n, dict) and isinstance(n.get("depends_on", {}).get("nodes"), list)
        for n in nodes.values()
    )


def parse_dbt_manifest(path: Path, root: Path, data):
    nodes = data["nodes"]
    node_name = {uid: n.get("name", uid) for uid, n in nodes.items()}
    edges = []
    for uid, node in nodes.items():
        for dep in node.get("depends_on", {}).get("nodes", []):
            if dep in node_name:  # dbt manifests also list source/macro deps we're not graphing here
                edges.append((node_name[dep], node_name[uid]))

    all_names = set(node_name.values())
    order, cycle = _topo_sort(all_names, edges)
    return {
        "source": str(path.relative_to(root)),
        "kind": "dbt_manifest",
        "node_count": len(nodes),
        "edges": [{"from": a, "to": b} for a, b in edges],
        "execution_order": order,
        "cycle_detected": cycle,
    }


def _names_in_expr(expr):
    """ast.Name -> [name]; ast.List/Tuple of Names -> flattened list; anything
    else -> [] (best-effort static analysis, not a full interpreter)."""
    if isinstance(expr, ast.Name):
        return [expr.id]
    if isinstance(expr, (ast.List, ast.Tuple)):
        out = []
        for e in expr.elts:
            out.extend(_names_in_expr(e))
        return out
    return []


def _chain_stages(expr, op_type):
    """Flatten a left-associative chain of same-direction BinOps (`a >> b >> c`
    parses as `(a >> b) >> c`, NOT a flat chain) into ordered stages, each a
    list of names -- so `a >> [b, c] >> d` yields [[a], [b, c], [d]] and both
    hops get an edge, not just the outermost one."""
    if isinstance(expr, ast.BinOp) and isinstance(expr.op, op_type):
        return _chain_stages(expr.left, op_type) + _chain_stages(expr.right, op_type)
    return [_names_in_expr(expr)]


def parse_airflow_dag(path: Path, root: Path, text: str, tree):
    """Best-effort static extraction of task wiring: `a >> b`, `a << b`,
    `a.set_downstream(b)`, `a.set_upstream(b)`, including list forms
    (`a >> [b, c]`). Only runs on files that actually mention airflow/DAG,
    to avoid false positives on unrelated `>>` bit-shift code."""
    if "airflow" not in text and "DAG(" not in text:
        return None

    var_to_task_id = {}
    edges = set()  # a set: chain flattening below visits both the outer AND
    # inner nested BinOp nodes, which would otherwise double-record the same
    # hop -- see _chain_stages' docstring for why the nesting happens at all.

    class Visitor(ast.NodeVisitor):
        def visit_Assign(self, node):
            if (
                len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Call)
            ):
                var = node.targets[0].id
                task_id = var
                for kw in node.value.keywords:
                    if kw.arg == "task_id" and isinstance(kw.value, ast.Constant):
                        task_id = kw.value.value
                var_to_task_id[var] = task_id
            self.generic_visit(node)

        def visit_BinOp(self, node):
            if isinstance(node.op, (ast.RShift, ast.LShift)):
                stages = _chain_stages(node, type(node.op))
                for i in range(len(stages) - 1):
                    for a in stages[i]:
                        for b in stages[i + 1]:
                            # `a >> b` means a runs before b; `a << b` means
                            # b runs before a -- flip the edge direction only
                            edges.add((a, b) if isinstance(node.op, ast.RShift) else (b, a))
            self.generic_visit(node)

        def visit_Call(self, node):
            if isinstance(node.func, ast.Attribute) and node.func.attr in ("set_downstream", "set_upstream"):
                if isinstance(node.func.value, ast.Name):
                    src = node.func.value.id
                    for arg in node.args:
                        for tgt in _names_in_expr(arg):
                            if node.func.attr == "set_downstream":
                                edges.add((src, tgt))
                            else:
                                edges.add((tgt, src))
            self.generic_visit(node)

    Visitor().visit(tree)
    if not edges:
        return None

    resolved = sorted({(var_to_task_id.get(a, a), var_to_task_id.get(b, b)) for a, b in edges})
    all_tasks = {n for pair in resolved for n in pair}
    order, cycle = _topo_sort(all_tasks, resolved)
    return {
        "source": str(path.relative_to(root)),
        "kind": "airflow_dag",
        "task_count": len(all_tasks),
        "edges": [{"from": a, "to": b} for a, b in resolved],
        "execution_order": order,
        "cycle_detected": cycle,
    }


# ---------------------------------------------------------------------------
# stack-identification / fingerprinting -- runs first, decides which
# references/frameworks/*.md applies and whether an empty declared_sequences
# means "genuinely nothing here" or "uncovered by this scan." Structural
# signals only (file presence, a manifest's own dependency import, a short
# corroborated call-pattern list) -- no attempt to extract a dependency
# graph for anything beyond dbt/Airflow; a new framework's own parser
# (Dagster's asset graph, etc.) is separate, later work, not this pass.
#
# Explicitly NOT covered here (named, not silently dropped): managed cloud
# schedulers declared only in IaC (a Terraform google_cloud_scheduler_job, a
# serverless.yml `schedule:` trigger), and SaaS/reverse-ETL integrations
# referenced by name in config/env vars. Both are real gaps the original
# issue named that this pass doesn't close.
# ---------------------------------------------------------------------------

LANGUAGE_MANIFESTS = [
    ("go", "go.mod"),
    ("python", "requirements.txt"),
    ("python", "pyproject.toml"),
    ("ruby", "Gemfile"),
    ("rust", "Cargo.toml"),
    ("java", "pom.xml"),
]

# Filename token match -- same tokenizer as _has_version_keyword (split on
# non-letters, prefix-match), language-agnostic on purpose: a Go, Python, or
# JS scheduler all surface the same way without hardcoding any one language.
SCHEDULER_FILENAME_KEYWORDS = ("scheduler", "cron", "jobrunner")
# Ambiguous enough alone (a stock-ticker UI widget, a price-ticker feed) that
# a bare filename match is noise -- only ever reported when a real
# scheduling call also shows up in the same file.
SCHEDULER_FILENAME_NEEDS_CORROBORATION = ("ticker",)

SCHEDULER_CALL_PATTERNS = [
    re.compile(r"\btime\.NewTicker\b"),        # Go
    re.compile(r"\bsetInterval\s*\("),         # JS/TS
    re.compile(r"\bschedule\.every\b", re.I),  # Python `schedule` package
    re.compile(r"\bAPScheduler\b"),            # Python
    re.compile(r"\bcron\.New\b"),              # Go cron libraries
    re.compile(r"@Scheduled\b"),               # Spring/Java
]

# Require the import AND the decorator in the same file, not either/or --
# `@job`/`@asset` alone false-positives on unrelated frameworks (python-rq's
# own decorator API is `from rq.decorators import job; @job(...)`, nothing
# to do with Dagster).
DAGSTER_IMPORT_RE = re.compile(r"^\s*(?:import dagster|from dagster\b)", re.MULTILINE)
DAGSTER_DECORATOR_RE = re.compile(r"@(?:asset|job|repository)\b")
PREFECT_IMPORT_RE = re.compile(r"^\s*(?:import prefect|from prefect\b)", re.MULTILINE)
PREFECT_DECORATOR_RE = re.compile(r"@(?:flow|task)\b")


def _safe_read(path: Path, max_bytes=1_000_000) -> str:
    """Best-effort text read for files this script has no other reason to
    open (anything outside .json/.py) -- caps the read so a binary or huge
    file that happens to match a filename heuristic doesn't cost a slow,
    pointless read. Returns "" on any failure, never raises."""
    try:
        if path.stat().st_size > max_bytes:
            return ""
        return path.read_text(errors="ignore")
    except OSError:
        return ""


def _scheduler_filename_signal(stem: str):
    """'plain' -> low-noise keyword match, reportable at low confidence on
    the filename alone. 'needs_corroboration' -> ambiguous keyword (ticker),
    reportable only once a real scheduling call is also found in the file.
    None -> no match. Same tokenizer as _has_version_keyword, for the same
    reason: a raw substring search would false-positive the way `version`
    does inside `conversion`."""
    tokens = [t for t in _NON_LETTER_RE.split(stem.lower()) if t]
    if any(t.startswith(kw) for t in tokens for kw in SCHEDULER_FILENAME_KEYWORDS):
        return "plain"
    if any(t.startswith(kw) for t in tokens for kw in SCHEDULER_FILENAME_NEEDS_CORROBORATION):
        return "needs_corroboration"
    return None


def detect_stack_markers(root: Path):
    """Presence-only checks that are cheap directory stats, not file reads --
    a separate, small walk from collect_declared_facts' per-file loop below
    (which handles the checks that need a file's actual content). Walks the
    whole tree, not just root: a monorepo's dbt project or DAGs folder is
    routinely nested (e.g. transform/dbt_project.yml), not always top-level.

    Returns (findings, known_framework_detected). known_framework_detected
    only ever reflects a real, named framework marker (dbt_project.yml,
    airflow.cfg/dags/) -- never the bespoke-scheduler heuristic, which lives
    entirely in collect_declared_facts' per-file loop and must never
    suppress the "uncovered, not clean" framing the way a real marker does.
    """
    findings = []
    known = False
    for d in [root] + list(iter_dirs(root)):
        rel = d.relative_to(root) if d != root else Path(".")
        for lang, filename in LANGUAGE_MANIFESTS:
            if (d / filename).exists():
                findings.append({"category": "language", "signal": lang,
                                  "confidence": "high", "evidence": str(rel / filename)})
        if (d / "dbt_project.yml").exists():
            findings.append({"category": "orchestration", "signal": "dbt", "confidence": "high",
                              "evidence": str(rel / "dbt_project.yml")})
            known = True
        if (d / "airflow.cfg").exists() or (d / "dags").is_dir():
            findings.append({"category": "orchestration", "signal": "airflow", "confidence": "high",
                              "evidence": str(rel / "airflow.cfg (or dags/)")})
            known = True
        if (d / "package.json").exists():
            # Deliberately not enumerating JS frameworks (vue/react/...) here
            # -- a fixed literal list always misses one; see VENV_DIR_RE's
            # docstring for the same lesson learned the hard way on a real
            # target. In the tree walk (not root-only) for the same monorepo
            # reason as dbt/airflow above -- a frontend package.json is
            # routinely nested (e.g. frontend/package.json), not top-level.
            findings.append({"category": "language", "signal": "javascript_typescript",
                              "confidence": "high", "evidence": str(rel / "package.json")})
    return findings, known


def detect_release_convention(root: Path):
    """Format-agnostic: look for any directory whose immediate children
    mostly match one of VERSION_PATTERNS (whatever convention that is —
    timestamps, semver, git shas, build numbers), then check for a pointer
    symlink inside it — under ANY name (current, latest, prod, stable,
    whatever) — and whether that pointer targets the most recent sibling
    by that convention's own ordering.

    Deliberately does not key off any one client's `category=`/`l2=`-style
    markers or the
    literal name `current` — those were one pipeline's naming, not what a
    release convention actually is."""
    findings = []
    candidates = [root] + list(iter_dirs(root))
    for d in candidates:
        try:
            children = list(d.iterdir())
        except OSError:
            continue
        subdirs = [c for c in children if c.is_dir() and not c.is_symlink()]
        if len(subdirs) < 2:
            continue

        best = None  # (pattern_name, order, matched_names)
        for pat_name, regex, order in VERSION_PATTERNS:
            matched = [c.name for c in subdirs if regex.match(c.name)]
            if len(matched) < 2:
                continue
            if pat_name == "build_number":
                # weak signal on its own -- only count it if something else
                # corroborates this is actually a release dir, not just a
                # folder of numeric IDs (e.g. a client's platform IDs)
                has_pointer_candidate = any(c.is_symlink() for c in children)
                name_hints = _has_version_keyword(d.name) or _has_version_keyword(d.parent.name)
                if not (has_pointer_candidate or name_hints):
                    continue
            if best is None or len(matched) > len(best[2]):
                best = (pat_name, order, matched)

        if best is None:
            continue
        pat_name, order, matched_names = best

        try:
            latest = sorted(matched_names, key=lambda n: _version_sort_key(n, order))[-1]
        except TypeError:
            latest = None

        entry = {
            "release_root": str(d.relative_to(root)) if d != root else ".",
            "convention_detected": pat_name,
            "versioned_children": sorted(matched_names),
        }
        if latest:
            entry["latest_by_convention"] = latest
        else:
            entry["note"] = (
                f"'{pat_name}' names can't be ranked by name alone (no inherent chronological "
                f"order) -- can't tell if a pointer is stale without external metadata."
            )

        pointers = []
        for c in children:
            if c.is_symlink():
                try:
                    target = c.resolve()
                except OSError:
                    continue
                if target.name in matched_names:
                    pointers.append({"pointer_name": c.name, "points_to": target.name})
        entry["pointers_found"] = pointers

        if not pointers:
            entry["freshness_flag"] = (
                "No pointer symlink found (e.g. current/latest/prod/stable) -- "
                "confirm how consumers know which version is live."
            )
        elif latest:
            stale = [p["pointer_name"] for p in pointers if p["points_to"] != latest]
            if stale:
                entry["freshness_flag"] = (
                    f"Pointer(s) {stale} do not point at the latest by {pat_name} ordering "
                    f"({latest}) -- confirm this is a deliberate pin, not stale."
                )
        findings.append(entry)
    return findings


def find_disagreements(json_facts):
    """Mechanical-only: same top-level key, present in >1 json config, different value.
    This is intentionally narrow — semantic disagreement (docstring says X, code does Y)
    is NOT attempted here; see cross_reference_candidates instead.

    Facts living under a dated-release-timestamp path are excluded: a dated
    release tree is *supposed* to differ from other dated releases (that's
    what versioning means), so comparing keys across them isn't a real
    disagreement — it would just flag every pipeline that has ever shipped
    a second release."""
    comparable = [f for f in json_facts if not _is_versioned_path(f["source"])]
    by_key = {}
    for fact in comparable:
        for k, v in fact["keys"].items():
            by_key.setdefault(k, []).append((fact["source"], v))
    disagreements = []
    for key, occurrences in by_key.items():
        distinct_values = {v for _, v in occurrences}
        if len(occurrences) > 1 and len(distinct_values) > 1:
            disagreements.append({"key": key, "occurrences": occurrences})
    return disagreements


def find_cross_reference_candidates(python_facts):
    """Group python modules that plausibly describe 'the same thing' by filename
    stem similarity, so the skill (not this script) can judge whether their
    docstrings actually agree. Mechanical grouping only, no semantic judgment."""
    by_stem = {}
    for fact in python_facts:
        stem = Path(fact["source"]).stem
        base = re.sub(r"(_v\d+|_old|_new|_legacy|_copy)$", "", stem)
        by_stem.setdefault(base, []).append(fact)
    return [
        {"group": base, "modules": [f["source"] for f in facts], "docstrings": [f["docstring"] for f in facts]}
        for base, facts in by_stem.items()
        if len(facts) > 1
    ]


def find_gap_candidates(root, json_facts, python_facts):
    gaps = []

    undocumented = [f["source"] for f in python_facts if not f["has_docstring"]]
    if undocumented:
        gaps.append({
            "type": "tribal",
            "summary": f"{len(undocumented)} python module(s) with no module docstring — "
                       f"no declared rationale for what they do or why.",
            "candidates": undocumented,
        })

    dirs_with_config = {Path(f["source"]).parent for f in json_facts}
    no_readme_dirs = sorted({
        str(d) for d in dirs_with_config
        if not list((root / d).glob("*.md"))
    })
    if no_readme_dirs:
        gaps.append({
            "type": "motivational",
            "summary": "Config file(s) with no README/markdown in the same directory — "
                       "the 'why' behind these values isn't declared anywhere nearby.",
            "candidates": no_readme_dirs,
        })

    has_codeowners = any(root.rglob("CODEOWNERS"))
    has_owner_field = any("owner" in f["keys"] or "maintainer" in f["keys"] for f in json_facts)
    if not has_codeowners and not has_owner_field:
        gaps.append({
            "type": "ownership",
            "summary": "No CODEOWNERS file and no owner/maintainer field in any parsed config — "
                       "who's actually responsible for this pipeline isn't declared anywhere.",
            "candidates": [],
        })

    return gaps


def collect_declared_facts(root: Path):
    """Used by cmd_declared (via run_declared_scan) -- walk once, return the
    raw fact lists, any mechanically-derived execution sequences (dbt
    manifest depends_on graphs, Airflow DAG task wiring), and the per-file
    half of stack-identification (Dagster/Prefect presence, bespoke-scheduler
    candidates) -- folded into this same walk rather than a second pass over
    every file, since a .py file's text/tree is already read here for
    parse_python_file/parse_airflow_dag and shouldn't be read twice. A
    manifest-shaped json file is routed to declared_sequences instead of
    json_configs -- its content isn't config key/values, so it shouldn't
    feed disagreement detection."""
    json_facts, python_facts, sequences = [], [], []
    stack_findings = []
    dagster_hit = prefect_hit = known_framework_detected = False

    for f in iter_files(root):
        text = None
        if f.suffix == ".json":
            data = load_json(f)
            if _is_dbt_manifest_shape(data):
                sequences.append(parse_dbt_manifest(f, root, data))
                # A successfully parsed manifest is a stronger signal than a
                # bare dbt_project.yml's mere presence -- must set this here
                # too, not just from detect_stack_markers' file-presence
                # check, or a repo with a compiled manifest but no project
                # file alongside it (e.g. only the build artifact is
                # checked in) would wrongly read as "no framework detected."
                known_framework_detected = True
                continue
            fact = parse_json_file(f, root, data=data)
            if fact:
                json_facts.append(fact)
        elif f.suffix == ".py":
            try:
                text = f.read_text()
                tree = ast.parse(text)
            except (SyntaxError, UnicodeDecodeError):
                continue
            fact = parse_python_file(f, root, tree=tree, text=text)
            if fact:
                python_facts.append(fact)
            dag_fact = parse_airflow_dag(f, root, text, tree)
            if dag_fact:
                sequences.append(dag_fact)
                known_framework_detected = True  # same reasoning as the dbt-manifest case above

            if not dagster_hit and DAGSTER_IMPORT_RE.search(text) and DAGSTER_DECORATOR_RE.search(text):
                stack_findings.append({"category": "orchestration", "signal": "dagster",
                                        "confidence": "high", "evidence": str(f.relative_to(root))})
                known_framework_detected = True
                dagster_hit = True  # presence-only -- one hit is enough, not extracting a graph here
            if not prefect_hit and PREFECT_IMPORT_RE.search(text) and PREFECT_DECORATOR_RE.search(text):
                stack_findings.append({"category": "orchestration", "signal": "prefect",
                                        "confidence": "high", "evidence": str(f.relative_to(root))})
                known_framework_detected = True
                prefect_hit = True

        # Runs for every file regardless of suffix -- reads text only for
        # filename-matched candidates (via _safe_read, size-capped), so this
        # costs nothing for the vast majority of files that don't match.
        signal = _scheduler_filename_signal(f.stem)
        if signal:
            candidate_text = text if text is not None else _safe_read(f)
            corroborated = any(p.search(candidate_text) for p in SCHEDULER_CALL_PATTERNS)
            if signal == "needs_corroboration" and not corroborated:
                pass  # bare "ticker"-style filename match, no scheduling call found -- too ambiguous to report
            else:
                stack_findings.append({
                    "category": "orchestration", "signal": "bespoke-scheduler",
                    "confidence": "medium" if corroborated else "low",
                    "evidence": str(f.relative_to(root)),
                })

    return json_facts, python_facts, sequences, stack_findings, known_framework_detected


def run_declared_scan(root: Path):
    """Used by cmd_declared -- the full declared-scan result dict."""
    json_facts, python_facts, sequences, file_stack_findings, known_from_files = collect_declared_facts(root)
    marker_findings, known_from_markers = detect_stack_markers(root)
    return {
        "root": str(root),
        "declared_facts": {"json_configs": json_facts, "python_modules": python_facts},
        # Count, not just a flag -- an "N of M had no scalar keys" number
        # tells the skill how much of find_disagreements' "0 disagreements"
        # below is a real clean result vs. nothing being comparable at all
        # (an ID-keyed lookup table -- data, not settings -- flattens to {}
        # the same as an empty config; see parse_json_file).
        "json_configs_no_scalar_keys": sum(1 for f in json_facts if not f["has_scalar_keys"]),
        "declared_sequences": sequences,
        "detected_stack": marker_findings + file_stack_findings,
        # Reflects only real, named framework markers (dbt_project.yml,
        # airflow.cfg/dags/, a Dagster/Prefect import+decorator pair) -- a
        # bespoke-scheduler filename/call-pattern guess never sets this true.
        # An empty declared_sequences with this false means "uncovered by
        # this scan," not "nothing to report" -- see SKILL.md's step 5. But
        # check root_readme before concluding that: a process can be
        # genuinely declared in prose/a diagram without being machine-
        # parseable into a graph -- a real third state, distinct from both
        # "uncovered" and "nothing declared."
        "known_framework_detected": known_from_markers or known_from_files,
        "root_readme": find_root_readme(root),
        "release_convention": detect_release_convention(root),
        "disagreements": find_disagreements(json_facts),
        "cross_reference_candidates": find_cross_reference_candidates(python_facts),
        "gap_candidates": find_gap_candidates(root, json_facts, python_facts),
    }


def cmd_declared(args):
    root = Path(args.path).resolve()
    if not root.exists():
        print(f"error: {root} does not exist", file=sys.stderr)
        sys.exit(1)
    _emit(run_declared_scan(root), args.out)


def collect_declared_identifiers(root: Path):
    """Used by cmd_backward_trace (via backward_trace)."""
    declared_ids = set()
    for f in iter_files(root):
        declared_ids.add(f.stem)
        if f.suffix == ".json":
            fact = parse_json_file(f, root)
            if fact:
                for k, v in fact["keys"].items():
                    declared_ids.add(k)
                    if isinstance(v, str):
                        declared_ids.add(v)
        m = CATEGORY_RE.search(str(f))
        if m:
            declared_ids.add(m.group(1))
        m = L2_RE.search(str(f))
        if m:
            declared_ids.add(m.group(1))
    return declared_ids


def backward_trace(root: Path, consumer_paths):
    """Used by cmd_backward_trace -- the full backward-trace result dict."""
    declared_ids = collect_declared_identifiers(root)
    undeclared = []
    for consumer_path in consumer_paths:
        cpath = Path(consumer_path)
        if not cpath.exists():
            print(f"warning: consumer file {cpath} not found, skipping", file=sys.stderr)
            continue
        text = cpath.read_text(errors="ignore")
        tokens = set(IDENTIFIER_TOKEN_RE.findall(text))
        for tok in sorted(tokens):
            leaf_candidates = {tok, tok.split(".")[-1], tok.split("/")[-1]}
            if not (leaf_candidates & declared_ids):
                undeclared.append({"consumer": str(cpath), "referenced": tok})
    return {
        "root": str(root),
        "consumers_scanned": [str(c) for c in consumer_paths],
        "declared_identifier_count": len(declared_ids),
        "undeclared_dependencies": undeclared,
    }


def cmd_backward_trace(args):
    root = Path(args.path).resolve()
    _emit(backward_trace(root, args.consumers), args.out)


def _emit(result, out_path):
    text = json.dumps(result, indent=2, default=str)
    if out_path:
        Path(out_path).write_text(text)
        print(f"wrote {out_path}", file=sys.stderr)
    else:
        print(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_declared = sub.add_parser("declared", help="Parse declared/explicit artifacts under a path.")
    p_declared.add_argument("path")
    p_declared.add_argument("--out")
    p_declared.set_defaults(func=cmd_declared)

    p_bt = sub.add_parser("backward-trace", help="Check consumer artifacts against what's declared upstream.")
    p_bt.add_argument("path")
    p_bt.add_argument("--consumers", nargs="+", required=True)
    p_bt.add_argument("--out")
    p_bt.set_defaults(func=cmd_backward_trace)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
