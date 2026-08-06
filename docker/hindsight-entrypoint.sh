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
# --- pg0 durability pre-start ------------------------------------------------
# `on` (the default) makes the pre-start append `-c fsync=on`; `off` omits the
# flag and leaves pg0's own `-F` (fsync OFF) standing.
#
# Unlike the two sizing knobs above this one defaults ON *here*, not only in
# src/setup/hindsight-pg-defaults.ts, and deliberately: durability must not
# depend on a new-enough switchroom CLI having emitted the env var. An operator
# running an older `switchroom apply`, or `docker run`-ing the image by hand,
# still gets a crash-safe database.
PG_FSYNC="${SWITCHROOM_HINDSIGHT_PG_FSYNC:-on}"
# pg0 CLI. The python wheel bundles it; the venv's python minor version is not
# guaranteed stable, so glob rather than hard-code. Overridable for tests.
PG0_BIN="${SWITCHROOM_HINDSIGHT_PG0_BIN:-}"
# Instance name pg0 keys the running server under. Must match the name
# hindsight_api resolves from HINDSIGHT_API_DB_URL, or its ensure_running()
# will not adopt ours.
PG0_NAME="${SWITCHROOM_HINDSIGHT_PG0_NAME:-hindsight}"
# --- Text-search provisioning (durable stopword config) ---------------------
# Baked stopword source (docker/hindsight-extra.stop → COPYd here at build time
# to a STABLE, version-independent path). Empty/missing DISABLES provisioning
# entirely, so an older image without the baked file — or an operator who
# removed it — boots exactly as before. Overridable for host tests.
TS_STOP_SRC="${SWITCHROOM_HINDSIGHT_TS_STOP_SRC:-/usr/local/lib/switchroom/hindsight_extra.stop}"
# Glob of the CURRENT embedded-pg install's tsearch_data dir(s). pg0 extracts a
# fresh, version-scoped install dir on every embedded-pg bump; the stopword file
# is re-materialized into every match on each boot so a bump can never orphan it
# (the "could not open stop-word file" landmine). Overridable for host tests.
TS_STOP_DEST_GLOB="${SWITCHROOM_HINDSIGHT_TS_STOP_DEST_GLOB:-/home/hindsight/.pg0/installation/*/share/tsearch_data}"
# Bounded readiness retries for the idempotent DDL. `pg0 start` already blocks
# until the server accepts, so the first psql normally succeeds; this only
# insures a slow-recovery edge. One `sleep 1` between tries.
TS_PROVISION_TRIES="${SWITCHROOM_HINDSIGHT_TS_PROVISION_TRIES:-30}"
# --- ParadeDB pg_search provisioning (durable BM25 backend) ------------------
# Baked extension artifacts. docker/Dockerfile.hindsight stages pg_search.so +
# the control + version SQL under a PG-MAJOR subdir here (…/pg_search/18/{lib,
# extension}). Empty/missing DISABLES pg_search provisioning entirely, so an
# older image without the bake boots exactly as before. Overridable for tests.
PG_SEARCH_SRC_ROOT="${SWITCHROOM_HINDSIGHT_PG_SEARCH_SRC_ROOT:-/usr/local/lib/switchroom/pg_search}"
# Glob of the embedded-pg install dir(s) to provision into. pg0 extracts a
# fresh, version-scoped install dir on every embedded-pg bump; the .so + control
# + SQL are re-materialized into each MAJOR-matched match on every boot (the pg0
# data dir is a mounted volume, so nothing baked into the image survives there).
# Overridable for host tests.
PG_SEARCH_INSTALL_GLOB="${SWITCHROOM_HINDSIGHT_PG_SEARCH_INSTALL_GLOB:-/home/hindsight/.pg0/installation/*}"
# The resolved text-search backend selector, read from the same env switchroom
# emits (src/setup/hindsight-perf-defaults.ts) and hindsight_api itself reads.
# pg_search provisioning AND the shared_preload_libraries flag are applied ONLY
# when this is exactly `pg_search`; any other value — empty (an older switchroom
# that does not emit it), or an operator pin of `native` on a not-yet-migrated
# fleet — leaves the box on the native backend, byte-identical to before.
TEXT_SEARCH_EXTENSION="${HINDSIGHT_API_TEXT_SEARCH_EXTENSION:-}"

