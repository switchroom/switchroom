#!/usr/bin/env bash
# Watchdog: restarts switchroom agent services whose Telegram bridge has
# disconnected from the gateway, OR whose journal output has been silent
# for too long (indicating an internally-frozen agent that systemd still
# reports as "active (running)"). Designed to run on a systemd timer.
#
# For each agent, checks whether the gateway is up and has an active bridge.
# If the gateway is healthy but the bridge is disconnected (or never connected),
# restarts the agent service so Claude Code gets a fresh MCP server.
#
# Journal-silence check (2026-04-26, issue #116): Three klanker hangs in
# 10 hours exposed a class of failure where the agent process is
# "active (running)" to systemd but internally frozen — no journal output
# for many minutes, manual restart the only recovery. Two hangs were on the
# Stop-hook ladder ("running stop hooks 0/N"); one was mid-task at 1.0 GB
# RSS. The watchdog now also checks journal-output freshness per-agent and
# restarts via `switchroom agent restart <agent>` when an agent has been
# silent for JOURNAL_SILENCE_SECS (default 600s) and has cleared the uptime
# grace. Sustained suspicion via a state file under
# /run/user/<uid>/switchroom-watchdog/ prevents transient quiet from
# triggering.
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
: "${UPTIME_GRACE_SECS:=90}"              # skip checks for this long after agent (re)start
: "${DISCONNECT_GRACE_SECS:=600}"         # require disconnection to persist this long before restarting
: "${LIVENESS_GRACE_SECS:=30}"            # liveness file mtime must be recent before we treat bridge as dead
# Journal-silence thresholds. Defaults raised from 600s to 4000s on
# 2026-04-30 (issue #405). The previous 600s default opened a trap zone
# where any agent whose latest journal entry sat between
# JOURNAL_SILENCE_SECS (600s) and RECENT_ACTIVITY_WINDOW_SECS (3600s)
# was eligible for restart. Normal chat-cadence agents (10–60 min between
# user messages) land in that zone every cycle, producing ~208 false
# restarts/24h on a typical host. With both defaults at 4000s (> the
# 3600s recent-activity window), the trap zone closes: by the time
# silence reaches 4000s, the latest entry is already past the
# recent-activity gate and gets treated as idle. The hang detector is
# effectively inert under defaults — operators who want it active must
# opt in by lowering these values via env, and `Restart=on-failure` in
# the unit file still catches actual crashes. See issue #405 for the
# worked example showing the 21.5-min restart cadence the trap zone
# produced.
: "${JOURNAL_SILENCE_SECS:=4000}"          # seconds of journal silence before suspecting a hang
: "${JOURNAL_SILENCE_HARD_SECS:=4000}"     # seconds the silence_since marker must predate before restarting
# Recent-activity gate: only treat journal-silence as suspect-hang when the
# agent had ANY log activity within this window. Distinguishes "hung mid-task"
# (last log moments ago, then silence) from "genuinely idle" (no logs in
# hours/days — agent waiting for the next user message). Default 1h: long
# enough to span a normal session but short enough that a long overnight idle
# doesn't get falsely flagged.
: "${RECENT_ACTIVITY_WINDOW_SECS:=3600}"
# Turn-active marker check (issue #412): the gateway writes a per-agent
# `turn-active.json` at turn-start, touches its mtime on every tool_use,
# and removes it on turn_complete. If the file exists AND its mtime
# hasn't advanced in TURN_HANG_SECS, the agent is wedged mid-turn —
# distinguishable from "legitimately idle" because legitimate idle
# leaves no marker file at all. Default 5 min: bigger than the slowest
# legitimate single-tool turn (a long Bash compile maybe) but tight
# enough to catch Stop-hook deadlocks before the user notices.
: "${TURN_HANG_SECS:=300}"

