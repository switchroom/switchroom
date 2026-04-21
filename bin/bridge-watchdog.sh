#!/usr/bin/env bash
# Watchdog: restarts switchroom agent services whose Telegram bridge has
# disconnected from the gateway. Designed to run on a systemd timer.
#
# For each agent, checks whether the gateway is up and has an active bridge.
# If the gateway is healthy but the bridge is disconnected (or never connected),
# restarts the agent service so Claude Code gets a fresh MCP server.
#
# Agent discovery: enumerates ALL active switchroom-*-gateway.service units
# and derives the agent name + gateway-log path from each. This replaces the
# previous hardcoded (agent, log) list which rotted any time an agent was
# renamed or added — e.g. on 2026-04-21 the old list still held "assistant"
# (since renamed to "clerk") and silently skipped the new "lawgpt" agent
# entirely, leaving both in a stale-bridge state for hours while klanker
# (still on the list) kept getting healed.

set -euo pipefail

# Discover active gateway units. systemd's list-units output includes only
# currently-loaded units; we filter to the switchroom-*-gateway.service
# pattern and strip the prefix/suffix to get the agent name.
mapfile -t gateway_services < <(
  systemctl --user list-units --type=service --state=active --no-legend --plain 2>/dev/null \
    | awk '{print $1}' \
    | grep -E '^switchroom-.+-gateway\.service$' || true
)

if [[ ${#gateway_services[@]} -eq 0 ]]; then
  # No active gateways — nothing to watch. Exit cleanly so the timer
  # keeps firing; transient absences (deploy windows) shouldn't error.
  exit 0
fi

for gateway_svc in "${gateway_services[@]}"; do
  # Extract agent name: switchroom-<agent>-gateway.service → <agent>
  agent="${gateway_svc#switchroom-}"
  agent="${agent%-gateway.service}"
  agent_svc="switchroom-${agent}.service"

  # Resolve the gateway's WorkingDirectory to locate its telegram state
  # dir. The gateway's gateway.log lives under WorkingDirectory/gateway.log
  # (the unit generator in src/agents/systemd.ts sets WorkingDirectory to
  # the agent's telegram/ subdir; see generateGatewayUnit).
  gateway_state_dir="$(
    systemctl --user show "$gateway_svc" -p WorkingDirectory --value 2>/dev/null
  )"
  if [[ -z "$gateway_state_dir" ]]; then
    echo "$(date -Iseconds) watchdog: ${agent} gateway has no WorkingDirectory; skipping"
    continue
  fi
  gateway_log="${gateway_state_dir}/gateway.log"

  if [[ ! -f "$gateway_log" ]]; then
    # Log file missing — gateway probably hasn't written a full turn yet.
    # Skip this tick; we'll try again in 60s.
    continue
  fi

  # If the agent service itself is inactive but the gateway is up,
  # treat that as a stale-bridge scenario too and restart it.
  #
  # Why: the agent service has `Restart=on-failure` in its unit (not
  # `Restart=always`) so a clean 0-exit of start.sh leaves it inactive.
  # That happens when Claude Code exits normally mid-session for any
  # reason (including external kill that start.sh handles gracefully).
  # Without this heal path the watchdog's earlier skip-if-inactive
  # guard left agents dead indefinitely.
  #
  # Production incident: 2026-04-22 ~03:44 AEST clerk's start.sh
  # exited with status=0/SUCCESS and the service went inactive. The
  # gateway stayed up; bridge was disconnected; systemd did nothing.
  if ! systemctl --user is-active --quiet "$agent_svc" 2>/dev/null; then
    # Also skip if the service is marked failed (start-limit-hit etc.)
    # — that needs operator intervention, not a restart loop.
    state="$(systemctl --user show "$agent_svc" -p ActiveState --value 2>/dev/null)"
    if [[ "$state" == "failed" ]]; then
      echo "$(date -Iseconds) watchdog: ${agent_svc} is failed state; skipping (needs operator reset-failed)"
      continue
    fi
    echo "$(date -Iseconds) watchdog: ${agent} agent service is inactive (${state}); starting ${agent_svc}"
    systemctl --user start "$agent_svc" || {
      echo "$(date -Iseconds) watchdog: ${agent_svc} start failed"
    }
    continue
  fi

  # Check the gateway log for the last bridge event.
  # "bridge registered"   = healthy
  # "bridge disconnected" = dead
  # (no events yet)       = dead (treat as bridge never connected)
  #
  # strings(1) strips the PTY control codes the gateway emits through
  # `script -qfc`; grep alone would miss lines wrapped in escape
  # sequences.
  last_bridge_event=$(
    strings "$gateway_log" 2>/dev/null \
      | grep -E 'bridge (registered|disconnected)' \
      | tail -1 || true
  )

  if [[ -z "$last_bridge_event" ]]; then
    bridge_healthy=false
  elif [[ "$last_bridge_event" == *"bridge registered"* ]]; then
    bridge_healthy=true
  else
    bridge_healthy=false
  fi

  if [[ "$bridge_healthy" == false ]]; then
    echo "$(date -Iseconds) watchdog: ${agent} bridge is disconnected, restarting ${agent_svc}"
    systemctl --user restart "$agent_svc" || {
      echo "$(date -Iseconds) watchdog: ${agent_svc} restart failed"
    }
  fi
done
