#!/bin/bash
# UserPromptSubmit hook for Hindsight auto-recall.
#
# Wired into an agent's .claude/settings.json hooks.UserPromptSubmit when
# switchroom.yaml has memory.backend == hindsight AND the agent has
# memory.auto_recall != false. On every inbound user prompt, this script:
#
#   1. Reads the JSON event from stdin (per Claude Code's hook contract)
#   2. Extracts the prompt text
#   3. Strips Telegram channel XML wrappers so the recall query is the
#      actual user content, not the surrounding metadata
#   4. POSTs to Hindsight's /v1/default/banks/{collection}/memories/recall
#   5. Formats the top results and prints to stdout — Claude Code prepends
#      this output to the user message as hook context
#
# Configuration is via env vars (set in the hook command line, see
# scaffold.ts for the wiring):
#
#   SWITCHROOM_HINDSIGHT_URL    - Hindsight API base URL (default http://127.0.0.1:8888)
#   SWITCHROOM_HINDSIGHT_BANK   - Memory bank/collection name (required)
#   SWITCHROOM_RECALL_MAX_TOKENS - Token budget for recall (default 800 — small to
#                             keep auto-recall lightweight; the agent can
#                             call recall directly via MCP for deeper queries)
#
# Failure modes (all silent — auto-recall must never block the user):
#   - jq missing             → exit 0 with no output
#   - hindsight unreachable  → exit 0 with no output
#   - bank doesn't exist     → exit 0 with no output (Hindsight returns 404)
#   - empty result set       → exit 0 with no output
#   - recall returns error   → exit 0 with no output

set -u

HINDSIGHT_URL="${SWITCHROOM_HINDSIGHT_URL:-http://127.0.0.1:8888}"
BANK="${SWITCHROOM_HINDSIGHT_BANK:-}"
MAX_TOKENS="${SWITCHROOM_RECALL_MAX_TOKENS:-800}"
TIMEOUT="${SWITCHROOM_RECALL_TIMEOUT_SECONDS:-3}"

if [ -z "$BANK" ]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

# Read the entire stdin event JSON
EVENT=$(cat)
if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract the prompt text. Tolerate non-JSON or missing fields.
PROMPT=$(printf '%s' "$EVENT" | jq -r '.prompt // empty' 2>/dev/null)
if [ -z "$PROMPT" ]; then
  exit 0
fi

# Strip a leading Telegram channel XML wrapper. The plugin sends prompts
# like:
#   <channel source="switchroom-telegram" chat_id="..." ...>
#   actual user text
#   </channel>
#
# For recall purposes we want the inner text only. If the prompt isn't
# wrapped, leave it alone.
QUERY=$(printf '%s' "$PROMPT" | sed -n -E ':a; N; $!ba; s|^[[:space:]]*<channel[^>]*>||; s|</channel>[[:space:]]*$||; p' | head -c 4000)
if [ -z "$QUERY" ]; then
  QUERY="$PROMPT"
fi

# POST to Hindsight recall. -m sets a hard timeout so a slow Hindsight
# can't hang the user's turn. -f makes curl exit non-zero on HTTP 4xx/5xx.
RESPONSE=$(curl -sf -m "$TIMEOUT" -X POST \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$QUERY" --argjson m "$MAX_TOKENS" '{query: $q, max_tokens: $m}')" \
  "${HINDSIGHT_URL}/v1/default/banks/${BANK}/memories/recall" 2>/dev/null)

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Format the recall results into a context block. Each memory has
# .text and .timestamp; we render them as bullet points with the date.
# $bank is passed as a jq --arg so the shell never interpolates the raw
# value into the filter body. Today bank names are agent names
# ([a-zA-Z0-9_-]) so it doesn't matter, but matching how $q is already
# handled above keeps the hook auditable — nothing inside the jq filter
# is shell-expanded.
FORMATTED=$(printf '%s' "$RESPONSE" | jq -r --arg bank "$BANK" '
  if .results == null or (.results | length) == 0 then
    empty
  else
    "## Recalled context (Hindsight, bank: " + $bank + ")\n\n" +
    (.results | map("- " + (.text // "(no text)") + (if .timestamp then " (" + .timestamp + ")" else "" end)) | join("\n"))
  end
' 2>/dev/null)

if [ -n "$FORMATTED" ]; then
  printf '%s\n' "$FORMATTED"
fi

# --- Workspace dynamic bootstrap (MEMORY.md, today/yesterday daily,
#     HEARTBEAT.md) ---
# The dynamic workspace block is re-read every turn. Prepend it so the
# agent sees the latest memory state + heartbeat intentions inline with
# the user's message. Stable files (AGENTS.md, etc.) are baked into the
# system prompt at start.sh time and not re-rendered here.
if [ -n "${SWITCHROOM_AGENT_NAME:-}" ] && command -v switchroom >/dev/null 2>&1; then
  WS_DYNAMIC=$(timeout 3 switchroom workspace render "$SWITCHROOM_AGENT_NAME" --dynamic --warning-mode once 2>/dev/null || true)
  if [ -n "$WS_DYNAMIC" ]; then
    if [ -n "$FORMATTED" ]; then
      printf '\n'
    fi
    printf '%s\n' "$WS_DYNAMIC"
  fi
fi

exit 0
