#!/usr/bin/env bash
# switchroom-status/scripts/status.sh
# Fetches and formats agent status from switchroom agent list
# Called directly for quick shell output (not required for the skill itself)

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

if ! command -v switchroom &>/dev/null; then
  echo "ERROR: switchroom not found on PATH"
  echo "Install: npm install -g switchroom"
  exit 1
fi

RAW=$(switchroom agent list --json 2>/dev/null) || {
  echo "ERROR: switchroom agent list failed"
  exit 1
}

if [ -z "$RAW" ] || [ "$RAW" = '{"agents":[]}' ]; then
  echo "No agents configured."
  exit 0
fi

echo "$RAW" | python3 -c "
import sys, json

payload = json.load(sys.stdin)
agents = payload.get('agents', [])
running = 0

for a in agents:
    name    = a.get('name', 'unknown')
    status  = a.get('status', 'unknown')
    model   = a.get('model', 'unknown')
    topic   = a.get('topic_name', '')
    uptime  = a.get('uptime', '')

    status_icon = '✓' if status == 'active' else '✗' if status in ('inactive', 'exited', 'dead') else '?'

    line = f'{status_icon} {name}'
    if topic:
        line += f' ({topic})'
    line += f' — {status}'
    if uptime:
        line += f' ({uptime})'
    print(line)
    print(f'    model: {model}')
    print()

    if status == 'active':
        running += 1

print(f'{running} of {len(agents)} agents running.')
"
