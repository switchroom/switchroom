/**
 * Behavioural proof for the graph-maintenance INTERVAL SWEEP patch that
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED) and against upstream +
 * the patch blocks applied (must be GREEN). Nothing here greps the patched
 * source — every assertion drives real shipping code and observes what it does.
 *
 * THE DEFECT, in the real shipping source at the pinned digest.
 *
 * `graph_maintenance` is ENQUEUE-DRIVEN ONLY.
 * `MemoryEngine.submit_async_graph_maintenance` short-circuits with
 * `no_work=True` when the bank's `graph_maintenance_queue` is empty, and its
 * only callers are the unit-removal / source-memory-unit paths. There is no
 * interval scheduler anywhere: `engine/maintenance.py` runs retention,
 * scheduled mental-model refresh and consolidation reconcile on its ~60s tick,
 * and nothing else. So a bank that stops deleting units stops being maintained
 * — permanently, and silently, because "no work" is a SUCCESS.
 *
 * Measured read-only against this fleet's live database on 2026-08-13: of 12
 * active banks only `marko` and `gymbro` had run graph maintenance in the 70
 * minutes since the v0.21.8 roll. Bank `klanker` had had ZERO attempts since
 * 2026-08-08 — five days — with `graph_maintenance_queue` count 0, while
 * actively retaining and consolidating the whole time. Before going quiet it
 * failed 9 consecutive times with an empty `error_message`; a later row on
 * another bank reveals that as `TimeoutError raised with no message
 * (task_type=graph_maintenance)`, the 60s asyncpg `command_timeout` that #4624
 * fixed. #4624 made the sweep finish. Nothing made it START again: klanker's
 * queue drained, and with it every future sweep. Stale cooccurrence rows leak
 * for ever.
 *
 * TWO ARMS, because they prove different things:
 *
 *   1. the LOOP arm (`PROBE`) drives the REAL `MaintenanceLoop._run_graph_sweep`
 *      and the REAL `MemoryEngine.submit_async_graph_maintenance` against a
 *      fake connection, which is what lets it script an empty queue, a
 *      multi-tenant schema list and an exploding bank. It can see everything
 *      about the CALLER — that a quiet bank really gets an operation created
 *      for it, that the sweep is FORCED rather than faked by inserting queue
 *      rows, that the per-tick cap bounds the wave — and nothing about SQL
 *      semantics, since a fake connection never parses a statement;
 *   2. the SQL arm (`SQL_PROBE`) takes the discovery statement the real
 *      shipping method builds and EXECUTES it against a real PostgreSQL on real
 *      rows. It is the only thing here that can prove the due-ness predicate
 *      means what it says: that a never-swept bank is due, that a bank with a
 *      `pending` or `processing` operation is NOT (the idempotency guarantee),
 *      that a FAILED attempt still counts as an attempt, and that the jitter
 *      term really spreads the wave instead of being a no-op.
 *
 * WHY A SHAPE TEST WOULD NOT BE ENOUGH. Every property that matters is a
 * property of BEHAVIOUR:
 *
 *   - "a sweep is submitted" proves nothing unless the bank's queue is EMPTY at
 *     the time — that is the exact state the defect fails on, and upstream's
 *     own short-circuit is what a naive submit hits;
 *   - `force_sweep=True` in the diff proves nothing unless it reaches the
 *     method: the probe binds the REAL `submit_async_graph_maintenance` onto
 *     its fake engine and replaces only the terminal INSERT, so the
 *     short-circuit, the tenant auth and the dedupe flag all run for real;
 *   - the in-flight guard must be checked BY POSTGRES against real rows — a
 *     `NOT EXISTS` that greps clean but names the wrong status set re-submits a
 *     bank every tick and stampedes exactly the 4.7M-link banks it must not;
 *   - and the jitter must actually vary per bank AND per cycle, or an
 *     exactly-periodic submitter aliases against #4624's `int(now) // 120 %
 *     slice_count` slice clock and visits only a fraction of a large bank's
 *     slices, for ever (3600s = 30 windows; gcd(30, 21) = 3, so 7 of a 21-slice
 *     bank's 21 slices).
 *
 * The expected numbers below are HARD-CODED LITERALS, not reads of the config
 * fields they check — a fixture and an expectation derived from the same
 * constant cannot fail for any value of that constant.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. Note it
 * applies THREE: the interval-sweep block asserts #4624's bounded sweep is
 * present (it must not resurrect an unbounded one), and #4624 in turn anchors
 * on text #4604 writes — so both are prerequisites and are applied first, in
 * Dockerfile order. It applies them by `docker exec` (not `docker build`) so it
 * runs on daemons without buildx, and it never touches the production
 * `switchroom-hindsight` container.
 *
 * SKIP DISCIPLINE: identical to
 * `hindsight-graph-maintenance-bounded-sweep.test.ts`. Locally, with no docker
 * or no cached image, this skips (never pull a 6.4GB third-party image onto a
 * dev box). In CI the `hindsight-probe` job pulls both pinned digests and sets
 * SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an unavailable
 * docker/image is a HARD FAILURE, never a green skip. Both runs assert a
 * `PROBE_EXECUTED` sentinel so a probe that dies early can never be mistaken
 * for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
// `execSync` survives for the two module-scope PREFLIGHTS only (`docker
// version`, `docker image inspect`): they run during collection, not the run
// phase, and cost milliseconds.
import { execSync } from "node:child_process";
// #4628: every docker call in the RUN phase is AWAITED — legs and teardown
// alike. A sync exec blocks the vitest worker's event loop, and vitest's
// worker→main birpc has a hard-coded 60 s timeout with no config knob, so a
// starved worker dies with `Timeout calling "onTaskUpdate"` while every test
// PASSES.
import { execFileAsync } from "./_exec-async.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-graph-maintenance-interval-sweep";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The blocks this file applies, named by their unique in-block markers, in the
 * order they must run. The first two are PREREQUISITES, not subjects: the
 * interval-sweep block asserts #4624's bounded sweep is in the image, and
 * #4624 anchors on the `_run_cooccurrence_prune` helper #4604 introduces.
 */
const PREREQUISITE_PATCH_NAMES: readonly string[] = [
  "graph-maintenance retry-storm patch",
  "graph-maintenance bounded sweep patch",
];
const PATCH_NAME = "graph-maintenance interval sweep patch";

/**
 * The patch blocks under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by their unique patch names and
 * returned in Dockerfile order.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const ordered: string[] = [];
  for (const name of [...PREREQUISITE_PATCH_NAMES, PATCH_NAME]) {
    const hits = blocks.filter((b) => b.includes(name));
    if (hits.length !== 1) {
      throw new Error(
        `Dockerfile.hindsight contains ${hits.length} "${name}" RUN blocks ` +
          `(expected exactly 1) — if the patch was deliberately removed, delete ` +
          `this test with it.`,
      );
    }
    ordered.push(hits[0]);
  }
  // Dockerfile order is load-bearing: each block anchors on text an earlier one
  // wrote, so an out-of-order Dockerfile fails the anchor assertion at BUILD
  // time. Assert it here so the failure names the cause instead of a stack.
  for (let i = 1; i < ordered.length; i += 1) {
    if (dockerfile.indexOf(ordered[i - 1]) > dockerfile.indexOf(ordered[i])) {
      throw new Error(
        `Dockerfile.hindsight applies its graph-maintenance patch blocks out ` +
          `of order — each anchors on text an earlier one writes; expected ` +
          `${[...PREREQUISITE_PATCH_NAMES, PATCH_NAME].join(" then ")}`,
      );
    }
  }
  return ordered;
}

/**
 * LOOP arm. Exits 0 only when every property holds; prints the offending
 * assertions otherwise. Every check prints a NAME=OK/FAIL line, and both the
 * RED and the GREEN case below assert on the same names, so the two runs are
 * compared on identical observations.
 */
