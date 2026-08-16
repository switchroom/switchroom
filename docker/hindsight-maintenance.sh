#!/bin/sh
# switchroom/hindsight periodic maintenance — runs as a sibling of the
# entrypoint's background loop (so it executes alongside a live pg,
# unlike the entrypoint body which runs before start-all.sh boots pg).
#
# Best-effort jobs, all idempotent and safe to run on every tick (the
# numbering below is the order they were added, not the order they run):
#
#   1. Backup     — rotated `pg_dump -Fc` of the embedded pg to a volume
#                   SEPARATE from the data volume, so a data-volume loss
#                   or corruption is recoverable. Runs at most once per
#                   BACKUP_INTERVAL_MIN. Keeps the newest BACKUP_KEEP.
#   2. Autovacuum — pins per-table autovacuum scale factors / thresholds on
#                   the large / high-churn tables. Upstream ships pg defaults
#                   (0.2), which on a multi-million-row table means autovacuum
#                   never fires until >1M dead tuples — so memory_links /
#                   async_operations bloat unbounded and their planner
#                   stats go stale (mis-estimating the worker's queue
#                   table by ~80x). On unit_entities / entities the same
#                   under-vacuuming leaves the VISIBILITY MAP stale, which
#                   silently un-does index-only scans (#4634). Idempotent
#                   `ALTER TABLE ... SET`.
#   3. Retention  — prune COMPLETED async_operations older than
#                   RETENTION_DAYS. Terminal queue records the worker
#                   never reads again; left unbounded they accumulate
#                   (tens of thousands carrying transcript JSON).
#                   failed/pending/processing rows are NEVER touched.
#
#   8a. Vacuum    — periodic `VACUUM (ANALYZE)` of the whole database, at
#                   most once per VACUUM_INTERVAL_MIN. Belt to autovacuum's
#                   braces: on this deployment pg's CUMULATIVE STATS DO NOT
#                   SURVIVE A CONTAINER RECREATE — minutes after a roll,
#                   pg_stat_database.stats_reset is NULL and last_autovacuum
#                   is empty for every table. Autovacuum fires off n_dead_tup
#                   in exactly those stats, so every image roll resets its
#                   counters toward zero and autovacuum can go unfired for
#                   long stretches; job #2's scale-factor tuning lowers the
#                   threshold but cannot fix a counter that keeps restarting
#                   at 0. The payoff measured on the live host is the
#                   VISIBILITY MAP, not disk space: before a manual vacuum,
#                   entity_cooccurrences was 35.1% all-visible,
#                   observation_history 25.2%, memory_links 86.3%; after a
#                   25-SECOND `vacuumdb -j 8 --analyze` of the whole 19 GB
#                   database, 99.0% / 100% / 99.2%. A low all-visible
#                   fraction forces heap fetches instead of index-only
#                   scans — one observed graph-maintenance query was doing
#                   1.15 MILLION heap fetches. NEVER `VACUUM FULL`: it takes
#                   an ACCESS EXCLUSIVE lock and would freeze fleet memory
#                   for the duration.
#   8b. Reindex   — conditional `REINDEX INDEX CONCURRENTLY`, at most once
#                   per REINDEX_INTERVAL_MIN, and MEASURED not guessed:
#                   pgstatindex().avg_leaf_density below
#                   REINDEX_MIN_DENSITY (a freshly built btree is ~90).
#                   Measured on the live host: idx_memory_links_unique 73.5%
#                   density / 29.1% leaf fragmentation,
#                   idx_memory_links_to_type_weight 68.7% / 35.3%,
#                   idx_memory_links_from_type_weight 69.6% / 34.3%,
#                   pk_entity_cooccurrences 67.4% / 44.6%. Candidates come
#                   from the CATALOG (pg_am.amname='btree', public schema,
#                   larger than REINDEX_MIN_MB), never a hardcoded list —
#                   this DB also carries hnsw (pgvector) and bm25
#                   (pg_search) indexes, where pgstatindex ERRORS outright
#                   and a rebuild is enormously expensive and not a bloat
#                   fix. CONCURRENTLY always (a bare REINDEX takes an
#                   exclusive lock). Guarded by free disk (CONCURRENTLY
#                   builds a full second copy), capped per tick, and never
#                   run in the same tick as 8a — both take a
#                   ShareUpdateExclusiveLock on the table and would
#                   serialize. Note the entrypoint calls this script
#                   SYNCHRONOUSLY inside its refresh loop, so a long 8a/8b
#                   pushes that tick's next credential refresh out by its
#                   own duration — bounded by REINDEX_MAX_PER_RUN, and
#                   harmless because the fetcher refreshes far ahead of
#                   token expiry.
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
#   SWITCHROOM_HINDSIGHT_DEAD_LETTER_WARN_S    warn if a failed 'retain' op with an
#                                             intact payload (recoverable, stalled
#                                             memory) is older than this. default
#                                             21600 (6h). 0=off  (#3795)
#   SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS  opt-in: POST FK-race dead letters to
#                                             the engine retry endpoint (costs LLM
#                                             spend). 1=on, default 0=off  (#3795)
#   SWITCHROOM_HINDSIGHT_REQUEUE_MAX           max dead letters requeued per tick.
#                                             default 100  (#3795)
#   SWITCHROOM_HINDSIGHT_API_URL / _API_TOKEN  override the loopback engine API base
#                                             URL / bearer token for the requeue POST
#                                             (else http://127.0.0.1:${HINDSIGHT_API_PORT:-9077})
#   SWITCHROOM_HINDSIGHT_VACUUM               job 8a master switch. 1=on (default), 0=off
#   SWITCHROOM_HINDSIGHT_VACUUM_INTERVAL_MIN  min minutes between vacuums. default 360 (6h)
#   SWITCHROOM_HINDSIGHT_VACUUM_JOBS          vacuumdb -j parallelism. default 4 (the host
#                                             is not assumed to be big)
#   SWITCHROOM_HINDSIGHT_REINDEX              job 8b master switch. 1=on (default), 0=off
#   SWITCHROOM_HINDSIGHT_REINDEX_INTERVAL_MIN min minutes between reindex sweeps.
#                                             default 10080 (weekly)
#   SWITCHROOM_HINDSIGHT_REINDEX_MIN_DENSITY  rebuild only below this avg_leaf_density
#                                             percent. default 70 (fresh btree is ~90)
#   SWITCHROOM_HINDSIGHT_REINDEX_MIN_MB       ignore indexes smaller than this. default 256
#   SWITCHROOM_HINDSIGHT_REINDEX_MAX_PER_RUN  max indexes rebuilt per sweep, lowest density
#                                             first. default 3 (the skipped count is LOGGED)
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
# Dead-letter visibility + recovery (#3795). A ForeignKeyViolation race on
# unit_entities (#3794) was misclassified by the engine as a DETERMINISTIC
# failure, so the affected `retain` ops were dead-lettered with retry_count=0
# / next_retry_at NULL — the worker's claim loop only revisits status='pending',
# so nothing ever picks them up, yet their `task_payload` is intact. The memory
# is STALLED, not lost. `DEAD_LETTER_WARN_S` surfaces the stalled backlog loudly
# (nothing surfaced 770 such ops for 8 days); `REQUEUE_*` is an OFF-by-default,
# operator-signed recovery that re-runs fact extraction (LLM spend) via the
# engine's own retry endpoint. The classifier fix itself is an engine change
# (out of scope here) tracked in #3794/#3795.
DEAD_LETTER_WARN_S="${SWITCHROOM_HINDSIGHT_DEAD_LETTER_WARN_S:-21600}"
REQUEUE_DEAD_LETTERS="${SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS:-0}"
REQUEUE_MAX="${SWITCHROOM_HINDSIGHT_REQUEUE_MAX:-100}"
# Job 8a/8b — periodic vacuum + conditional reindex (see the header block).
VACUUM_ENABLED="${SWITCHROOM_HINDSIGHT_VACUUM:-1}"
VACUUM_INTERVAL_MIN="${SWITCHROOM_HINDSIGHT_VACUUM_INTERVAL_MIN:-360}"
VACUUM_JOBS="${SWITCHROOM_HINDSIGHT_VACUUM_JOBS:-4}"
REINDEX_ENABLED="${SWITCHROOM_HINDSIGHT_REINDEX:-1}"
REINDEX_INTERVAL_MIN="${SWITCHROOM_HINDSIGHT_REINDEX_INTERVAL_MIN:-10080}"
REINDEX_MIN_DENSITY="${SWITCHROOM_HINDSIGHT_REINDEX_MIN_DENSITY:-70}"
REINDEX_MIN_MB="${SWITCHROOM_HINDSIGHT_REINDEX_MIN_MB:-256}"
REINDEX_MAX_PER_RUN="${SWITCHROOM_HINDSIGHT_REINDEX_MAX_PER_RUN:-3}"