log() { echo "switchroom-hindsight-entrypoint: $*" >&2; }

# Echoes the BAKED pg_search MAJOR (e.g. "18") when pg_search is the selected
# backend AND the extension artifacts are baked into the image; empty otherwise.
# This is the SOURCE side: provision_pg_search() uses it to locate the artifacts
# to stage into the embedded-pg install dir. It says nothing about whether the
# stage SUCCEEDED — see pg_search_landed_major() for the preload gate.
pg_search_baked_major() {
  [ "${TEXT_SEARCH_EXTENSION}" = "pg_search" ] || return 0
  for _sofile in ${PG_SEARCH_SRC_ROOT}/*/lib/pg_search.so; do
    [ -r "${_sofile}" ] || continue
    _m="${_sofile%/lib/pg_search.so}"
    _m="${_m##*/}"
    printf '%s\n' "${_m}"
    return 0
  done
  return 0
}

# Echoes the LANDED pg_search MAJOR when pg_search is the selected backend AND
# pg_search.so has actually been COPIED into a version-scoped embedded-pg install
# dir whose major matches the baked deb; empty otherwise. This is the DESTINATION
# side, and it is what prestart_pg0() gates the shared_preload_libraries=pg_search
# flag on — NOT the bake.
#
# WHY NOT the bake (pg_search_baked_major). The two CAN disagree: on a future pg
# MAJOR bump that lands a new install dir AHEAD of the baked deb,
# provision_pg_search() correctly SKIPS the copy (ABI mismatch), so the install
# dir has no .so even though the bake still exists under PG_SEARCH_SRC_ROOT. A
# postmaster told to preload a library that is not in its install dir REFUSES to
# start, so gating the preload on the bake would turn that graceful copy-skip
# into a boot crash-loop — the exact opposite of the "ABI mismatch refused
# gracefully" contract. Gating on the landed .so degrades a skipped/failed stage
# to "no preload -> pg0 starts plain -> hindsight_api's CREATE EXTENSION pg_search
# surfaces the missing library loudly" — the correct, recoverable failure mode.
#
# The baked-major match also ignores a STALE .so left in an OLD install dir by a
# prior boot: only a dir whose major equals the currently-baked deb can have been
# staged with an ABI-compatible library, so that is the only major we preload.
pg_search_landed_major() {
  [ "${TEXT_SEARCH_EXTENSION}" = "pg_search" ] || return 0
  _baked="$(pg_search_baked_major)"
  [ -n "${_baked}" ] || return 0
  for _sofile in ${PG_SEARCH_INSTALL_GLOB}/lib/pg_search.so; do
    [ -r "${_sofile}" ] || continue
    _d="${_sofile%/lib/pg_search.so}"
    _ver="${_d##*/}"
    case "${_ver%%.*}" in
      "${_baked}") printf '%s\n' "${_baked}"; return 0 ;;
    esac
  done
  return 0
}

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
# pg0 sizing + durability pre-start (#3706)
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
# DURABILITY. Note the `-F` in that argv: pg0 starts PostgreSQL with fsync
# DISABLED, which means a crash can leave a torn or stale page that
# `data_checksums` still validates (a lost write, not a corrupt one). `-F` is a
# positional flag pg0 always emits immediately after `-D`/`-p`, BEFORE the
# merged `-c` block, and postgres applies command-line options in order — so a
# later `-c fsync=on` wins. Verified on a throwaway pg0 instance from the same
# image (2026-07-29):
#
#   pg0 start --name probeA … -c fsync=on
#   argv:  postgres -D …/probeA/data -F -p 5432 … -c fsync=on …
#   SELECT name, setting, source FROM pg_settings WHERE name='fsync'
#     →  fsync | on | command line
#
# The order of the `-c` flags among themselves is NOT stable (pg0 iterates a
# map), so this only holds because `-F` is positional and there is exactly one
# fsync `-c`. Do not add a second one.
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
  # fsync is a tri-state collapsed to a boolean: only the literal `on` (any
  # case) applies the flag. `off`, empty, and any typo all fall through to
  # "omit it", which restores pg0's `-F` — the pre-change behaviour. A typo can
  # therefore never hand postgres an unparseable `fsync=` value and turn a
  # durability change into a boot failure.
  case "$(printf '%s' "${PG_FSYNC}" | tr '[:upper:]' '[:lower:]')" in
    on) PG_FSYNC="on" ;;
    *) PG_FSYNC="" ;;
  esac
  # pg_search preload. When pg_search is the selected backend and its .so has
  # actually LANDED in the install dir, THIS start is the authoritative one that
  # must set shared_preload_libraries=pg_search — a PGC_POSTMASTER GUC that only
  # applies at server start. provision_pg_search() ran just before us, staged the
  # .so into the install dir, and left pg0 STOPPED precisely so this start applies
  # the preload. We gate on pg_search_landed_major() (the COPIED .so whose major
  # matches the baked deb), not the bake: if provisioning could not stage the
  # library — e.g. a future pg-major bump moved the install dir ahead of the
  # baked deb and the ABI-mismatched copy was skipped — this returns empty, we do
  # NOT preload, pg0 starts plain, and hindsight_api surfaces any real miss loudly.
  _pg_preload_major="$(pg_search_landed_major)"
  # Nothing to apply ⇒ do not touch pg0 at all (pre-#3706 behaviour).
  [ -n "${PG_EFFECTIVE_CACHE_SIZE}" ] || [ -n "${PG_SHARED_BUFFERS}" ] ||
    [ -n "${PG_FSYNC}" ] || [ -n "${_pg_preload_major}" ] || return 0

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
  if [ -n "${PG_FSYNC}" ]; then
    set -- "$@" -c "fsync=${PG_FSYNC}"
  fi
  if [ -n "${_pg_preload_major}" ]; then
    # NOTE: this SETS shared_preload_libraries rather than appending. pg0 does
    # not set the GUC itself, so `pg_search` is the only preloaded library. If a
    # second preload-requiring extension is ever added, make this a
    # comma-joined value — a second `-c shared_preload_libraries=` would NOT
    # merge, the last one wins.
    set -- "$@" -c "shared_preload_libraries=pg_search"
  fi

  if _out="$("${_pg0}" "$@" 2>&1)"; then
    log "pg0 pre-start ok: name=${PG0_NAME} effective_cache_size=${PG_EFFECTIVE_CACHE_SIZE:-<pg0-default>} shared_buffers=${PG_SHARED_BUFFERS:-<pg0-default>} fsync=${PG_FSYNC:-<pg0-default:off>} shared_preload_libraries=$([ -n "${_pg_preload_major}" ] && echo pg_search || echo '<none>')"
    return 0
  fi

  # `already running` — some path won the race and the instance is up. When NO
  # preload is required, adopting it is fine (hindsight_api would too). But when
  # the pg_search preload IS required (_pg_preload_major set), a postmaster that
  # came up WITHOUT shared_preload_libraries=pg_search can never CREATE EXTENSION
  # pg_search (PGC_POSTMASTER — the GUC only applies at start), so adopting it
  # silently would strand the box on a boot loop or a broken text-search backend.
  # Verify via SHOW; if the preload is absent, STOP and restart WITH it rather
  # than adopt a preload-less postmaster (MAJOR-2). This matters when
  # provision_pg_search()'s own `pg0 stop` failed and left a plain server up.
  if printf '%s' "${_out}" | grep -qi 'already running'; then
    if [ -z "${_pg_preload_major}" ]; then
      log "pg0 pre-start: instance ${PG0_NAME} already running; leaving it alone"
      return 0
    fi
    _cur_preload=""
    _psqlx="$(command -v psql 2>/dev/null || ls /home/hindsight/.pg0/installation/*/bin/psql 2>/dev/null | head -1)"
    if [ -n "${_psqlx}" ] && [ -x "${_psqlx}" ] && [ -n "${_pport}" ]; then
      _cur_preload="$(PGPASSWORD="${_pp}" "${_psqlx}" -U "${_pu}" -h /tmp -p "${_pport}" -d "${_pd}" -tAc 'SHOW shared_preload_libraries' 2>/dev/null || true)"
    fi
    case "${_cur_preload}" in
      *pg_search*)
        log "pg0 pre-start: instance ${PG0_NAME} already running WITH pg_search preload; adopting"
        return 0
        ;;
    esac
    log "WARNING: pg0 pre-start: instance ${PG0_NAME} already running WITHOUT pg_search preload; stopping to restart with shared_preload_libraries=pg_search"
    if _stout="$("${_pg0}" stop --name "${PG0_NAME}" 2>&1)"; then
      if _out2="$("${_pg0}" "$@" 2>&1)"; then
        log "pg0 pre-start ok (restarted to apply pg_search preload): name=${PG0_NAME} shared_preload_libraries=pg_search"
        return 0
      fi
      log "WARNING: pg0 pre-start: restart-with-preload failed; hindsight_api's CREATE EXTENSION pg_search will surface it. detail: $(printf '%s' "${_out2}" | tr '\n' ' ' | cut -c1-300)"
      return 0
    fi
    log "WARNING: pg0 pre-start: could not stop the already-running instance to apply the pg_search preload; adopting the preload-less postmaster (CREATE EXTENSION pg_search will fail loudly). detail: $(printf '%s' "${_stout}" | tr '\n' ' ' | cut -c1-300)"
    return 0
  fi

  log "WARNING: pg0 pre-start failed; falling back to hindsight_api's own pg0 start with pg0 defaults. detail: $(printf '%s' "${_out}" | tr '\n' ' ' | cut -c1-300)"
  return 0
}

