#!/bin/sh
# switchroom/hindsight periodic maintenance — runs as a sibling of the
# entrypoint's background loop (so it executes alongside a live pg,
# unlike the entrypoint body which runs before start-all.sh boots pg).
#
# Three best-effort jobs, all idempotent and safe to run on every tick:
#
#   1. Backup     — rotated `pg_dump -Fc` of the embedded pg to a volume
#                   SEPARATE from the data volume, so a data-volume loss
#                   or corruption is recoverable. Runs at most once per
#                   BACKUP_INTERVAL_MIN. Keeps the newest BACKUP_KEEP.
#   2. Autovacuum — pins per-table autovacuum scale factors on the large
#                   / high-churn tables. Upstream ships pg defaults (0.2),
#                   which on a multi-million-row table means autovacuum
#                   never fires until >1M dead tuples — so memory_links /
#                   async_operations bloat unbounded and their planner
#                   stats go stale (mis-estimating the worker's queue
#                   table by ~80x). Idempotent `ALTER TABLE ... SET`.
#   3. Retention  — prune COMPLETED async_operations older than
#                   RETENTION_DAYS. Terminal queue records the worker
#                   never reads again; left unbounded they accumulate
#                   (tens of thousands carrying transcript JSON).
#                   failed/pending/processing rows are NEVER touched.
#
# Everything is best-effort: any failure (pg not up yet, missing creds,
# psql absent) is logged and swallowed so a bad tick can never wedge the
# loop or the container. No-ops cleanly on a host without the embedded
# pg (e.g. unit tests).
#
# Env knobs (all defaulted):
#   SWITCHROOM_HINDSIGHT_MAINTENANCE          master switch (1=on, 0=off). default 1
#   SWITCHROOM_HINDSIGHT_PG0_INSTANCE         pg0 descriptor (holds the pw)
#   SWITCHROOM_HINDSIGHT_BACKUP_DIR           backup dir. default /backups
#   SWITCHROOM_HINDSIGHT_BACKUP_INTERVAL_MIN  min minutes between backups. default 1440
#   SWITCHROOM_HINDSIGHT_BACKUP_KEEP          rotated backups to retain. default 7
#   SWITCHROOM_HINDSIGHT_RETENTION_DAYS       completed-op prune age. default 30
#   SWITCHROOM_HINDSIGHT_QUEUE_LAG_WARN_S     warn if oldest pending/processing
#                                             op older than this. default 7200 (2h). 0=off
#   SWITCHROOM_HINDSIGHT_INDEX_HEALTH_CHECK   bt_index_check pk_async_operations
#                                             + stuck-op alarm. default 1 (on). 0=off
#   SWITCHROOM_HINDSIGHT_STUCK_OP_WARN_S      alarm if any 'processing' op is
#                                             claimed older than this (the reaper
#                                             should have reset it). default 3600 (1h)
set -u

MAINT_ENABLED="${SWITCHROOM_HINDSIGHT_MAINTENANCE:-1}"
PG0_INSTANCE="${SWITCHROOM_HINDSIGHT_PG0_INSTANCE:-/home/hindsight/.pg0/instances/hindsight/instance.json}"
BACKUP_DIR="${SWITCHROOM_HINDSIGHT_BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_MIN="${SWITCHROOM_HINDSIGHT_BACKUP_INTERVAL_MIN:-1440}"
BACKUP_KEEP="${SWITCHROOM_HINDSIGHT_BACKUP_KEEP:-7}"
RETENTION_DAYS="${SWITCHROOM_HINDSIGHT_RETENTION_DAYS:-30}"
# Queue-liveness warn threshold: if the oldest pending/processing async
# op is older than this, the consolidation/retain pipeline is likely
# wedged (the 26-day strand of 2026-05-23 went unseen because nothing
# watched this). Default 2h — well above ~510s/op + the 30-min lease
# reaper. 0 disables. Logs a loud WARNING (picked up by docker logs /
# any log monitoring). The reaper auto-heals stuck *processing* ops ONLY
# when the pk_async_operations index is healthy — a corrupt index made its
# reset UPDATE silently no-op for 3 days (2026-07-22). Job #5 below alarms on
# that index-corruption / persistent-stuck-op condition directly.
QUEUE_LAG_WARN_S="${SWITCHROOM_HINDSIGHT_QUEUE_LAG_WARN_S:-7200}"
# Index-health + stuck-op alarm (incident 2026-07-22). The reaper's reset
# UPDATE silently no-oped for 3 days when pk_async_operations was corrupt,
# deadlocking consolidation per-bank with NO alarm. This probe surfaces BOTH
# a corrupt index (bt_index_check) and a persistent stuck-op count LOUDLY so
# neither can hide again. 1=on (default), 0=off.
INDEX_HEALTH_CHECK="${SWITCHROOM_HINDSIGHT_INDEX_HEALTH_CHECK:-1}"
# A healthy reaper keeps 'processing' ops younger than its 30-min window; a
# 'processing' op still claimed past this threshold means the heal isn't
# landing (corrupt index / disabled reaper) and the deadlock is ACTIVE.
STUCK_OP_WARN_S="${SWITCHROOM_HINDSIGHT_STUCK_OP_WARN_S:-3600}"