const PROBE = String.raw`
"""Behavioural probe for the periodic graph-maintenance sweep patch.

RED against unpatched upstream, GREEN against the patched image. Every check is
wrapped so an unpatched module records a FAILURE rather than aborting the run —
both directions must reach PROBE_EXECUTED, or a crash would be
indistinguishable from a red assertion.
"""

import asyncio
import contextlib
import os
import sys

failures = []


def check(name, cond, detail=""):
    print(f"{name}={'OK' if cond else 'FAIL'}")
    if not cond:
        failures.append(f"{name}: {detail}")


def guard(name, fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - surviving anything is the point
        check(name, False, f"{type(e).__name__}: {e}")
        return None


from hindsight_api.engine import maintenance as mnt
from hindsight_api.engine.memory_engine import MemoryEngine

# ────────────────────────────────────────────────────────── the test doubles


class Cfg:
    """Every OTHER maintenance job off, so a tick is the graph sweep alone."""

    audit_log_retention_days = 0
    llm_trace_enabled = False
    llm_trace_retention_days = 0
    consolidation_reconcile_interval_seconds = 0
    mental_model_refresh_tick_seconds = 0
    operation_retention_days = 0
    database_schema = "public"
    graph_maintenance_sweep_interval_seconds = 3600
    graph_maintenance_sweep_max_banks_per_tick = 2

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class FakeConn:
    """Stands in for Postgres. Records every statement and its bound params.

    'fetch' models the discovery query INCLUDING its server-side LIMIT (the SQL
    arm proves the real statement enforces it); 'fetchval' is upstream's
    empty-queue pre-check and always reports an EMPTY queue — the state of every
    bank this job exists to reach.
    """

    def __init__(self, due_by_schema):
        self.due_by_schema = due_by_schema
        self.discovery = []
        self.queue_probes = []

    async def fetch(self, sql, *params):
        self.discovery.append((sql, params))
        banks = []
        for schema, names in self.due_by_schema.items():
            if f'"{schema}".banks' in sql:
                banks = names
        limit = params[1] if len(params) > 1 else len(banks)
        return [{"bank_id": b} for b in banks[:limit]]

    async def fetchval(self, sql, *params):
        self.queue_probes.append((sql, params))
        return None


class Tenant:
    def __init__(self, schema, tenant_id):
        self.schema = schema
        self.tenant_id = tenant_id


class Tenants:
    def __init__(self, tenants):
        self._t = tenants

    async def list_tenants(self):
        return self._t


class FakeEngine:
    """Carries the REAL 'submit_async_graph_maintenance' (bound below).

    Only '_submit_async_operation' — the terminal INSERT — is replaced, so the
    force_sweep short-circuit, the tenant auth and the dedupe flag all run for
    real. An operation appearing in 'self.operations' is therefore the OUTCOME
    of the whole submit path, not the fact that some function was called.
    """

    def __init__(self, conn, tenants=(), raise_for=()):
        self._backend = object()
        self._tenant_extension = Tenants(list(tenants))
        self._operation_validator = None
        self._conn = conn
        self._raise_for = set(raise_for)
        self.operations = []

    async def _get_backend(self):
        return self._backend

    async def _authenticate_tenant(self, request_context):
        return None

    async def _submit_async_operation(
        self, bank_id, operation_type, task_type, task_payload, **kw
    ):
        # Raising HERE stands in for every real raise site strictly BEFORE the
        # terminal INSERT: '_authenticate_tenant' (memory_engine.py:15573) and
        # '_validate_operation' (:15596) both run ahead of it, so a submit that
        # dies in either leaves NO async_operations row behind — which is the
        # whole starvation mechanism the ledger checks below exercise.
        if bank_id in self._raise_for:
            raise RuntimeError(f"submit exploded for {bank_id}")
        # Upstream's INSERT is what records the ATTEMPT. Mirror it into the
        # ledger so the discovery model below sees what the server would.
        record = getattr(self._conn, "record_attempt", None)
        if record is not None:
            record(bank_id)
        self.operations.append(
            {
                "bank_id": bank_id,
                "operation_type": operation_type,
                "task_type": task_type,
                "payload": dict(task_payload),
                "dedupe_by_bank": kw.get("dedupe_by_bank", False),
            }
        )
        return {"operation_id": f"op-{bank_id}"}


FakeEngine.submit_async_graph_maintenance = MemoryEngine.submit_async_graph_maintenance


def install(conn):
    @contextlib.asynccontextmanager
    async def fake_acquire(backend, *a, **kw):
        yield conn

    mnt.acquire_with_retry = fake_acquire
    import hindsight_api.engine.memory_engine as me

    me.acquire_with_retry = fake_acquire


def run_tick(cfg, due_by_schema, tenants=(), raise_for=(), ticks=1):
    conn = FakeConn(due_by_schema)
    install(conn)
    mnt.get_config = lambda: cfg
    engine = FakeEngine(conn, tenants=tenants, raise_for=raise_for)
    loop = mnt.MaintenanceLoop(engine)

    async def go():
        for _ in range(ticks):
            await loop._tick()

    asyncio.run(go())
    return engine, conn


# ═════════════════════ THE DEFECT: a quiet bank never gets swept at all ══════
# One maintenance tick, one bank whose graph_maintenance_queue is EMPTY and
# whose last sweep is ancient. Upstream schedules nothing here, for ever.
cfg = Cfg()
engine, conn = guard(
    "GS_tick_runs", lambda: run_tick(cfg, {"public": ["quiet-bank"]})
) or (None, None)
ops = list(engine.operations) if engine else []

check(
    "GS_quiet_bank_gets_a_sweep",
    [o["bank_id"] for o in ops] == ["quiet-bank"],
    f"one maintenance tick scheduled {[o['bank_id'] for o in ops]!r} — a bank with an "
    "empty graph_maintenance_queue and no recent sweep must get one scheduled",
)
check(
    "GS_operation_is_graph_maintenance",
    bool(ops) and ops[0]["operation_type"] == "graph_maintenance"
    and ops[0]["task_type"] == "graph_maintenance",
    f"got {ops[:1]!r}",
)
# force_sweep=True SKIPS the empty-queue pre-check entirely. So zero queue
# probes plus an operation is proof the submit was forced: without the flag the
# probe would have run, returned empty, and created NO operation at all.
check(
    "GS_sweep_is_forced_not_faked",
    bool(ops) and conn is not None and conn.queue_probes == [],
    "the submit ran upstream's empty-queue pre-check "
    f"({len(conn.queue_probes) if conn else '?'} probes) — it was not forced, so on a real "
    "quiet bank it short-circuits to no_work and this job does nothing",
)
check(
    "GS_dedupes_by_bank",
    bool(ops) and ops[0]["dedupe_by_bank"] is True,
    "the submit does not dedupe by bank; the loop runs in every api/worker process "
    "with no leader election, so one wave per process would be queued",
)

# The interval and the per-tick cap reach the server as BOUND parameters.
disc = conn.discovery if conn else []
check(
    "GS_discovery_binds_interval_and_cap",
    len(disc) == 1 and disc[0][1] == (3600.0, 2),
    f"expected one discovery call bound ($1 interval seconds, $2 per-tick cap) = "
    f"(3600.0, 2), got {[d[1] for d in disc]!r}",
)

# ═══════════════════════════ the tick guard: not once per second ═════════════
engine2, conn2 = guard(
    "GS_double_tick_runs",
    lambda: run_tick(Cfg(), {"public": ["quiet-bank"]}, ticks=2),
) or (None, None)
check(
    "GS_one_submit_per_tick_window",
    engine2 is not None and len(engine2.operations) == 1,
    f"two back-to-back ticks scheduled {len(engine2.operations) if engine2 else '?'} "
    "sweeps — the _GRAPH_SWEEP_TICK_SECONDS guard is not holding",
)

# ═══════════════════════════ the cap really caps the tick ════════════════════
engine3, conn3 = guard(
    "GS_cap_runs",
    lambda: run_tick(
        Cfg(graph_maintenance_sweep_max_banks_per_tick=2),
        {"public": ["b1", "b2", "b3", "b4", "b5"]},
    ),
) or (None, None)
check(
    "GS_per_tick_cap_bounds_the_wave",
    engine3 is not None and len(engine3.operations) == 2,
    f"five due banks produced {len(engine3.operations) if engine3 else '?'} submits in one "
    "tick; the cap is 2",
)

# ═══════════════════════════ 0 disables it completely ════════════════════════
engine4, conn4 = guard(
    "GS_disabled_runs",
    lambda: run_tick(
        Cfg(graph_maintenance_sweep_interval_seconds=0), {"public": ["quiet-bank"]}
    ),
) or (None, None)
check(
    "GS_interval_zero_restores_upstream",
    engine4 is not None and engine4.operations == [] and conn4.discovery == [],
    "interval 0 must be an exact opt-out: no discovery, no submit",
)

# ═══════════════════════ the loop STARTS for this job alone ══════════════════
mnt.get_config = lambda: Cfg()
check(
    "GS_enables_the_maintenance_loop",
    mnt.MaintenanceLoop._any_job_enabled() is True,
    "with every other job off, the loop would not start and the sweep would never tick",
)
mnt.get_config = lambda: Cfg(graph_maintenance_sweep_interval_seconds=0)
check(
    "GS_does_not_enable_the_loop_when_off",
    mnt.MaintenanceLoop._any_job_enabled() is False,
    "interval 0 still starts the loop — the opt-out is not complete",
)

# ═══════════════════════════ multi-tenant: every polled schema ═══════════════
engine5, conn5 = guard(
    "GS_tenant_runs",
    lambda: run_tick(
        Cfg(),
        {"public": ["pub-bank"], "t1": ["t1-bank"]},
        tenants=[Tenant("t1", "tenant-1")],
    ),
) or (None, None)
check(
    "GS_sweeps_every_polled_schema",
    engine5 is not None
    and sorted(o["bank_id"] for o in engine5.operations) == ["pub-bank", "t1-bank"],
    f"got {[o['bank_id'] for o in (engine5.operations if engine5 else [])]!r}",
)
check(
    "GS_carries_the_tenant_id",
    engine5 is not None
    and {o["bank_id"]: o["payload"].get("_tenant_id") for o in engine5.operations}
    == {"pub-bank": None, "t1-bank": "tenant-1"},
    "the tenant id is not carried into the task payload, so config resolution in the "
    "worker would not honour tenant-level overrides",
)

# ═══════════════════════ one bank's failure is not the wave's ════════════════
engine6, _ = guard(
    "GS_isolation_runs",
    lambda: run_tick(
        Cfg(graph_maintenance_sweep_max_banks_per_tick=5),
        {"public": ["boom", "fine"]},
        raise_for=["boom"],
    ),
) or (None, None)
check(
    "GS_one_bad_bank_does_not_stop_the_rest",
    engine6 is not None and [o["bank_id"] for o in engine6.operations] == ["fine"],
    f"got {[o['bank_id'] for o in (engine6.operations if engine6 else [])]!r}",
)

# ═════════ STARVATION: a bank whose SUBMIT raises must not pin the queue ═════
# Upstream creates the async_operations row only AFTER '_authenticate_tenant'
# (memory_engine.py:15573) and '_validate_operation' (:15596). A bank whose
# submit raises in either records NO attempt, so its last-attempt stays NULL —
# and the discovery orders 'last.created_at ASC NULLS FIRST'. Two such banks
# therefore occupy both per-tick slots on EVERY tick, for ever, and every other
# bank silently stops being swept: the exact defect this job exists to fix,
# reinstated, with only a logger.warning as the signal.
#
# The model below is the two server behaviours that decide this, and nothing
# else: the discovery's NULLS-FIRST ordering + LIMIT, and the fact that
# async_operations IS the attempt ledger the ordering reads.


class LedgerConn:
    """Postgres modelled as the attempt ledger the discovery query reads.

    Ticks are the clock: 'now' advances once per tick and a bank is due when its
    last recorded attempt is DUE_AFTER ticks old, or absent. 'record_attempt' is
    the only way a row appears — from upstream's INSERT on a successful submit,
    or from whatever the sweep does when a submit raises.
    """

    DUE_AFTER = 3

    def __init__(self, banks):
        self.banks = list(banks)
        self.attempts = {}
        self.selected = []
        self.writes = []
        self.now = 0

    def record_attempt(self, bank_id):
        self.attempts[bank_id] = self.now

    async def fetch(self, sql, *params):
        limit = params[1] if len(params) > 1 else len(self.banks)
        due = [
            b
            for b in self.banks
            if b not in self.attempts or self.now - self.attempts[b] >= self.DUE_AFTER
        ]
        # 'ORDER BY last.created_at ASC NULLS FIRST, b.bank_id'.
        due.sort(key=lambda b: (self.attempts.get(b, -1), b))
        picked = due[:limit]
        self.selected.extend(picked)
        return [{"bank_id": b} for b in picked]

    async def fetchval(self, sql, *params):
        return None

    async def execute(self, sql, *params):
        self.writes.append((sql, params))
        # An attempt row written by the sweep's own failure path counts exactly
        # as upstream's would: same table, same operation_type, same ledger.
        if "async_operations" in sql and "graph_maintenance" in sql:
            for p in params:
                if isinstance(p, str) and p in self.banks:
                    self.record_attempt(p)
                    break


def run_ledger(cfg, banks, raise_for, ticks):
    conn = LedgerConn(banks)
    install(conn)
    mnt.get_config = lambda: cfg
    engine = FakeEngine(conn, raise_for=raise_for)
    loop = mnt.MaintenanceLoop(engine)

    async def go():
        for _ in range(ticks):
            # A fresh 60s tick window (the _GRAPH_SWEEP_TICK_SECONDS guard is
            # proven separately above); the ledger's clock advances with it.
            loop._last_run.clear()
            conn.now += 1
            await loop._tick()

    asyncio.run(go())
    return engine, conn


BOOM = ["boom-1", "boom-2"]
HEALTHY = ["healthy-1", "healthy-2", "healthy-3"]
# Sorted order puts both exploding banks ahead of every healthy one, so a sweep
# that never records their attempt hands them both slots on every single tick.
engine7, conn7 = guard(
    "GS_starvation_runs",
    lambda: run_ledger(
        Cfg(graph_maintenance_sweep_max_banks_per_tick=2), BOOM + HEALTHY, BOOM, 4
    ),
) or (None, None)
swept = sorted({o["bank_id"] for o in engine7.operations}) if engine7 else []
check(
    "GS_failing_banks_do_not_starve_the_fleet",
    swept == HEALTHY,
    f"over four ticks the only banks swept were {swept!r} — two banks whose submit "
    "raises before upstream writes their async_operations row keep a NULL last "
    "attempt, sort first under NULLS FIRST, and consume the whole per-tick cap for "
    "ever, so every other bank stops being swept entirely",
)
check(
    "GS_failed_submit_records_an_attempt",
    conn7 is not None and sorted(b for b in BOOM if b in conn7.attempts) == BOOM,
    "a submit that raised left NO attempt in async_operations "
    f"({sorted(conn7.attempts) if conn7 else '?'}), so the bank stays NULL-forever at "
    "the head of the discovery order",
)
check(
    "GS_failed_attempt_is_recorded_as_failed",
    conn7 is not None
    and any(
        "async_operations" in sql
        and "'failed'" in sql
        and any(isinstance(p, str) and "submit exploded" in p for p in params)
        for sql, params in conn7.writes
    ),
    "the recorded attempt does not carry status 'failed' and the error text, so a "
    f"wedged bank is invisible to the operator: writes were {conn7.writes if conn7 else '?'}",
)
# The opposite direction. Recording the attempt must DELAY the failing bank by
# one interval, never banish it: a bank that can only fail must still be retried,
# or the fix is the same starvation pointed the other way.
check(
    "GS_failing_bank_is_retried_not_banished",
    conn7 is not None and all(conn7.selected.count(b) >= 2 for b in BOOM),
    f"a bank whose submit always raises was tried "
    f"{[conn7.selected.count(b) for b in BOOM] if conn7 else '?'} time(s) in four ticks — "
    "recording the failed attempt must rate-limit the retry to the interval, not "
    "exclude the bank permanently",
)

# ═══════════════════════════ the knobs are real env config ═══════════════════
def env_roundtrip():
    from hindsight_api.config import HindsightConfig

    os.environ["HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_INTERVAL_SECONDS"] = "777"
    os.environ["HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_MAX_BANKS_PER_TICK"] = "9"
    try:
        c = HindsightConfig.from_env()
        return (
            c.graph_maintenance_sweep_interval_seconds,
            c.graph_maintenance_sweep_max_banks_per_tick,
        )
    finally:
        del os.environ["HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_INTERVAL_SECONDS"]
        del os.environ["HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_MAX_BANKS_PER_TICK"]


got = guard("GS_env_roundtrip_runs", env_roundtrip)
check(
    "GS_interval_is_env_configurable",
    got == (777, 9),
    f"HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_* did not reach the config: got {got!r}",
)


def default_interval():
    from hindsight_api.config import HindsightConfig

    for var in (
        "HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_INTERVAL_SECONDS",
        "HINDSIGHT_API_GRAPH_MAINTENANCE_SWEEP_MAX_BANKS_PER_TICK",
    ):
        os.environ.pop(var, None)
    c = HindsightConfig.from_env()
    return (
        c.graph_maintenance_sweep_interval_seconds,
        c.graph_maintenance_sweep_max_banks_per_tick,
    )


# Hard-coded literals, not reads of the DEFAULT_* constants they check: an
# expectation derived from the same constant cannot fail for any value of it.
check(
    "GS_defaults_are_on",
    guard("GS_default_runs", default_interval) == (3600, 2),
    "the sweep must be ON by default at 3600s / 2 banks per tick — a knob defaulting "
    "to 0 ships the defect",
)

print("PROBE_EXECUTED")
for f in failures:
    print("FAILURE:", f)
sys.exit(1 if failures else 0)
`;

