#!/bin/bash
# Prints a compact snapshot of the time-logger's state: where everything lives, how fresh each
# source is per day, when the scheduled jobs last ran, and what's pending. Deterministic and
# cheap — the model reads this before answering a free-form question (`/time-logger <question>`)
# so it knows what it can answer from disk and what is stale.
#
# Usage: context.sh [days]     (default 7)
set -u
DAYS="${1:-7}"
DATA_HOME="${TIME_LOGGER_DATA_HOME:-$HOME/.local/share/time-logger}"
CAPS="$DATA_HOME/capabilities.yml"
PREFS="$DATA_HOME/user-preferences.md"
now=$(date +%s)

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
age() {  # seconds -> "25m" / "3h10m" / "2d"
  local s=$1; if (( s < 3600 )); then echo "$((s/60))m"; elif (( s < 86400 )); then echo "$((s/3600))h$(( (s%3600)/60 ))m"; else echo "$((s/86400))d"; fi
}
file_age() { local m; m=$(mtime "$1"); [ -n "$m" ] && age $((now - m)) || echo "—"; }
day_offset() { date -v-"$1"d +%F 2>/dev/null || date -d "$1 days ago" +%F; }
yq() { grep -A20 "^$1:" "$CAPS" 2>/dev/null | grep -m1 "^[[:space:]]*$2:" | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+#.*$//; s/^"(.*)"$/\1/'; }

echo "data_home: $DATA_HOME"
echo "now: $(date '+%Y-%m-%d %H:%M') ($(date +%A))"
echo "org: $(yq client org)   dashboard: port $(yq dashboard port) launchd=$(yq dashboard launchd)"
en=""; for k in claude_sessions slack google_calendar github granola; do
  v=$(grep -A3 "^[[:space:]]*$k:" "$CAPS" 2>/dev/null | grep -m1 enabled | awk '{print $2}'); [ "$v" = "true" ] && en="$en $k"; done
echo "enabled sources:${en:- none}"
si=$(grep -A2 '^submit:' "$CAPS" 2>/dev/null | grep -m1 instructions | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+#.*$//'); si="${si/#\~/$HOME}"
if [ -n "$si" ] && [ -f "$si" ]; then echo "submit: $si — $(grep -m1 '^# ' "$si" | sed 's/^# *//')"; else echo "submit: ${si:-disabled (blank)}${si:+ (FILE MISSING)}"; fi

port=$(yq dashboard port); port="${port:-4680}"
if curl -sf -o /dev/null "http://localhost:$port/data/meta.json"; then echo "server: up on :$port"; else echo "server: not answering on :$port"; fi
rl="$DATA_HOME/dashboard/logs/refresh.log"; ml="$DATA_HOME/dashboard/logs/morning.log"
lr=$(grep 'refresh end' "$rl" 2>/dev/null | tail -1 | sed -E 's/^\[([^]]+)\].*/\1/')
lm=$(grep 'morning run done' "$ml" 2>/dev/null | tail -1 | sed -E 's/^\[([^]]+)\].*/\1/')
echo "last scheduled refresh: ${lr:-never}   last morning run: ${lm:-never}"
pf="$DATA_HOME/dashboard/feedback/pending.json"
pc=$(python3 -c "import json,sys;d=json.load(open('$pf'));print(sum(1 for x in d if not x.get('resolved')) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
echo "pending dashboard comments: $pc"
sc=$(ls "$DATA_HOME"/summaries/*.md 2>/dev/null | wc -l | tr -d " "); sl=$(ls "$DATA_HOME"/summaries/*.md 2>/dev/null | sort | tail -1)
echo "summaries: $sc saved${sl:+, latest $(basename "$sl")}"
echo
echo "freshness — age of each file (- = not fetched / not drafted):"
printf '  %-10s %-4s %-8s %-8s %-8s %-8s %-8s %-8s\n' date day claude slack calendar github granola DRAFT
for i in $(seq 0 $((DAYS-1))); do
  d=$(day_offset "$i"); dn=$(date -j -f %F "$d" +%a 2>/dev/null || date -d "$d" +%a)
  row=""
  for src in claude slack calendar github granola; do
    f="$DATA_HOME/raw/$src/$d.md"; [ -f "$f" ] && row="$row $(printf '%-8s' "$(file_age "$f")")" || row="$row $(printf '%-8s' -)"
  done
  tf="$DATA_HOME/time_logs/time_entries_${d//-/}.md"
  if [ -f "$tf" ]; then hrs=$(grep -m1 '^\*\*Hours\*\*' "$tf" | sed -E 's/.*:[[:space:]]*//'); dr="$(file_age "$tf") ($hrs)"; else dr="-"; fi
  printf '  %-10s %-4s%s %s\n' "$d" "$dn" "$row" "$dr"
done
echo
echo "paths:"
echo "  drafts        $DATA_HOME/time_logs/time_entries_YYYYMMDD.md   (one [client: Name] tag per entry; header has Hours/Clients)"
echo "  raw sources   $DATA_HOME/raw/{claude,slack,calendar,github,granola}/YYYY-MM-DD.md"
echo "  combined      $DATA_HOME/raw/combined/"
echo "  summaries     $DATA_HOME/summaries/YYYY-MM-DD_<slug>.md   (frontmatter: title, focus, audience, format, range)"
echo "  preferences   $PREFS   (Orgs, Clients, Corrections log)"
echo "  config        $CAPS"
echo "  dashboard     $DATA_HOME/dashboard/data/*.json (rendered store), feedback/pending.json, logs/"
