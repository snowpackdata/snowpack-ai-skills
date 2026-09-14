#!/usr/bin/env python3
"""
Build raw/combined/time-log_YYYY-MM-DD_<slug>.md for a target date — deterministic
concatenation of that day's raw source files plus a Recommended Time Log Structure section
derived from time_logs/time_entries_YYYYMMDD.md. No LLM judgment involved: every piece of this
file is either "copy this file's bytes verbatim" or "strip a fixed prefix off an existing
heading line" — see combined-file.md, which this replaces the hand-written half of.

Usage: python3 build_combined_file.py YYYY-MM-DD
"""
import os
import re
import sys
from pathlib import Path

SOURCES = [
    ("slack", "Slack"),
    ("calendar", "Calendar"),
    ("claude", "Claude Sessions"),
    ("github", "GitHub"),
    ("granola", "Granola Meeting Notes"),
]

ENTRY_HEADING_RE = re.compile(r"^### (.+)$", re.MULTILINE)


def data_home_dir() -> Path:
    return Path(os.environ.get("TIME_LOGGER_DATA_HOME") or (Path.home() / ".local" / "share" / "time-logger"))


def client_slug(data_home: Path) -> str:
    """A minimal, targeted read of capabilities.yml's client.slug — not a general YAML parser
    (no dependency any other script here needs), just enough to find one nested scalar."""
    caps_path = data_home / "capabilities.yml"
    try:
        lines = caps_path.read_text().splitlines()
    except OSError:
        return ""
    in_client = False
    for line in lines:
        if re.match(r"^client:\s*$", line):
            in_client = True
            continue
        if in_client:
            if re.match(r"^\S", line):  # dedented back to top level — client: block ended
                break
            m = re.match(r"^\s+slug:\s*\"?([^\"\s]*)\"?\s*$", line)
            if m:
                return m.group(1)
    return ""


def read_source(path: Path) -> str:
    """Returns the file's content verbatim, or the literal "(no data)" placeholder if the file
    doesn't exist — every source section is always present (confirmed against several real
    combined files already on disk), never omitted just because that day happened to have
    nothing for it. No separator is inserted between sections here: whatever a source's own raw
    format naturally ends with (some, like claude and granola, already end each of their own
    blocks with a trailing "---"; others, like slack and github, don't) is preserved exactly
    as-is — this build step only ever concatenates "## Title" + the file's own bytes, nothing
    more."""
    try:
        return path.read_text().rstrip("\n")
    except OSError:
        return "(no data)"


def recommended_structure(data_home: Path, target_date: str) -> str:
    """Every line here already exists verbatim in the entries file — a '### ' heading becomes
    a '- ' bullet, and the Total line is copied straight from the file's own **Hours**/
    **Clients** header fields. No re-deriving anything the entries file doesn't already state."""
    entries_path = data_home / "time_logs" / f"time_entries_{target_date.replace('-', '')}.md"
    try:
        text = entries_path.read_text()
    except OSError:
        return ""

    hours_m = re.search(r"^\*\*Hours\*\*:\s*(.+)$", text, re.MULTILINE)
    clients_m = re.search(r"^\*\*Clients\*\*:\s*(.+)$", text, re.MULTILINE)
    hours = hours_m.group(1).strip() if hours_m else "0h"
    clients = clients_m.group(1).strip() if clients_m else ""

    bullets = [f"- {h}" for h in ENTRY_HEADING_RE.findall(text)]
    total_line = f"Total: {hours}" + (f" ({clients})" if clients and clients.lower() != "none" else "")
    if not bullets:
        return "(no entries — zero-hours day, no activity found in any source)\n" + total_line
    return "\n".join(bullets + [total_line])


def main():
    if len(sys.argv) != 2:
        print("Usage: build_combined_file.py YYYY-MM-DD", file=sys.stderr)
        sys.exit(1)
    target_date = sys.argv[1]

    data_home = data_home_dir()
    slug = client_slug(data_home)
    suffix = f"_{slug}" if slug else ""

    parts = [f"# time-log_{target_date}{suffix}", ""]
    for dirname, title in SOURCES:
        content = read_source(data_home / "raw" / dirname / f"{target_date}.md")
        parts.append(f"## {title}")
        parts.append("")
        parts.append(content)
        parts.append("")

    structure = recommended_structure(data_home, target_date)
    if structure:
        parts.append("## Recommended Time Log Structure")
        parts.append("")
        parts.append(structure)
    # else: entries file doesn't exist yet — section omitted entirely, per combined-file.md.

    out_dir = data_home / "raw" / "combined"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"time-log_{target_date}{suffix}.md"
    content = "\n".join(parts).rstrip("\n") + "\n"
    out_path.write_text(content)

    n_entries = sum(1 for line in structure.splitlines() if line.startswith("- "))
    print(f"wrote {out_path} ({n_entries} entries)")


if __name__ == "__main__":
    main()
