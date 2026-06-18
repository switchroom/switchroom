#!/bin/sh
# switchroom/hindsight entrypoint shim.
#
# RFC H §4.8 — ephemeral consumer pattern. The auth-broker binds a
# per-consumer UDS at /run/switchroom/auth-broker/hindsight/sock on
# the broker side; the hindsight compose project bind-mounts the
# `auth-broker-hindsight-sock` named volume into this container at
# /run/switchroom/auth-broker/, so the socket is reachable here as
# /run/switchroom/auth-broker/sock (the consumer's single-socket
# view of its own bind).
#
# Boot flow:
#   1. Wait up to ${WAIT_TIMEOUT_S} for the broker socket to appear
#      (broker may still be starting on the host).
#   2. Run hindsight-fetch-creds.cjs once (LABEL=boot) — fetches creds,
#      writes the tmpfs dotfile.
#   3. Spawn a background refresh loop that re-runs the fetcher every
#      ${REFRESH_S} seconds (LABEL=refresh). RFC H §4.8 step 6:
#      "Hindsight re-fetches via get-credentials after its tmpfs copy
#      ages out." The broker refreshes its canonical creds at the
#      60-min threshold; this loop runs at half that by default
#      (1800s = 30 min) so we stay safely ahead of access-token
#      expiry while not hammering the broker.
#   4. Export CLAUDE_CONFIG_DIR so the claude-agent-sdk picks up the
#      credentials.
#   5. exec into the upstream CMD ("$@"), preserving PID 1 + signal
#      handling so docker's --restart unless-stopped backs off cleanly.
#      The refresh loop survives the exec as a sibling shell process;
#      it dies when the container dies.
#
# Env-var knobs (all have safe defaults; tests override):
#   SWITCHROOM_AUTH_BROKER_SOCKET   broker socket path
#                                   default /run/switchroom/auth-broker/sock
#   SWITCHROOM_HINDSIGHT_CRED_DIR   where to write the dotfile
#                                   default /run/claude-creds
#   SWITCHROOM_HINDSIGHT_WAIT_S     socket-wait timeout in seconds
#                                   default 60
#   SWITCHROOM_HINDSIGHT_REFRESH_S  refresh-loop interval in seconds
#                                   default 1800 (30 min)
#                                   set to 0 to disable the loop (test only)
#   SWITCHROOM_HINDSIGHT_WORKER_ID  stable hindsight worker identity
#                                   default switchroom-hindsight
#   SWITCHROOM_HINDSIGHT_REAP_STALE_S  lease-timeout reaper threshold in
#                                   seconds. Stuck 'processing' async ops
#                                   whose claim is older than this are
#                                   reset to 'pending' on each loop tick.
#                                   default 1800 (30 min); 0 disables.
#
# Durable consolidation across restarts (incident 2026-06-18):
#   Hindsight's worker derives its id from the container hostname (the
#   ephemeral docker id, NEW on every `compose` recreate). Its only
#   crash-recovery — recover_own_tasks(), which at startup resets stuck
#   'processing' async_operations WHERE worker_id = <own id> — can
#   therefore never reclaim a PRIOR incarnation's in-flight tasks: a
#   worker that dies mid-consolidation strands those ops forever (4 agent
#   banks went 26 days with zero new observations). We fix this at the
#   "how switchroom runs hindsight" layer, two ways:
#     A. Pin HINDSIGHT_API_WORKER_ID to a stable value so every restart
#        runs recover_own_tasks() against its predecessor's id and
#        reclaims the stranded ops via hindsight's own tested path. Safe
#        because hindsight is single-worker (DEFAULT_WORKERS=1).
#     B. A lease-timeout reaper on the background loop catches the
#        no-restart wedge (worker hangs but the container never bounces,
#        so [A]'s startup recovery never fires) — it resets any
#        'processing' op claimed longer ago than the threshold.
#
# Fail-loud — every step has an explicit exit. We never boot hindsight
# with empty/missing credentials; better to crash-loop with a clear
# log line than 500 every request.
set -eu

SOCKET="${SWITCHROOM_AUTH_BROKER_SOCKET:-/run/switchroom/auth-broker/sock}"
CRED_DIR="${SWITCHROOM_HINDSIGHT_CRED_DIR:-/run/claude-creds}"
CRED_FILE="${CRED_DIR}/.credentials.json"
WAIT_TIMEOUT_S="${SWITCHROOM_HINDSIGHT_WAIT_S:-60}"
REFRESH_S="${SWITCHROOM_HINDSIGHT_REFRESH_S:-1800}"
FETCHER="${SWITCHROOM_HINDSIGHT_FETCHER:-/usr/local/lib/switchroom/hindsight-fetch-creds.cjs}"
REAP_STALE_S="${SWITCHROOM_HINDSIGHT_REAP_STALE_S:-1800}"
# pg0 instance descriptor (holds the embedded-postgres password); the
# reaper reads it to connect. Overridable for host tests.
PG0_INSTANCE="${SWITCHROOM_HINDSIGHT_PG0_INSTANCE:-/home/hindsight/.pg0/instances/hindsight/instance.json}"

log() { echo "switchroom-hindsight-entrypoint: $*" >&2; }