/**
 * The SQL arm's Postgres, pinned by digest. The same image the bounded-sweep
 * probe uses: only stock SQL is exercised here (`LEFT JOIN LATERAL`,
 * `make_interval`, `md5`, `::bit(16)`, `NOT EXISTS`), which is long-stable.
 */
const PG_IMAGE =
  "postgres@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const PG_USER = "probe";
const PG_DB = "probe";
/** Throwaway container on a private netns; never reachable off the host. */
const PG_PASSWORD = "probe";

/**
 * SQL arm. Captures the discovery statement the REAL shipping
 * `MaintenanceLoop._run_graph_sweep` issues (by running it against a capturing
 * connection) and EXECUTES it against a real PostgreSQL, on real
 * `banks` / `async_operations` rows. Every assertion below is a set of bank ids
 * Postgres computed — nothing here inspects the SQL as a string.
 *
 * It exists because a substring check cannot tell a working due-ness predicate
 * from a broken one. `AND p.status IN ('pending')` contains every substring a
 * grep-style check looks for, and re-submits a bank on every 60s tick while a
 * sweep is already `processing` — a stampede on exactly the 4.7M-link banks
 * this patch must not stampede. Under this arm it fails NOT_DUE_while_processing.
 */
const SQL_PROBE = String.raw`
"""Executable proof for the periodic sweep's DUE-BANK selection.

The loop arm proves the tick submits; it cannot prove WHICH banks the server
picks, because a fake connection never parses a statement. This arm takes the
statement the real shipping '_run_graph_sweep' issues at runtime — captured off
a recording connection, not re-typed here — and executes it against a real
PostgreSQL on real rows. Every assertion below is a set the server computed.
"""

import asyncio
import contextlib
import os
import sys

sys.path.insert(0, "/app/api")

import asyncpg

failures = []


def check(name, cond, detail=""):
    print(f"{name}={'OK' if cond else 'FAIL'}")
    if not cond:
        failures.append(f"{name}: {detail}")


from hindsight_api.engine import maintenance as mnt

INTERVAL = 3600.0


# ── capture the statement the SHIPPING job issues ────────────────────────────
class CaptureConn:
    def __init__(self):
        self.sql = None
        self.params = None

    async def fetch(self, sql, *params):
        self.sql = sql
        self.params = params
        return []


class Tenants:
    async def list_tenants(self):
        return []


class CaptureEngine:
    _backend = object()
    _tenant_extension = Tenants()


class Cfg:
    database_schema = "public"
    graph_maintenance_sweep_interval_seconds = int(INTERVAL)
    graph_maintenance_sweep_max_banks_per_tick = 1000


cap = CaptureConn()


@contextlib.asynccontextmanager
async def fake_acquire(backend, *a, **kw):
    yield cap


mnt.acquire_with_retry = fake_acquire
mnt.get_config = lambda: Cfg()
asyncio.run(mnt.MaintenanceLoop(CaptureEngine())._run_graph_sweep(Cfg()))

DUE_SQL = cap.sql
check(
    "SQL_captured_from_shipping_code",
    bool(DUE_SQL) and "graph_maintenance" in (DUE_SQL or ""),
    f"the shipping job issued no discovery statement; got {DUE_SQL!r}",
)
if not DUE_SQL:
    print("SQL_PROBE_EXECUTED")
    for f in failures:
        print("FAILURE:", f)
    sys.exit(1)

# The statement names '"public".banks' / '"public".async_operations'; the probe
# database serves them from the default search_path schema.
DUE_SQL = DUE_SQL.replace('"public".', "")


# ── capture the FAILED-ATTEMPT statement, the same way ───────────────────────
# A submit that raises does so BEFORE upstream writes its async_operations row
# (_authenticate_tenant, then _validate_operation), so unless the sweep records
# the attempt itself the bank keeps a NULL last attempt and — NULLS FIRST — pins
# the head of the queue for ever. This captures whatever the shipping failure
# path writes and executes it below against the real column set.
class WedgeConn:
    def __init__(self, bank):
        self.bank = bank
        self.insert = None

    async def fetch(self, sql, *params):
        return [{"bank_id": self.bank}]

    async def execute(self, sql, *params):
        self.insert = (sql, params)


class ExplodingEngine:
    _backend = object()
    _tenant_extension = Tenants()

    async def submit_async_graph_maintenance(self, **kw):
        raise RuntimeError("probe: submit exploded before the operation row")


WEDGED = "wedged-bank"
wedge = WedgeConn(WEDGED)


@contextlib.asynccontextmanager
async def wedge_acquire(backend, *a, **kw):
    yield wedge


mnt.acquire_with_retry = wedge_acquire
asyncio.run(mnt.MaintenanceLoop(ExplodingEngine())._run_graph_sweep(Cfg()))
FAIL_SQL, FAIL_PARAMS = wedge.insert or (None, None)
check(
    "SQL_failed_attempt_captured_from_shipping_code",
    bool(FAIL_SQL) and "INSERT" in (FAIL_SQL or "").upper(),
    "a submit that raised wrote nothing — the bank keeps a NULL last attempt and "
    f"starves every other bank behind it; got {FAIL_SQL!r}",
)
if FAIL_SQL:
    FAIL_SQL = FAIL_SQL.replace('"public".', "")

SCHEMA = """
DROP TABLE IF EXISTS async_operations, banks;
CREATE TABLE banks (bank_id text PRIMARY KEY);
-- The real column set (5a366d414dce_initial_schema), so a statement that names
-- a column the shipping schema does not have fails HERE rather than in prod.
CREATE TABLE async_operations (
    operation_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_id         text NOT NULL REFERENCES banks(bank_id) ON DELETE CASCADE,
    operation_type  text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed','cancelled')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    error_message   text,
    task_payload    jsonb,
    result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON async_operations (bank_id, created_at DESC);
CREATE INDEX ON async_operations (bank_id, status);
"""


async def due(conn, interval=INTERVAL, limit=1000):
    rows = await conn.fetch(DUE_SQL, float(interval), limit)
    return [r["bank_id"] for r in rows]


async def add_bank(conn, bank, ops=()):
    await conn.execute("INSERT INTO banks (bank_id) VALUES ($1)", bank)
    for op_type, status, age in ops:
        await conn.execute(
            "INSERT INTO async_operations (bank_id, operation_type, status, created_at) "
            "VALUES ($1, $2, $3, NOW() - make_interval(secs => $4))",
            bank, op_type, status, float(age),
        )


async def main():
    conn = await asyncpg.connect(os.environ["PROBE_DSN"])
    try:
        await conn.execute(SCHEMA)

        GM = "graph_maintenance"
        # The fleet's real shapes, one bank each.
        await add_bank(conn, "never-swept")
        await add_bank(conn, "swept-10min-ago", [(GM, "completed", 600)])
        await add_bank(conn, "swept-3h-ago", [(GM, "completed", 10800)])
        await add_bank(conn, "failed-3h-ago", [(GM, "failed", 10800)])
        await add_bank(conn, "pending-since-10d", [(GM, "pending", 864000)])
        await add_bank(conn, "processing-since-10d", [(GM, "processing", 864000)])
        await add_bank(conn, "only-consolidation", [("consolidation", "completed", 60)])
        # A bank swept 3h ago that ALSO has a fresh pending sweep: in flight wins.
        await add_bank(
            conn, "swept-3h-ago-and-pending", [(GM, "completed", 10800), (GM, "pending", 60)]
        )

        got = set(await due(conn))
        check("DUE_never_swept_bank", "never-swept" in got,
              "a bank that has NEVER had a graph_maintenance operation is not selected — "
              "this is the klanker shape, the whole defect")
        check("DUE_bank_quiet_longer_than_the_interval", "swept-3h-ago" in got,
              f"got {sorted(got)}")
        check("NOT_DUE_recently_swept", "swept-10min-ago" not in got,
              "a bank swept 10 minutes ago is due again — the interval is not rate-limiting")
        check("DUE_after_a_FAILED_sweep", "failed-3h-ago" in got,
              "a bank whose last sweep FAILED is never retried — a terminal failure would "
              "wedge it for ever, which is the defect in a different costume")
        check("NOT_DUE_while_pending", "pending-since-10d" not in got,
              "a bank with a PENDING sweep is resubmitted — duplicate operations pile up")
        check("NOT_DUE_while_processing", "processing-since-10d" not in got,
              "a bank with a sweep IN FLIGHT is resubmitted; dedupe_by_bank only dedupes "
              "against pending, so nothing else would stop this")
        check("NOT_DUE_when_in_flight_outranks_an_old_attempt",
              "swept-3h-ago-and-pending" not in got, f"got {sorted(got)}")
        check("DUE_ignores_other_operation_types", "only-consolidation" in got,
              "a consolidation an hour ago suppressed the graph sweep — the operation_type "
              "filter is not holding, so an active bank is starved by its own traffic")

        # Oldest first: a bank that has NEVER been swept must not queue behind one
        # that was swept an hour ago, or the per-tick cap starves it indefinitely.
        ordered = await due(conn)
        check("ORDER_never_swept_first", ordered and ordered[0] == "never-swept",
              f"order was {ordered}")

        # The per-tick cap is enforced by the SERVER, not by the caller.
        check("LIMIT_bounds_the_result", len(await due(conn, limit=2)) == 2,
              f"limit 2 returned {len(await due(conn, limit=2))} rows")
        check("LIMIT_1_bounds_the_result", len(await due(conn, limit=1)) == 1)

        # ── THE RECORDED FAILED ATTEMPT, EXECUTED ───────────────────────────
        # A bank whose submit raises records nothing upstream, so it stays NULL
        # and — NULLS FIRST — pins the head of the queue for ever, starving every
        # other bank behind the per-tick cap. The statement below is the one the
        # shipping failure path issued, run against the real column set.
        await add_bank(conn, WEDGED)
        check("DUE_wedged_bank_before_the_record", WEDGED in set(await due(conn)),
              "the fixture bank is not even due, so the check below proves nothing")
        if FAIL_SQL:
            await conn.execute(FAIL_SQL, *FAIL_PARAMS)
        row = await conn.fetchrow(
            "SELECT operation_type, status, error_message FROM async_operations "
            "WHERE bank_id = $1", WEDGED,
        )
        check(
            "RECORDS_a_failed_graph_maintenance_attempt",
            row is not None
            and row["operation_type"] == "graph_maintenance"
            and row["status"] == "failed"
            and "exploded" in (row["error_message"] or ""),
            f"the failure path's row is {dict(row) if row else None!r} — it must be a "
            "graph_maintenance attempt marked failed and carrying the error, or a wedged "
            "bank is invisible to the query an operator reaches for",
        )
        check(
            "NOT_DUE_after_the_failed_attempt_is_recorded",
            WEDGED not in set(await due(conn)),
            "the recorded attempt did not take the bank off the head of the queue — it "
            "would still consume a per-tick slot on every tick, for ever",
        )
        # …and the opposite direction: it is a DELAY of one interval, not a
        # banishment. A bank that can only ever fail must still be retried.
        await conn.execute(
            "UPDATE async_operations SET created_at = NOW() - make_interval(secs => $1) "
            "WHERE bank_id = $2", 3.0 * INTERVAL, WEDGED,
        )
        check(
            "DUE_again_an_interval_after_a_failed_attempt",
            WEDGED in set(await due(conn)),
            "a bank whose submit failed is never retried — recording the attempt turned "
            "the starvation around instead of fixing it",
        )
        await conn.execute("DELETE FROM async_operations WHERE bank_id = $1", WEDGED)
        await conn.execute("DELETE FROM banks WHERE bank_id = $1", WEDGED)

        # ── THE JITTER ──────────────────────────────────────────────────────
        # 64 banks, all with an identical last attempt. Every property below is
        # a count of what the server selected.
        await conn.execute("DELETE FROM async_operations")
        await conn.execute("DELETE FROM banks")
        N = 64

        async def seed_at(age):
            await conn.execute("DELETE FROM async_operations")
            await conn.execute("DELETE FROM banks")
            for i in range(N):
                await add_bank(conn, f"jbank-{i:03d}", [(GM, "completed", age)])

        # r = age / interval. The jitter stretches the effective interval into
        # [1.0, 1.25) x interval, so r below 1.0 is never due and r at or above
        # 1.25 always is.
        async def due_at_ratio(r, interval=INTERVAL):
            await seed_at(r * interval)
            return set(await due(conn, interval=interval))

        # The next two are BOUNDS, and are named as bounds on purpose: a jitter
        # term multiplied by zero satisfies both, so neither is evidence that the
        # jitter EXISTS. Its existence is what the four variance checks below
        # prove (they are the ones that go red when the term is neutered).
        below = await due_at_ratio(0.95)
        check("JITTER_never_shortens_the_interval", below == set(),
              f"{len(below)} of {N} banks were due at 0.95x the interval — the jitter must "
              "only ever ADD delay, never shorten the interval")

        above = await due_at_ratio(1.30)
        check("JITTER_never_delays_past_125pct", len(above) == N,
              f"only {len(above)} of {N} banks were due at 1.30x the interval — the jitter "
              "is unbounded, so some bank's sweep is delayed arbitrarily")

        mid = await due_at_ratio(1.10)
        check("JITTER_VARIES_BY_BANK", 0 < len(mid) < N,
              f"{len(mid)} of {N} banks due at 1.10x — the offset is the same for every "
              "bank, so all 12 banks re-synchronise after a restart and hit the database "
              "in one wave")

        # A gradual staircase over [1.0, 1.25) is what "spread" means
        # operationally: banks come due a few at a time, not all in one clump.
        # NOT asserted monotone — deliberately. The jitter is a function of the
        # last-attempt timestamp as well as the bank, and each sample below
        # reseeds at a different age, so a bank can be due at 1.10x and not at
        # 1.12x. That is the per-cycle variation JITTER_VARIES_BY_CYCLE asserts,
        # and a monotone expectation here would forbid it.
        ratios = [1.0 + i / 100.0 for i in range(0, 30, 2)]
        counts = [len(await due_at_ratio(r)) for r in ratios]
        check("JITTER_IS_SPREAD", len(set(counts)) >= 8,
              f"the {len(ratios)} sampled ratios produced only {len(set(counts))} distinct "
              f"due counts ({counts}) — the offsets are clumped, not spread over the window")
        # The window is [1.05, 1.22], NOT the whole open interval, and the lower
        # bound is a sampling-noise margin rather than a claim about the jitter.
        # The offsets are uniform over a 25% window, so at 1.02x only ~8% of the
        # banks are expected to be due; measured over 40 seedings of N=64 that
        # came out min=2, max=8, which is close enough to zero that an honest
        # implementation would flake here. At 1.06x the expectation is ~24% of
        # N and P(none) is ~1e-8. The low end of the window is not left
        # unasserted: JITTER_IS_SPREAD and JITTER_TRENDS_UP both read counts[:5].
        interior = [(r, c) for r, c in zip(ratios, counts) if 1.05 < r <= 1.22]
        check("JITTER_INTERIOR_IS_PARTIAL", all(0 < c < N for _, c in interior),
              f"some ratio strictly inside the jitter window released none or all {N} banks: "
              f"{[(round(r, 2), c) for r, c in interior]}")
        check("JITTER_TRENDS_UP", sum(counts[:5]) < sum(counts[-5:]),
              f"more banks come due EARLY in the window than late: {counts}")

        # PER-CYCLE variation, the property that keeps the submitter from being
        # exactly periodic. Same ratio, same banks, a last-attempt timestamp ten
        # hours apart: if the jitter depended on bank_id alone the two due sets
        # would be identical, each bank's period would be constant, and it would
        # alias against #4624's 'int(now) // 120 % slice_count' slice clock.
        a = await due_at_ratio(1.10, interval=INTERVAL)
        b = await due_at_ratio(1.10, interval=INTERVAL * 10)
        check("JITTER_VARIES_BY_CYCLE", a != b,
              f"the same banks at the same ratio but a last attempt 10x further back "
              f"produced the SAME due set ({len(a)} banks) — the phase is a function of "
              "bank_id only, so every bank's sweeps form an exact period")
        check("JITTER_BOTH_CYCLES_NONTRIVIAL", 0 < len(a) < N and 0 < len(b) < N,
              f"got {len(a)} and {len(b)} of {N}")

        print("SQL_PROBE_EXECUTED")
    finally:
        await conn.close()


asyncio.run(main())
for f in failures:
    print("FAILURE:", f)
sys.exit(1 if failures else 0)
`;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * CI marker. When set, this suite MUST really execute — an absent docker or
 * an absent upstream image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);
