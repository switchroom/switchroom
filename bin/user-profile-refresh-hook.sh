#!/usr/bin/env bash
# Refresh the user-profile Mental Model on Stop, so the next session
# wakes up with a current snapshot of who the user is.
# Debounced to 30 min via a marker file so rapid-fire turns don't
# hammer Hindsight.
set -u
AGENT_DIR="$(dirname "$TELEGRAM_STATE_DIR")"
BANK_ID="${HINDSIGHT_BANK_ID:-}"
API_URL="${HINDSIGHT_API_URL:-http://127.0.0.1:18888}"
[ -z "$BANK_ID" ] && exit 0
MARKER="$AGENT_DIR/.mm-refresh-last"
if [ -f "$MARKER" ]; then
  _LAST=$(cat "$MARKER" 2>/dev/null || echo 0)
  _NOW=$(date +%s)
  if [ $((_NOW - _LAST)) -lt 1800 ]; then
    exit 0   # < 30 min since last refresh, skip
  fi
fi
# Fire-and-forget refresh via MCP. Timeout bounded by Claude Code hook.
# Output nothing on success or failure; errors are surfaced via doctor.
{
  # JSON-RPC flow: initialize → tools/call refresh_mental_model
  SESSION=$(curl -sS -X POST "$API_URL/mcp/" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "X-Bank-Id: $BANK_ID" -D /tmp/mm-refresh-$$.headers \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mm-refresh","version":"0.1"}}}' \
    -m 3 -o /dev/null 2>/dev/null && grep -i mcp-session-id /tmp/mm-refresh-$$.headers | cut -d' ' -f2 | tr -d '\r\n')
  if [ -n "$SESSION" ]; then
    curl -sS -X POST "$API_URL/mcp/" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H "X-Bank-Id: $BANK_ID" -H "mcp-session-id: $SESSION" \
      -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"refresh_mental_model","arguments":{"name":"user-profile"}}}' \
      -m 5 -o /dev/null 2>/dev/null || true
  fi
  rm -f /tmp/mm-refresh-$$.headers 2>/dev/null || true
  date +%s > "$MARKER"
} &
exit 0
