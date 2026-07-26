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
# --- pg0 sizing pre-start (#3706) -------------------------------------------
# Values come from src/setup/hindsight-pg-defaults.ts via `docker run -e` /
# compose `environment:`. EMPTY OR UNSET DISABLES that flag, and empty/unset
# for BOTH disables the pre-start entirely — so an older switchroom that does
# not set them keeps today's behaviour byte for byte. The literal `off` (any
# case) is the operator's per-knob opt-out.
PG_EFFECTIVE_CACHE_SIZE="${SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE:-}"
PG_SHARED_BUFFERS="${SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS:-}"
# pg0 CLI. The python wheel bundles it; the venv's python minor version is not
# guaranteed stable, so glob rather than hard-code. Overridable for tests.
PG0_BIN="${SWITCHROOM_HINDSIGHT_PG0_BIN:-}"
# Instance name pg0 keys the running server under. Must match the name
# hindsight_api resolves from HINDSIGHT_API_DB_URL, or its ensure_running()
# will not adopt ours.
PG0_NAME="${SWITCHROOM_HINDSIGHT_PG0_NAME:-hindsight}"

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

# ---------------------------------------------------------------------------
# pg0 sizing pre-start (#3706)
#
# Hindsight's embedded PostgreSQL is pg0, and pg0 bakes its tuning into the
# `postgres` child's ARGV:
#
#   postgres -D … -F -p 5432 -c work_mem=64MB -c maintenance_work_mem=512MB
#            -c effective_cache_size=1GB -c shared_buffers=256MB …
#
# PostgreSQL ranks the `command line` source ABOVE both postgresql.conf and
# postgresql.auto.conf, so `ALTER SYSTEM SET` cannot move those two values —
# verified live: ALTER SYSTEM + pg_reload_conf() left pg_settings reporting the
# old value with source='command line'.
#
# The route that DOES work: hindsight_api's EmbeddedPostgres.ensure_running()
# (api/hindsight_api/pg0.py) short-circuits when the named instance is already
# running — it returns the existing URI and never re-applies config. So we
# start pg0 ourselves, with tuned `-c` flags, before exec'ing the upstream CMD.
# pg0 MERGES `-c` over its own defaults (verified: a probe started with
# `-c effective_cache_size=4GB -c shared_buffers=1536MB` kept pg0's work_mem,
# maintenance_work_mem, max_parallel_maintenance_workers and logging flags).
#
# BEST-EFFORT BY CONSTRUCTION. Every failure path returns 0 and leaves pg0
# unstarted, so hindsight_api starts it exactly as it does today with pg0's own
# defaults. A sizing change can never be why the container fails to boot.
#
# Connection identity is READ from the existing instance descriptor rather than
# assumed, so we can never rewrite it with different credentials; on first boot
# (no descriptor) we use hindsight_api's own DEFAULT_USERNAME / DEFAULT_PASSWORD
# / DEFAULT_DATABASE ("hindsight") and let pg0 auto-allocate the port, which is
# byte-identical to what EmbeddedPostgres() would have done.
prestart_pg0() {
  # Normalise the two knobs; `off` (any case) means "leave pg0's default".
  case "$(printf '%s' "${PG_EFFECTIVE_CACHE_SIZE}" | tr '[:upper:]' '[:lower:]')" in
    off) PG_EFFECTIVE_CACHE_SIZE="" ;;
  esac
  case "$(printf '%s' "${PG_SHARED_BUFFERS}" | tr '[:upper:]' '[:lower:]')" in
    off) PG_SHARED_BUFFERS="" ;;
  esac
  # Nothing to apply ⇒ do not touch pg0 at all (pre-#3706 behaviour).
  [ -n "${PG_EFFECTIVE_CACHE_SIZE}" ] || [ -n "${PG_SHARED_BUFFERS}" ] || return 0

  # Only the embedded-pg0 database is ours to pre-start. An operator pointing
  # hindsight at an external postgres (or a differently-named/ported pg0
  # instance) must not have a server started underneath them.
  case "${HINDSIGHT_API_DB_URL:-pg0}" in
    pg0 | "pg0://${PG0_NAME}") : ;;
    *)
      log "pg0 pre-start skipped: HINDSIGHT_API_DB_URL=${HINDSIGHT_API_DB_URL:-} is not the default embedded instance"
      return 0
      ;;
  esac

  _pg0="${PG0_BIN}"
  if [ -z "${_pg0}" ]; then
    _pg0="$(command -v pg0 2>/dev/null || ls /app/api/.venv/lib/python3.*/site-packages/pg0/bin/pg0 2>/dev/null | head -1)"
  fi
  if [ -z "${_pg0}" ] || [ ! -x "${_pg0}" ]; then
    log "pg0 pre-start skipped: pg0 binary not found (hindsight_api will start pg0 with its own defaults)"
    return 0
  fi

  # Identity: reuse the descriptor when it exists so we never rewrite it.
  _pu="hindsight"; _pp="hindsight"; _pd="hindsight"; _pport=""
  if [ -r "${PG0_INSTANCE}" ]; then
    if { read -r _v_u; read -r _v_d; read -r _v_p; read -r _v_pw; } <<EOF
