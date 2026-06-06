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
#
# Two bugs this fixes (2026-06-07):
#  1. The Hindsight server is STATELESS (HINDSIGHT_API_MCP_STATELESS=true) and
#     returns NO mcp-session-id header, so the old code's `[ -n "$SESSION" ]`
#     gate was ALWAYS false → the refresh NEVER fired. Stateless MCP needs no
#     session — drop the gate (mirrors src/memory/hindsight.ts, which tolerates
#     a missing session id).
#  2. refresh_mental_model takes `mental_model_id` (a UUID), NOT `name`. Passing
#     `name` returns isError "Missing required argument: mental_model_id". So we
#     list_mental_models, resolve the `user-profile` model's id, then refresh
#     by id.
{
  # initialize (no session id needed on the stateless server).
  curl -sS -X POST "$API_URL/mcp/" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "X-Bank-Id: $BANK_ID" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mm-refresh","version":"0.1"}}}' \
    -m 3 -o /dev/null 2>/dev/null || true

  # Resolve the user-profile mental model's id (refresh is by id, not name).
  # list_mental_models returns the items as a JSON STRING nested in
  # .result.structuredContent.result, so parse with jq (fromjson). The agent
  # image ships jq; if it's somehow absent, MM_ID stays empty → skip (the next
  # Stop fires it again; fire-and-forget, no wedge).
  MM_ID=$(curl -sS -X POST "$API_URL/mcp/" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "X-Bank-Id: $BANK_ID" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_mental_models","arguments":{}}}' \
    -m 5 2>/dev/null \
    | grep '^data:' | sed 's/^data: //' \
    | jq -r '.result.structuredContent.result | fromjson | .items[] | select(.name=="user-profile") | .id' 2>/dev/null | head -1)

  if [ -n "$MM_ID" ]; then
    curl -sS -X POST "$API_URL/mcp/" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H "X-Bank-Id: $BANK_ID" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"refresh_mental_model\",\"arguments\":{\"mental_model_id\":\"$MM_ID\"}}}" \
      -m 5 -o /dev/null 2>/dev/null || true
  fi
  date +%s > "$MARKER"
} &
exit 0