# ---------------------------------------------------------------------------
# Text-search provisioning (durable stopword config).
#
# switchroom runs hindsight recall through a CUSTOM Postgres text-search
# regconfig — HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE=hindsight_english,
# a COPY of `english` whose snowball dictionary (`hindsight_stem`) drops
# boilerplate lexemes (claude/code/agent/user/switchroom/…) via a stopword file
# (`hindsight_extra`). Both the index write and the recall query call
# to_tsvector/to_tsquery against that regconfig. It was first applied by hand on
# the live volume; nothing re-creates it. Two ways that bites a fresh boot:
#
#   L1  Fresh/empty volume + the env set = HARD BOOT FAILURE. The backfill
#       migration runs to_tsvector('hindsight_english'::regconfig, …); `::regconfig`
#       resolves at PLAN time, so a missing config is SQLSTATE 42704 and the
#       migration — hence the whole API — crash-loops. The config must exist
#       BEFORE hindsight_api runs migrations.
#   L2  An embedded-pg version bump extracts a NEW install dir WITHOUT the
#       stopword file, so `stopwords = 'hindsight_extra'` no longer resolves and
#       to_tsvector fails with "could not open stop-word file".
#
# Ordering: hindsight_api (start-all.sh, exec'd below) owns pg0 start + Alembic
# migrations, so we run BEFORE the exec — (1) drop the stopword file into the
# current install's tsearch_data (fixes L2), (2) synchronously ensure pg0 is up
# ourselves (ensure_running() adopts an already-running instance, the same
# mechanism prestart_pg0 relies on), and (3) run IDEMPOTENT DDL creating the
# dict + config (fixes L1). No race with hindsight_api: it does not start until
# we exec.
#
# BEST-EFFORT BY CONSTRUCTION. Every failure path returns 0. If provisioning
# cannot complete AND the operator set native_language=hindsight_english, the
# migration surfaces the exact 42704 — no worse than L1 today; and switchroom's
# default leaves native_language at the always-safe upstream `english`, so a
# stock fleet never depends on this path. The DDL is guarded against the catalog
# (Postgres has no CREATE ... IF NOT EXISTS for TS objects) and never
# DROP...CASCADEs, so it is a cheap no-op on every boot after the first.
#
# int/uint/number token mappings are LEFT on the default `simple` dictionary so
# numbers, semvers, ports, and error codes stay searchable — only word tokens
# are routed through the stopword-bearing stemmer.
_provision_ddl_once() {
  # Reads the (effectively global — sh has no locals) connection vars set by
  # provision_text_search; feeds the idempotent DDL on psql's stdin. The
  # heredoc delimiter is quoted so nothing inside is shell-expanded ($prov$,
  # the SQL string literals, etc. are all literal). Echoes psql's combined
  # stdout+stderr and returns its exit status.
  PGPASSWORD="${_pp}" "${_psql}" -U "${_pu}" -h /tmp -p "${_pport}" -d "${_pd}" -v ON_ERROR_STOP=1 2>&1 <<'PROVSQL'
DO $prov$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_dict d JOIN pg_namespace n ON n.oid = d.dictnamespace
    WHERE d.dictname = 'hindsight_stem' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'CREATE TEXT SEARCH DICTIONARY public.hindsight_stem (TEMPLATE = snowball, Language = english, StopWords = hindsight_extra)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
    WHERE c.cfgname = 'hindsight_english' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'CREATE TEXT SEARCH CONFIGURATION public.hindsight_english (COPY = pg_catalog.english)';
  END IF;
  EXECUTE 'ALTER TEXT SEARCH CONFIGURATION public.hindsight_english ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH public.hindsight_stem';
END
$prov$;
PROVSQL
}