log() { echo "switchroom-hindsight-maintenance: $*" >&2; }

[ "${MAINT_ENABLED}" = "1" ] || exit 0
[ -r "${PG0_INSTANCE}" ] || exit 0

# Resolve pg client binaries from the pg0 install (glob the version dir)
# or PATH. Absent → nothing to do (host/test).
_bindir="$(ls -d /home/hindsight/.pg0/installation/*/bin 2>/dev/null | head -1)"
PSQL="$(command -v psql 2>/dev/null || echo "${_bindir:-/nonexistent}/psql")"
PG_DUMP="$(command -v pg_dump 2>/dev/null || echo "${_bindir:-/nonexistent}/pg_dump")"
[ -x "${PSQL}" ] || exit 0

# Pull connection fields from the descriptor without a JSON dep in sh.
if ! { read -r PGUSER_; read -r PGDB_; read -r PGPORT_; read -r PGPW_; } <<EOF
$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("username","hindsight"));print(d.get("database","hindsight"));print(d.get("port",5432));print(d.get("password",""))' "${PG0_INSTANCE}" 2>/dev/null)
EOF
then
  exit 0
fi
[ -n "${PGPW_}" ] || exit 0

# Readiness probe — skip this tick if pg isn't accepting connections yet
# (the entrypoint execs start-all.sh which boots pg AFTER this loop began).
PGPASSWORD="${PGPW_}" "${PSQL}" -U "${PGUSER_}" -h /tmp -p "${PGPORT_}" -d "${PGDB_}" \
  -tAc "SELECT 1" >/dev/null 2>&1 || exit 0

_sql() {
  PGPASSWORD="${PGPW_}" "${PSQL}" -U "${PGUSER_}" -h /tmp -p "${PGPORT_}" -d "${PGDB_}" \
    -v ON_ERROR_STOP=0 -tAc "$1" 2>/dev/null
}

# --- 2. Autovacuum tuning (idempotent; ALTER is a no-op if unchanged) ---
_sql "ALTER TABLE IF EXISTS memory_links SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.02)" >/dev/null
_sql "ALTER TABLE IF EXISTS async_operations SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.02)" >/dev/null
_sql "ALTER TABLE IF EXISTS entity_cooccurrences SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.05)" >/dev/null
_sql "ALTER TABLE IF EXISTS unit_entities SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.05)" >/dev/null

# --- 3. Retention: prune terminal completed ops (never failed/pending/processing) ---
_pruned="$(_sql "WITH d AS (DELETE FROM async_operations WHERE status='completed' AND created_at < now() - make_interval(days => ${RETENTION_DAYS}) RETURNING 1) SELECT count(*) FROM d")"
if [ "${_pruned:-0}" -gt 0 ] 2>/dev/null; then
  log "pruned ${_pruned} completed async_operations older than ${RETENTION_DAYS}d"
fi

# --- 4. Queue-liveness probe: warn (loudly, in the logs) if the
# consolidation/retain pipeline looks wedged. Catches the strand class
# that previously hid for 26 days. Reports the oldest pending/processing
# op's age; if it exceeds the threshold, something isn't draining. ---
if [ "${QUEUE_LAG_WARN_S}" -gt 0 ] 2>/dev/null; then
  # "count|oldest_age_seconds" for non-terminal ops (0 rows → "0|0").
  _q="$(_sql "SELECT count(*)||'|'||coalesce(max(extract(epoch from (now()-created_at)))::bigint,0) FROM async_operations WHERE status IN ('pending','processing')")"
  _qn="${_q%%|*}"
  _qage="${_q##*|}"
  if [ "${_qage:-0}" -gt "${QUEUE_LAG_WARN_S}" ] 2>/dev/null; then
    log "WARNING: queue may be wedged — ${_qn} pending/processing async op(s), oldest $((_qage/60))m old (> $((QUEUE_LAG_WARN_S/60))m). Consolidation/retain pipeline not draining; inspect async_operations + 'docker logs switchroom-hindsight'."
  fi
