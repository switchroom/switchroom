#!/bin/sh
# switchroom/hindsight HOST-SIDE autoheal loop (#2910).
#
# The problem this closes: the standalone `switchroom-hindsight` container
# (started by `startHindsight()` / `switchroom memory --start`) carries a
# docker healthcheck that marks it `unhealthy` in `docker inspect` when the
# API wedges. But vanilla Docker NEVER restarts a container on health status
# — `--restart always` acts on process EXIT only. And the in-container
# `hindsight-maintenance.sh` runs inside that same container with no docker
# binary/socket, so it cannot restart itself. So a wedged-but-not-exited API
# stayed `unhealthy` forever and the fleet went silently amnesiac.
#
# This script is the missing host-side mechanism. It runs in a TINY sidecar
# (the hostd image, which already carries the docker CLI) that talks to the
# docker daemon through the EXISTING hostd `docker-socket-proxy` over
# DOCKER_HOST=tcp://docker-socket-proxy:2375 — least-privilege: the proxy
# already allowlists GET /containers (inspect) + POST restart (ALLOW_RESTARTS)
# for hostd, so no new socket mount and no widened surface are introduced.
#
# It polls the target's `.State.Health.Status` and, on `unhealthy`, issues a
# `docker restart` — but GUARDED against restart loops: at most
# MAX_RESTARTS within a sliding WINDOW_S window, with exponential backoff
# between restarts. When the cap is hit it GIVES UP loudly (structured log
# line `switchroom doctor` reads back) and enters a cooldown before it will
# try again, so a genuinely-broken hindsight can't be restart-looped forever.
#
# Every decision is logged as a single structured line prefixed
# `hindsight-autoheal` so `switchroom doctor` (classifyAutohealStatus in
# src/cli/doctor-memory.ts) can report "hindsight was auto-restarted N times /
# autoheal gave up" from `docker logs`.
#
# Env knobs (all defaulted):
#   SWITCHROOM_HINDSIGHT_AUTOHEAL              master switch (1=on, 0=off). default 1
#   SWITCHROOM_HINDSIGHT_AUTOHEAL_TARGET       container name. default switchroom-hindsight
#   SWITCHROOM_HINDSIGHT_AUTOHEAL_POLL_S       seconds between polls. default 30
#   SWITCHROOM_HINDSIGHT_AUTOHEAL_MAX_RESTARTS restarts allowed per window. default 3
#   SWITCHROOM_HINDSIGHT_AUTOHEAL_WINDOW_S     sliding window seconds. default 3600 (1h)
#   SWITCHROOM_HINDSIGHT_AUTOHEAL_BACKOFF_BASE_S exp-backoff base seconds. default 30
#   SWITCHROOM_HINDSIGHT_AUTOHEAL_COOLDOWN_S   pause after giving up. default 900 (15m)
#
# Sourcing for tests: set SWITCHROOM_HINDSIGHT_AUTOHEAL_LIB_ONLY=1 to load the
# pure decision functions WITHOUT entering the poll loop.
set -u

# ── Pure decision core (unit-tested; no docker, no clock side-effects) ───────
#
# autoheal_prune STATE NOW WINDOW
#   STATE is a space-separated list of past restart epoch-seconds. Echoes the
#   subset still inside [NOW-WINDOW, NOW]. Deterministic, no side effects.
autoheal_prune() {
  _state="$1"; _now="$2"; _window="$3"
  _cutoff=$((_now - _window))
  _out=""
  for _ts in $_state; do
    if [ "$_ts" -ge "$_cutoff" ] 2>/dev/null; then
      _out="${_out:+$_out }$_ts"
    fi
  done
  printf '%s' "$_out"
}

# autoheal_count STATE
#   Echoes how many timestamps are in STATE.
autoheal_count() {
  set -- $1
  printf '%d' "$#"
}

# autoheal_decide HEALTH STATE NOW WINDOW MAX
#   THE decision function. Echoes "<verb>|<new-state>" where verb is:
#     ok       — target is not unhealthy; nothing to do (state pruned).
#     restart  — unhealthy AND under the cap; NOW appended to the new state.
#     capped   — unhealthy AND already at/over MAX restarts in the window.
#   new-state is the pruned (and, for restart, NOW-appended) timestamp list.
autoheal_decide() {
  _health="$1"; _st="$2"; _now="$3"; _win="$4"; _max="$5"
  _pruned=$(autoheal_prune "$_st" "$_now" "$_win")
  _n=$(autoheal_count "$_pruned")
  if [ "$_health" != "unhealthy" ]; then
    printf 'ok|%s' "$_pruned"
    return 0
  fi
  if [ "$_n" -ge "$_max" ]; then
    printf 'capped|%s' "$_pruned"
    return 0
  fi
  printf 'restart|%s' "${_pruned:+$_pruned }$_now"
}

