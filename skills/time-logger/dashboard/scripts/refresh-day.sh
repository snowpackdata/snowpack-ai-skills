#!/bin/zsh
# On-demand single-day refresh, triggered by the "Refresh day" button on the Time Entries page.
# Unlike scheduled-refresh.sh (always today, weekday/working-hours-gated, cron-scheduled) this
# takes an explicit date, any day past or present, with no schedule guards — the user asked for
# this one day, right now.
set -u

DATE="${1:?usage: refresh-day.sh YYYY-MM-DD}"
if [[ ! "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "invalid date: $DATE (expected YYYY-MM-DD)" >&2
  exit 1
fi

DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
APP="$DATA_HOME/app/dashboard"
SKILL_DIR="${TIME_LOGGER_SKILL_DIR:-$(cat "$DATA_HOME/skill-dir" 2>/dev/null || echo "$HOME/.claude/skills/time-logger")}"
LOG_DIR="$DATA_HOME/dashboard/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/refresh-day-$DATE.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# claude lives outside launchd's/the server process's minimal PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CLAUDE=$(command -v claude)
if [[ -z "$CLAUDE" ]]; then
  log "ERROR: claude CLI not found on PATH"
  exit 1
fi

log "refresh-day start for $DATE"

# Same allowlist as scheduled-refresh.sh: enough to fetch every source, run the fan-out/generate
# agents, and render; nothing outward-facing.
ALLOWED=(
  "Read" "Write" "Edit" "Glob" "Grep" "Agent" "ToolSearch"
  "Bash(node *)" "Bash(python3 *)"
  "Bash(ls *)" "Bash(cat *)" "Bash(mkdir *)" "Bash(date *)" "Bash(wc *)" "Bash(sort *)" "Bash(tail *)" "Bash(head *)"
  "Bash(gh auth status*)" "Bash(gh api user*)" "Bash(gh search *)"
  "mcp__claude_ai_Slack" "mcp__plugin_slack_slack" "mcp__claude_ai_Google_Calendar" "mcp__claude_ai_Granola"
)

cd "$APP"
"$CLAUDE" -p "On-demand refresh for a single day: $DATE (a specific date, not necessarily today — do not substitute today's date anywhere in this task). The time-logger skill is installed at $SKILL_DIR and its data home is $DATA_HOME. You are running with an explicit tool allowlist (file tools, subagents, node/python3, basic read-only shell, read-only gh, and the Slack/Calendar/Granola MCP tools); anything else is denied — do not retry a denied tool, note it and move on.

Follow step 1 (Entries) of $SKILL_DIR/references/dash-refresh.md exactly as written, for date $DATE — it already knows how to gate fetch/draft freshness correctly whether $DATE is today or a past day, and it builds the combined file. Do NOT run the Week backfill sub-step (that's only for a general refresh with no explicit date — this is an explicit single-day request). Do NOT upload or submit anything.

Final output: one line per source, 'slack: <n> messages' / 'calendar: <n> events' / 'claude: <n> sessions' / 'github: <n> items' / 'granola: <n> meetings' or the error, then one line 'draft: <hours>h across <n> entries' or 'draft: unchanged — skipped' or the error." \
  --allowedTools "${ALLOWED[@]}" \
  --output-format stream-json --verbose < /dev/null 2>>"$LOG" \
  | python3 "$APP/scripts/format-stream-log.py" >> "$LOG"
rc=${pipestatus[1]}
log "claude refresh-day exit=$rc"

log "render start"
node "$APP/scripts/render.mjs" >> "$LOG" 2>&1
log "render done"

log "refresh-day end for $DATE"
exit $rc
