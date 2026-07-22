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
# Periodic maintenance (backup + autovacuum tuning + op retention). Runs
# from the same background loop because it needs a live pg (which boots
# only after the exec below). Best-effort + idempotent. See the script
# header for the jobs + env knobs. Empty/unset path disables it.
MAINTENANCE="${SWITCHROOM_HINDSIGHT_MAINTENANCE_SCRIPT:-/usr/local/lib/switchroom/hindsight-maintenance.sh}"
REAP_STALE_S="${SWITCHROOM_HINDSIGHT_REAP_STALE_S:-1800}"
# Bounded batch + concurrency guard for the reaper reset (incident
# 2026-07-22): reset at most this many stale rows per pass, and skip any a
# live worker currently row-locks (FOR UPDATE SKIP LOCKED) so we can never
# steal a claim mid-flight.
REAP_BATCH_LIMIT="${SWITCHROOM_HINDSIGHT_REAP_BATCH_LIMIT:-1000}"
# Corrupt-index self-heal switch (incident 2026-07-22). When the reaper's
# reset UPDATE fails with the pk_async_operations unique-violation signature
# (a corrupt PK btree — the exact 3-day-freeze cause), REINDEX the index and
# retry the reset. 1=on (default), 0=alarm-only (log the loud ERROR, skip the
# automatic REINDEX DDL).
REINDEX_SELFHEAL="${SWITCHROOM_HINDSIGHT_REINDEX_SELFHEAL:-1}"
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

# One reaper reset pass. Reads the (effectively global, sh has no locals)
# connection vars set by reap_stale_processing; echoes psql's COMBINED
# stdout+stderr and returns psql's exit status so the caller can both parse
# the `UPDATE N` tag on success AND inspect the error text on failure.
#
# Bounded + concurrency-safe: the SKIP LOCKED subselect resets only stale,
# unlocked, non-batch 'processing' rows — never a row a live worker currently
# row-locks — at most REAP_BATCH_LIMIT per pass.
#   - threshold (REAP_STALE_S, default 30 min) sits well above the
#     consolidation LLM timeout + the 600s DB statement_timeout, so it only
#     ever fires on genuinely-dead claims, never a long-but-live one.
#   - the batch_id guard mirrors upstream: batch-API ops have their own
#     recovery path (_recover_batch_operations) and must not be reset here.
_reap_reset_pass() {
  PGPASSWORD="${_pgpw}" "${_psql}" -U "${_pguser}" -h /tmp -p "${_pgport}" -d "${_pgdb}" -v ON_ERROR_STOP=1 -c \
    "UPDATE async_operations SET status='pending', worker_id=NULL, claimed_at=NULL, updated_at=now() WHERE operation_id IN (SELECT operation_id FROM async_operations WHERE status='processing' AND claimed_at < now() - make_interval(secs => ${REAP_STALE_S}) AND coalesce(result_metadata->>'batch_id','') = '' ORDER BY claimed_at FOR UPDATE SKIP LOCKED LIMIT ${REAP_BATCH_LIMIT})" \
    2>&1
}

# Log the reset count from psql's own `UPDATE N` tag (ROW_COUNT of THIS
# statement) — NEVER a follow-up `SELECT count(*) … updated_at > now()-5s`,
# which counted fresh enqueues and inflated the reaper log (#3421).
_reap_log_count() {
  _n="$(printf '%s\n' "$1" | awk '/^UPDATE[[:space:]]+[0-9]+/ { print $2; exit }')"
  _n="$(echo "${_n}" | tr -d '[:space:]')"
  if [ "${_n:-0}" -gt 0 ] 2>/dev/null; then
    log "stale-claim reaper reset ${_n} stuck 'processing' op(s) older than ${REAP_STALE_S}s -> pending"
  fi
}

# Rebuild the pk_async_operations PK btree from the (dup-free) heap. Echoes
# combined output, returns status. CONCURRENTLY first (no table lock, but can
# fail leaving an INVALID index); plain REINDEX as an atomic fallback (brief
# ACCESS EXCLUSIVE lock — acceptable: the queue is already wedged).
_reap_reindex_pk() {
  if _rout="$(PGPASSWORD="${_pgpw}" "${_psql}" -U "${_pguser}" -h /tmp -p "${_pgport}" -d "${_pgdb}" -v ON_ERROR_STOP=1 -c 'REINDEX INDEX CONCURRENTLY pk_async_operations' 2>&1)"; then
    printf '%s' "${_rout}"; return 0
  fi
  log "hindsight-reaper reindex_selfheal=concurrent-failed falling-back-to-plain detail: $(printf '%s' "${_rout}" | tr '\n' ' ' | cut -c1-200)"
  if _rout="$(PGPASSWORD="${_pgpw}" "${_psql}" -U "${_pguser}" -h /tmp -p "${_pgport}" -d "${_pgdb}" -v ON_ERROR_STOP=1 -c 'REINDEX INDEX pk_async_operations' 2>&1)"; then
    printf '%s' "${_rout}"; return 0
  fi
  printf '%s' "${_rout}"; return 1
}

