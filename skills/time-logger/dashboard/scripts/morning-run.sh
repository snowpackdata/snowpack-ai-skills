#!/bin/zsh
# Scheduled full "morning" flow for the time logger.
# Invoked by launchd (com.time-logger.morning-run): daily at 6:45 AM, at boot/login
# (RunAtLoad), and hourly as a retry. The marker file guarantees exactly one run per
# weekday — whenever the machine is first up on or after 6:45. Also runnable from the
# dashboard's Morning button (--force).
set -u

DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
APP="$DATA_HOME/app/dashboard"
SKILL_DIR="${TIME_LOGGER_SKILL_DIR:-$(cat "$DATA_HOME/skill-dir" 2>/dev/null || echo "$HOME/.claude/skills/time-logger")}"
LOG_DIR="$DATA_HOME/dashboard/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/morning.log"
MARKER="$LOG_DIR/morning-last-run"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

TODAY=$(date +%Y-%m-%d)
dow=$(date +%u)   # 1=Mon .. 7=Sun
hour=$(date +%H)

# --force: manual trigger (dashboard button) — skip the schedule guards.
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if (( ! FORCE )); then
  if (( dow > 5 )); then log "skip: weekend"; exit 0; fi
  if (( hour < 6 )); then log "skip: before the 6:45 window"; exit 0; fi
  if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$TODAY" ]]; then log "skip: already ran today"; exit 0; fi
fi

# claude lives outside launchd's minimal PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CLAUDE=$(command -v claude)
if [[ -z "$CLAUDE" ]]; then
  log "ERROR: claude CLI not found on PATH"
  exit 1
fi
PORT=$(node "$APP/scripts/capabilities.mjs" dashboard.port 2>/dev/null); PORT="${PORT:-4680}"

# Explicit tool allowlist for the unattended run — no bypassPermissions. Anything outside
# this list is denied (not prompted) in -p mode, so the run can read sources, write the
# data home, run the local scripts, and call read-only gh/MCP tools, but cannot post to
# GitHub or Slack, edit tickets, or run arbitrary shell.
ALLOWED=(
  "Read" "Write" "Edit" "Glob" "Grep" "Agent" "ToolSearch"
  "Bash(node *)" "Bash(python3 *)"
  "Bash(ls *)" "Bash(cat *)" "Bash(mkdir *)" "Bash(date *)" "Bash(wc *)" "Bash(sort *)" "Bash(tail *)" "Bash(head *)"
  "Bash(gh auth status*)" "Bash(gh api user*)" "Bash(gh search *)"
  "mcp__claude_ai_Slack" "mcp__plugin_slack_slack" "mcp__claude_ai_Google_Calendar" "mcp__claude_ai_Granola"
)

echo "$TODAY" > "$MARKER"
log "morning run start for $TODAY"

cd "$APP"
"$CLAUDE" -p "Scheduled headless morning run for $TODAY. The time-logger skill is installed at $SKILL_DIR and its data home is $DATA_HOME. Execute the morning flow from $SKILL_DIR/references/morning.md with these adjustments for running unattended:

You are running with an explicit tool allowlist: file tools, subagents, node/python3 and basic read-only shell, read-only gh (auth status, api user, search), and the Slack/Calendar/Granola MCP tools. Anything else is denied — do not retry a denied tool, note it in the final summary and move on.

1. Drain dashboard feedback per $SKILL_DIR/references/review-feedback.md — but apply ONLY time_entry_comment and todo_comment items. Leave every pr_comment item pending (they can require outward-facing GitHub actions), and take NO outward-facing action of any kind: no gh writes, no PR closes, no PR comments, no Slack messages, no Jira changes. Nothing leaves this machine in a headless run.
2. Backfill: for each weekday from last Monday through yesterday missing $DATA_HOME/time_logs/time_entries_YYYYMMDD.md, fetch all enabled sources per $DATA_HOME/capabilities.yml (follow the $SKILL_DIR/.claude/agents/fetch-*-day.md instructions; spawn agents if available, otherwise perform the fetches directly), then run the generate flow per $SKILL_DIR/.claude/agents/generate-time-entry.md, and build the combined file per $SKILL_DIR/references/combined-file.md.
3. Refresh: fetch today's Slack and Calendar into $DATA_HOME/raw/, write the daily digest by following $SKILL_DIR/references/summary.md with the focus 'daily digest' (its preset section) — it saves $DATA_HOME/summaries/${TODAY}_daily-digest.md and skips delivery, write $DATA_HOME/dashboard/data/slack_conversations.json per step 2b of $SKILL_DIR/references/dash-refresh.md, run node $APP/scripts/fetch-github-prs.mjs, then node $APP/scripts/render.mjs. Skip the artifacts section (the Artifact tool is not in the allowlist). Do not run 'open'.
4. Final output: a short plain-text summary — days backfilled, feedback items applied/left pending, any source that failed, and any tool call that was denied." \
  --allowedTools "${ALLOWED[@]}" \
  --output-format stream-json --verbose < /dev/null 2>>"$LOG" \
  | python3 "$APP/scripts/format-stream-log.py" >> "$LOG"
rc=${pipestatus[1]}
log "morning run exit=$rc"

# Belt and braces: make sure the store is rendered and the server is up even if the run died.
node "$APP/scripts/render.mjs" >> "$LOG" 2>&1 || log "WARN: render failed"
if ! curl -sf -o /dev/null "http://localhost:$PORT/data/meta.json"; then
  launchctl kickstart "gui/$(id -u)/com.time-logger.dash-server" >> "$LOG" 2>&1
  log "kickstarted dash-server"
fi
log "morning run done"