log() { echo "switchroom-hindsight-maintenance: $*" >&2; }

[ "${MAINT_ENABLED}" = "1" ] || exit 0
[ -r "${PG0_INSTANCE}" ] || exit 0

# Resolve pg client binaries from the pg0 install (glob the version dir)
# or PATH. Absent → nothing to do (host/test).
_bindir="$(ls -d /home/hindsight/.pg0/installation/*/bin 2>/dev/null | head -1)"
PSQL="$(command -v psql 2>/dev/null || echo "${_bindir:-/nonexistent}/psql")"
PG_DUMP="$(command -v pg_dump 2>/dev/null || echo "${_bindir:-/nonexistent}/pg_dump")"
# vacuumdb gives job 8a table-level parallelism; absent, 8a falls back to
# per-table `VACUUM (ANALYZE)` over the same connection psql already uses.
VACUUMDB="$(command -v vacuumdb 2>/dev/null || echo "${_bindir:-/nonexistent}/vacuumdb")"
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

# Same connection, but ON_ERROR_STOP=1 so the CALLER can branch on failure.
# `_sql` deliberately swallows errors (exit 0) — a DDL statement whose outcome
# we report on (job 8b's REINDEX / DROP INDEX) must not silently "succeed".
_sql_x() {
  PGPASSWORD="${PGPW_}" "${PSQL}" -U "${PGUSER_}" -h /tmp -p "${PGPORT_}" -d "${PGDB_}" \
    -v ON_ERROR_STOP=1 -tAc "$1" >/dev/null 2>&1
}