$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("username","hindsight"));print(d.get("database","hindsight"));print(d.get("port",""));print(d.get("password","hindsight"))' "${PG0_INSTANCE}" 2>/dev/null)
EOF
    then
      if [ -n "${_v_u}" ]; then _pu="${_v_u}"; fi
      if [ -n "${_v_d}" ]; then _pd="${_v_d}"; fi
      if [ -n "${_v_pw}" ]; then _pp="${_v_pw}"; fi
      if [ -n "${_v_p}" ]; then _pport="${_v_p}"; fi
    fi
  fi

  # NOTE: `set --` inside a POSIX function shadows only the FUNCTION's
  # positional parameters; the script's "$@" (the upstream CMD this entrypoint
  # execs) is restored on return. Every branch below is an `if`, never a bare
  # `[ … ] && …` — under `set -eu` a false AND-OR list at statement level would
  # abort the whole entrypoint.
  set -- start --name "${PG0_NAME}" --username "${_pu}" --password "${_pp}" --database "${_pd}"
  if [ -n "${_pport}" ]; then set -- "$@" --port "${_pport}"; fi
  if [ -n "${PG_EFFECTIVE_CACHE_SIZE}" ]; then
    set -- "$@" -c "effective_cache_size=${PG_EFFECTIVE_CACHE_SIZE}"
  fi
  if [ -n "${PG_SHARED_BUFFERS}" ]; then
    set -- "$@" -c "shared_buffers=${PG_SHARED_BUFFERS}"
  fi

  if _out="$("${_pg0}" "$@" 2>&1)"; then
    log "pg0 pre-start ok: name=${PG0_NAME} effective_cache_size=${PG_EFFECTIVE_CACHE_SIZE:-<pg0-default>} shared_buffers=${PG_SHARED_BUFFERS:-<pg0-default>}"
    return 0
  fi

  # `already running` is not a failure — some other path won the race and the
  # instance is up; hindsight_api adopts it either way.
  if printf '%s' "${_out}" | grep -qi 'already running'; then
    log "pg0 pre-start: instance ${PG0_NAME} already running; leaving it alone"
    return 0
  fi

  log "WARNING: pg0 pre-start failed; falling back to hindsight_api's own pg0 start with pg0 defaults. detail: $(printf '%s' "${_out}" | tr '\n' ' ' | cut -c1-300)"
  return 0
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

# 4c. pg0 sizing pre-start (#3706). MUST run before the exec: hindsight_api's
# ensure_running() adopts an already-running instance without re-applying
# config, which is the only reason we can set these at all. Synchronous by
# necessity (a background race would let hindsight_api win and start pg0
# untuned); bounded by pg0's own start, and best-effort — see prestart_pg0().
prestart_pg0 || true

# 5. Hand off to upstream start-all.sh.
exec "$@"
