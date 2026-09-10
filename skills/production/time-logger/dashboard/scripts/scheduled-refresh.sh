#!/bin/zsh
# Scheduled intraday refresh for the Morning Dashboard: refetches today's enabled sources and
# redrafts today's time entries (merge mode) so they can be reviewed and commented on during the day.
# Invoked by launchd (com.time-logger.dash-refresh) at 7:13, 9:13, 11:13, 13:13, 15:13 on
# weekdays, or manually from the dashboard's Refresh button (--force).
set -u

DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
APP="$DATA_HOME/app/dashboard"
SKILL_DIR="${TIME_LOGGER_SKILL_DIR:-$(cat "$DATA_HOME/skill-dir" 2>/dev/null || echo "$HOME/.claude/skills/time-logger")}"
LOG_DIR="$DATA_HOME/dashboard/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/refresh.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# --force: manual trigger (dashboard button) — skip the schedule guards.
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# Weekday + working-hours guard (launchd config also gates this; belt and braces).
dow=$(date +%u)  # 1=Mon .. 7=Sun
hour=$(date +%H)
if (( ! FORCE )) && { (( dow > 5 )) || (( hour < 7 )) || (( hour > 16 )); }; then
  log "skip: outside weekday working hours"
  exit 0
fi

# Skip wake-time catch-up runs: launchd fires missed jobs when the Mac wakes from
# sleep. Only run if we're within 30 min of an actual slot (7:13, 9:13, ... 15:13);
# a later slot will cover it.
now_min=$((10#$(date +%H) * 60 + 10#$(date +%M)))
latest=-1
for h in 7 9 11 13 15; do
  s=$((h * 60 + 13))
  (( s <= now_min )) && latest=$s
done
if (( ! FORCE )) && { (( latest < 0 )) || (( now_min - latest > 30 )); }; then
  log "skip: wake catch-up outside the 30-min slot window"
  exit 0
fi

# claude lives outside launchd's minimal PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CLAUDE=$(command -v claude)
if [[ -z "$CLAUDE" ]]; then
  log "ERROR: claude CLI not found on PATH"
  exit 1
fi
PORT=$(node "$APP/scripts/capabilities.mjs" dashboard.port 2>/dev/null); PORT="${PORT:-4680}"

TODAY=$(date +%Y-%m-%d)
log "refresh start for $TODAY"

# Explicit tool allowlist for the unattended run — no bypassPermissions. Enough to fetch every
# source, run the generate agent, and render; nothing outward-facing (no gh writes, no Slack
# posts, no arbitrary shell).
ALLOWED=(
  "Read" "Write" "Edit" "Glob" "Grep" "Agent" "ToolSearch"
  "Bash(node *)" "Bash(python3 *)"
  "Bash(ls *)" "Bash(cat *)" "Bash(mkdir *)" "Bash(date *)" "Bash(wc *)" "Bash(sort *)" "Bash(tail *)" "Bash(head *)"
  "Bash(gh auth status*)" "Bash(gh api user*)" "Bash(gh search *)"
  "mcp__claude_ai_Slack" "mcp__plugin_slack_slack" "mcp__claude_ai_Google_Calendar" "mcp__claude_ai_Granola"
)

cd "$APP"
"$CLAUDE" -p "Scheduled headless dashboard refresh for $TODAY. The time-logger skill is installed at $SKILL_DIR and its data home is $DATA_HOME. You are running with an explicit tool allowlist (file tools, subagents, node/python3, basic read-only shell, read-only gh, and the Slack/Calendar/Granola MCP tools); anything else is denied — do not retry a denied tool, note it and move on.

1. Read $DATA_HOME/capabilities.yml. For every integration under integrations: with enabled: true (claude_sessions, slack, google_calendar, github, granola), spawn the matching fetch agent (fetch-claude-sessions-day, fetch-slack-day, fetch-calendar-day, fetch-github-day, fetch-granola-day) IN PARALLEL for $TODAY. Each writes $DATA_HOME/raw/<source>/$TODAY.md. If agents are unavailable, follow the instructions in $SKILL_DIR/.claude/agents/fetch-*-day.md yourself. If one source fails, continue with the others.
2. Write $DATA_HOME/dashboard/data/slack_conversations.json per step 2b of $SKILL_DIR/references/dash-refresh.md (last 3 workdays of $DATA_HOME/raw/slack/, self-DMs excluded, follow-ups flagged conservatively). Skip if slack is disabled.
3. Then spawn generate-time-entry for $TODAY. It merges with $DATA_HOME/time_logs/time_entries_${TODAY//-/}.md if that exists — never overwrite entries already there, only add or extend. Do NOT build the combined file and do NOT upload anything; the morning run owns those.
4. Final output: one line per source, 'slack: <n> messages' / 'calendar: <n> events' / 'claude: <n> sessions' / 'github: <n> items' / 'granola: <n> meetings' or the error, then 'conversations: <n> (<m> need follow-up)', then one line 'draft: <hours>h across <n> entries' or the error." \
  --allowedTools "${ALLOWED[@]}" \
  --output-format text < /dev/null >> "$LOG" 2>&1
rc=$?
log "claude fetch exit=$rc"

node "$APP/scripts/fetch-github-prs.mjs" >> "$LOG" 2>&1 || log "WARN: github PR fetch failed"
node "$APP/scripts/render.mjs" >> "$LOG" 2>&1
log "render done"

# Server is managed by com.time-logger.dash-server (KeepAlive), but check anyway.
if ! curl -sf -o /dev/null "http://localhost:$PORT/data/meta.json"; then
  log "WARN: dashboard server not responding on :$PORT"
fi
log "refresh end"