const pgOk = dockerOk && hasImage(PG_IMAGE);

type ProbeResult = { status: number; stdout: string };

/** Label-scoped teardown belt (never an unlabelled bulk removal), awaited and
 * bounded for the #4628 reason above. */
async function reapByRunLabel(label: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-aq", "--filter", `label=switchroom.test.run=${label}`],
      { timeoutMs: 60_000 },
    );
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length) {
      await execFileAsync("docker", ["rm", "-f", ...ids], {
        timeoutMs: 120_000,
      });
    }
  } catch {
    /* nothing to clean, or the daemon is gone — the labels bound the blast
       radius either way */
  }
}

/**
 * Run a docker command, folding stderr into the returned text.
 *
 * Load-bearing: when a patch block stops applying, ALL the diagnosis is on
 * stderr (the block's own assertion message names the drifted anchor).
 */
async function dockerText(args: string[], input?: string): Promise<string> {
  const res = await execFileAsync("docker", args, { input });
  return res.stdout;
}

function errText(e: unknown): string {
  const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
  return (
    (err.stdout ?? "").toString() +
    (err.stderr ? `\n--- stderr ---\n${err.stderr.toString()}` : "")
  );
}

/**
 * Apply every patch block, in Dockerfile order, into a running container.
 * Each block is self-verifying: it asserts every upstream anchor exists exactly
 * once and re-asserts the result, so a throw here means upstream drifted and
 * the patch must be re-authored.
 */