# --- 2. Autovacuum tuning (idempotent; ALTER is a no-op if unchanged) ---
#
# `ALTER TABLE ... SET (...)` MERGES into reloptions — options not named on a
# line are left standing — so each line states only what it means to pin.
#
# COROLLARY: DELETING A LINE HERE DOES NOT UNDO IT. reloptions live in the
# catalog, on the data volume; nothing in this script ever RESETs them. So a
# `git revert` of the change that added a line leaves every option it set
# standing on the live database forever, invisibly — which is precisely the
# hand-applied drift #4650 exists to document. Backing a tuning out means
# running the matching RESET by hand, once, against the live DB. For the
# unit_entities / entities block below (#4634) that is:
#
#   -- unit_entities: reverting restores the old line, which re-pins
#   -- autovacuum_vacuum_scale_factor / autovacuum_analyze_scale_factor to
#   -- 0.05 on the next tick, but leaves these six standing:
#   ALTER TABLE unit_entities RESET (
#     autovacuum_vacuum_threshold,
#     autovacuum_vacuum_insert_scale_factor,
#     autovacuum_vacuum_insert_threshold,
#     autovacuum_analyze_threshold,
#     autovacuum_vacuum_cost_delay,
#     autovacuum_vacuum_cost_limit);
#
#   -- entities: main has NO line for this table, so a revert restores
#   -- nothing at all here and all eight must be reset explicitly.
#   ALTER TABLE entities RESET (
#     autovacuum_vacuum_scale_factor,
#     autovacuum_vacuum_threshold,
#     autovacuum_vacuum_insert_scale_factor,
#     autovacuum_vacuum_insert_threshold,
#     autovacuum_analyze_scale_factor,
#     autovacuum_analyze_threshold,
#     autovacuum_vacuum_cost_delay,
#     autovacuum_vacuum_cost_limit);
#
# (RESET drops the per-table override so the global GUC applies again. It does
# NOT restore any hand-applied value that predated the line — on `entities`
# that was scale_factor=0.02 / cost_limit=2000, per #4650.)
_sql "ALTER TABLE IF EXISTS memory_links SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.02)" >/dev/null
_sql "ALTER TABLE IF EXISTS async_operations SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.02)" >/dev/null
_sql "ALTER TABLE IF EXISTS entity_cooccurrences SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.05)" >/dev/null
#
# unit_entities / entities: VISIBILITY-MAP freshness, not bloat (#4634).
#
# Only VACUUM sets all-visible bits, so how often a table is vacuumed IS how
# fresh its visibility map is, and a stale VM turns an index-only scan into an
# index scan plus a heap access per row. Measured read-only on the live fleet
# DB, 2026-08-12 UTC (all timestamps in this block are UTC), over 22h of uptime
# since the last crash-recovery stats reset:
#
#   relation       relpages  relallvisible    VM%       rows
#   unit_entities    13,454          8,445  62.8%  1,739,740
#   entities          3,210          1,009  31.4%    239,939
#
#   EXPLAIN (ANALYZE, BUFFERS) over the first 200k index tuples:
#     idx_unit_entities_entity_unit -> Heap Fetches:  64,177  (63,492 buffers)
#     pk_entities                   -> Heap Fetches: 138,465 (139,325 buffers)
#
#   i.e. 69% of the "index-only" rows on `entities` hit the heap anyway, on
#   indexes the graph queries drive 6.2M / 73.8M scans through.
#
# Why the previous unit_entities line (scale_factor=0.05 alone) did not fix it:
# autovacuum computes its triggers from pg_class.reltuples, and it has THREE
# independent triggers. The dead-tuple one is the only one 0.05 touched, and
# unit_entities is append-only — 25,583 inserts vs 0 updates and 560 deletes
# over those 22h — so dead tuples never approach 50 + 0.05 * 1.7M = 84,984.
# What governs an insert-only table is the INSERT trigger, and that was still
# at the stock 1000 + 0.2 * 1.7M = 340,735 inserts (~2 weeks of ingest at the
# measured rate). Hence `last_autovacuum` NULL and `autovacuum_count` 0 on
# BOTH tables at the time of measurement, while `entities` was not listed here
# at all.
#
# The values below bound VM staleness to hours instead of leaving it unbounded:
#   unit_entities insert trigger: 1000 + 0.005 * 1,698,677 =  9,493 ins  (was 340,735)
#   entities      dead   trigger:  500 + 0.005 *   239,964 =  1,700 dead (was 4,849)
#
# unit_entities: 29,014 inserts over 23.1h of pg uptime (~1,255/h) puts 9,493
# about 7.6h out — call it ~3 passes/day, up from ~0.
#
# entities: AT LEAST ~3 passes/day, and in practice a good deal more. Churn is
# bursty, so quote a range, not a point:
#   - 22.5h-average: it took that long to reach the old 4,849 trigger, i.e.
#     ~5.2k dead/day => 1,700 every ~8h => ~3 passes/day. This is the FLOOR.
#   - measured live in the 38.5 min after the 2026-08-12 22:19:13Z pass: 948
#     dead tuples accumulated, i.e. 21-25/min ≈ 30-35k/day, consistent across
#     six samples spanning 22:52-22:58Z (arrival is bursty minute to minute,
#     but the trend is flat, so this is not one spike) => 1,700 every ~70-80
#     min => ~18-21 passes/day.
# Size the I/O expectation off the upper end (roughly hourly), not the floor.
#
# 4,849 IS reachable — `entities` did hit it once, autovacuuming at 2026-08-12
# 22:19:13Z and taking its VM from 31.4% straight back to 100% — but only after
# roughly 23h of accumulated churn. That is the problem, not the refutation:
# any container recreate inside that day-long window resets the dead-tuple
# counter, the trigger is never reached, and the visibility map just stays
# stale. 1,700 puts a pass well inside the restart window.
# Cost is the tradeoff — more frequent vacuum is more background I/O — but
# these two are small: 108MB heap + 261MB index (unit_entities) and 25MB + 56MB
# (entities), so a pass is a few hundred MB of mostly-cached reads. That holds
# even at the ~20x/day upper end above, because the frequent table is the 81MB
# one; the 369MB one stays at ~3x/day on its insert trigger. memory_units
# (1.7GB + HNSW) is a genuinely expensive pass and is deliberately left alone.
# cost_delay / cost_limit match the memory_links precedent so the pass finishes
# promptly instead of being throttled across the ingest window.
_sql "ALTER TABLE IF EXISTS unit_entities SET (autovacuum_vacuum_scale_factor=0.01, autovacuum_vacuum_threshold=1000, autovacuum_vacuum_insert_scale_factor=0.005, autovacuum_vacuum_insert_threshold=1000, autovacuum_analyze_scale_factor=0.02, autovacuum_analyze_threshold=1000, autovacuum_vacuum_cost_delay=2, autovacuum_vacuum_cost_limit=3000)" >/dev/null
_sql "ALTER TABLE IF EXISTS entities SET (autovacuum_vacuum_scale_factor=0.005, autovacuum_vacuum_threshold=500, autovacuum_vacuum_insert_scale_factor=0.01, autovacuum_vacuum_insert_threshold=1000, autovacuum_analyze_scale_factor=0.01, autovacuum_analyze_threshold=500, autovacuum_vacuum_cost_delay=2, autovacuum_vacuum_cost_limit=3000)" >/dev/null

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
  # "count|oldest_age_seconds" for CLAIMABLE non-terminal ops (0 rows → "0|0").
  # #3758: `task_payload IS NOT NULL` mirrors the worker's PARTIAL claim index
  # (`idx_async_operations_pending_claim ON (status, created_at) WHERE
  # status='pending' AND task_payload IS NOT NULL`). A `batch_retain` PARENT is
  # created with `task_payload=NULL` by design (memory_engine.py:12556) and is
  # resolved by sibling aggregation, NEVER claimed by a worker — so its age can
  # never indicate a stalled claimable pipeline. Counting payload-null parents
  # produced recurring FALSE "queue may be wedged" alerts on perfectly healthy
  # in-flight retains, whose suggested remediation (clearing the rows) would
  # destroy live memory writes.
  _q="$(_sql "SELECT count(*)||'|'||coalesce(max(extract(epoch from (now()-created_at)))::bigint,0) FROM async_operations WHERE status IN ('pending','processing') AND task_payload IS NOT NULL")"
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