# Per-agent watchdog state lives under /run/user/$UID/switchroom-watchdog/
# (tmpfs, cleared on logout — correct: we don't want stale silence markers
# surviving restarts). mkdir -p is idempotent.
# WATCHDOG_STATE_DIR is env-overridable for the test harness.
UID_VAL="${UID:-$(id -u)}"
: "${WATCHDOG_STATE_DIR:=/run/user/${UID_VAL}/switchroom-watchdog}"
mkdir -p "$WATCHDOG_STATE_DIR" 2>/dev/null || true

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

  # Check the IPC socket for an actual ESTAB connection from the
  # agent's bridge. This is authoritative — if there's a live unix
  # socket, the bridge is connected right now. If not, it isn't.
  #
  # Why not just grep the gateway log: log grep used to be the check,
  # but it had a subtle bug. After a gateway restart, the log persists
  # across the restart (the gateway's `tee $LOG_PATH` appends). The
  # last "bridge registered" event might be from BEFORE the restart,
  # so `tail -1` reports it as healthy even though the agent hasn't
  # reconnected yet. Production incident 2026-04-22 ~07:20: clerk was
  # stuck with 0 IPC connections but watchdog said healthy because
  # the pre-restart "bridge registered" was the latest in the log.
  #
  # ss -x reads kernel-level socket state so it's immune to log
  # staleness. Unix sockets are visible without sudo for the owner.
  gateway_sock="${gateway_state_dir}/gateway.sock"
  if [[ ! -S "$gateway_sock" ]]; then
    # Socket file doesn't exist — gateway hasn't fully started or is
    # shutting down. Skip this tick; try again in 60s.
    continue
  fi

  ipc_estab_count=$(
    ss -x 2>/dev/null \
      | awk -v sock="$gateway_sock" '$1 == "u_str" && $2 == "ESTAB" && index($0, sock) { n++ } END { print n+0 }'
  )

  if (( ipc_estab_count > 0 )); then
    bridge_healthy=true
  else
    # ESTAB == 0: socket is disconnected. Before declaring the bridge dead,
    # check the liveness file the bridge writes on every heartbeat tick (~5s).
    # A recent mtime means the bridge process is alive but temporarily
    # reconnecting (e.g. after a gateway restart) — restarting the agent
    # here would be wasteful and would kill any in-flight Claude turn.
    liveness_file="${gateway_state_dir}/.bridge-alive"
    bridge_healthy=false
    if [[ -f "$liveness_file" ]]; then
      liveness_mtime=$(stat -c %Y "$liveness_file" 2>/dev/null || echo 0)
      liveness_age=$(( $(now_epoch) - liveness_mtime ))
      if (( liveness_age < LIVENESS_GRACE_SECS )); then
        bridge_healthy=true
        echo "$(date -Iseconds) watchdog: ${agent} bridge socket disconnected but liveness file is fresh (${liveness_age}s ago); bridge process alive, skipping restart"
      fi
    fi
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
  # Stamp WHY before killing so the next agent greeting card can show
  # "Restarted  watchdog: bridge disconnected for ${disc_duration}s".
  # The gateway's own SIGTERM handler writes `clean-shutdown.json` on
  # shutdown too — but its marker carries no `reason`, so the greeting
  # omits the row. Pre-seeding here wins the race: we write it BEFORE
  # issuing systemctl restart so it's on disk by the time the new
  # processes boot. Best-effort: if jq is unavailable fall back to a
  # printf-shaped JSON literal.
  _clean_marker="${gateway_state_dir}/clean-shutdown.json"
  _ts_ms=$(( $(date +%s) * 1000 ))
  _reason="watchdog: bridge disconnected for ${disc_duration}s"
  _tmp="${_clean_marker}.tmp-$$"
  if command -v jq >/dev/null 2>&1; then
    jq -n --argjson ts "$_ts_ms" --arg reason "$_reason" \
      '{ts: $ts, signal: "SIGTERM", reason: $reason}' > "$_tmp" 2>/dev/null \
      && mv -f "$_tmp" "$_clean_marker" 2>/dev/null || rm -f "$_tmp" 2>/dev/null || true
  else
    # Escape backslashes and double-quotes in the reason for safe JSON embedding.
    _esc_reason=$(printf '%s' "$_reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"ts":%s,"signal":"SIGTERM","reason":"%s"}' "$_ts_ms" "$_esc_reason" > "$_tmp" 2>/dev/null \
      && mv -f "$_tmp" "$_clean_marker" 2>/dev/null || rm -f "$_tmp" 2>/dev/null || true
  fi
  systemctl --user restart "$agent_svc" || {
    echo "$(date -Iseconds) watchdog: ${agent_svc} restart failed"
  }
done

# ─── Journal-silence check ───────────────────────────────────────────────────
#
# Independent of the bridge-disconnect check above. For each active
# switchroom-<agent>.service unit (NOT the gateway), verify that it has
# emitted at least one journal entry within JOURNAL_SILENCE_SECS. If an
# agent has been silent longer than that AND uptime has cleared
# UPTIME_GRACE_SECS, record a silence_since marker in the watchdog state
# dir. Once the marker is older than JOURNAL_SILENCE_HARD_SECS, restart
# via `switchroom agent restart <agent>` (the contracted reconcile+restart
# path; NOT raw systemctl restart, which would bypass switchroom's
# config reconciliation).
#
# Why `switchroom agent restart` rather than `systemctl --user restart`:
# the project contract is that all lifecycle transitions go through the
# switchroom CLI so that config reconciliation always runs. Raw systemctl
# calls skip that step and can leave units with stale unit files.

mapfile -t agent_services < <(
  systemctl --user list-units --type=service --state=active --no-legend --plain 2>/dev/null \
    | awk '{print $1}' \
    | grep -E '^switchroom-.+\.service$' \
    | grep -v -E '^switchroom-(gateway|vault-broker|foreman)\.service$' \
    | grep -v -E '^switchroom-.+-gateway\.service$' \
    | grep -v -E '^switchroom-.+-cron-[0-9]+\.service$' || true
)

for agent_svc in "${agent_services[@]}"; do
  # Extract agent name: switchroom-<agent>.service → <agent>
  agent="${agent_svc#switchroom-}"
  agent="${agent%.service}"

  silence_marker="${WATCHDOG_STATE_DIR}/${agent}.silence_since"

  # Uptime grace: same logic as the bridge check. Fresh agents haven't
  # had time to settle into a normal logging cadence.
  active_enter_ts="$(
    systemctl --user show "$agent_svc" -p ActiveEnterTimestamp --value 2>/dev/null
  )"
  if [[ -n "$active_enter_ts" ]]; then
    active_enter_epoch="$(date -d "$active_enter_ts" +%s 2>/dev/null || echo 0)"
    if [[ "$active_enter_epoch" -gt 0 ]]; then
      uptime_secs=$(( $(now_epoch) - active_enter_epoch ))
      if [[ "$uptime_secs" -lt "$UPTIME_GRACE_SECS" ]]; then
        # Clear stale silence marker on fresh start so the grace window
        # is a clean slate.
        rm -f "$silence_marker" 2>/dev/null || true
        continue
      fi
    fi
  fi

  # Issue #412: turn-active marker hang detector. The gateway writes
  # `<agentDir>/telegram/turn-active.json` at turn-start, bumps its
  # mtime on every tool_use, and removes it on turn_complete. If the
  # file is older than TURN_HANG_SECS, the agent is wedged mid-turn —
  # distinguishable from healthy idle because healthy idle leaves no
  # marker file at all. This closes the gap left when JOURNAL_SILENCE_SECS
  # was raised to 4000s (PR #410) to kill chat-cadence false positives.
  agent_state_dir="${HOME}/.switchroom/agents/${agent}/telegram"
  turn_active_file="${agent_state_dir}/turn-active.json"
  if [[ -f "$turn_active_file" ]]; then
    turn_mtime=$(stat -c %Y "$turn_active_file" 2>/dev/null || echo 0)
    if [[ "$turn_mtime" -gt 0 ]]; then
      turn_age=$(( $(now_epoch) - turn_mtime ))
      if [[ "$turn_age" -ge "$TURN_HANG_SECS" ]]; then
        logger -t switchroom-watchdog "agent ${agent}: turn-active marker stale (${turn_age}s >= ${TURN_HANG_SECS}s); restarting via switchroom agent restart (#412)"
        echo "$(date -Iseconds) watchdog: ${agent} wedged mid-turn (${turn_age}s), restarting"
        # Resolve the switchroom CLI (same belt-and-suspenders as below)
        switchroom_cli=""
        for candidate in "${HOME}/.bun/bin/switchroom" "${HOME}/.local/bin/switchroom"; do
          if [[ -x "$candidate" ]]; then
            switchroom_cli="$candidate"
            break
          fi
        done
        if [[ -z "$switchroom_cli" ]] && command -v switchroom >/dev/null 2>&1; then
          switchroom_cli="$(command -v switchroom)"
        fi
        if [[ -n "$switchroom_cli" ]]; then
          "$switchroom_cli" agent restart "$agent" || {
            logger -t switchroom-watchdog "agent ${agent}: switchroom agent restart failed; falling back to systemctl"
            systemctl --user restart "$agent_svc" || true
          }
        else
          systemctl --user restart "$agent_svc" || true
        fi
        # Restarted — skip remaining checks for this agent this tick.
        continue
      fi
    fi
  fi

  # Read the timestamp of the most recent journal entry from this unit.
  # --output=short-unix gives "EPOCH.USEC MESSAGE" format; we grab the
  # leading integer epoch seconds.
  latest_journal_line="$(
    journalctl --user -u "$agent_svc" -n 1 --output=short-unix --no-pager 2>/dev/null || true
  )"
  latest_journal_epoch=0
  if [[ -n "$latest_journal_line" ]]; then
    # short-unix format: "1745632800.123456 hostname unit[pid]: message"
    # Extract the leading epoch (integer part before the dot or space).
    candidate="$(echo "$latest_journal_line" | awk '{print $1}' | cut -d. -f1)"
    if [[ "$candidate" =~ ^[0-9]+$ ]]; then
      latest_journal_epoch="$candidate"
    fi
  fi

  now="$(now_epoch)"
  if [[ "$latest_journal_epoch" -eq 0 ]]; then
    # No journal entries at all — possibly a very new unit that hasn't
    # logged yet. Treat conservatively: skip this tick (uptime grace
    # should have caught a genuine fresh start above, so this branch
    # mostly hits units that truly haven't logged due to a bug — still
    # give them one tick of benefit of the doubt).
    continue
  fi

  journal_age=$(( now - latest_journal_epoch ))

  if [[ "$journal_age" -lt "$JOURNAL_SILENCE_SECS" ]]; then
    # Journal is fresh — clear any stale silence marker and move on.
    rm -f "$silence_marker" 2>/dev/null || true
    continue
  fi

  # Recent-activity gate: only suspect a hang if the agent had log activity
  # within RECENT_ACTIVITY_WINDOW_SECS. A genuinely idle agent (e.g. a
  # personal agent that hasn't received a message in hours/days) has its
  # latest journal entry far in the past — restarting it would just churn
  # state for no reason. A hung agent, by contrast, was active before
  # freezing, so its most recent entry is recent (within the window).
  #
  # Implementation: if `journal_age >= RECENT_ACTIVITY_WINDOW_SECS`, the
  # latest entry is older than the window, so by definition there's no
  # activity inside it. Treat as idle — clear any stale marker and skip.
  if [[ "$journal_age" -ge "$RECENT_ACTIVITY_WINDOW_SECS" ]]; then
    rm -f "$silence_marker" 2>/dev/null || true
    continue
  fi

  # Journal has been silent for >= JOURNAL_SILENCE_SECS but the agent had
  # activity within RECENT_ACTIVITY_WINDOW_SECS. Record the first
  # observation so we can require sustained silence.
  if [[ -f "$silence_marker" ]]; then
    silence_since="$(cat "$silence_marker" 2>/dev/null || echo "$now")"
    if ! [[ "$silence_since" =~ ^[0-9]+$ ]]; then
      silence_since="$now"
      echo "$now" > "$silence_marker"
    fi
  else
    echo "$now" > "$silence_marker"
    silence_since="$now"
    logger -t switchroom-watchdog "agent ${agent}: journal silent for ${journal_age}s; recording silence marker (will restart after ${JOURNAL_SILENCE_HARD_SECS}s of sustained silence)"
    continue
  fi

  silence_duration=$(( now - silence_since ))
  if [[ "$silence_duration" -lt "$JOURNAL_SILENCE_HARD_SECS" ]]; then
    # Silence not yet sustained long enough to act.
    continue
  fi

  # The agent has been journal-silent for >= JOURNAL_SILENCE_HARD_SECS
  # AND has cleared the uptime grace. This matches the production hang
  # pattern (issue #116). Restart via the switchroom CLI.
  logger -t switchroom-watchdog "agent ${agent}: journal silent for ${journal_age}s (marker age ${silence_duration}s >= ${JOURNAL_SILENCE_HARD_SECS}s); restarting via switchroom agent restart"
  echo "$(date -Iseconds) watchdog: ${agent} journal silent for ${journal_age}s, restarting"
  rm -f "$silence_marker" 2>/dev/null || true

  # Use `switchroom agent restart` (not raw systemctl) — the project
  # contract is that all agent lifecycle transitions go through the CLI
  # so config reconciliation always runs.
  #
  # Belt-and-suspenders CLI resolution (issue #406): the systemd .service
  # unit pins Environment=PATH=~/.bun/bin:..., but if a hand-installed
  # legacy unit is still on disk the PATH may be empty. Probe the two
  # known install locations directly before falling back to PATH lookup,
  # so a silent PATH gap can't silently downgrade us to the systemctl
  # fallback (which bypasses reconcile).
  switchroom_cli=""
  for candidate in "${HOME}/.bun/bin/switchroom" "${HOME}/.local/bin/switchroom"; do
    if [[ -x "$candidate" ]]; then
      switchroom_cli="$candidate"
      break
    fi
  done
  if [[ -z "$switchroom_cli" ]] && command -v switchroom >/dev/null 2>&1; then
    switchroom_cli="$(command -v switchroom)"
  fi

  if [[ -n "$switchroom_cli" ]]; then
    "$switchroom_cli" agent restart "$agent" || {
      logger -t switchroom-watchdog "agent ${agent}: switchroom agent restart failed; falling back to systemctl"
      systemctl --user restart "$agent_svc" || true
    }
  else
    # Fallback: if the switchroom CLI isn't on PATH (unusual), use systemctl
    # directly and log the degraded path.
    logger -t switchroom-watchdog "agent ${agent}: switchroom CLI not on PATH; using systemctl restart as fallback"
    systemctl --user restart "$agent_svc" || true
  fi
done