provision_text_search() {
  # Disabled unless the stopword source is baked in (older image / removed file,
  # or a host unit test that has not staged one).
  [ -r "${TS_STOP_SRC}" ] || return 0

  # Only the embedded pg0 database is ours to provision — never reach into an
  # operator's external postgres.
  case "${HINDSIGHT_API_DB_URL:-pg0}" in
    pg0 | "pg0://${PG0_NAME}") : ;;
    *)
      log "text-search provisioning skipped: HINDSIGHT_API_DB_URL=${HINDSIGHT_API_DB_URL:-} is not the default embedded instance"
      return 0
      ;;
  esac

  # (1) Re-materialize the stopword file into the CURRENT install's tsearch_data
  # (fixes L2). Unquoted glob so `*` expands; guard each match. A miss here is a
  # warning, not fatal — an existing dict keeps working off the file already on
  # the volume; only a version bump strictly needs the refresh.
  _ts_placed=0
  for _sd in ${TS_STOP_DEST_GLOB}; do
    [ -d "${_sd}" ] || continue
    if cp -f "${TS_STOP_SRC}" "${_sd}/hindsight_extra.stop" 2>/dev/null; then
      _ts_placed=1
    fi
  done
  if [ "${_ts_placed}" != 1 ]; then
    log "WARNING: text-search provisioning: no tsearch_data dir matched ${TS_STOP_DEST_GLOB} (embedded pg not extracted yet?); stopword file not placed"
  fi

  # (2) Ensure pg0 is running so the DDL lands before migrations consume it.
  _pg0="${PG0_BIN}"
  if [ -z "${_pg0}" ]; then
    _pg0="$(command -v pg0 2>/dev/null || ls /app/api/.venv/lib/python3.*/site-packages/pg0/bin/pg0 2>/dev/null | head -1)"
  fi
  if [ -z "${_pg0}" ] || [ ! -x "${_pg0}" ]; then
    log "WARNING: text-search provisioning: pg0 binary not found; skipping DDL (migrations will fail if native_language=hindsight_english)"
    return 0
  fi

  # Reuse the descriptor's identity when present so we never rewrite creds; on a
  # first boot use hindsight_api's own defaults + pg0 auto-port (byte-identical
  # to what hindsight_api would do), exactly like prestart_pg0.
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

  # `set --` shadows only THIS function's positional params; the script's "$@"
  # (the upstream CMD) is restored on return. Every branch is an `if`, never a
  # bare AND-OR list, so `set -eu` cannot abort the entrypoint mid-provision.
  set -- start --name "${PG0_NAME}" --username "${_pu}" --password "${_pp}" --database "${_pd}"
  if [ -n "${_pport}" ]; then set -- "$@" --port "${_pport}"; fi
  if _sout="$("${_pg0}" "$@" 2>&1)"; then
    :
  elif printf '%s' "${_sout}" | grep -qi 'already running'; then
    :
  else
    log "WARNING: text-search provisioning: pg0 start failed; skipping DDL. detail: $(printf '%s' "${_sout}" | tr '\n' ' ' | cut -c1-200)"
    return 0
  fi

  # Re-read the descriptor now pg0 is up: on a first boot it was only written
  # just now (port + password were empty above).
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
  if [ -z "${_pport}" ]; then
    log "WARNING: text-search provisioning: no pg0 port after start; skipping DDL"
    return 0
  fi

  _psql="$(command -v psql 2>/dev/null || ls /home/hindsight/.pg0/installation/*/bin/psql 2>/dev/null | head -1)"
  if [ -z "${_psql}" ] || [ ! -x "${_psql}" ]; then
    log "WARNING: text-search provisioning: psql not found; skipping DDL"
    return 0
  fi

  # (3) Idempotent DDL, bounded readiness retries. `if var=$(...)` keeps this
  # set -e-safe and does not swallow psql's stderr (captured for the warning).
  _try=0
  while [ "${_try}" -lt "${TS_PROVISION_TRIES}" ]; do
    _try=$((_try + 1))
    if _dout="$(_provision_ddl_once)"; then
      log "text-search provisioning ok: hindsight_stem dictionary + hindsight_english configuration ensured (idempotent)"
      return 0
    fi
    sleep 1
  done
  log "WARNING: text-search provisioning: DDL did not succeed after ${TS_PROVISION_TRIES} tries; if native_language=hindsight_english the backfill migration will surface the exact error. detail: $(printf '%s' "${_dout:-}" | tr '\n' ' ' | cut -c1-200)"
  return 0
}