# --- 6. Dead-letter visibility: WARN on recoverable-but-stalled failed
# retains (#3795). A failed 'retain' op still carrying its task_payload is
# recoverable via the retry endpoint — the memory is stalled, not lost — but
# the worker's claim loop (status='pending') will never revisit it. Nothing
# surfaced 770 such ops for 8 days; this makes the silent pile loud. ---
if [ "${DEAD_LETTER_WARN_S}" -gt 0 ] 2>/dev/null; then
  # "total|fk_signature|oldest_age_seconds". `total` = every failed retain with
  # an intact payload (all recoverable). `fk_signature` = the subset the FK-race
  # misclassifier stranded (retry_count=0 AND next_retry_at NULL) — these never
  # entered the retry ladder and are the safe default to requeue. Read-only.
  _dl="$(_sql "SELECT count(*)||'|'||count(*) FILTER (WHERE retry_count=0 AND next_retry_at IS NULL)||'|'||coalesce(max(extract(epoch from (now()-created_at)))::bigint,0) FROM async_operations WHERE operation_type='retain' AND status='failed' AND task_payload IS NOT NULL")"
  _dltot="${_dl%%|*}"
  _dlrest="${_dl#*|}"
  _dlfk="${_dlrest%%|*}"
  _dlage="${_dlrest##*|}"
  if [ "${_dltot:-0}" -gt 0 ] 2>/dev/null && [ "${_dlage:-0}" -gt "${DEAD_LETTER_WARN_S}" ] 2>/dev/null; then
    log "WARNING: ${_dltot} failed 'retain' op(s) with an intact payload are stalled (recoverable, oldest $((_dlage/3600))h old > $((DEAD_LETTER_WARN_S/3600))h); ${_dlfk} match the FK-race dead-letter signature (retry_count=0, never retried). STALLED memory, not lost — requeue via the retry endpoint (SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS=1; re-runs extraction, costs LLM spend). See #3795."
  fi
