#!/usr/bin/env bash
# bootstrap.sh — runs on every /todo invocation (from the `!` block in SKILL.md).
#
# 1. Resolves the data home and creates it.
# 2. Seeds capabilities.yml / user-preferences.md from the examples if missing.
# 3. Prints a compact status block the model reads before dispatching.
#
# Usage: bootstrap.sh <skill_dir>
set -u

SKILL_DIR="${1:-}"
DATA_HOME="${TODO_DATA_HOME:-$HOME/.local/share/todo}"

mkdir -p "$DATA_HOME/todo-instructions"

if [ -n "$SKILL_DIR" ]; then
  [ -f "$DATA_HOME/capabilities.yml" ] || cp "$SKILL_DIR/capabilities.example.yml" "$DATA_HOME/capabilities.yml"
  [ -f "$DATA_HOME/user-preferences.md" ] || cp "$SKILL_DIR/user-preferences.example.md" "$DATA_HOME/user-preferences.md"
  echo "skill_dir: $SKILL_DIR"
else
  echo "skill_dir: NOT FOUND — see Troubleshooting"
fi

echo "data_home: $DATA_HOME"

CAPS="$DATA_HOME/capabilities.yml"
if [ -f "$CAPS" ]; then
  todos_file=$(grep -m1 'todos_file:' "$CAPS" | sed 's/^[^:]*: *//')
  todos_file="${todos_file/#\~/$HOME}"
  echo "todos_file: ${todos_file:-$HOME/.claude/todos.yaml}"
  if [ -f "$todos_file" ]; then
    if grep -q '^todos:' "$todos_file"; then
      pending=$(grep -c '^    state: pending' "$todos_file")
      inprog=$(grep -c '^    state: in_progress' "$todos_file")
      done=$(grep -c '^    state: done' "$todos_file")
      echo "todos: $pending pending, $inprog in progress, $done done"
    else
      echo "todos_file: v1 format detected — run /todo migrate before any other command"
    fi
  else
    echo "todos: file does not exist yet — first /todo <text> creates it"
  fi
  n=$(grep -c 'enabled: true' "$CAPS")
  echo "capabilities.yml: $n backend(s) enabled"
else
  echo "capabilities.yml: missing — run /todo setup"
fi
