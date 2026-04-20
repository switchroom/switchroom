#!/usr/bin/env bash
# UserPromptSubmit hook for stable workspace content (AGENTS.md, SOUL.md,
# USER.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md).
#
# Used only when channels.telegram.hotReloadStable is true. In that mode,
# the stable workspace render moves from a session-start bake into
# --append-system-prompt to a per-turn injection via this hook. Lets
# workspace edits show up on the next turn without an agent restart, at the
# cost of ~5-10% per-turn latency/spend (the stable prefix is no longer
# prompt-cached).
#
# Configuration is via env vars (set at start.sh time):
#
#   SWITCHROOM_AGENT_NAME - The agent name (required, set in start.sh)
#   SWITCHROOM_CONFIG     - Path to switchroom.yaml (optional)
#
# Failure modes (all silent — workspace injection must never block the turn):
#   - switchroom CLI missing  → exit 0 with no output
#   - workspace dir missing   → exit 0 with no output
#   - workspace render fails  → exit 0 with no output
#   - empty result set        → exit 0 with no output

set -euo pipefail

AGENT="${SWITCHROOM_AGENT_NAME:-}"
CONFIG="${SWITCHROOM_CONFIG:-}"

if [ -z "$AGENT" ]; then
  exit 0
fi

if ! command -v switchroom >/dev/null 2>&1; then
  exit 0
fi

# Render the stable workspace files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md,
# TOOLS.md, HEARTBEAT.md). The render command exits 0 and returns empty string
# if the workspace doesn't exist or all stable files are missing/empty, so no
# special-casing needed here.
#
# --warning-mode off: truncation warnings go to the stable render shown in
# debug output, not the per-turn path where they'd spam every turn.
#
# timeout 5: belt-and-braces so a hung render (disk I/O stall, etc) can't
# freeze the user's turn. The render is a few file reads and should finish in
# <50ms; 5s is generous headroom.
if [ -n "$CONFIG" ]; then
  WS_STABLE=$(timeout 5 switchroom --config "$CONFIG" workspace render "$AGENT" --stable --warning-mode off 2>/dev/null || true)
else
  WS_STABLE=$(timeout 5 switchroom workspace render "$AGENT" --stable --warning-mode off 2>/dev/null || true)
fi

if [ -n "$WS_STABLE" ]; then
  printf '%s\n' "$WS_STABLE"
fi

exit 0