fi

# --- 7. Dead-letter REQUEUE (opt-in, costs LLM spend). POST each FK-race dead
# letter to the engine's own retry endpoint (failed→pending; clears
# next_retry_at / worker_id; resets retry_count). The worker's claim index then
# re-picks it up. OFF by default; operator sign-off required (#3795). ---
if [ "${REQUEUE_DEAD_LETTERS}" = "1" ]; then
  _api="${SWITCHROOM_HINDSIGHT_API_URL:-http://127.0.0.1:${HINDSIGHT_API_PORT:-9077}}"
  _tok="${SWITCHROOM_HINDSIGHT_API_TOKEN:-${HINDSIGHT_API_TOKEN:-}}"
  if ! command -v curl >/dev/null 2>&1; then
    log "ERROR: dead-letter requeue requested but curl is absent — cannot reach ${_api}; skipping."
  else
    # bank|operation_id for the FK-race dead letters, oldest first, bounded.
    _cands="$(_sql "SELECT bank_id||'|'||operation_id FROM async_operations WHERE operation_type='retain' AND status='failed' AND task_payload IS NOT NULL AND retry_count=0 AND next_retry_at IS NULL ORDER BY created_at LIMIT ${REQUEUE_MAX}")"
    if [ -z "${_cands}" ]; then
      log "dead-letter requeue: no FK-race dead letters to requeue."
    else
      # Read from a file (not a pipe) so the counters survive the loop.
      _tmpf="$(mktemp 2>/dev/null || echo "/tmp/hs-requeue.$$")"
      printf '%s\n' "${_cands}" > "${_tmpf}"
      _ok=0; _fail=0; _aborted=0
      while IFS='|' read -r _bank _op; do
        [ -n "${_bank}" ] && [ -n "${_op}" ] || continue
        _url="${_api}/v1/default/banks/${_bank}/operations/${_op}/retry"
        if [ -n "${_tok}" ]; then
          _code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer ${_tok}" "${_url}" 2>/dev/null)"
        else
          _code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${_url}" 2>/dev/null)"
        fi
        case "${_code}" in
          2*) log "dead-letter requeue: ${_bank}/${_op} -> HTTP ${_code} (failed->pending)"; _ok=$((_ok + 1)) ;;
          401|403) log "ERROR: dead-letter requeue: ${_bank}/${_op} -> HTTP ${_code} — the retry endpoint needs auth; set SWITCHROOM_HINDSIGHT_API_TOKEN. Aborting sweep."; _aborted=1; break ;;
          *) log "WARNING: dead-letter requeue: ${_bank}/${_op} -> HTTP ${_code:-000} (not requeued)"; _fail=$((_fail + 1)) ;;
        esac
      done < "${_tmpf}"
      rm -f "${_tmpf}" 2>/dev/null
      if [ "${_aborted}" = 1 ]; then
        log "dead-letter requeue: aborted after ${_ok} requeued (auth error) — supply SWITCHROOM_HINDSIGHT_API_TOKEN and re-run."
      else
        log "dead-letter requeue: ${_ok} requeued, ${_fail} failed (bounded at ${REQUEUE_MAX}/tick)."
      fi
    fi
  fi