# autoheal_backoff BASE COUNT
#   Exponential backoff seconds = BASE * 2^COUNT, capped at 8*BASE so it can
#   never grow unbounded. COUNT is the number of restarts already done this
#   window (0-based → first restart waits BASE).
autoheal_backoff() {
  _base="$1"; _c="$2"
  _mult=1
  _i=0
  while [ "$_i" -lt "$_c" ]; do
    _mult=$((_mult * 2))
    _i=$((_i + 1))
    if [ "$_mult" -ge 8 ]; then _mult=8; break; fi
  done
  printf '%d' $((_base * _mult))
}

# autoheal_log EVENT KEY=VAL ...
#   Emit one structured line doctor can grep. Stable prefix + flat k=v pairs.
autoheal_log() {
  _ev="$1"; shift
  _ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'na')
  printf 'hindsight-autoheal event=%s ts=%s %s\n' "$_ev" "$_ts" "$*"
}

# ── Runtime loop (skipped when sourced with LIB_ONLY=1) ──────────────────────
autoheal_main() {
  ENABLED="${SWITCHROOM_HINDSIGHT_AUTOHEAL:-1}"
  TARGET="${SWITCHROOM_HINDSIGHT_AUTOHEAL_TARGET:-switchroom-hindsight}"
  POLL_S="${SWITCHROOM_HINDSIGHT_AUTOHEAL_POLL_S:-30}"
  MAX="${SWITCHROOM_HINDSIGHT_AUTOHEAL_MAX_RESTARTS:-3}"
  WINDOW_S="${SWITCHROOM_HINDSIGHT_AUTOHEAL_WINDOW_S:-3600}"
  BACKOFF_BASE_S="${SWITCHROOM_HINDSIGHT_AUTOHEAL_BACKOFF_BASE_S:-30}"
  COOLDOWN_S="${SWITCHROOM_HINDSIGHT_AUTOHEAL_COOLDOWN_S:-900}"

  if [ "$ENABLED" = "0" ]; then
    autoheal_log disabled target="$TARGET"
    return 0
  fi

  autoheal_log started target="$TARGET" poll_s="$POLL_S" max_restarts="$MAX" window_s="$WINDOW_S"

  STATE=""
  gave_up=0
  while true; do
    now=$(date +%s)
    # Health status; "missing" if the container/daemon can't be inspected
    # (target recreating, daemon blip) — treated as NOT unhealthy so we never
    # fight a legitimate recreate. python3-free: pure docker CLI.
    health=$(docker inspect -f '{{.State.Health.Status}}' "$TARGET" 2>/dev/null) || health="missing"
    [ -z "$health" ] && health="missing"

    decision=$(autoheal_decide "$health" "$STATE" "$now" "$WINDOW_S" "$MAX")
    verb="${decision%%|*}"
    STATE="${decision#*|}"

    case "$verb" in
      restart)
        gave_up=0
        # count BEFORE this restart = entries minus the one just appended
        newcount=$(autoheal_count "$STATE")
        priorcount=$((newcount - 1))
        autoheal_log restart_issued target="$TARGET" health="$health" attempt="$newcount" window_restarts="$newcount"
        if docker restart "$TARGET" >/dev/null 2>&1; then
          autoheal_log restart_ok target="$TARGET" attempt="$newcount"
        else
          autoheal_log restart_failed target="$TARGET" attempt="$newcount"
        fi
        backoff=$(autoheal_backoff "$BACKOFF_BASE_S" "$priorcount")
        sleep "$backoff"
        continue
        ;;
      capped)
        if [ "$gave_up" = "0" ]; then
          autoheal_log gave_up target="$TARGET" health="$health" restarts="$(autoheal_count "$STATE")" window_s="$WINDOW_S" cooldown_s="$COOLDOWN_S"
          gave_up=1
        fi
        sleep "$COOLDOWN_S"
        # Cooldown elapsed: clear the window so a since-recovered target can be
        # healed again, but a still-broken one just re-trips the cap next tick.
        STATE=""
        continue
        ;;
      ok|*)
        gave_up=0
        ;;
    esac
    sleep "$POLL_S"
  done
}

if [ "${SWITCHROOM_HINDSIGHT_AUTOHEAL_LIB_ONLY:-0}" != "1" ]; then
  autoheal_main
fi