# ---------------------------------------------------------------------------
# ParadeDB pg_search provisioning (durable BM25 backend).
#
# pg_search is a Postgres extension whose LIBRARY (pg_search.so, ~180MB) is
# loaded into the postmaster via shared_preload_libraries and whose control+SQL
# live in the embedded-pg install's share/extension. Both are baked into the
# image at a STABLE path (docker/Dockerfile.hindsight) but must be re-copied
# into pg0's version-scoped install dir on every boot, because that dir lives on
# a mounted volume the image content cannot reach — the same durability problem
# provision_text_search() solves for the stopword file, and the same fix.
#
# THE ORDERING PROBLEM this function exists to solve. shared_preload_libraries
# is PGC_POSTMASTER: it only takes effect at server start, and a server told to
# preload a library that is not present FAILS to start. On a FRESH volume the
# install dir does not exist until pg0 first extracts it, so we cannot copy the
# .so before pg0 has run at least once — but we must not hand the very first
# start a preload it cannot satisfy. So:
#   (1) start pg0 PLAIN (no preload) — this extracts the install dir and can
#       never fail on the not-yet-copied library;
#   (2) copy the .so + control + SQL into every MAJOR-matched install dir;
#   (3) STOP pg0, so the NEXT start — prestart_pg0(), which runs immediately
#       after us — is the authoritative one that sets
#       shared_preload_libraries=pg_search against a now-present library.
# On a reboot the install dir already exists, so step (1) is skipped and this is
# just an idempotent re-copy + a stop of a server that was not running.
#
# BEST-EFFORT BY CONSTRUCTION. Every failure path returns 0. Gated entirely on
# pg_search_baked_major() — a stock native fleet (selector != pg_search, or an
# older image with no bake) never enters here and is byte-identical to before.
#
# ── EXISTING-INSTALL MIGRATION BOUNDARY (read before assuming this migrates) ──
# This function makes a NEW (empty) database come up on pg_search. It does NOT,
# and MUST NOT, migrate a POPULATED database from the native tsvector backend:
# hindsight_api HARD-REFUSES a text-search backend switch on non-empty memory
# tables (the BM25 index must be rebuilt under a different operator class, which
# upstream will not silently do under live data). The data migration is a
# DELIBERATE operator-run step (pg_dump backup → drop the native search index →
# flip HINDSIGHT_API_TEXT_SEARCH_EXTENSION → restart so this provisioning +
# prestart_pg0 preload run → let hindsight_api rebuild the BM25 index). An
# operator not ready to migrate pins `native` in hindsight.env; that pin
# survives `switchroom apply` (the key is on HINDSIGHT_PERF_ENV_KEYS) and this
# function no-ops. Nothing here touches operator data.
provision_pg_search() {
  _psm="$(pg_search_baked_major)"
  [ -n "${_psm}" ] || return 0

  # Only the embedded pg0 database is ours to provision — never an operator's
  # external postgres.
  case "${HINDSIGHT_API_DB_URL:-pg0}" in
    pg0 | "pg0://${PG0_NAME}") : ;;
    *)
      log "pg_search provisioning skipped: HINDSIGHT_API_DB_URL=${HINDSIGHT_API_DB_URL:-} is not the default embedded instance"
      return 0
      ;;
  esac

  _src_lib="${PG_SEARCH_SRC_ROOT}/${_psm}/lib/pg_search.so"
  _src_ext="${PG_SEARCH_SRC_ROOT}/${_psm}/extension"
  if [ ! -r "${_src_lib}" ] || [ ! -d "${_src_ext}" ]; then
    log "WARNING: pg_search provisioning: baked artifacts missing (${_src_lib}); skipping"
    return 0
  fi

  _pg0="${PG0_BIN}"
  if [ -z "${_pg0}" ]; then
    _pg0="$(command -v pg0 2>/dev/null || ls /app/api/.venv/lib/python3.*/site-packages/pg0/bin/pg0 2>/dev/null | head -1)"
  fi
  if [ -z "${_pg0}" ] || [ ! -x "${_pg0}" ]; then
    log "WARNING: pg_search provisioning: pg0 binary not found; skipping (CREATE EXTENSION pg_search will fail if the .so is absent)"
    return 0
  fi

  # (1) On a FRESH volume the install dir does not exist until pg0 extracts it.
  # Start pg0 PLAIN so the extraction can never fail on the not-yet-copied
  # library. Reuse the descriptor's identity when present (never rewrite creds);
  # on first boot use hindsight_api's own defaults + pg0 auto-port, exactly like
  # prestart_pg0 / provision_text_search.
  _have_install=0
  for _id in ${PG_SEARCH_INSTALL_GLOB}; do
    [ -d "${_id}/lib" ] || continue
    _have_install=1
    break
  done
  if [ "${_have_install}" != 1 ]; then
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
    set -- start --name "${PG0_NAME}" --username "${_pu}" --password "${_pp}" --database "${_pd}"
    if [ -n "${_pport}" ]; then set -- "$@" --port "${_pport}"; fi
    if _sout="$("${_pg0}" "$@" 2>&1)"; then
      :
    elif printf '%s' "${_sout}" | grep -qi 'already running'; then
      :
    else
      log "WARNING: pg_search provisioning: initial pg0 start failed; skipping copy (CREATE EXTENSION pg_search will fail). detail: $(printf '%s' "${_sout}" | tr '\n' ' ' | cut -c1-200)"
      return 0
    fi
  fi

  # (2) Re-materialize the extension into every MAJOR-matched install dir. A
  # version bump that lands a NEW major ahead of the baked deb is skipped with a
  # loud warning rather than copying an ABI-mismatched .so (which would crash the
  # postmaster on preload) — bump PG_SEARCH_* in the Dockerfile to match.
  _placed=0
  for _id in ${PG_SEARCH_INSTALL_GLOB}; do
    [ -d "${_id}/lib" ] || continue
    _ver="${_id##*/}"
    case "${_ver}" in
      "${_psm}" | "${_psm}".*) : ;;
      *)
        log "WARNING: pg_search provisioning: install ${_ver} major != baked ${_psm}; NOT copying (ABI mismatch — bump the baked pg_search deb)"
        continue
        ;;
    esac
    [ -d "${_id}/share/extension" ] || mkdir -p "${_id}/share/extension" 2>/dev/null || true
    if cp -f "${_src_lib}" "${_id}/lib/pg_search.so" 2>/dev/null &&
      cp -f "${_src_ext}/"pg_search*.control "${_id}/share/extension/" 2>/dev/null &&
      cp -f "${_src_ext}/"pg_search*.sql "${_id}/share/extension/" 2>/dev/null; then
      _placed=1
    else
      log "WARNING: pg_search provisioning: copy into ${_id} failed"
    fi
  done
  if [ "${_placed}" != 1 ]; then
    log "WARNING: pg_search provisioning: no major-matched install dir under ${PG_SEARCH_INSTALL_GLOB}; extension NOT staged (CREATE EXTENSION pg_search will fail)"
  else
    log "pg_search provisioning ok: staged pg_search.so + control + sql (major ${_psm}) into embedded-pg install"
  fi

  # (3) Stop pg0 so prestart_pg0 can (re)start it with
  # shared_preload_libraries=pg_search — a PGC_POSTMASTER GUC that only applies
  # at server start. `pg0 stop` blocks until the postmaster has fully exited, so
  # on success the instance is confirmed DOWN and prestart_pg0's start cannot
  # race it. But this stop MUST actually take effect: if an up-but-preload-less
  # postmaster survives here and prestart_pg0 then sees "already running", the
  # preload never gets applied and CREATE EXTENSION pg_search crash-loops. So on
  # a non-"already-down" stop failure we do NOT silently proceed — we re-verify
  # with a bounded, idempotent second stop (a down server reports "not running")
  # and loud-warn if the instance is still up, leaving prestart_pg0's own
  # SHOW-verify branch as the backstop rather than a silent adopt.
  if _stout="$("${_pg0}" stop --name "${PG0_NAME}" 2>&1)"; then
    :
  else
    case "${_stout}" in
      *"not running"* | *"no server"* | *"not found"* | *"No such"*) : ;;
      *)
        log "pg_search provisioning: pg0 stop returned: $(printf '%s' "${_stout}" | tr '\n' ' ' | cut -c1-200)"
        # Confirm the postmaster is actually down before returning. Re-issue stop
        # up to a few times; a down instance reports the not-running family.
        _down=0
        _try=0
        while [ "${_try}" -lt 5 ]; do
          _try=$((_try + 1))
          if _vout="$("${_pg0}" stop --name "${PG0_NAME}" 2>&1)"; then
            _down=1
            break
          fi
          case "${_vout}" in
            *"not running"* | *"no server"* | *"not found"* | *"No such"*) _down=1; break ;;
          esac
          sleep 1
        done
        if [ "${_down}" != 1 ]; then
          log "WARNING: pg_search provisioning: pg0 instance ${PG0_NAME} still running after stop; prestart_pg0 will SHOW-verify the preload and restart or fail loudly rather than adopt it"
        fi
        ;;
    esac
  fi
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