fi

# --- 8a. Periodic VACUUM (ANALYZE) — belt to autovacuum's braces ---
# Cumulative stats do NOT survive a container recreate on this deployment
# (pg_stat_database.stats_reset NULL, last_autovacuum empty for every table
# minutes after a roll), so autovacuum's n_dead_tup trigger keeps restarting
# from zero and can go unfired for long stretches. The measured win is the
# visibility map: 35.1% / 25.2% all-visible before, 99.0% / 100% after — a low
# all-visible fraction forces heap fetches instead of index-only scans (one
# graph-maintenance query observed doing 1.15M heap fetches).
#
# PLAIN VACUUM ONLY. `VACUUM FULL` takes an ACCESS EXCLUSIVE lock and would
# freeze every agent's memory for the whole rewrite; it is never issued here.
#
# The throttle marker lives in BACKUP_DIR because that is a SEPARATE
# PERSISTENT volume — a marker under the pg data dir or /tmp would vanish on
# a container recreate and the vacuum would re-run on every roll.
_vacuum_ran=0
if [ "${VACUUM_ENABLED}" = "1" ] && mkdir -p "${BACKUP_DIR}" 2>/dev/null; then
  _vac_marker="${BACKUP_DIR}/.vacuum-last"
  if [ -z "$(find "${_vac_marker}" -maxdepth 0 -mmin "-${VACUUM_INTERVAL_MIN}" 2>/dev/null)" ]; then
    # Claim the window BEFORE the work: a vacuum that dies mid-way (container
    # stop) must not re-run on every subsequent tick.
    touch "${_vac_marker}" 2>/dev/null
    _vacuum_ran=1
    _vac_t0="$(date +%s)"
    if [ -x "${VACUUMDB}" ]; then
      if PGPASSWORD="${PGPW_}" "${VACUUMDB}" -U "${PGUSER_}" -h /tmp -p "${PGPORT_}" \
           -d "${PGDB_}" -j "${VACUUM_JOBS}" --analyze >/dev/null 2>&1; then
        log "vacuum (analyze) completed in $(( $(date +%s) - _vac_t0 ))s (vacuumdb -j ${VACUUM_JOBS})"
      else
        log "vacuum (analyze) FAILED via vacuumdb after $(( $(date +%s) - _vac_t0 ))s (will retry in ${VACUUM_INTERVAL_MIN}m)"
      fi
    else
      # No vacuumdb in the image — serial per-table fallback over psql.
      _vac_tables="$(_sql "SELECT quote_ident(schemaname)||'.'||quote_ident(relname) FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname")"
      _vac_n=0
      if [ -n "${_vac_tables}" ]; then
        _vac_tmpf="$(mktemp 2>/dev/null || echo "/tmp/hs-vacuum.$$")"
        printf '%s\n' "${_vac_tables}" > "${_vac_tmpf}"
        while IFS= read -r _vt; do
          [ -n "${_vt}" ] || continue
          _sql "VACUUM (ANALYZE) ${_vt}" >/dev/null 2>&1
          _vac_n=$((_vac_n + 1))
        done < "${_vac_tmpf}"
        rm -f "${_vac_tmpf}" 2>/dev/null
      fi
      log "vacuum (analyze) completed in $(( $(date +%s) - _vac_t0 ))s (${_vac_n} table(s), per-table fallback — vacuumdb absent)"
    fi
  fi