# Stable worker identity (fix A above). `:=` only sets it when the
# operator/compose hasn't already pinned HINDSIGHT_API_WORKER_ID, so an
# explicit override still wins. Exported so the upstream worker
# (worker/main.py reads ENV_WORKER_ID) picks it up.
: "${HINDSIGHT_API_WORKER_ID:=${SWITCHROOM_HINDSIGHT_WORKER_ID:-switchroom-hindsight}}"
export HINDSIGHT_API_WORKER_ID

# Lease-timeout reaper (fix B above). Resets async_operations stuck in
# 'processing' past the threshold back to 'pending' so the live worker
# re-claims them — mirroring upstream recover_own_tasks() but keyed on
# claim age instead of the (ephemeral) worker_id. Best-effort: any
# failure (pg not up yet, missing instance file, psql absent) is
# swallowed so it can never wedge the loop or the container. No-ops
# cleanly on hosts without the embedded pg (e.g. unit tests).
#   - threshold (REAP_STALE_S, default 30 min) sits well above the
#     consolidation LLM timeout + the 600s DB statement_timeout, so it
#     only ever fires on genuinely-dead claims, never a long-but-live one.
#   - the batch_id guard mirrors upstream: batch-API ops have their own
#     recovery path (_recover_batch_operations) and must not be reset here.
reap_stale_processing() {
  [ "${REAP_STALE_S}" -gt 0 ] || return 0
  [ -r "${PG0_INSTANCE}" ] || return 0
  _psql="$(command -v psql 2>/dev/null || ls /home/hindsight/.pg0/installation/*/bin/psql 2>/dev/null | head -1)"
  [ -n "${_psql}" ] && [ -x "${_psql}" ] || return 0
  # Pull connection fields from the pg0 descriptor without a JSON dep in sh.
  if ! { read -r _pguser; read -r _pgdb; read -r _pgport; read -r _pgpw; } <<EOF
$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("username","hindsight"));print(d.get("database","hindsight"));print(d.get("port",5432));print(d.get("password",""))' "${PG0_INSTANCE}" 2>/dev/null)
EOF
  then
    return 0
  fi
  [ -n "${_pgpw}" ] || return 0
  _n="$(PGPASSWORD="${_pgpw}" "${_psql}" -U "${_pguser}" -h /tmp -p "${_pgport}" -d "${_pgdb}" -tAc \
    "UPDATE async_operations SET status='pending', worker_id=NULL, claimed_at=NULL, updated_at=now() WHERE status='processing' AND claimed_at < now() - make_interval(secs => ${REAP_STALE_S}) AND result_metadata->>'batch_id' IS NULL RETURNING 1" \
    2>/dev/null | grep -c 1 || true)"
  if [ "${_n:-0}" -gt 0 ]; then
    log "stale-claim reaper reset ${_n} stuck 'processing' op(s) older than ${REAP_STALE_S}s -> pending"
  fi
}

# 1. Wait for the broker socket. The broker may still be starting on
# the host when this container boots (no cross-project depends_on).
i=0
while [ ! -S "${SOCKET}" ]; do
  i=$((i + 1))
  if [ "${i}" -ge "${WAIT_TIMEOUT_S}" ]; then
    log "auth-broker socket ${SOCKET} did not appear within ${WAIT_TIMEOUT_S}s; giving up"
    exit 1
  fi
  sleep 1
done

# 2. Cred dir.
mkdir -p "${CRED_DIR}"
chmod 0700 "${CRED_DIR}"

# 3. Boot-time fetch. The fetcher exits non-zero on any error; we
# refuse to boot hindsight with broken or missing credentials.
SOCKET="${SOCKET}" CRED_FILE="${CRED_FILE}" LABEL=boot node "${FETCHER}" || {
  log "boot credential fetch failed; refusing to boot hindsight"
  exit 1
}

# Sanity-check the file landed (defense-in-depth — the fetcher already
# exits non-zero on failure, but a stale layer / mount weirdness could
# still leave the dotfile missing).
[ -s "${CRED_FILE}" ] || {
  log "${CRED_FILE} is missing or empty after boot fetch; refusing to boot hindsight"
  exit 1
}

# 4. Background refresh loop. Survives the exec below as a sibling
# shell process — when the container dies (SIGTERM to PID 1), the
# shell dies with it. Disabled when REFRESH_S=0 (test mode) or when
# the fetcher is missing (defence in depth; should never happen in
# a real container).
if [ "${REFRESH_S}" -gt 0 ] && [ -f "${FETCHER}" ]; then
  (
    while sleep "${REFRESH_S}"; do
      SOCKET="${SOCKET}" CRED_FILE="${CRED_FILE}" LABEL=refresh node "${FETCHER}" || true
      # Best-effort: a transient broker outage shouldn't kill the loop.
      # The next tick retries. Hindsight keeps running on the previous
      # successfully-fetched credentials until the loop catches up.
      # Same loop drives the stale-claim reaper (fix B) — also best-effort.
      reap_stale_processing || true
    done
  ) &
  log "credential refresh loop started (interval=${REFRESH_S}s, pid=$!)"
fi

export CLAUDE_CONFIG_DIR="${CRED_DIR}"

# 5. Hand off to upstream start-all.sh.
exec "$@"
