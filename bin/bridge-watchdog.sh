#!/usr/bin/env bash
# Watchdog: restarts switchroom agent services whose Telegram bridge has
# disconnected from the gateway. Designed to run on a systemd timer.
#
# For each agent, checks whether the gateway is up and has an active bridge.
# If the gateway is healthy but the bridge is disconnected (or never connected),
# restarts the agent service so Claude Code gets a fresh MCP server.

set -euo pipefail

AGENTS=(
  "assistant:/home/kenthompson/.switchroom/agents/assistant/telegram/gateway.log"
  "klanker:/home/kenthompson/.switchroom-klanker/agents/klanker/telegram/gateway.log"
)

for entry in "${AGENTS[@]}"; do
  agent="${entry%%:*}"
  gateway_log="${entry#*:}"
  gateway_svc="switchroom-${agent}-gateway.service"
  agent_svc="switchroom-${agent}.service"

  # Skip if gateway isn't running — PartOf= handles that restart path
  if ! systemctl --user is-active --quiet "$gateway_svc" 2>/dev/null; then
    continue
  fi

  # Skip if agent isn't running
  if ! systemctl --user is-active --quiet "$agent_svc" 2>/dev/null; then
    continue
  fi

  # Check the gateway log for the last bridge event.
  # "bridge registered" = healthy, "bridge disconnected" = dead
  last_bridge_event=$(strings "$gateway_log" 2>/dev/null \
    | grep -E 'bridge (registered|disconnected)' \
    | tail -1 || true)

  if [[ -z "$last_bridge_event" ]]; then
    # No bridge events at all — bridge never connected
    bridge_healthy=false
  elif [[ "$last_bridge_event" == *"bridge registered"* ]]; then
    bridge_healthy=true
  else
    bridge_healthy=false
  fi

  if [[ "$bridge_healthy" == false ]]; then
    echo "$(date -Iseconds) watchdog: ${agent} bridge is disconnected, restarting ${agent_svc}"
    systemctl --user restart "$agent_svc"
  fi
done
