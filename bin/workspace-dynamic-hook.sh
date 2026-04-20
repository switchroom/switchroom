#!/bin/bash
# UserPromptSubmit hook for dynamic workspace bootstrap (MEMORY.md, daily
# notes, HEARTBEAT.md).
#
# Wired into the agent's .claude/settings.json hooks.UserPromptSubmit by
# scaffold.ts. On every inbound user prompt, this script re-renders the
# dynamic workspace files and prints the result to stdout — Claude Code
# prepends this output to the user message as hook context.
#
# Configuration is via env vars (set at start.sh time):
#
#   SWITCHROOM_AGENT_NAME - The agent name (required, set in start.sh)
#
# Failure modes (all silent — workspace injection must never block the turn):
#   - switchroom CLI missing  → exit 0 with no output
#   - workspace dir missing   → exit 0 with no output
#   - workspace render fails  → exit 0 with no output
#   - empty result set        → exit 0 with no output

set -u

AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

if ! command -v switchroom >/dev/null 2>&1; then
  exit 0
fi

# Render the dynamic workspace files (MEMORY.md, today/yesterday daily,
# HEARTBEAT.md). The render command exits 0 and returns empty string if the
# workspace doesn't exist or all dynamic files are missing/empty, so no
# special-casing needed here.
#
# --warning-mode off: truncation warnings go to the stable render (where they
# can surface during scaffold/reconcile), not the per-turn path where they'd
# spam every turn.
#
# timeout 3: belt-and-braces so a hung render (disk I/O stall, etc) can't
# freeze the user's turn. The render is a few file reads and should finish in
# <50ms; 3s is generous headroom.
WS_DYNAMIC=$(timeout 3 switchroom workspace render "$AGENT_NAME" --dynamic --warning-mode off 2>/dev/null || true)

if [ -n "$WS_DYNAMIC" ]; then
  printf '%s\n' "$WS_DYNAMIC"
fi

exit 0