fi

# --- 8b. Conditional REINDEX INDEX CONCURRENTLY — measured, not guessed ---
# Skipped entirely in a tick where 8a ran: VACUUM and REINDEX CONCURRENTLY both
# take a ShareUpdateExclusiveLock on the table and would simply serialize.
if [ "${REINDEX_ENABLED}" = "1" ] && [ "${_vacuum_ran}" = "0" ] && mkdir -p "${BACKUP_DIR}" 2>/dev/null; then
  _rix_marker="${BACKUP_DIR}/.reindex-last"
  if [ -z "$(find "${_rix_marker}" -maxdepth 0 -mmin "-${REINDEX_INTERVAL_MIN}" 2>/dev/null)" ]; then
    touch "${_rix_marker}" 2>/dev/null
    # pgstattuple supplies pgstatindex(); best-effort, same shape as amcheck.
    _sql "CREATE EXTENSION IF NOT EXISTS pgstattuple" >/dev/null 2>&1
    # Candidates from the CATALOG: btree ONLY. This DB carries hnsw (pgvector)
    # and bm25 (pg_search) indexes — pgstatindex errors on those AMs and
    # rebuilding them is enormously expensive and not a bloat fix.
    _rix_cands="$(_sql "SELECT c.oid::regclass::text||'|'||pg_relation_size(c.oid) FROM pg_class c JOIN pg_am am ON am.oid=c.relam JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.relkind='i' AND am.amname='btree' AND n.nspname='public' AND i.indisvalid AND pg_relation_size(c.oid) > ${REINDEX_MIN_MB}*1024*1024 ORDER BY pg_relation_size(c.oid) DESC")"
    if [ -n "${_rix_cands}" ]; then
      # Residue sweep: a CANCELLED `REINDEX ... CONCURRENTLY` leaves an INVALID
      # index behind that still costs writes. Drop only the ones matching pg's
      # own `_ccnew` suffix — a user index that is invalid for some other reason
      # is NOT ours to remove.
      _rix_dead="$(_sql "SELECT c.oid::regclass::text FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE NOT i.indisvalid AND n.nspname='public' AND c.relname LIKE '%\\_ccnew%'")"
      if [ -n "${_rix_dead}" ]; then
        _rix_dtmp="$(mktemp 2>/dev/null || echo "/tmp/hs-ccnew.$$")"
        printf '%s\n' "${_rix_dead}" > "${_rix_dtmp}"
        while IFS= read -r _di; do
          [ -n "${_di}" ] || continue
          if _sql_x "DROP INDEX CONCURRENTLY IF EXISTS ${_di}"; then
            log "reindex: dropped leftover INVALID index ${_di} (residue of a cancelled REINDEX CONCURRENTLY)"
          fi
        done < "${_rix_dtmp}"
        rm -f "${_rix_dtmp}" 2>/dev/null
      fi

      # Measure each candidate's avg_leaf_density; a freshly built btree is ~90.
      # pgstatindex reads the whole index, so this costs one sequential pass per
      # candidate — bounded by the >REINDEX_MIN_MB floor and the weekly interval,
      # and it is the price of not rebuilding on a guess.
      _rix_tmpf="$(mktemp 2>/dev/null || echo "/tmp/hs-reindex.$$")"
      _rix_bloated="$(mktemp 2>/dev/null || echo "/tmp/hs-reindex-b.$$")"
      printf '%s\n' "${_rix_cands}" > "${_rix_tmpf}"
      : > "${_rix_bloated}"
      while IFS='|' read -r _ix _ixbytes; do
        [ -n "${_ix}" ] || continue
        _dens="$(_sql "SELECT round(avg_leaf_density)::int FROM pgstatindex('${_ix}')")"
        # Unreadable density (non-btree slipped through, extension missing,
        # index vanished) => leave it alone rather than rebuild blind.
        [ -n "${_dens}" ] || continue
        [ "${_dens}" -lt "${REINDEX_MIN_DENSITY}" ] 2>/dev/null || continue
        printf '%s|%s|%s\n' "${_dens}" "${_ix}" "${_ixbytes:-0}" >> "${_rix_bloated}"
      done < "${_rix_tmpf}"
      rm -f "${_rix_tmpf}" 2>/dev/null

      _rix_total="$(grep -c . "${_rix_bloated}" 2>/dev/null || true)"
      if [ "${_rix_total:-0}" -gt 0 ] 2>/dev/null; then
        # Worst bloat (lowest density) first, capped per tick.
        _rix_pgdata="$(_sql "SHOW data_directory")"
        [ -n "${_rix_pgdata}" ] && [ -d "${_rix_pgdata}" ] || _rix_pgdata="$(dirname "${PG0_INSTANCE}")"
        sort -t'|' -k1,1n "${_rix_bloated}" | head -n "${REINDEX_MAX_PER_RUN}" > "${_rix_bloated}.pick"
        mv -f "${_rix_bloated}.pick" "${_rix_bloated}" 2>/dev/null
        _rix_picked="$(grep -c . "${_rix_bloated}" 2>/dev/null || true)"
        while IFS='|' read -r _dens _ix _ixbytes; do
          [ -n "${_ix}" ] || continue
          # Disk guard: CONCURRENTLY builds a full SECOND copy before swapping.
          # An unreadable df (path gone) leaves _free_kb empty and the guard
          # open — the same best-effort posture as the rest of the script.
          _free_kb="$(df -P "${_rix_pgdata}" 2>/dev/null | awk 'NR==2{print $4}')"
          _need_kb=$(( (${_ixbytes:-0} / 1024) * 2 ))
          if [ -n "${_free_kb}" ] && [ "${_free_kb}" -lt "${_need_kb}" ] 2>/dev/null; then
            log "reindex: SKIPPED ${_ix} (density ${_dens}%) — only $((_free_kb/1024))MB free on ${_rix_pgdata}, CONCURRENTLY needs $((_need_kb/1024))MB (2x the index)."
            continue
          fi
          _rix_t0="$(date +%s)"
          if _sql_x "REINDEX INDEX CONCURRENTLY ${_ix}"; then
            log "reindex: rebuilt ${_ix} (avg_leaf_density was ${_dens}% < ${REINDEX_MIN_DENSITY}%) in $(( $(date +%s) - _rix_t0 ))s"
          else
            log "WARNING: reindex: REINDEX INDEX CONCURRENTLY ${_ix} failed after $(( $(date +%s) - _rix_t0 ))s — continuing with the next candidate."
          fi
        done < "${_rix_bloated}"
        _rix_skipped=$(( ${_rix_total:-0} - ${_rix_picked:-0} ))
        if [ "${_rix_skipped}" -gt 0 ] 2>/dev/null; then
          log "reindex: ${_rix_skipped} bloated index(es) left for the next sweep — capped at ${REINDEX_MAX_PER_RUN}/run (SWITCHROOM_HINDSIGHT_REINDEX_MAX_PER_RUN)."
        fi
      fi
      rm -f "${_rix_bloated}" 2>/dev/null
    fi
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
