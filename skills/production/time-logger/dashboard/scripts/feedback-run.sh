#!/bin/zsh
# Headless "apply dashboard comments" run — the Apply comments button in the dashboard.
# Drains dashboard/feedback/pending.json per references/review-feedback.md, but only the
# item types that are safe unattended: time_entry_comment and todo_comment. pr_comment items
# stay pending (they can require outward-facing GitHub actions) for an interactive
# `/time-logger feedback`. Same tool allowlist posture as morning-run.sh.
set -u

DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
APP="$DATA_HOME/app/dashboard"
SKILL_DIR="${TIME_LOGGER_SKILL_DIR:-$(cat "$DATA_HOME/skill-dir" 2>/dev/null || echo "$HOME/.claude/skills/time-logger")}"
LOG_DIR="$DATA_HOME/dashboard/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/feedback.log"
PENDING="$DATA_HOME/dashboard/feedback/pending.json"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Nothing to do? Say so and exit cleanly — the button re-enables immediately.
n=$(python3 -c "import json,sys
try:
  d=json.load(open('$PENDING'))
  print(sum(1 for x in d if not x.get('resolved') and x.get('type') in ('time_entry_comment','todo_comment')))
except Exception: print(0)" 2>/dev/null); n="${n:-0}"
if (( n == 0 )); then log "skip: no applicable pending comments"; exit 0; fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CLAUDE=$(command -v claude)
if [[ -z "$CLAUDE" ]]; then log "ERROR: claude CLI not found on PATH"; exit 1; fi

ALLOWED=(
  "Read" "Write" "Edit" "Glob" "Grep" "Agent" "ToolSearch"
  "Bash(node *)" "Bash(python3 *)"
  "Bash(ls *)" "Bash(cat *)" "Bash(mkdir *)" "Bash(date *)" "Bash(wc *)" "Bash(sort *)" "Bash(tail *)" "Bash(head *)"
)
NOTES_ENABLED=$(node "$APP/scripts/capabilities.mjs" integrations.notes_api.enabled 2>/dev/null)
NOTES_SCRIPT=$(node "$APP/scripts/capabilities.mjs" integrations.notes_api.script 2>/dev/null)
NOTES_SCRIPT="${NOTES_SCRIPT/#\~/$HOME}"
[[ "$NOTES_ENABLED" == "true" && -n "$NOTES_SCRIPT" ]] && ALLOWED+=("Bash($NOTES_SCRIPT upload *)")

log "feedback run start ($n applicable comment(s))"
cd "$APP"
"$CLAUDE" -p "Headless feedback run triggered from the dashboard. The time-logger skill is installed at $SKILL_DIR and its data home is $DATA_HOME. Follow $SKILL_DIR/references/review-feedback.md to apply the comments queued in $DATA_HOME/dashboard/feedback/pending.json, with these constraints for running unattended:

- Apply ONLY items of type time_entry_comment and todo_comment. Leave every pr_comment item exactly as it is (still pending) — those need an interactive run.
- Take NO outward-facing action of any kind: no gh writes, no PR comments or closes, no Slack messages, no Jira changes. Uploading a rebuilt combined file via the notes API wrapper is allowed only if integrations.notes_api.enabled is true in $DATA_HOME/capabilities.yml.
- You are running with an explicit tool allowlist (file tools, subagents, node/python3, basic read-only shell). Anything else is denied — do not retry a denied tool; note it and move on.
- After editing, if a time-entry file changed and today's daily digest summarizes it, re-run the 'summary daily digest' preset from $SKILL_DIR/references/summary.md; then run node $APP/scripts/render.mjs.
- Final output: one line per comment — applied (what changed) or left pending (why)." \
  --allowedTools "${ALLOWED[@]}" \
  --output-format text < /dev/null >> "$LOG" 2>&1
rc=$?
log "claude exit=$rc"
node "$APP/scripts/render.mjs" >> "$LOG" 2>&1 || log "WARN: render failed"
log "feedback run end"