async function applyPatches(container: string): Promise<void> {
  for (const block of patchBlocks()) {
    await dockerText(["exec", "-i", container, "python3", "-"], block);
  }
}

/** Run the loop probe in a throwaway container, optionally patching first. */
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-gmtick-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8,
  )}`;
  try {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `switchroom.test=${TEST_PHASE}`,
      "--label",
      `switchroom.test.run=${RUN_ID}`,
      "--user",
      "root",
      "--network",
      "none",
      UPSTREAM_IMAGE,
      "sleep",
      "300",
    ]);

    if (patched) await applyPatches(name);

    const res = await dockerText(
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      PROBE,
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number };
    return { status: err.status ?? -1, stdout: errText(e) };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run the SQL arm: a throwaway Postgres, and the PATCHED hindsight container
 * joined to its network namespace so the statement runs against a real server
 * over loopback. Both containers are labelled and force-removed in `finally`.
 */
async function runSqlProbe(): Promise<ProbeResult> {
  const tag = RUN_ID.slice(0, 8);
  const pg = `sr-hs-gmtick-pg-${tag}`;
  const app = `sr-hs-gmtick-sql-${tag}`;
  const labels = [
    "--label",
    `switchroom.test=${TEST_PHASE}`,
    "--label",
    `switchroom.test.run=${RUN_ID}-sql`,
  ];
  try {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      pg,
      ...labels,
      // No published port: the app container joins this netns directly, so
      // the server is reachable ONLY from inside it.
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      "-e",
      `POSTGRES_DB=${PG_DB}`,
      PG_IMAGE,
    ]);

    // Readiness: pg_isready, not a fixed sleep.
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        await execFileAsync("docker", ["exec", pg, "pg_isready", "-U", PG_USER]);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!ready) {
      return {
        status: -1,
        stdout: `postgres never became ready:\n${await dockerLogs(pg)}`,
      };
    }

    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      app,
      ...labels,
      "--user",
      "root",
      "--network",
      `container:${pg}`,
      UPSTREAM_IMAGE,
      "sleep",
      "600",
    ]);

    await applyPatches(app);

    const out = await dockerText(
      [
        "exec",
        "-i",
        "-w",
        "/app/api",
        "-e",
        `PROBE_DSN=postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:5432/${PG_DB}`,
        app,
        "/app/api/.venv/bin/python",
        "-",
      ],
      SQL_PROBE,
    );
    return { status: 0, stdout: out };
  } catch (e) {
    const err = e as { status?: number };
    return { status: err.status ?? -1, stdout: errText(e) };
  } finally {
    for (const name of [app, pg]) {
      try {
        await execFileAsync("docker", ["rm", "-f", name]);
      } catch {
        /* already gone */
      }
    }
  }
}

async function dockerLogs(name: string): Promise<string> {
  try {
    return await dockerText(["logs", "--tail", "40", name]);
  } catch (e) {
    return errText(e);
  }
}

// ---------------------------------------------------------------------------
// Probe registry (#4636). The set of hindsight docker probes is derived from
// the FILENAME GLOB `tests/docker/hindsight-*.test.ts` minus the explicit
// allowlist below — never by scanning a file for the very string the guard then
// asserts.
// ---------------------------------------------------------------------------

/**
 * `hindsight-*.test.ts` files that legitimately need NO hindsight image and
 * therefore no `docker-e2e.yml` run step.
 */
const NOT_A_PROBE: readonly string[] = [
  // docker/hindsight-autoheal.sh — pure decision core, sourced lib-only.
  "hindsight-autoheal.test.ts",
  // docker/hindsight-entrypoint.sh — portable sh + node against a fake UDS.
  "hindsight-entrypoint.test.ts",
  // docker/hindsight-maintenance.sh — no-pg no-op path plus static SQL pins.
  "hindsight-maintenance.test.ts",
  // parse_pg_search_index_casts() regression over real catalog-output fixtures.
  "hindsight-pg-search-cast-parser.test.ts",
];

const DOCKER_E2E_WORKFLOW = ".github/workflows/docker-e2e.yml";

/**
 * Every workflow that invokes a `tests/docker` suite. The stale-run-step guard
 * ranges over all of them (#4651). `ci-tests-race-long.yml` invokes via `bunx`,
 * not `npx` — see `vitestTargets()` for why that matters.
 */
const GUARDED_WORKFLOWS: readonly string[] = [
  DOCKER_E2E_WORKFLOW,
  ".github/workflows/docker-images.yml",
  ".github/workflows/ci-tests-race-long.yml",
];

/** The paths-filter output that gates the job running the hindsight probes. */
const HINDSIGHT_FILTER = "hindsight";

/** The exact spelling every probe must use to opt into the hard-fail path. */
const PROBE_ENV_VAR = "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE";

/** Every file in `tests/docker`. */
function dockerTestDir(): string[] {
  return readdirSync(resolve(root, "tests/docker"));
}

/** Every `hindsight-*.test.ts` on disk, sorted. */
function hindsightTestFiles(): string[] {
  return dockerTestDir()
    .filter((f) => f.startsWith("hindsight-") && f.endsWith(".test.ts"))
    .sort();
}

/** The probe set: the glob minus the named allowlist. */
function probeSet(): string[] {
  return hindsightTestFiles().filter((f) => !NOT_A_PROBE.includes(f));
}

interface WorkflowStep {
  name?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
  run?: unknown;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
}

/** `jobs:` of a workflow, loud rather than vacuous when the shape changes. */
function workflowJobs(path: string): Record<string, WorkflowJob> {
  const wf = parse(readFileSync(resolve(root, path), "utf8")) as {
    jobs?: Record<string, WorkflowJob>;
  };
  const jobs = wf?.jobs ?? {};
  expect(
    Object.keys(jobs).length,
    `${path} parsed to zero jobs — the guard would pass ` +
      "vacuously; the workflow is malformed or its shape changed",
  ).toBeGreaterThan(0);
  return jobs;
}

/**
 * Each `run:` in a job, with shell-comment lines stripped, in declaration
 * order. A regex over raw workflow TEXT counts a commented-out step as live —
 * the exact edit a "disabled temporarily, it's flaky" commit makes — so this
 * parses with `yaml` and enumerates real `jobs.*.steps[].run` values (#4643).
 */
function liveRunSteps(job: WorkflowJob): string[] {
  const out: string[] = [];
  for (const step of job?.steps ?? []) {
    if (typeof step?.run !== "string") continue;
    out.push(
      step.run
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n"),
    );
  }
  return out;
}

/**
 * The `tests/docker/<file>` targets of every `vitest run` invocation in a run
 * step. RUNNER-AGNOSTIC on purpose: a matcher anchored on the `npx` literal
 * returns the EMPTY set for the `bunx` workflow, so every guard over it passes
 * vacuously (#4651).
 */
function vitestTargets(runText: string): string[] {
  const files: string[] = [];
  for (const inv of runText.matchAll(/vitest run ([^\n]*)/g)) {
    for (const m of inv[1].matchAll(
      /tests\/docker\/([A-Za-z0-9._-]+\.test\.ts)/g,
    )) {
      files.push(m[1]);
    }
  }
  return files;
}

function workflowRunSteps(path: string = DOCKER_E2E_WORKFLOW): string[] {
  const files = new Set<string>();
  for (const job of Object.values(workflowJobs(path))) {
    for (const run of liveRunSteps(job)) {
      for (const f of vitestTargets(run)) files.add(f);
    }
  }
  expect(
    files.size,
    `${path} yielded no \`vitest run tests/docker/...\` steps — the matcher ` +
      "no longer sees this workflow's invocations, so every guard over it " +
      "passes vacuously",
  ).toBeGreaterThan(0);
  return [...files].sort();
}

