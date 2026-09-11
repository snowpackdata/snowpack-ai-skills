#!/usr/bin/env bash
# bootstrap.sh — runs on every /time-logger invocation (from the `!` block in SKILL.md).
#
# 1. Resolves the data home and creates its tree.
# 2. Migrates data from the pre-data-home location (~/repos/time_logs) once, if found.
# 3. Installs the bundled subagents into ~/.claude/agents/ (Claude Code can't discover them
#    inside a skill folder) and copies scan_sessions.py where the sessions agent expects it.
# 4. Seeds capabilities.yml / user-preferences.md from the examples if missing.
# 5. Syncs + builds the dashboard into <data home>/app/dashboard when its source changed.
# 6. Prints a compact status block the model reads before dispatching.
#
# Usage: bootstrap.sh <skill_dir>
set -u

SKILL_DIR="${1:-}"
DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
LEGACY="${TIME_LOGGER_LEGACY_DIR:-$HOME/repos/time_logs}"   # pre-data-home output dir
AGENTS_DIR="$HOME/.claude/agents"

mkdir -p "$DATA_HOME"/raw/{slack,calendar,claude,github,granola,combined} \
         "$DATA_HOME"/time_logs "$DATA_HOME"/summaries "$DATA_HOME"/scripts "$DATA_HOME"/app \
         "$DATA_HOME"/dashboard/{data,feedback,logs} "$AGENTS_DIR"

# --- 2. one-time migration from the old fixed output dir ---------------------------------
migrated=""
if [ ! -f "$DATA_HOME/capabilities.yml" ] && [ -f "$LEGACY/capabilities.yml" ] \
   && grep -q '^[[:space:]]*output_dir:' "$LEGACY/capabilities.yml"; then
  for item in capabilities.yml user-preferences.md; do
    [ -f "$LEGACY/$item" ] && mv "$LEGACY/$item" "$DATA_HOME/$item"
  done
  for src in slack calendar claude github granola combined; do
    if [ -d "$LEGACY/raw/$src" ]; then
      find "$LEGACY/raw/$src" -maxdepth 1 -name '*.md' -exec mv -n {} "$DATA_HOME/raw/$src/" \;
    fi
  done
  if [ -d "$LEGACY/time_logs" ]; then
    find "$LEGACY/time_logs" -maxdepth 1 -name '*.md' -exec mv -n {} "$DATA_HOME/time_logs/" \;
  fi
  # output_dir -> data_home so the file matches the current schema
  sed -i '' -e "s|^\([[:space:]]*\)output_dir:.*|\1data_home: ${DATA_HOME/#$HOME/~}|" "$DATA_HOME/capabilities.yml"
  migrated="yes"
fi

# --- 3. subagents + scanner script --------------------------------------------------------
if [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/.claude/agents" ]; then
  cp "$SKILL_DIR"/.claude/agents/*.md "$AGENTS_DIR/"
  cp "$SKILL_DIR/scripts/scan_sessions.py" "$DATA_HOME/scripts/scan_sessions.py"
  cp "$SKILL_DIR/scripts/check_week_continuity.py" "$DATA_HOME/scripts/check_week_continuity.py"
  cp "$SKILL_DIR/scripts/check_draft_freshness.py" "$DATA_HOME/scripts/check_draft_freshness.py"
  [ -f "$DATA_HOME/capabilities.yml" ] || cp "$SKILL_DIR/capabilities.example.yml" "$DATA_HOME/capabilities.yml"
  [ -f "$DATA_HOME/user-preferences.md" ] || cp "$SKILL_DIR/user-preferences.example.md" "$DATA_HOME/user-preferences.md"
  # Remember where the skill lives so the headless launchd scripts can find agent/reference docs.
  printf '%s\n' "$SKILL_DIR" > "$DATA_HOME/skill-dir"
  echo "skill_dir: $SKILL_DIR"
else
  echo "skill_dir: NOT FOUND — subagents were not (re)installed; see Troubleshooting"
fi
echo "data_home: $DATA_HOME${migrated:+   (migrated from $LEGACY)}"
echo "today: $(date +%F)   yesterday: $(date -v-1d +%F 2>/dev/null || date -d yesterday +%F)   weekday: $(date +%A)"
# --- today's freshness (raw source ages + draft) ----------------------------------------
_age() { local m now; now=$(date +%s); m=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null); [ -z "$m" ] && { echo "-"; return; }; local s=$((now-m)); if (( s < 3600 )); then echo "$((s/60))m"; elif (( s < 86400 )); then echo "$((s/3600))h$(( (s%3600)/60 ))m"; else echo "$((s/86400))d"; fi; }
_today=$(date +%F); _fresh=""
for _src in claude slack calendar github granola; do _f="$DATA_HOME/raw/$_src/$_today.md"; [ -f "$_f" ] && _fresh="$_fresh $_src=$(_age "$_f")" || _fresh="$_fresh $_src=-"; done
_tf="$DATA_HOME/time_logs/time_entries_${_today//-/}.md"; [ -f "$_tf" ] && _fresh="$_fresh draft=$(_age "$_tf")" || _fresh="$_fresh draft=-"
echo "today's data (age, - = none):$_fresh"
echo "agents installed: $(ls "$AGENTS_DIR"/fetch-*-day.md "$AGENTS_DIR"/generate-time-entry.md 2>/dev/null | wc -l | tr -d ' ')/6"

# --- 4. capabilities status ----------------------------------------------------------------
CAPS="$DATA_HOME/capabilities.yml"
if [ -f "$CAPS" ]; then
  last=$(grep -m1 'Last configured' "$CAPS" | sed 's/^# *//')
  n=$(grep -c 'enabled: true' "$CAPS")
  missing=""
  for sec in client dashboard submit; do grep -q "^$sec:" "$CAPS" || missing="$missing $sec:"; done
  if [ -n "$missing" ]; then schema="outdated (missing$missing — run /time-logger setup)"; else schema="ok"; fi
  echo "capabilities.yml: $n integration(s) enabled — $last — schema $schema"
else
  echo "capabilities.yml: missing — run /time-logger setup"
fi

# --- 5. dashboard ----------------------------------------------------------------------------
dash_enabled=$(grep -A6 '^dashboard:' "$CAPS" 2>/dev/null | grep -m1 'enabled:' | awk '{print $2}')
if [ "${dash_enabled:-true}" = "false" ]; then
  echo "dashboard: disabled in capabilities.yml"
elif [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/dashboard" ]; then
  bash "$SKILL_DIR/scripts/dashboard-build.sh" "$SKILL_DIR" --status
else
  echo "dashboard: source not found in skill"
fi