# Lease-timeout reaper (fix B above) — HARDENED for corrupt-index self-heal
# (incident 2026-07-22). Resets async_operations stuck in 'processing' past
# the threshold back to 'pending' so the live worker re-claims them —
# mirroring upstream recover_own_tasks() but keyed on claim age instead of the
# (ephemeral) worker_id.
#
# CORRUPT-INDEX SELF-HEAL (the 3-day freeze this closes): when the
# pk_async_operations btree is corrupt, the reset UPDATE itself throws
# `duplicate key value violates unique constraint "pk_async_operations"`
# (writing the updated rows' index tuples collides with a phantom entry) —
# EXACTLY like upstream recover_own_tasks. The PRIOR reaper piped that failure
# into `2>/dev/null) || return 0` and silently no-oped, so stuck ops were
# never reset and NOTHING alarmed → per-bank consolidation deadlocked for
# days. Now: on ANY reset failure we (1) log a LOUD structured ERROR (never
# swallow again), and (2) if the failure carries the pk_async_operations
# signature and REINDEX_SELFHEAL != 0, REINDEX the index and retry the reset
# once — the same REINDEX that manually cleared the live incident, automated.
#
# Still best-effort on the benign no-op paths (pg not up yet, missing instance
# file, psql absent) so it can never wedge the loop or the container. No-ops
# cleanly on hosts without the embedded pg (e.g. unit tests).
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

  # First reset pass. `if var=$(...)` keeps this set -e-safe (a failing
  # command substitution in an if-condition does NOT abort the shell) and,
  # crucially, does NOT swallow the error — _out carries psql's stderr.
  if _out="$(_reap_reset_pass)"; then
    _reap_log_count "${_out}"
    return 0
  fi

  # Reset FAILED — never swallow (that silent no-op WAS the 3-day freeze).
  # Loud structured ERROR the fleet log monitor / `switchroom doctor` can grep.
  log "ERROR: hindsight-reaper reset_failed — stuck 'processing' ops NOT reset; consolidation may deadlock. detail: $(printf '%s' "${_out}" | tr '\n' ' ' | cut -c1-300)"

  # Corrupt-index self-heal: the reset UPDATE hit the pk_async_operations
  # unique-violation signature => the PK btree is corrupt. REINDEX + retry.
  if printf '%s' "${_out}" | grep -q 'pk_async_operations' && [ "${REINDEX_SELFHEAL}" != "0" ]; then
    log "ERROR: hindsight-reaper reindex_selfheal=attempting index=pk_async_operations reason=corrupt-index-blocks-reset"
    if _rout="$(_reap_reindex_pk)"; then
      log "hindsight-reaper reindex_selfheal=ok index=pk_async_operations — retrying reset"
      if _out2="$(_reap_reset_pass)"; then
        _reap_log_count "${_out2}"
        log "hindsight-reaper reindex_selfheal=recovered reset retried successfully after REINDEX"
      else
        log "ERROR: hindsight-reaper reindex_selfheal=reset-still-failing after REINDEX — manual intervention needed. detail: $(printf '%s' "${_out2}" | tr '\n' ' ' | cut -c1-300)"
      fi
    else
      log "ERROR: hindsight-reaper reindex_selfheal=failed index=pk_async_operations — manual 'REINDEX INDEX CONCURRENTLY pk_async_operations' needed. detail: $(printf '%s' "${_rout}" | tr '\n' ' ' | cut -c1-300)"
    fi
  fi
  return 0
}

# Boot-deferred reaper (2026-07-19): the refresh-loop reaper only fires after
# the first REFRESH_S sleep (default 1800s). After a crash/recreate that leaves
# orphaned `processing` claims, consolidation is blocked until that first tick
# — or until an operator hand-resets them. Fire ONE reaper attempt as soon as
# embedded pg accepts connections, without holding boot. Best-effort; dies with
# the container when PID 1 exits.
reap_stale_processing_when_ready() {
  [ "${REAP_STALE_S}" -gt 0 ] || return 0
  # Host unit tests point PG0_INSTANCE at a missing path — skip entirely so we
  # don't leave a long-lived sleep loop under PID 1 replacement and dilate the
  # suite. Live containers always have the pg0 descriptor on the data volume.
  [ -r "${PG0_INSTANCE}" ] || return 0
  (
    # Up to ~2 min for embedded pg to finish recovery + accept.
    for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
      if ls /tmp/.s.PGSQL.* >/dev/null 2>&1; then
        sleep 2
        reap_stale_processing || true
        exit 0
      fi
      sleep 5
    done
  ) &
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
      # ...and periodic maintenance (backup / autovacuum / op retention).
      # Self-gates on interval + pg-readiness; safe to invoke every tick.
      [ -f "${MAINTENANCE}" ] && sh "${MAINTENANCE}" || true
    done
  ) &
  log "credential refresh loop started (interval=${REFRESH_S}s, pid=$!)"
fi

export CLAUDE_CONFIG_DIR="${CRED_DIR}"

# 4b. Boot-deferred stale-claim reaper (does not block boot; see fn header).
reap_stale_processing_when_ready || true

# 5. Hand off to upstream start-all.sh.
exec "$@"