fi

# --- 5. Index-health + stuck-op alarm (incident 2026-07-22) ---
# The reaper's reset UPDATE silently no-oped for 3 days when
# pk_async_operations was corrupt, deadlocking consolidation per-bank with no
# alarm. This probe surfaces BOTH conditions LOUDLY (structured ERROR the
# fleet log monitor / `switchroom doctor` can grep) so neither can hide again.
# Read-only: bt_index_check takes only an AccessShareLock (non-blocking); the
# stuck-op metric is a SELECT. The reaper does the heal; this is the alarm.
if [ "${INDEX_HEALTH_CHECK}" = "1" ]; then
  # amcheck ships with pg but its extension may not be created yet; best-effort.
  _sql "CREATE EXTENSION IF NOT EXISTS amcheck" >/dev/null 2>&1
  # bt_index_check(..., true) = heapallindexed: detects a phantom index tuple
  # pointing at the wrong heap ctid (the exact 2026-07-22 corruption). It
  # RAISEs on corruption; ON_ERROR_STOP=1 => nonzero exit + the error text.
  _ic="$(PGPASSWORD="${PGPW_}" "${PSQL}" -U "${PGUSER_}" -h /tmp -p "${PGPORT_}" -d "${PGDB_}" \
    -v ON_ERROR_STOP=1 -tAc "SELECT bt_index_check('pk_async_operations'::regclass, true)" 2>&1)"
  if [ $? -ne 0 ]; then
    # A genuine corruption reports btree/heap/index-tuple/duplicate text; an
    # amcheck-absent / index-missing environment reads as a skip, not an alarm.
    if printf '%s' "${_ic}" | grep -qiE 'corrupt|not.*ordered|heap tuple|index tuple|duplicate|not equal'; then
      log "ERROR: index health check FAILED for pk_async_operations — btree corruption; consolidation queue can deadlock. Heal: REINDEX INDEX CONCURRENTLY pk_async_operations (the reaper self-heals on its next reset). detail: $(printf '%s' "${_ic}" | tr '\n' ' ' | cut -c1-300)"
    fi
  fi
  # Stuck-op count: 'processing' ops still claimed past the alarm window. A
  # working reaper keeps this at 0; a persistent nonzero means the heal isn't
  # landing (corrupt index / disabled reaper) — the deadlock is ACTIVE.
  _stuck="$(_sql "SELECT count(*) FROM async_operations WHERE status='processing' AND claimed_at < now() - make_interval(secs => ${STUCK_OP_WARN_S})")"
  if [ "${_stuck:-0}" -gt 0 ] 2>/dev/null; then
    log "ERROR: ${_stuck} async op(s) stuck in 'processing' older than $((STUCK_OP_WARN_S/60))m — the stale-claim reaper is not clearing them (corrupt pk_async_operations index or reaper disabled); per-bank consolidation is deadlocked. Inspect async_operations + 'docker logs switchroom-hindsight'."
  fi
fi

# --- 1. Backup: rotated pg_dump, at most once per interval ---
[ -x "${PG_DUMP}" ] || exit 0
mkdir -p "${BACKUP_DIR}" 2>/dev/null || exit 0
# Skip if a backup already landed within the interval window.
if [ -z "$(find "${BACKUP_DIR}" -maxdepth 1 -name 'hindsight-*.dump' -mmin "-${BACKUP_INTERVAL_MIN}" 2>/dev/null | head -1)" ]; then
  _ts="$(date -u +%Y%m%d-%H%M%S)"
  _tmp="${BACKUP_DIR}/.hindsight-${_ts}.dump.partial"
  _final="${BACKUP_DIR}/hindsight-${_ts}.dump"
  if PGPASSWORD="${PGPW_}" "${PG_DUMP}" -U "${PGUSER_}" -h /tmp -p "${PGPORT_}" -d "${PGDB_}" \
       -Fc --no-owner --no-privileges -f "${_tmp}" 2>/dev/null; then
    mv -f "${_tmp}" "${_final}" 2>/dev/null \
      && log "backup written: ${_final} ($(du -h "${_final}" 2>/dev/null | cut -f1))"
    # Rotate — keep the newest BACKUP_KEEP, drop the rest.
    _stale="$(ls -1t "${BACKUP_DIR}"/hindsight-*.dump 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))")"
    if [ -n "${_stale}" ]; then
      echo "${_stale}" | while IFS= read -r f; do rm -f "$f" 2>/dev/null; done
    fi
  else
    rm -f "${_tmp}" 2>/dev/null
    log "backup pg_dump failed (will retry next tick)"
  fi
fi

exit 0
