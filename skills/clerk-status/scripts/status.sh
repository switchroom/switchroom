#!/usr/bin/env bash
# clerk-status/scripts/status.sh
# Fetches and formats agent status from clerk agent list
# Called directly for quick shell output (not required for the skill itself)

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

if ! command -v clerk &>/dev/null; then
  echo "ERROR: clerk not found on PATH"
  echo "Install: npm install -g clerk-ai"
  exit 1
fi

RAW=$(clerk agent list --json 2>/dev/null) || {
  echo "ERROR: clerk agent list failed"
  exit 1
}

if [ -z "$RAW" ] || [ "$RAW" = "[]" ]; then
  echo "No agents configured."
  exit 0
fi

TOTAL=$(echo "$RAW" | python3 -c "import sys,json; agents=json.load(sys.stdin); print(len(agents))" 2>/dev/null || echo "?")
RUNNING=0

echo "$RAW" | python3 -c "
import sys, json, datetime

agents = json.load(sys.stdin)
running = 0

for a in agents:
    name    = a.get('name', 'unknown')
    status  = a.get('status', 'unknown')
    model   = a.get('model', 'unknown')
    topic   = a.get('topic_name', '')
    coll    = a.get('memory', {}).get('collection', '')
    uptime  = a.get('uptime', '')
    pid     = a.get('pid', '')

    status_icon = '✓' if status == 'running' else '✗' if status in ('stopped','failed') else '?'

    line = f'{status_icon} {name}'
    if topic:
        line += f' ({topic})'
    line += f' — {status}'
    if uptime:
        line += f' ({uptime})'
    print(line)
    print(f'    model: {model}', end='')
    if coll:
        print(f'  collection: {coll}', end='')
    if pid:
        print(f'  pid: {pid}', end='')
    print()
    print()

    if status == 'running':
        running += 1

print(f'{running} of {len(agents)} agents running.')
" 2>/dev/null || echo "$RAW"
