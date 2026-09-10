#!/usr/bin/env bash
# install-launchd.sh — render and load the three launchd jobs that keep the dashboard running
# without a Claude session (macOS only). Idempotent: re-running re-renders and reloads.
#
#   com.time-logger.dash-server   keeps `node server.mjs` alive (KeepAlive, RunAtLoad)
#   com.time-logger.dash-refresh  scheduled-refresh.sh weekdays at 7:13, 9:13, 11:13, 13:13, 15:13
#   com.time-logger.morning-run   morning-run.sh at 6:45 + at load + hourly retry (script
#                                 guarantees one run per weekday via a marker file)
#
# Usage: install-launchd.sh            install / reload
#        install-launchd.sh --uninstall
#        install-launchd.sh --dry-run   render + lint the plists into $TIME_LOGGER_PLIST_DIR
#                                       (default ~/Library/LaunchAgents) without loading them
set -u

DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
APP="$DATA_HOME/app/dashboard"
LOG_DIR="$DATA_HOME/dashboard/logs"
PLIST_DIR="${TIME_LOGGER_PLIST_DIR:-$HOME/Library/LaunchAgents}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
UID_NUM=$(id -u)
LABELS=(com.time-logger.dash-server com.time-logger.dash-refresh com.time-logger.morning-run)

if [ "$(uname)" != "Darwin" ]; then
  echo "launchd is macOS-only; on other systems schedule scripts/*.sh with cron."; exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID_NUM/$l" >/dev/null 2>&1 || true
    rm -f "$PLIST_DIR/$l.plist"
  done
  echo "launchd: removed ${LABELS[*]}"
  exit 0
fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "node not found on PATH — install Node 20+ first"; exit 1; }
[ -f "$APP/server.mjs" ] || { echo "dashboard not built at $APP — run /time-logger dashboard build first"; exit 1; }
PORT=$("$NODE" "$APP/scripts/capabilities.mjs" dashboard.port 2>/dev/null); PORT="${PORT:-4680}"
mkdir -p "$PLIST_DIR" "$LOG_DIR"

env_block() {
  cat <<EOF
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>TIME_LOGGER_DATA_HOME</key><string>$DATA_HOME</string>
    <key>PORT</key><string>$PORT</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
EOF
}

write_plist() { # label body
  local label="$1"; local body="$2"
  cat > "$PLIST_DIR/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
$body
  <key>WorkingDirectory</key><string>$APP</string>
  <key>StandardOutPath</key><string>$LOG_DIR/$label.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.err.log</string>
$(env_block)
</dict>
</plist>
EOF
}

# 1. server
write_plist com.time-logger.dash-server "  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$APP/server.mjs</string></array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>"

# 2. scheduled refresh: weekdays (1-5) at :13 past 7, 9, 11, 13, 15
cal=""
for d in 1 2 3 4 5; do for h in 7 9 11 13 15; do
  cal+="    <dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>13</integer></dict>
"
done; done
write_plist com.time-logger.dash-refresh "  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$APP/scripts/scheduled-refresh.sh</string></array>
  <key>StartCalendarInterval</key>
  <array>
$cal  </array>"

# 3. morning run: 6:45 daily + at load + hourly retry; the script enforces weekdays + once/day
write_plist com.time-logger.morning-run "  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$APP/scripts/morning-run.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>45</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>"

for l in "${LABELS[@]}"; do
  plutil -lint -s "$PLIST_DIR/$l.plist" || { echo "invalid plist: $l"; exit 1; }
done
if (( DRY )); then echo "launchd (dry run): rendered ${LABELS[*]} into $PLIST_DIR — not loaded"; exit 0; fi
for l in "${LABELS[@]}"; do
  launchctl bootout "gui/$UID_NUM/$l" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_DIR/$l.plist" || { echo "failed to load $l"; exit 1; }
done

# Record in capabilities.yml so setup/status can report it.
CAPS="$DATA_HOME/capabilities.yml"
[ -f "$CAPS" ] && sed -i '' -e 's/^\([[:space:]]*launchd:\).*/\1 true/' "$CAPS"

echo "launchd: loaded ${LABELS[*]}"
echo "server: http://localhost:$PORT   logs: $LOG_DIR"
