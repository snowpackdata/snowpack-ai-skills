#!/usr/bin/env python3
"""
Reformats `claude -p --output-format stream-json` (which requires --verbose, hence the noisy
system/init and hook events this filters out) into short, readable progress lines for a
headless job's log file — so the dashboard's log modal shows what's happening AS IT HAPPENS,
including subagent spawns/completions, instead of one final blob once the whole invocation
exits (the previous --output-format text behavior).

Reads NDJSON from stdin, writes plain text lines to stdout, flushed per-line so a `tail -f` or
the dashboard's log-fetch endpoint sees them as they arrive, not buffered until EOF.

Kept deliberately minimal: task_started/task_notification (subagent spawn/finish, with a
human-written description/summary) and top-level tool_use/text/result events. Raw tool_result
content, the assistant's internal "thinking" blocks, and the verbose system/init/hook noise are
dropped on purpose — this is a progress log, not a full transcript.
"""

import json
import sys
from datetime import datetime


def ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def emit(line: str) -> None:
    print(f"[{ts()}] {line}", flush=True)


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            continue
        t = d.get("type")

        if t == "assistant":
            for c in d.get("message", {}).get("content", []):
                kind = c.get("type")
                if kind == "tool_use":
                    name = c.get("name")
                    if name == "Agent":
                        continue  # task_started below has a cleaner description for this
                    inp = c.get("input", {})
                    detail = inp.get("description") or inp.get("command") or inp.get("file_path") or ""
                    emit(f"tool: {name} {detail}".strip())
                elif kind == "text" and c.get("text", "").strip():
                    emit(f"note: {c['text'].strip()[:200]}")

        elif t == "system" and d.get("subtype") == "task_started":
            emit(f"subagent started: {d.get('description') or d.get('subagent_type') or '?'}")

        elif t == "system" and d.get("subtype") == "task_notification":
            emit(f"subagent {d.get('status')}: {d.get('summary', '')}"[:250])

        elif t == "result":
            # Fires at the end of every turn, not just once at the very end of the whole -p
            # invocation — a headless run that gets woken up repeatedly by background subagent
            # notifications produces several of these. "update", not "done": most of them are
            # mid-run.
            emit(f"update: {d.get('result', '')[:300]}")
            if d.get("is_error"):
                emit(f"ERROR (subtype={d.get('subtype')})")

        # Intentionally ignored: system/init, system/hook_*, rate_limit_event, user/tool_result
        # (redundant with the tool_use line and eventual subagent/result summaries).


if __name__ == "__main__":
    main()