/** The single docker-e2e.yml job that runs THIS probe. */
function hindsightProbeJob(): { name: string; job: WorkflowJob } {
  const target = `${TEST_PHASE}.test.ts`;
  const hits = Object.entries(workflowJobs(DOCKER_E2E_WORKFLOW)).filter(
    ([, job]) =>
      liveRunSteps(job).some((run) => vitestTargets(run).includes(target)),
  );
  expect(
    hits.map(([name]) => name),
    `exactly one ${DOCKER_E2E_WORKFLOW} job must run \`vitest run ` +
      `tests/docker/${target}\` — none means the probe does not run in CI at ` +
      "all; several means the guards below are scoped to an arbitrary one",
  ).toHaveLength(1);
  return { name: hits[0][0], job: hits[0][1] };
}

/** The glob list of one `dorny/paths-filter` output. */
function pathsFilterGlobs(filter: string): string[] {
  const specs: string[] = [];
  for (const job of Object.values(workflowJobs(DOCKER_E2E_WORKFLOW))) {
    for (const step of job?.steps ?? []) {
      if (
        typeof step?.uses !== "string" ||
        !step.uses.includes("dorny/paths-filter")
      ) {
        continue;
      }
      const spec = step.with?.filters;
      if (typeof spec === "string") specs.push(spec);
    }
  }
  expect(
    specs.length,
    `${DOCKER_E2E_WORKFLOW} has no \`dorny/paths-filter\` step with a ` +
      "`filters:` spec — the filter guard below cannot see its subject",
  ).toBeGreaterThan(0);

  const globs: string[] = [];
  for (const spec of specs) {
    const parsed = parse(spec) as Record<string, unknown> | null;
    const list = parsed?.[filter];
    if (Array.isArray(list)) {
      for (const g of list) if (typeof g === "string") globs.push(g);
    }
  }
  expect(
    globs.length,
    `the \`${filter}:\` paths filter in ${DOCKER_E2E_WORKFLOW} is missing or ` +
      "empty — a guard over an empty list asserts nothing",
  ).toBeGreaterThan(0);
  return globs;
}