# 4b2. pg_search staging (durable BM25 backend). MUST run before prestart_pg0:
# it stages the extension .so into pg0's install dir and leaves pg0 STOPPED so
# prestart_pg0's start is the one that sets shared_preload_libraries=pg_search
# (a PGC_POSTMASTER GUC). No-op unless pg_search is the selected backend AND the
# artifacts are baked in. Synchronous + best-effort — see provision_pg_search().
provision_pg_search || true

# 4c. pg0 sizing pre-start (#3706). MUST run before the exec: hindsight_api's
# ensure_running() adopts an already-running instance without re-applying
# config, which is the only reason we can set these at all. Synchronous by
# necessity (a background race would let hindsight_api win and start pg0
# untuned); bounded by pg0's own start, and best-effort — see prestart_pg0().
# When pg_search is the selected backend this is also the start that applies
# shared_preload_libraries=pg_search against the library provision_pg_search
# just staged (which is why that ran first and left pg0 stopped).
prestart_pg0 || true

# 4d. Text-search provisioning (durable stopword config). MUST run before the
# exec: hindsight_api's Alembic migrations consume the hindsight_english
# regconfig, so it has to exist first. Runs after prestart_pg0 so a tuned pg0 is
# already up (adopted via "already running"); if prestart_pg0 opted out, this
# starts pg0 with pg0's own defaults — byte-identical to what hindsight_api
# would do. Synchronous + best-effort; no-op unless the stopword source is baked
# in. See provision_text_search()'s header.
provision_text_search || true

# 5. Hand off to upstream start-all.sh.
exec "$@"
