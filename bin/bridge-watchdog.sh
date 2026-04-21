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
#
# False-restart fix (2026-04-22): the bridge IPC flaps `registered ↔
# disconnected` rapidly across Claude Code turn boundaries. The old
# `tail -1` heuristic caught transient disconnect states and restarted
# otherwise-healthy agents. On 2026-04-21 20:12–20:26 AEST this produced
# 3 spurious restarts of klanker mid-CPU-heavy-work. The watchdog now
# requires SUSTAINED disconnection (>= DISCONNECT_GRACE_SECS across
# consecutive ticks) and an uptime grace (>= UPTIME_GRACE_SECS since
# the agent service started) before acting.

set -euo pipefail

# Tunables. Expressed as env-overridable so the test harness can drive
# edge cases without mutating the script.
: "${UPTIME_GRACE_SECS:=90}"       # skip the bridge check for this long after agent (re)start
: "${DISCONNECT_GRACE_SECS:=120}"  # require disconnection to persist this long before restarting

now_epoch() { date +%s; }

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
  # Sidecar file where we remember when the disconnected state started,
  # so we can detect SUSTAINED disconnection across ticks. Lives in the
  # same per-agent state dir so it's self-cleaning when an agent is
  # removed.
  disconnect_marker="${gateway_state_dir}/.watchdog-disconnect-since"

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

  # Uptime grace: freshly-started agents haven't had time to register
  # their bridge yet. systemctl emits ActiveEnterTimestamp in a format
  # like "Tue 2026-04-21 20:23:38 AEST"; ActiveEnterTimestampMonotonic
  # is easier to parse (microseconds since boot) but comparing to
  # wall-clock uptime is cross-platform-icky. We use the wall-clock
  # field and parse it with `date -d`, which systemd's format supports.
  active_enter_ts="$(
    systemctl --user show "$agent_svc" -p ActiveEnterTimestamp --value 2>/dev/null
  )"
  if [[ -n "$active_enter_ts" ]]; then
    # `date -d ""` fails; guard the empty case.
    active_enter_epoch="$(date -d "$active_enter_ts" +%s 2>/dev/null || echo 0)"
    if [[ "$active_enter_epoch" -gt 0 ]]; then
      uptime_secs=$(( $(now_epoch) - active_enter_epoch ))
      if [[ "$uptime_secs" -lt "$UPTIME_GRACE_SECS" ]]; then
        # Agent just started — give it time to come up. Clear any
        # stale disconnect marker from a previous cycle too, so the
        # grace window really is a clean slate.
        rm -f "$disconnect_marker" 2>/dev/null || true
        continue
      fi
    fi
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

  if [[ "$bridge_healthy" == true ]]; then
    # Healthy — wipe the disconnect marker so the next disconnect
    # starts a fresh grace window.
    rm -f "$disconnect_marker" 2>/dev/null || true
    continue
  fi

  # Disconnected. Has it been sustained long enough to act?
  now="$(now_epoch)"
  if [[ -f "$disconnect_marker" ]]; then
    disc_since="$(cat "$disconnect_marker" 2>/dev/null || echo "$now")"
    # Paranoia: if the file got corrupted (non-numeric), treat as now.
    if ! [[ "$disc_since" =~ ^[0-9]+$ ]]; then
      disc_since="$now"
      echo "$now" > "$disconnect_marker"
    fi
  else
    # First observation of disconnect on this tick. Record it and wait.
    echo "$now" > "$disconnect_marker"
    disc_since="$now"
  fi

  disc_duration=$(( now - disc_since ))
  if [[ "$disc_duration" -lt "$DISCONNECT_GRACE_SECS" ]]; then
    # Transient flap — the bridge IPC disconnects across Claude Code
    # turn boundaries. Don't restart yet; give it another tick or two.
    continue
  fi

  echo "$(date -Iseconds) watchdog: ${agent} bridge has been disconnected for ${disc_duration}s (>= ${DISCONNECT_GRACE_SECS}s), restarting ${agent_svc}"
  # Clear the marker so post-restart we don't immediately re-trip on
  # the still-old tail. The uptime grace will cover the startup window
  # anyway, but removing the marker keeps state clean.
  rm -f "$disconnect_marker" 2>/dev/null || true
  systemctl --user restart "$agent_svc" || {
    echo "$(date -Iseconds) watchdog: ${agent_svc} restart failed"
  }
done