describe("Dockerfile.hindsight interval-sweep probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts the subject block and its prerequisites, in Dockerfile order", () => {
    const blocks = patchBlocks();
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain(PREREQUISITE_PATCH_NAMES[0]);
    expect(blocks[1]).toContain(PREREQUISITE_PATCH_NAMES[1]);
    expect(blocks[2]).toContain(PATCH_NAME);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`,
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable",
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite",
    ).toBe(true);
    expect(
      pgOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${PG_IMAGE} is not present locally — ` +
        "the SQL arm is the only executable proof that the due-ness predicate " +
        "skips a bank with a sweep already in flight, so CI must pull this digest too",
    ).toBe(true);
  });

  it("pins the SQL arm's Postgres by digest as well", () => {
    expect(PG_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("the probe set is exactly the set of probes docker-e2e.yml runs", () => {
    const onDisk = hindsightTestFiles();
    expect(onDisk.length).toBeGreaterThan(5);
    expect(onDisk).toContain(TEST_PHASE + ".test.ts");

    expect(
      NOT_A_PROBE.filter((f) => !onDisk.includes(f)),
      "these NOT_A_PROBE entries name files that no longer exist in " +
        `tests/docker, so they excuse nothing from a ${DOCKER_E2E_WORKFLOW} ` +
        "run step — the allowlist outlived a rename or deletion and must be " +
        "edited deliberately",
    ).toEqual([]);

    expect(
      NOT_A_PROBE.filter((f) =>
        readFileSync(resolve(root, "tests/docker", f), "utf8").includes(
          PROBE_ENV_VAR,
        ),
      ),
      `these NOT_A_PROBE entries DO read ${PROBE_ENV_VAR} — they are real ` +
        "probes being excused from their run step, which retires them from CI " +
        "with every other guard here still green; remove the allowlist entry " +
        `and add a ${DOCKER_E2E_WORKFLOW} run step`,
    ).toEqual([]);

    const expected = probeSet();
    const ran = workflowRunSteps().filter((f) => f.startsWith("hindsight-"));

    expect(
      expected.filter((f) => !ran.includes(f)),
      `these hindsight probes exist on disk but no ${DOCKER_E2E_WORKFLOW} step ` +
        `runs them, so ${PROBE_ENV_VAR} is never set and their hard-fail ` +
        "discipline is inert — add the run step, or add the file to " +
        "NOT_A_PROBE with a reason",
    ).toEqual([]);

    expect(
      ran.filter((f) => !expected.includes(f)),
      `these ${DOCKER_E2E_WORKFLOW} steps run hindsight probe files that are ` +
        "not in the probe set — the step outlived a deleted or renamed probe, " +
        "or names a file the NOT_A_PROBE allowlist says needs no run step",
    ).toEqual([]);

    expect(ran).toEqual(expected);
  });

  it("every probe spells the require-env-var exactly", () => {
    const silent = probeSet().filter(
      (f) =>
        !readFileSync(resolve(root, "tests/docker", f), "utf8").includes(
          PROBE_ENV_VAR,
        ),
    );
    expect(
      silent,
      `these hindsight probes never read ${PROBE_ENV_VAR}, so CI sets it for ` +
        "them and they skip anyway — a mis-spelling here green-skips for ever " +
        "on every runner without the image",
    ).toEqual([]);
  });

  it("every guarded workflow's run steps point at test files that still exist", () => {
    const dir = dockerTestDir();
    for (const wf of GUARDED_WORKFLOWS) {
      const stale = workflowRunSteps(wf).filter((f) => !dir.includes(f));
      expect(
        stale,
        `${wf} runs ${stale.join(", ")} — tests/docker files that do not ` +
          "exist; the step outlived a deletion or rename",
      ).toEqual([]);
    }
  });

  it("the `hindsight:` paths filter and the probe job's run steps agree", () => {
    const prefix = "tests/docker/";
    const filtered = [
      ...new Set(
        pathsFilterGlobs(HINDSIGHT_FILTER)
          .filter((g) => g.startsWith(prefix) && g.endsWith(".test.ts"))
          .map((g) => g.slice(prefix.length)),
      ),
    ].sort();
    const { name, job } = hindsightProbeJob();
    const ran = [...new Set(liveRunSteps(job).flatMap(vitestTargets))].sort();
    expect(
      ran.length,
      `the ${name} job runs no tests/docker suites`,
    ).toBeGreaterThan(0);

    const unfiltered = ran.filter((f) => !filtered.includes(f));
    expect(
      unfiltered,
      `the ${name} job runs ${unfiltered.join(", ")} but the ` +
        `\`${HINDSIGHT_FILTER}:\` paths filter does not list them — editing ` +
        "one of them does not trigger the job, so it goes unproven until the " +
        `merge queue; add '${prefix}<file>' to the filter`,
    ).toEqual([]);

    const unrun = filtered.filter((f) => !ran.includes(f));
    expect(
      unrun,
      `the \`${HINDSIGHT_FILTER}:\` paths filter lists ${unrun.join(", ")} ` +
        `but the ${name} job does not run them — the filter entry outlived a ` +
        "rename, a deletion, or a run step that was never added",
    ).toEqual([]);

    expect(ran).toEqual(filtered);
  });

  it("this probe's containers are reaped by the label-scoped teardown", () => {
    const { name, job } = hindsightProbeJob();
    const teardowns = (job.steps ?? [])
      .filter(
        (s) =>
          typeof s?.name === "string" &&
          s.name.includes("Label-scoped teardown"),
      )
      .map((s) =>
        typeof s.run === "string"
          ? s.run
              .split("\n")
              .filter((line) => !line.trim().startsWith("#"))
              .join("\n")
          : "",
      );
    expect(
      teardowns.length,
      `the ${name} job has no \`Label-scoped teardown\` step`,
    ).toBeGreaterThan(0);

    const phases = teardowns.flatMap((run) =>
      (run.split("for phase in ")[1]?.split("; do")[0] ?? "")
        .split(/\s+/)
        .filter(Boolean),
    );
    expect(
      phases.length,
      `the ${name} job's teardown has no \`for phase in ...\` phase list`,
    ).toBeGreaterThan(0);
    // Both arms label with TEST_PHASE, including the SQL arm's pg sidecar, so
    // one entry reaps everything this file starts.
    expect(
      phases,
      `${TEST_PHASE} is missing from the teardown phase list, so a crashed run ` +
        "leaves its containers (and the SQL arm's Postgres) on the runner",
    ).toContain(TEST_PHASE);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight interval-sweep patch changes real behaviour",
  () => {
    afterAll(async () => {
      await reapByRunLabel(RUN_ID);
    });

    it("unpatched upstream is RED — a quiet bank is never swept again", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // THE defect, stated as the outcome: a bank whose graph_maintenance_queue
      // is empty and which has no recent sweep gets NOTHING scheduled, for ever.
      expect(stdout).toContain("GS_quiet_bank_gets_a_sweep=FAIL");
      expect(stdout).toContain("GS_operation_is_graph_maintenance=FAIL");
      expect(stdout).toContain("GS_sweep_is_forced_not_faked=FAIL");

      // There is no scheduler at all: no discovery statement is issued, so
      // nothing is rate-limited, deduped, or spread across tenant schemas.
      expect(stdout).toContain("GS_discovery_binds_interval_and_cap=FAIL");
      expect(stdout).toContain("GS_per_tick_cap_bounds_the_wave=FAIL");
      expect(stdout).toContain("GS_dedupes_by_bank=FAIL");
      expect(stdout).toContain("GS_sweeps_every_polled_schema=FAIL");
      expect(stdout).toContain("GS_carries_the_tenant_id=FAIL");
      expect(stdout).toContain("GS_one_bad_bank_does_not_stop_the_rest=FAIL");
      expect(stdout).toContain("GS_one_submit_per_tick_window=FAIL");

      // Nothing records an attempt, so nothing stops a bank whose submit raises
      // from sitting at the head of the NULLS-FIRST queue for ever.
      expect(stdout).toContain("GS_failing_banks_do_not_starve_the_fleet=FAIL");
      expect(stdout).toContain("GS_failed_submit_records_an_attempt=FAIL");
      expect(stdout).toContain("GS_failed_attempt_is_recorded_as_failed=FAIL");

      // …and the maintenance loop does not consider a graph sweep a reason to
      // run, so on a deployment with every other job disabled it does not even
      // start.
      expect(stdout).toContain("GS_enables_the_maintenance_loop=FAIL");

      // The config surface does not exist: HindsightConfig has no interval
      // field to read, so nothing can be tuned or turned off.
      expect(stdout).toContain("GS_env_roundtrip_runs=FAIL");
      expect(stdout).toContain("GS_interval_is_env_configurable=FAIL");
      expect(stdout).toContain("GS_defaults_are_on=FAIL");
    }, 240_000);

    it("patched is GREEN — a quiet bank gets a forced, deduped, rate-limited sweep", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(stdout, `probe reported failures:\n${stdout}`).not.toContain(
        "FAILURE:",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).not.toContain("=FAIL");

      // THE fix, as the outcome the brief demands: one maintenance tick, a bank
      // with an EMPTY graph_maintenance_queue and no recent sweep, and an
      // async_operations row is created for it.
      expect(stdout).toContain("GS_quiet_bank_gets_a_sweep=OK");
      expect(stdout).toContain("GS_operation_is_graph_maintenance=OK");
      // …by `force_sweep=True` through the REAL submit method, not by inserting
      // fake `graph_maintenance_queue` rows: the probe's queue counter is never
      // even consulted, and an operation still appears.
      expect(stdout).toContain("GS_sweep_is_forced_not_faked=OK");

      // Idempotency, arm 1 (arm 2 is the SQL predicate below): the submit is
      // deduped by bank, so the ~60s tick in every api/worker process — there
      // is no leader election — cannot pile up duplicate operations.
      expect(stdout).toContain("GS_dedupes_by_bank=OK");

      // No stampede. The discovery statement binds the configured interval and
      // the per-tick cap as PARAMETERS, and the cap really bounds how many
      // banks one tick submits — 12 banks, some with 4.7M semantic links.
      expect(stdout).toContain("GS_discovery_binds_interval_and_cap=OK");
      expect(stdout).toContain("GS_per_tick_cap_bounds_the_wave=OK");
      // …and the sweep runs at its OWN cadence, not on every 60s loop tick.
      expect(stdout).toContain("GS_one_submit_per_tick_window=OK");

      // Multi-tenant deployments: every polled schema is swept, and the tenant
      // id travels with the request context (a sweep attributed to the wrong
      // tenant is worse than no sweep).
      expect(stdout).toContain("GS_sweeps_every_polled_schema=OK");
      expect(stdout).toContain("GS_carries_the_tenant_id=OK");
      // One exploding bank must not silently cancel the rest of the wave.
      expect(stdout).toContain("GS_one_bad_bank_does_not_stop_the_rest=OK");

      // …nor STARVE it. Upstream writes the async_operations row only after
      // `_authenticate_tenant` and `_validate_operation`, so a submit that
      // raises in either records no attempt, keeps a NULL `created_at`, and —
      // the discovery orders NULLS FIRST — occupies the head of the queue for
      // ever. Two such banks consume the whole per-tick cap on every tick and
      // every other bank silently stops being swept, which is this job's own
      // defect reinstated. The sweep therefore records the failed ATTEMPT
      // itself, in async_operations, where it is durable, shared by every
      // process, and read by the same due-ness clock.
      expect(stdout).toContain("GS_failing_banks_do_not_starve_the_fleet=OK");
      expect(stdout).toContain("GS_failed_submit_records_an_attempt=OK");
      expect(stdout).toContain("GS_failed_attempt_is_recorded_as_failed=OK");
      // …and the record is a DELAY of one interval, never a banishment.
      expect(stdout).toContain("GS_failing_bank_is_retried_not_banished=OK");

      // The loop must consider this job a reason to run, or a deployment with
      // retention and mental-model refresh disabled never starts the loop and
      // the sweep never fires.
      expect(stdout).toContain("GS_enables_the_maintenance_loop=OK");
      expect(stdout).toContain("GS_does_not_enable_the_loop_when_off=OK");

      // Configurable per the HINDSIGHT_API_* convention, with an off switch —
      // interval 0 restores exactly the upstream behaviour, which is the escape
      // hatch if this ever misbehaves in production.
      expect(stdout).toContain("GS_interval_is_env_configurable=OK");
      expect(stdout).toContain("GS_interval_zero_restores_upstream=OK");
      // On by default, at the literal values (hard-coded here, not read from
      // the config fields they check).
      expect(stdout).toContain("GS_defaults_are_on=OK");
    }, 240_000);
  },
);

describe.skipIf(!dockerOk || !imageOk || !pgOk)(
  "the due-ness predicate really selects quiet banks (executed SQL, real Postgres)",
  () => {
    afterAll(async () => {
      await reapByRunLabel(`${RUN_ID}-sql`);
    });

    it("executes the shipping discovery statement against real rows", async () => {
      const { status, stdout } = await runSqlProbe();
      expect(
        stdout,
        `SQL probe did not run to completion:\n${stdout}`,
      ).toContain("SQL_PROBE_EXECUTED");
      expect(stdout, `SQL probe reported failures:\n${stdout}`).not.toContain(
        "FAILURE:",
      );
      expect(status, `SQL probe failed:\n${stdout}`).toBe(0);

      // The statement under test came from the shipping method, not a copy.
      expect(stdout).toContain("SQL_captured_from_shipping_code=OK");

      // THE defect's shape, in SQL: klanker — no attempt for five days, empty
      // queue — is selected; a bank swept minutes ago is not.
      expect(stdout).toContain("DUE_never_swept_bank=OK");
      expect(stdout).toContain("DUE_bank_quiet_longer_than_the_interval=OK");
      expect(stdout).toContain("NOT_DUE_recently_swept=OK");
      // A FAILED attempt is still an attempt: klanker's 9 consecutive failures
      // must not make it due every 60s and retry-storm the thing #4604 fixed.
      expect(stdout).toContain("DUE_after_a_FAILED_sweep=OK");

      // IDEMPOTENCY, checked by Postgres against real rows. `status IN
      // ('pending')` alone greps clean and re-submits a bank on every tick
      // while its sweep is running.
      expect(stdout).toContain("NOT_DUE_while_pending=OK");
      expect(stdout).toContain("NOT_DUE_while_processing=OK");
      expect(stdout).toContain(
        "NOT_DUE_when_in_flight_outranks_an_old_attempt=OK",
      );
      // Another operation type on the bank is not a graph-maintenance sweep.
      expect(stdout).toContain("DUE_ignores_other_operation_types=OK");

      // Fairness and the rate limit, as executed: never-swept first, and the
      // server-side LIMIT really bounds the returned wave.
      expect(stdout).toContain("ORDER_never_swept_first=OK");
      expect(stdout).toContain("LIMIT_bounds_the_result=OK");
      expect(stdout).toContain("LIMIT_1_bounds_the_result=OK");

      // NULLS FIRST is only safe because a bank whose submit RAISES stops being
      // NULL: the statement the shipping failure path issues is executed here
      // against the real column set, and it must both take the bank off the head
      // of the queue and let it come back an interval later.
      expect(stdout).toContain("SQL_failed_attempt_captured_from_shipping_code=OK");
      expect(stdout).toContain("DUE_wedged_bank_before_the_record=OK");
      expect(stdout).toContain("RECORDS_a_failed_graph_maintenance_attempt=OK");
      expect(stdout).toContain("NOT_DUE_after_the_failed_attempt_is_recorded=OK");
      expect(stdout).toContain("DUE_again_an_interval_after_a_failed_attempt=OK");

      // The jitter is not decoration. An exactly-periodic submitter aliases
      // against #4624's `int(now) // 120 % slice_count` slice clock — 3600s is
      // 30 windows, gcd(30, 21) = 3, so a 21-slice bank would only ever see 7
      // of its slices. These are counts Postgres computed, so a jitter term
      // multiplied by zero fails them.
      expect(stdout).toContain("JITTER_never_shortens_the_interval=OK");
      expect(stdout).toContain("JITTER_never_delays_past_125pct=OK");
      expect(stdout).toContain("JITTER_VARIES_BY_BANK=OK");
      expect(stdout).toContain("JITTER_IS_SPREAD=OK");
      expect(stdout).toContain("JITTER_INTERIOR_IS_PARTIAL=OK");
      expect(stdout).toContain("JITTER_TRENDS_UP=OK");
      // …and it re-seeds each cycle, so two banks that collide once do not
      // collide for ever.
      expect(stdout).toContain("JITTER_VARIES_BY_CYCLE=OK");
      expect(stdout).toContain("JITTER_BOTH_CYCLES_NONTRIVIAL=OK");
    }, 600_000);
  },
);
