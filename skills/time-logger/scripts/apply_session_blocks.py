#!/usr/bin/env python3
"""
Apply a batch of session-block changes to raw/claude/YYYY-MM-DD.md (the unified Claude Code +
Codex sessions file) in one pass.

fetch-claude-sessions-day used to issue one Edit tool call per changed or new session block —
correct, but each Edit is its own tool-call round trip on top of the actual write, and a day
with many sessions pays that overhead once per session. This script takes every block that
needs to change, however many there are, and applies them all in a single invocation instead.

Usage: apply_session_blocks.py <target_file> <operations_json_file>

<operations_json_file> is a JSON object:
{
  "header": "# Coding Agent Sessions — Weekday, Month Day, Year",  // used only if target_file
                                                                    // doesn't exist yet
  "operations": [
    {"type": "replace", "anchor_file": "<the **File**: path already in the target file>",
     "block": "<full replacement block, '## Session: ...' through the trailing '---'>"},
    {"type": "insert_after", "anchor_file": "<the **File**: path of the preceding block>",
     "block": "<full new block>"},
    {"type": "append", "block": "<full new block>"},
    {"type": "remove", "anchor_file": "<a **File**: path from the manifest's stale_blocks>"}
  ]
}

Operations are applied in the given order. "replace"/"insert_after"/"remove" locate a block by its
"**File**: <path>" line; a block runs from its "## Session:" header through the next
"## Session:" line or end of file. Exits 1 with a message on stderr if an anchor can't be
found (never silently drops a change) or if any input is malformed.
"""
import json
import re
import sys

SESSION_HEADER_RE = re.compile(r"^## Session: ", re.MULTILINE)


def _find_block_span(content: str, anchor_file: str) -> tuple[int, int]:
    """Return (start, end) character offsets of the block whose '**File**:' line matches
    anchor_file exactly (after stripping). Raises ValueError if not found or ambiguous."""
    anchor_line = f"**File**: {anchor_file}"
    idx = content.find(anchor_line)
    if idx == -1:
        raise ValueError(f"anchor not found: {anchor_file}")
    if content.find(anchor_line, idx + 1) != -1:
        raise ValueError(f"anchor matches more than one block: {anchor_file}")

    start = content.rfind("## Session:", 0, idx)
    if start == -1:
        raise ValueError(f"anchor line has no preceding '## Session:' header: {anchor_file}")

    next_match = SESSION_HEADER_RE.search(content, idx + 1)
    end = next_match.start() if next_match else len(content)
    return start, end


def _normalize_spacing(content: str) -> str:
    """Ensure exactly one blank line between a block's trailing '---' and the next
    '## Session:' header — callers aren't required to get trailing whitespace exactly right on
    every block they hand in, this is the one place that guarantees consistent formatting."""
    content = re.sub(r"\n---\n+(## Session:)", r"\n---\n\n\1", content)
    return content


def apply_operations(content: str, operations: list) -> str:
    for op in operations:
        kind = op.get("type")
        if kind == "remove":
            # A stale block (provider disabled, or now a deduplicated copy). Missing is fine —
            # the goal state is "not in the file", which already holds.
            try:
                start, end = _find_block_span(content, op["anchor_file"])
            except ValueError as e:
                if "not found" in str(e):
                    continue
                raise
            content = content[:start] + content[end:]
            continue
        block = op["block"]
        if not block.endswith("\n"):
            block += "\n"

        if kind == "replace":
            start, end = _find_block_span(content, op["anchor_file"])
            content = content[:start] + block + content[end:]
        elif kind == "insert_after":
            _, end = _find_block_span(content, op["anchor_file"])
            content = content[:end] + block + content[end:]
        elif kind == "append":
            if not content.endswith("\n\n") and content.strip():
                content = content.rstrip("\n") + "\n\n"
            content += block
        else:
            raise ValueError(f"unknown operation type: {kind!r}")
    return content


def main():
    if len(sys.argv) != 3:
        print("usage: apply_session_blocks.py <target_file> <operations_json_file>", file=sys.stderr)
        sys.exit(2)
    target_file, ops_file = sys.argv[1], sys.argv[2]

    with open(ops_file) as f:
        payload = json.load(f)
    operations = payload.get("operations", [])

    try:
        with open(target_file) as f:
            content = f.read()
    except FileNotFoundError:
        header = payload.get("header")
        if not header:
            print("target file doesn't exist and no 'header' was given to create it", file=sys.stderr)
            sys.exit(1)
        content = header.rstrip("\n") + "\n\n"

    try:
        content = apply_operations(content, operations)
    except ValueError as e:
        print(f"error applying operations: {e}", file=sys.stderr)
        sys.exit(1)

    content = _normalize_spacing(content)

    with open(target_file, "w") as f:
        f.write(content)

    print(f"applied {len(operations)} operation(s) to {target_file}")


if __name__ == "__main__":
    main()
