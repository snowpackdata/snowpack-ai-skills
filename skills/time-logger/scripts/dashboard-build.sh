#!/usr/bin/env bash
# dashboard-build.sh — sync the bundled dashboard source into <data home>/app/dashboard and
# build it there. The skill folder is replaced on every `npx skills add` update, so nothing
# generated (node_modules, dist) may live inside it.
#
# Usage: dashboard-build.sh <skill_dir> [--status | --force]
#   (default)  sync + build only when the source hash changed or dist is missing
#   --status   same as default, but prints a one-line status suitable for the bootstrap block
#   --force    always re-sync and rebuild
set -u

SKILL_DIR="${1:?skill dir required}"
MODE="${2:-}"
DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
SRC="$SKILL_DIR/dashboard"
APP="$DATA_HOME/app/dashboard"
LOG_DIR="$DATA_HOME/dashboard/logs"
LOG="$LOG_DIR/build.log"
mkdir -p "$APP" "$LOG_DIR"

# launchd's PATH is minimal; interactive shells usually have node via homebrew/nvm.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

source_hash() {
  (cd "$SRC" && find . -type f -not -path './node_modules/*' -not -path './dist/*' -print0 \
     | sort -z | xargs -0 shasum 2>/dev/null | shasum | awk '{print $1}')
}

hash_now=$(source_hash)
hash_built=$(cat "$APP/.source-hash" 2>/dev/null || echo none)

if [ "$MODE" != "--force" ] && [ "$hash_now" = "$hash_built" ] && [ -f "$APP/dist/index.html" ]; then
  echo "dashboard: built (${hash_now:0:8}) at $APP"
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "dashboard: NOT built — node/npm not on PATH (install Node 20+, then run /time-logger dashboard build)"
  exit 0
fi

(
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] build start (source ${hash_now:0:8})"
  # Sync source, dropping files that no longer exist upstream but keeping node_modules/dist.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude node_modules --exclude dist --exclude .source-hash "$SRC/" "$APP/"
  else
    (cd "$SRC" && find . -type f -not -path './node_modules/*' -not -path './dist/*' | while read -r f; do
       mkdir -p "$APP/$(dirname "$f")"; cp "$f" "$APP/$f"; done)
  fi
  chmod +x "$APP"/scripts/*.sh 2>/dev/null
  cd "$APP" || exit 1
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --silent; else npm install --no-audit --no-fund --silent; fi \
    && npm run build --silent \
    && printf '%s\n' "$hash_now" > .source-hash
  rc=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] build exit=$rc"
  exit $rc
) >> "$LOG" 2>&1
rc=$?

if [ $rc -eq 0 ]; then
  # A running server picks up dist/ changes on the next request, but server.mjs itself only
  # reloads on restart — kick the launchd job if it exists.
  launchctl kickstart -k "gui/$(id -u)/com.time-logger.dash-server" >/dev/null 2>&1 || true
  echo "dashboard: built (${hash_now:0:8}) at $APP"
else
  echo "dashboard: BUILD FAILED (exit $rc) — see $LOG"
fi
exit 0
