/**
 * Behavioural proof for the three recall-isolation patches
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of those patch blocks
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED on every defect) and
 * against upstream + the patch blocks applied (must be GREEN).
 *
 * The three defects, all measured on this host before the fix:
 *
 *  1. Background consolidation and the latency-critical per-turn recall hook
 *     contend on ONE admission semaphore. The consolidator calls the very same
 *     `MemoryEngine.recall_async` a user's turn does, which acquires
 *     `self._search_semaphore` sized by HINDSIGHT_API_RECALL_MAX_CONCURRENT
 *     (8 in this fleet). Measured admission wait: mean 5.43s, p90 15.7s, max
 *     27.4s, against a recall hook whose per-bank socket timeout is 8s — fleet
 *     p50 pinned at exactly 8.02s, with per-agent timeout rates of 97.5%,
 *     95.8% and 73.9%.
 *  2. There is no per-operation-type worker slot CEILING. The
 *     HINDSIGHT_API_WORKER_<TYPE>_RESERVED_SLOTS knobs are reservations, i.e. a
 *     FLOOR: `WorkerPoller._get_available_slots` documents that "when an
 *     operation type's in-flight count exceeds its reservation, the excess
 *     tasks are considered to be using shared pool slots". So consolidation
 *     could take every one of DEFAULT_WORKER_MAX_SLOTS = 10 slots, and the
 *     `consolidation=6/1(avail=0)` seen in the worker log was documented
 *     behaviour rather than the overrun it looked like.
 *  3. The recall completion line only emitted `sem=` when the wait exceeded
 *     0.01s, so the recalls that did NOT queue left no datum. That is how the
 *     contention above was first mis-measured: averaging only the lines that
 *     appeared biased the mean upwards and hid that just 45% of recalls wait
 *     at all.
 *
 * Beyond proving the three fixes, the probe pins the properties that make them
 * SAFE, none of which is visible from the patch text:
 *
 *  - The admission split does not RAISE database concurrency. Background takes
 *    a small reservation semaphore and then the SAME shared one, so the peak is
 *    still exactly recall_max_concurrent — it is a reservation, not a second
 *    budget.
 *  - It cannot deadlock: foreground never acquires the background semaphore, so
 *    the acquisition order is total. Driven here rather than argued.
 *  - A ceiling on one operation type never throttles another, and with no
 *    ceilings configured `claim_tasks` returns byte-for-byte what upstream did.
 *  - An over-ceiling row is dropped BEFORE the `UPDATE ... SET
 *    status='processing'`, so it is left pending rather than half-claimed.
 *  - The `conn=` wait threshold is untouched: fix 3 is scoped to `sem=`.
 *
 * Both slot mechanisms are driven through the REAL shipping code — the real
 * `PostgreSQLOps.claim_tasks` against a fake connection, and the real
 * `WorkerPoller._get_available_slots` — rather than a reimplementation, and the
 * config validations are driven through the real `HindsightConfig.from_env()`.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies them by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-search-patches.test.ts`. Locally,
 * with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { execFileAsync } from "./_exec-async.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8"
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-recall-isolation-patches";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch names this file proves, in the order they must be applied. */
const PATCH_NAMES = [
  "recall-admission-split patch",
  "worker-slot-ceiling patch",
  "sem-wait-always-logged patch",
];

/**
 * The three patch blocks under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by their unique patch names.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  return PATCH_NAMES.map((name) => {
    const b = blocks.find((x) => x.includes(name));
    if (!b) {
      throw new Error(
        `Dockerfile.hindsight no longer contains the "${name}" RUN block — ` +
          `if it was deliberately removed, delete this test with it.`
      );
    }
    return b;
  });
}

/**
 * Python probe. Exits 0 only when all three fixes are in effect AND every
 * safety property above holds; prints the offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES rather than merely calling the code: it starves
 * a real asyncio admission gate and times a foreground acquire, drives the real
 * `claim_tasks` and counts what it marks processing, and executes the real
 * wait-line assembly lifted out of the shipping source. The only string-shaped
 * assertions are AST checks on the two call sites a live database would be
 * needed to reach.
 */
const PROBE = String.raw`
import ast
import asyncio
import inspect
import os
import re
import sys
import textwrap
import uuid

failures = []


def fail(msg):
    failures.append(msg)


# =====================================================================
# fix 1 - recall admission split (foreground must not be starvable)
# =====================================================================
import hindsight_api.config as hs_config
import hindsight_api.engine.memory_engine as me
from hindsight_api.engine.memory_engine import MemoryEngine

_admission = getattr(me, "_recall_admission", None)
print("HAS_ADMISSION_HELPER", _admission is not None)


def admit(shared, background_reservation, is_background):
    """Admission exactly as the SHIPPING module defines it.

    Upstream has no split, so every caller takes the one shared semaphore -
    that IS the defect. Running the identical scenario through whatever the
    module actually provides is what makes this probe RED on upstream and
    GREEN once patched.
    """
    if _admission is None:
        return shared
    return _admission(shared, background_reservation, is_background)


SHARED = 8  # HINDSIGHT_API_RECALL_MAX_CONCURRENT in this deployment
BG = 2  # DEFAULT_CONSOLIDATION_RECALL_MAX_CONCURRENT


async def starvation_scenario(n_background):
    """Saturate admission with background recalls, then time a foreground one."""
    shared = asyncio.Semaphore(SHARED)
    background = asyncio.Semaphore(BG)
    release = asyncio.Event()
    live_background = 0
    peak_background = 0
    lock = asyncio.Lock()

    async def bg_recall():
        nonlocal live_background, peak_background
        async with admit(shared, background, True):
            async with lock:
                live_background += 1
                peak_background = max(peak_background, live_background)
            await release.wait()
            async with lock:
                live_background -= 1

    tasks = [asyncio.create_task(bg_recall()) for _ in range(n_background)]
    await asyncio.sleep(0.1)  # let everything that CAN be admitted be admitted

    loop = asyncio.get_running_loop()
    t0 = loop.time()
    admitted = True
    try:
        async with asyncio.timeout(0.5):
            async with admit(shared, background, False):
                pass
    except TimeoutError:
        admitted = False
    waited = loop.time() - t0

    release.set()
    await asyncio.gather(*tasks)
    return admitted, waited, peak_background


fg_ok, fg_wait, bg_in = asyncio.run(starvation_scenario(SHARED))
print(f"STARVATION background={bg_in} foreground_admitted={fg_ok} wait={fg_wait:.3f}s")
if not fg_ok:
    fail(
        f"foreground recall was STARVED: {bg_in} concurrent background (consolidation) "
        f"recalls held every one of the {SHARED} admission slots"
    )
if _admission is not None and bg_in > BG:
    fail(f"background held {bg_in} admission slots, above its reservation of {BG}")

# The floor must be a guarantee, not luck: with far more background pressure
# than there are slots, foreground must still be admitted immediately.
fg_ok2, fg_wait2, bg_in2 = asyncio.run(starvation_scenario(SHARED * 4))
print(f"STARVATION_HEAVY background={bg_in2} foreground_admitted={fg_ok2} wait={fg_wait2:.3f}s")
if not fg_ok2:
    fail("foreground recall was STARVED under heavy background load")
if _admission is not None:
    if bg_in2 != BG:
        fail(f"{bg_in2} background recalls were admitted at once, expected exactly {BG}")
    if fg_wait2 > 0.25:
        fail(f"foreground recall queued {fg_wait2:.3f}s behind background work")


async def total_concurrency_scenario():
    """The split must not RAISE total DB concurrency above recall_max_concurrent."""
    shared = asyncio.Semaphore(SHARED)
    background = asyncio.Semaphore(BG)
    release = asyncio.Event()
    live = 0
    peak = 0
    lock = asyncio.Lock()

    async def one(is_bg):
        nonlocal live, peak
        async with admit(shared, background, is_bg):
            async with lock:
                live += 1
                peak = max(peak, live)
            await release.wait()
            async with lock:
                live -= 1

    tasks = [asyncio.create_task(one(i % 2 == 0)) for i in range(SHARED * 5)]
    await asyncio.sleep(0.1)
    observed = peak
    release.set()
    await asyncio.gather(*tasks)
    return observed


peak = asyncio.run(total_concurrency_scenario())
print("TOTAL_CONCURRENCY_PEAK", peak)
if peak > SHARED:
    fail(f"admission let {peak} recalls run concurrently, above recall_max_concurrent={SHARED}")
if peak < SHARED:
    fail(f"admission only reached {peak} concurrent recalls, below recall_max_concurrent={SHARED}")


async def no_deadlock_scenario():
    """Driven, not argued: a blocked background caller must not wedge anyone."""
    shared = asyncio.Semaphore(1)
    background = asyncio.Semaphore(1)
    held = asyncio.Event()
    release = asyncio.Event()

    async def holder():
        async with admit(shared, background, False):
            held.set()
            await release.wait()

    async def blocked_bg():
        async with admit(shared, background, True):
            pass

    h = asyncio.create_task(holder())
    await held.wait()
    b = asyncio.create_task(blocked_bg())
    await asyncio.sleep(0.05)
    release.set()
    try:
        async with asyncio.timeout(1.0):
            await asyncio.gather(h, b)
        return True
    except TimeoutError:
        h.cancel()
        b.cancel()
        return False


no_deadlock = asyncio.run(no_deadlock_scenario())
print("NO_DEADLOCK", no_deadlock)
if not no_deadlock:
    fail("nested background admission deadlocked")

# ---- the wiring the scenario above cannot reach without a live database ----
# Structural (AST), not a string grep: these pin that the REAL recall entry
# point and the REAL consolidation caller are what the split governs.
params = inspect.signature(MemoryEngine.recall_async).parameters
print("RECALL_HAS_BACKGROUND_PARAM", "_background" in params)
if "_background" not in params:
    fail("recall_async has no _background parameter - the admission split is not wired in")
elif params["_background"].default is not False:
    fail("recall_async _background must default to False so foreground stays the default")

recall_src = textwrap.dedent(inspect.getsource(MemoryEngine.recall_async))
tree = ast.parse(recall_src)
admission_calls = [
    item
    for n in ast.walk(tree)
    if isinstance(n, ast.AsyncWith)
    for item in n.items
    if isinstance(item.context_expr, ast.Call)
    and isinstance(item.context_expr.func, ast.Name)
    and item.context_expr.func.id == "_recall_admission"
]
bare_shared = [
    item
    for n in ast.walk(tree)
    if isinstance(n, ast.AsyncWith)
    for item in n.items
    if isinstance(item.context_expr, ast.Attribute) and item.context_expr.attr == "_search_semaphore"
]
print("RECALL_ADMISSION_WIRED", len(admission_calls), "BARE_SHARED_ACQUIRES", len(bare_shared))
if len(admission_calls) != 1:
    fail("recall_async does not admit through _recall_admission exactly once")
if bare_shared:
    fail(
        "recall_async still acquires _search_semaphore directly - background recalls "
        "would bypass the reservation"
    )


def _arg_repr(node):
    """A stable, readable description of one call argument."""
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return node.value.id + "." + node.attr
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant):
        return "<literal %r>" % (node.value,)
    return "<" + type(node).__name__ + ">"


# The ARGUMENTS, not just the presence of the call. Asserting only that
# _recall_admission is called leaves the whole split revertible by a one-token
# edit: _recall_admission(shared, background, False) keeps the helper defined,
# keeps the call site, keeps _search_semaphore as an argument, and admits every
# background recall as foreground again. The third argument MUST be the caller's
# _background parameter, and the first two must be the two real semaphores.
ADMISSION_ARGS_EXPECTED = [
    "self._search_semaphore",
    "self._background_search_semaphore",
    "_background",
]
if admission_calls:
    _call = admission_calls[0].context_expr
    admission_args = [_arg_repr(a) for a in _call.args] + [
        (kw.arg or "**") + "=" + _arg_repr(kw.value) for kw in _call.keywords
    ]
else:
    admission_args = []
print("ADMISSION_ARGS", admission_args)
if admission_args != ADMISSION_ARGS_EXPECTED:
    fail(
        "recall_async passes %r to _recall_admission, expected %r - the caller's "
        "_background flag must reach the admission helper, otherwise the split is "
        "hard-coded and background recalls take the foreground path"
        % (admission_args, ADMISSION_ARGS_EXPECTED)
    )

import hindsight_api.engine.consolidation.consolidator as consolidator

ctree = ast.parse(inspect.getsource(consolidator))
recall_calls = [
    n
    for n in ast.walk(ctree)
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "recall_async"
]
bg_flagged = [
    c
    for c in recall_calls
    if any(
        kw.arg == "_background" and isinstance(kw.value, ast.Constant) and kw.value.value is True
        for kw in c.keywords
    )
]
print("CONSOLIDATOR_RECALLS", len(recall_calls), "MARKED_BACKGROUND", len(bg_flagged))
if not recall_calls:
    fail("no recall_async call found in the consolidator - re-author this probe")
if len(bg_flagged) != len(recall_calls):
    fail(
        f"{len(recall_calls) - len(bg_flagged)} consolidator recall_async call(s) are still "
        "admitted as FOREGROUND and can starve the per-turn recall hook"
    )


def cfg_with(**env):
    """Build a config from env, returning (config, error)."""
    old = {k: os.environ.get(k) for k in env}
    os.environ.update({k: str(v) for k, v in env.items()})
    try:
        return hs_config.HindsightConfig.from_env(), None
    except ValueError as e:
        return None, str(e)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


fields = getattr(hs_config.HindsightConfig, "__dataclass_fields__", {})
has_bg_field = "consolidation_recall_max_concurrent" in fields
print("CONFIG_HAS_BG_FIELD", has_bg_field)
if not has_bg_field:
    fail("HindsightConfig has no consolidation_recall_max_concurrent field")
else:
    good, err = cfg_with(
        HINDSIGHT_API_RECALL_MAX_CONCURRENT=8, HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT=2
    )
    print("BG_CONFIG_OK", good is not None and good.consolidation_recall_max_concurrent == 2)
    if good is None:
        fail(f"a valid admission config was rejected: {err}")

    no_floor, _ = cfg_with(
        HINDSIGHT_API_RECALL_MAX_CONCURRENT=8, HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT=8
    )
    print("BG_CONFIG_REJECTS_NO_FLOOR", no_floor is None)
    if no_floor is not None:
        fail(
            "a background reservation equal to recall_max_concurrent was accepted - "
            "foreground would have no guaranteed floor"
        )

    zero, _ = cfg_with(HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT=0)
    print("BG_CONFIG_REJECTS_ZERO", zero is None)
    if zero is not None:
        fail("a zero background reservation was accepted - consolidation could never recall")

    # A DEFAULT must never turn a deployment that boots today into one that
    # refuses to boot: the reservation default is derived from the shared budget.
    tiny, err = cfg_with(HINDSIGHT_API_RECALL_MAX_CONCURRENT=2)
    one, err_one = cfg_with(HINDSIGHT_API_RECALL_MAX_CONCURRENT=1)
    print(
        "BG_DEFAULT_DERIVED",
        None if tiny is None else tiny.consolidation_recall_max_concurrent,
        None if one is None else one.consolidation_recall_max_concurrent,
    )
    if tiny is None or tiny.consolidation_recall_max_concurrent != 1:
        fail(f"recall_max_concurrent=2 did not derive a background reservation of 1: {err}")
    if one is None or one.consolidation_recall_max_concurrent != 1:
        fail(f"a single-slot deployment no longer boots: {err_one}")


# =====================================================================
# fix 2 - a real per-type worker slot CEILING
# =====================================================================
from hindsight_api.engine.db.ops_postgresql import PostgreSQLOps
from hindsight_api.worker.poller import WorkerPoller


class FakeConn:
    """Enough of asyncpg to drive the real claim_tasks end to end.

    Row order is insertion order, which stands in for 'ORDER BY created_at'.
    Placeholder indices are read out of the SQL rather than guessed positionally,
    so the '!= ALL(...)' filters are applied to the parameter the real query
    actually binds them to.
    """

    def __init__(self, pending):
        self.pending = list(pending)
        self.claimed = []
        self.fetches = []

    async def fetch(self, sql, *params):
        self.fetches.append(sql)
        if "SELECT DISTINCT bank_id" in sql:
            return []
        limit = int(params[-1]) if params else len(self.pending)
        rows = self.pending
        if "operation_type = $1" in sql:
            rows = [r for r in rows if r["operation_type"] == params[0]]
        elif "operation_type = 'consolidation'" in sql:
            rows = [r for r in rows if r["operation_type"] == "consolidation"]
        elif "operation_type != 'consolidation'" in sql:
            rows = [r for r in rows if r["operation_type"] != "consolidation"]

        m = re.search(r"operation_id != ALL\(\$(\d+)", sql)
        if m:
            excluded = {str(x) for x in params[int(m.group(1)) - 1]}
            rows = [r for r in rows if str(r["operation_id"]) not in excluded]

        m = re.search(r"operation_type != ALL\(\$(\d+)", sql)
        if m:
            excluded_types = set(params[int(m.group(1)) - 1])
            rows = [r for r in rows if r["operation_type"] not in excluded_types]

        return rows[:limit]

    async def execute(self, sql, *params):
        if "SET status = 'processing'" in sql:
            self.claimed = [str(x) for x in params[1]]
        return None


def rows_of(*spec):
    """Pending rows in created_at order: rows_of(("retain", 12), ("consolidation", 3))."""
    rows = []
    for op_type, n in spec:
        for _ in range(n):
            rows.append(
                {
                    "operation_id": uuid.uuid4(),
                    "operation_type": op_type,
                    "task_payload": "{}",
                    "retry_count": 0,
                    "bank_id": f"bank-{len(rows)}",
                }
            )
    return rows


def pending(n_consolidation, n_retain=0):
    return rows_of(("consolidation", n_consolidation), ("retain", n_retain))


def claim(conn, reserved, shared, ceilings=None):
    """Drive the real claim_tasks, passing ceilings only when it supports them."""
    kwargs = {"consolidation_bank_priority": None}
    if ceilings is not None and supports_ceilings:
        kwargs["type_ceilings"] = ceilings
    rows = asyncio.run(ops.claim_tasks(conn, "async_operations", "w1", reserved, shared, **kwargs))
    counts = {}
    for r in rows:
        counts[r["operation_type"]] = counts.get(r["operation_type"], 0) + 1
    return rows, counts


ops = PostgreSQLOps()
supports_ceilings = "type_ceilings" in inspect.signature(ops.claim_tasks).parameters
print("CLAIM_TASKS_SUPPORTS_CEILINGS", supports_ceilings)

# THE BUG, driven through the real claim path: worker_max_slots=10 with a
# consolidation RESERVATION of 1 and a 9-slot shared pool. A reservation is a
# floor, so upstream lets consolidation take every slot.
conn = FakeConn(pending(12))
kwargs = {"consolidation_bank_priority": None}
if supports_ceilings:
    kwargs["type_ceilings"] = {"consolidation": 4}
rows = asyncio.run(ops.claim_tasks(conn, "async_operations", "w1", {"consolidation": 1}, 9, **kwargs))
n_consolidation = sum(1 for r in rows if r["operation_type"] == "consolidation")
print("CEILING_CLAIMED", n_consolidation, "MARKED_PROCESSING", len(conn.claimed))
if n_consolidation > 4:
    fail(
        f"consolidation claimed {n_consolidation} worker slots under a ceiling of 4 - no "
        "per-type CEILING exists, only the ..._RESERVED_SLOTS reservation FLOOR"
    )
if len(conn.claimed) != len(rows):
    fail("claim_tasks marked a different number of rows processing than it returned")
if {str(r["operation_id"]) for r in rows} != set(conn.claimed):
    fail("rows dropped by the ceiling were still marked processing (half-claimed)")

if supports_ceilings:
    # A ceiling on one type must not throttle another, and an uncapped type
    # must be claimed in full.
    #
    # NOTE this configuration caps ONLY consolidation, which phase 2a excludes in
    # SQL — so it exercises the one case where "filter after selection" and
    # "bound before selection" agree. It is kept because it is the shipping
    # default, but it proves nothing about a capped type phase 2a actually
    # claims. MIXED_CLAIM_SHARED_BUDGET below is the assertion that does.
    _, by_type = claim(FakeConn(pending(12, n_retain=5)), {}, 9, {"consolidation": 2})
    print("MIXED_CLAIM_CONSOLIDATION_ONLY", sorted(by_type.items()))
    if by_type.get("consolidation", 0) > 2:
        fail("the ceiling did not bound consolidation in a mixed batch")
    if by_type.get("retain", 0) != 5:
        fail("the uncapped retain type was throttled by another type's ceiling")

    # THE REGRESSION the ceiling must not introduce: a capped type that phase 2a
    # DOES claim must not spend the shared budget on rows it cannot keep.
    #
    # 12 pending retain (older) + 5 graph_maintenance, shared_limit=9, retain
    # capped at 2. Phase 2a is one 'ORDER BY created_at LIMIT 9' across both
    # types, so a post-selection filter selects 9 retain rows, keeps 2, and
    # claims ZERO graph_maintenance — against upstream's 9 claimed tasks. Bounded
    # before selection, the at-ceiling type is excluded in SQL and the unspent
    # budget refills: 2 retain + 5 graph_maintenance.
    conn5 = FakeConn(rows_of(("retain", 12), ("graph_maintenance", 5)))
    rows5, by_type5 = claim(conn5, {}, 9, {"retain": 2})
    print("MIXED_CLAIM_SHARED_BUDGET", sorted(by_type5.items()), "TOTAL", len(rows5))
    if by_type5.get("retain", 0) != 2:
        fail(f"retain claimed {by_type5.get('retain', 0)} rows under a ceiling of 2")
    if by_type5.get("graph_maintenance", 0) != 5:
        fail(
            "the shared budget was spent on retain rows the ceiling then discarded: "
            f"{by_type5.get('graph_maintenance', 0)} of 5 pending graph_maintenance tasks "
            "were claimed. A ceiling must bound SELECTION, not filter after it, or one "
            "capped type starves every other type of the whole batch"
        )
    if set(conn5.claimed) != {str(r["operation_id"]) for r in rows5}:
        fail("rows dropped by the ceiling were still marked processing (half-claimed)")

    # L1/L2: with consolidation at its ceiling, phase 2b must not run AT ALL —
    # no busy-banks scan, no FOR UPDATE locks on rows this worker must discard —
    # and the budget phase 2a did not spend must still reach the rest of the batch.
    #
    # 9 retain (capped at 1) + 9 consolidation (capped at 0), shared_limit=9. A
    # post-selection filter claims exactly ONE task here and leaves 8 slots idle
    # against 17 pending, because phase 2a burned all 9 on retain rows it dropped.
    conn6 = FakeConn(rows_of(("retain", 9), ("consolidation", 9)))
    rows6, by_type6 = claim(conn6, {}, 9, {"retain": 1, "consolidation": 0})
    busy_scans = sum(1 for s in conn6.fetches if "SELECT DISTINCT bank_id" in s)
    print(
        "AT_CEILING_BATCH", sorted(by_type6.items()), "TOTAL", len(rows6),
        "BUSY_BANK_SCANS", busy_scans,
    )
    if by_type6.get("consolidation", 0) != 0:
        fail("a type at zero ceiling headroom was still claimed")
    if by_type6.get("retain", 0) != 1:
        fail(f"retain claimed {by_type6.get('retain', 0)} rows under a ceiling of 1")
    if busy_scans != 0:
        fail(
            f"phase 2b ran its busy-banks scan {busy_scans}x with consolidation at zero "
            "ceiling headroom - it takes FOR UPDATE locks on rows it must discard, which "
            "multi-worker briefly hides head consolidation rows from a worker that does "
            "have headroom"
        )

    # …and the same batch with headroom restored proves the skip above is the
    # ceiling talking, not the probe failing to reach phase 2b at all.
    conn7 = FakeConn(rows_of(("retain", 9), ("consolidation", 9)))
    _, by_type7 = claim(conn7, {}, 9, {"retain": 1, "consolidation": 4})
    busy_scans7 = sum(1 for s in conn7.fetches if "SELECT DISTINCT bank_id" in s)
    print("HEADROOM_BATCH", sorted(by_type7.items()), "BUSY_BANK_SCANS", busy_scans7)
    if by_type7.get("consolidation", 0) != 4 or by_type7.get("retain", 0) != 1:
        fail(f"with headroom the batch should claim 1 retain + 4 consolidation: {by_type7}")
    if busy_scans7 != 1:
        fail(f"phase 2b did not run with consolidation headroom left ({busy_scans7} scans)")

    # No ceilings == upstream, byte for byte.
    conn4 = FakeConn(pending(12))
    rows4 = asyncio.run(
        ops.claim_tasks(
            conn4, "async_operations", "w1", {"consolidation": 1}, 9, consolidation_bank_priority=None
        )
    )
    print("UNCAPPED_CLAIMED", len(rows4))
    if len(rows4) != 10:
        fail(f"with no ceilings claim_tasks returned {len(rows4)} rows, expected upstream's 10")

# The poller must compute and expose the headroom the claim path spends.
poller_kwargs = {
    "backend": object(),
    "worker_id": "w1",
    "executor": lambda *_: None,
    "tenant_extension": object(),
    "max_slots": 10,
    "slot_reservations": {"consolidation": 1},
}
if "slot_limits" in inspect.signature(WorkerPoller.__init__).parameters:
    poller_kwargs["slot_limits"] = {"consolidation": 4}
poller = WorkerPoller(**poller_kwargs)

poller._in_flight_count = 4
poller._in_flight_by_type = {"consolidation": 4}
avail = asyncio.run(poller._get_available_slots())
ceilings = getattr(avail, "ceilings", None)
print("POLLER_CEILINGS", ceilings, "RESERVED", avail.reserved, "SHARED", avail.shared)
if ceilings is None:
    fail("SlotAvailability carries no per-type ceilings - the poller cannot enforce a cap")
else:
    if ceilings.get("consolidation") != 0:
        fail(f"consolidation headroom is {ceilings.get('consolidation')} at 4 in-flight, cap 4")
    if avail.shared > 0 and ceilings.get("consolidation") == 0:
        pass  # shared stays open for OTHER types - that is correct

poller._in_flight_count = 0
poller._in_flight_by_type = {}
avail0 = asyncio.run(poller._get_available_slots())
idle_ceilings = getattr(avail0, "ceilings", None)
print("POLLER_CEILINGS_IDLE", idle_ceilings)
if idle_ceilings is not None and idle_ceilings.get("consolidation") != 4:
    fail("idle consolidation headroom should equal the full ceiling")

has_limits = "worker_slot_limits" in fields
print("CONFIG_HAS_SLOT_LIMITS", has_limits)
if not has_limits:
    fail("HindsightConfig has no worker_slot_limits - there is no per-type ceiling mechanism")
else:
    c, err = cfg_with(HINDSIGHT_API_WORKER_MAX_SLOTS=10)
    print("DEFAULT_CEILINGS", None if c is None else sorted(c.worker_slot_limits.items()))
    if c is None or c.worker_slot_limits.get("consolidation") != 4:
        fail(f"default consolidation ceiling is not 4: {err or c.worker_slot_limits}")

    over, _ = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10, HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT=11
    )
    print("REJECTS_CEILING_ABOVE_MAX_SLOTS", over is None)
    if over is not None:
        fail("a ceiling above worker_max_slots was accepted")

    # Canonical v0.8.6 spelling. Upstream #3016 renamed the per-type reservation
    # HINDSIGHT_API_WORKER_<TYPE>_MAX_SLOTS -> ..._RESERVED_SLOTS and kept the old
    # name as a deprecated alias; switchroom emits only the canonical one.
    under, _ = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10,
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS=5,
        HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT=2,
    )
    print("REJECTS_CEILING_BELOW_RESERVATION", under is None)
    if under is not None:
        fail("a ceiling below the type's own reservation was accepted - the floor is unsatisfiable")

    # ── upstream #3016: the rename, and the trap it laid ──────────────────
    # The deprecated alias still resolves, so an operator's pre-0.8.6 yaml is
    # not silently dropped...
    alias, alias_err = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10,
        HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS=3,
    )
    print(
        "ALIAS_RESERVATION",
        None if alias is None else alias.worker_slot_reservations.get("consolidation"),
    )
    if alias is None or alias.worker_slot_reservations.get("consolidation") != 3:
        fail(f"the deprecated ..._MAX_SLOTS alias no longer resolves: {alias_err}")

    canon, canon_err = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10,
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS=3,
    )
    print(
        "CANONICAL_RESERVATION",
        None if canon is None else canon.worker_slot_reservations.get("consolidation"),
    )
    if canon is None or canon.worker_slot_reservations.get("consolidation") != 3:
        fail(f"the canonical ..._RESERVED_SLOTS name does not resolve: {canon_err}")

    # ...but setting BOTH is a hard boot failure. This is the premise behind
    # HINDSIGHT_WORKER_RESERVED_SLOT_ALIASES in src/setup/hindsight-perf-defaults.ts,
    # which normalises to the canonical name so both can never be emitted at once.
    # Asserted here rather than assumed: if upstream ever demoted this to a
    # warning the emitter's alias machinery would be over-engineering, and if the
    # emitter regressed this is the crash the fleet would take at boot.
    both, both_err = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10,
        HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS=3,
        HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS=3,
    )
    # Each spelling ALONE is accepted just above with the same value, so the
    # rejection here can only be the both-names conflict - not some unrelated
    # validation tripping and making this look like a pass.
    print("REJECTS_BOTH_SLOT_SPELLINGS", both is None)
    print("BOTH_SPELLINGS_ERROR_NAMES_CONFLICT", both_err is not None and "RESERVED_SLOTS" in str(both_err) and "MAX_SLOTS" in str(both_err))
    if both is not None:
        fail(
            "setting both ..._MAX_SLOTS and ..._RESERVED_SLOTS was accepted - "
            "upstream #3016's conflict check is gone"
        )

    off, _ = cfg_with(HINDSIGHT_API_WORKER_MAX_SLOTS=10, HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT="")
    print("CEILING_OPT_OUT", off is not None and not off.worker_slot_limits)
    if off is None or off.worker_slot_limits:
        fail("an empty ceiling env var did not switch the cap off")

    zero_cap, _ = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10, HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT=0
    )
    print("REJECTS_ZERO_CEILING", zero_cap is None)
    if zero_cap is not None:
        fail("a zero ceiling was accepted - the type could never be scheduled")

    # Same rule as the admission reservation: an EXPLICIT ceiling above
    # worker_max_slots is rejected (above), but the DEFAULT is clamped so that
    # lowering HINDSIGHT_API_WORKER_MAX_SLOTS cannot break boot.
    small, err_small = cfg_with(HINDSIGHT_API_WORKER_MAX_SLOTS=2)
    print(
        "CEILING_DEFAULT_CLAMPED",
        None if small is None else small.worker_slot_limits.get("consolidation"),
    )
    if small is None or small.worker_slot_limits.get("consolidation") != 2:
        fail(f"worker_max_slots=2 did not clamp the default consolidation ceiling: {err_small}")


# =====================================================================
# fix 3 - the admission wait is OBSERVABLE on every recall, background included
# =====================================================================
# Executes the REAL shipping completion block: the wait-line assembly AND the
# 'if not quiet:' emission gate that decides whether any of it reaches the log.
# Both matter — an unconditional sem= that is then swallowed by _quiet leaves the
# BACKGROUND population (the one this PR pins at 2 concurrent) emitting nothing,
# which is the same blind spot that mis-sized the contention in the first place.


class _CapturingLogger:
    """Stands in for the module logger so the emission itself is observable."""

    def __init__(self):
        self.lines = []

    def info(self, msg, *a, **k):
        self.lines.append(str(msg))

    error = warning = debug = info


def run_completion_block(block, *, quiet, semaphore_wait, max_conn_wait):
    """Execute the real completion block and return (wait_info, emitted lines)."""
    log = _CapturingLogger()
    scope = {
        "semaphore_wait": semaphore_wait,
        "max_conn_wait": max_conn_wait,
        "quiet": quiet,
        "logger": log,
        "log_buffer": ["[RECALL r-1] Start"],
        "recall_id": "r-1",
        "recall_start": 0.0,
        "total_time": 1.25,
        "top_scored": [object()] * 3,
        "total_tokens": 100,
        "num_chunks": 1,
        "total_chunk_tokens": 10,
        "num_entities": 2,
        "total_entity_tokens": 20,
        "fact_type_summary": "world=3",
    }
    exec(compile(block, "<recall-completion>", "exec"), scope)
    return scope["wait_info"], log.lines


engine_src = inspect.getsource(me)
# From 'wait_parts = []' up to (not including) the 'return RecallResultModel('
# that follows at the same indentation - i.e. the whole completion block.
m = re.search(
    r"^( *)wait_parts = \[\]\n(?P<body>(?:.*?\n)*?)\1return RecallResultModel\(",
    engine_src,
    re.M,
)
if not m:
    fail("could not locate the recall completion block - re-author this probe")
else:
    indent = m.group(1)
    raw = indent + "wait_parts = []\n" + m.group("body")
    block = "\n".join(
        line[len(indent) :] if line.startswith(indent) else line
        for line in raw.splitlines()
    )
    if "if not quiet:" not in block:
        fail("the recall completion block no longer contains the quiet gate - re-author this probe")

    wait_info, loud = run_completion_block(
        block, quiet=False, semaphore_wait=0.0, max_conn_wait=0.0
    )
    print("WAIT_INFO_AT_ZERO %r" % wait_info)
    if "sem=" not in wait_info:
        fail(
            "sem= is absent when the admission wait is 0.000s - the >0.01s gate hides that a "
            "recall did not queue, so no log scrape can recover the wait distribution"
        )
    elif "sem=0.000s" not in wait_info:
        fail(f"expected sem=0.000s in the zero-wait line, got {wait_info!r}")
    print("FOREGROUND_EMITTED", len(loud))
    if not any("sem=" in line for line in loud):
        fail("a foreground recall emitted no sem= line at all")

    wait_info2, _ = run_completion_block(
        block, quiet=False, semaphore_wait=5.43, max_conn_wait=0.0
    )
    print("WAIT_INFO_AT_MEASURED_MEAN %r" % wait_info2)
    if "sem=5.430s" not in wait_info2:
        fail("a real 5.43s admission wait is no longer reported")

    wait_info3, _ = run_completion_block(
        block, quiet=False, semaphore_wait=0.0, max_conn_wait=0.0053
    )
    print("WAIT_INFO_CONN_SUBTHRESHOLD %r" % wait_info3)
    if "conn=" in wait_info3:
        fail("the connection-wait threshold was changed - this fix is scoped to sem= only")

    # THE QUIET GATE. consolidator.py recalls with _quiet=True, so this is the
    # exact population the background reservation caps. If it emits nothing, the
    # reservation backing consolidation up is invisible in the logs - the very
    # failure ("we mis-sized this from biased logs") the fix exists to prevent.
    _, quiet_lines = run_completion_block(
        block, quiet=True, semaphore_wait=5.43, max_conn_wait=0.0
    )
    quiet_sem = [line for line in quiet_lines if "sem=5.430s" in line]
    print("QUIET_EMITTED", len(quiet_lines), "QUIET_SEM_LINES", len(quiet_sem))
    if not quiet_sem:
        fail(
            "a quiet (BACKGROUND) recall emitted no sem= line - the whole completion line "
            "is gated on 'if not quiet:' and the consolidator passes _quiet=True, so the "
            "population this reservation caps is unobservable and cannot be re-measured"
        )
    # …and it stays ONE line: _quiet exists to suppress the multi-line buffer, and
    # restoring that noise would be a different regression.
    if len(quiet_lines) > 1:
        fail(f"a quiet recall emitted {len(quiet_lines)} log records, expected exactly 1")
    if quiet_sem and "\n" in quiet_sem[0]:
        fail("the quiet recall line restored the full multi-line log buffer")


print("FAILURES", failures)
print("PROBE_EXECUTED")
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

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching first. */
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-iso-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8
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

    if (patched) {
      for (const block of patchBlocks()) {
        // Each block is self-verifying: it asserts its upstream anchors exist
        // exactly once and re-asserts the result, so a non-zero exit here means
        // upstream drifted and the patch must be re-authored.
        await execFileAsync("docker", ["exec", "-i", name, "python3", "-"], { input: block });
      }
    }

    const res = await execFileAsync("docker", ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"], { input: PROBE });
    return { status: 0, stdout: res.stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight recall-isolation probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the three patch blocks it claims to prove", () => {
    const blocks = patchBlocks();
    expect(blocks).toHaveLength(PATCH_NAMES.length);
    // Distinct blocks: a duplicated name would silently apply one patch twice
    // and leave another unproven.
    expect(new Set(blocks).size).toBe(PATCH_NAMES.length);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable"
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite"
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight recall-isolation patches change real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" }
        )
          .split("\n")
          .filter(Boolean);
        if (ids.length) {
          execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
        }
      } catch {
        /* nothing to clean */
      }
    });

    it("unpatched upstream is RED on all three defects (proves the probe bites)", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // Defect 1 — the starvation itself, driven: 8 concurrent background
      // recalls hold all 8 admission slots and the foreground acquire never
      // completes. Total concurrency is already correct upstream (8), which is
      // why the fix must not change it.
      expect(stdout).toContain("HAS_ADMISSION_HELPER False");
      expect(stdout).toMatch(
        /STARVATION background=8 foreground_admitted=False/
      );
      expect(stdout).toMatch(
        /STARVATION_HEAVY background=8 foreground_admitted=False/
      );
      expect(stdout).toContain("TOTAL_CONCURRENCY_PEAK 8");
      expect(stdout).toContain(
        "foreground recall was STARVED: 8 concurrent background (consolidation) " +
          "recalls held every one of the 8 admission slots"
      );
      // … and the wiring that causes it: the consolidator's recall is admitted
      // as foreground, straight onto the shared semaphore.
      expect(stdout).toContain("RECALL_ADMISSION_WIRED 0 BARE_SHARED_ACQUIRES 1");
      expect(stdout).toContain("ADMISSION_ARGS []");
      expect(stdout).toContain("CONSOLIDATOR_RECALLS 1 MARKED_BACKGROUND 0");
      expect(stdout).toContain("CONFIG_HAS_BG_FIELD False");

      // Defect 2 — with a consolidation reservation of 1 and a 9-slot shared
      // pool, consolidation claims all 10 worker slots.
      expect(stdout).toContain("CLAIM_TASKS_SUPPORTS_CEILINGS False");
      expect(stdout).toContain("CEILING_CLAIMED 10 MARKED_PROCESSING 10");
      expect(stdout).toContain(
        "consolidation claimed 10 worker slots under a ceiling of 4 - no " +
          "per-type CEILING exists, only the ..._RESERVED_SLOTS reservation FLOOR"
      );
      expect(stdout).toContain("POLLER_CEILINGS None");
      expect(stdout).toContain("CONFIG_HAS_SLOT_LIMITS False");

      // Defect 3 — a recall that did not queue produces NO wait information at
      // all, so the 0-wait population is unrecoverable from the logs …
      expect(stdout).toContain("WAIT_INFO_AT_ZERO ''");
      expect(stdout).toContain(
        "sem= is absent when the admission wait is 0.000s"
      );
      // … and a BACKGROUND (quiet) recall emits nothing whatsoever, even when it
      // waited 5.43s, because the whole completion line sits behind
      // `if not quiet:` and the consolidator passes _quiet=True.
      expect(stdout).toContain("QUIET_EMITTED 0 QUIET_SEM_LINES 0");
      expect(stdout).toContain(
        "a quiet (BACKGROUND) recall emitted no sem= line"
      );
      // The >0.01s lines upstream DID emit are unchanged by the fix.
      expect(stdout).toContain(
        "WAIT_INFO_AT_MEASURED_MEAN ' | waits: sem=5.430s'"
      );
    }, 240_000);

    it("upstream + the baked patch blocks is GREEN, including every safety property", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // Fix 1: background is pinned at its reservation of 2 even under 32
      // concurrent background recalls, and foreground is admitted immediately …
      expect(stdout).toMatch(
        /STARVATION background=2 foreground_admitted=True wait=0\.00\d+s/
      );
      expect(stdout).toMatch(
        /STARVATION_HEAVY background=2 foreground_admitted=True wait=0\.00\d+s/
      );
      // … without raising total database concurrency above recall_max_concurrent
      // (a reservation, not a second budget) …
      expect(stdout).toContain("TOTAL_CONCURRENCY_PEAK 8");
      // … and the nested acquisition cannot deadlock.
      expect(stdout).toContain("NO_DEADLOCK True");
      // The wiring, checked structurally because reaching it needs a database:
      // recall_async admits through the helper exactly once, never bare, and
      // every consolidator recall is flagged background.
      expect(stdout).toContain("RECALL_HAS_BACKGROUND_PARAM True");
      expect(stdout).toContain("RECALL_ADMISSION_WIRED 1 BARE_SHARED_ACQUIRES 0");
      // The call's ARGUMENTS, pinned. Asserting only that _recall_admission is
      // called leaves the split revertible by one token — hard-coding the third
      // argument to False sends every background recall down the foreground path
      // while every other assertion in this file stays green.
      expect(stdout).toContain(
        "ADMISSION_ARGS ['self._search_semaphore', " +
          "'self._background_search_semaphore', '_background']"
      );
      expect(stdout).toContain("CONSOLIDATOR_RECALLS 1 MARKED_BACKGROUND 1");
      // An incoherent admission policy fails at boot rather than silently
      // reintroducing the starvation.
      expect(stdout).toContain("BG_CONFIG_OK True");
      expect(stdout).toContain("BG_CONFIG_REJECTS_NO_FLOOR True");
      expect(stdout).toContain("BG_CONFIG_REJECTS_ZERO True");
      // … but a DEFAULT must never break boot. The reservation default is
      // derived from the shared budget, so lowering recall_max_concurrent —
      // even to the degenerate 1, where no split is possible at all — still
      // starts. Only an EXPLICIT incoherent value fails.
      expect(stdout).toContain("BG_DEFAULT_DERIVED 1 1");

      // Fix 2: the ceiling bounds what is marked processing …
      expect(stdout).toContain("CEILING_CLAIMED 4 MARKED_PROCESSING 4");
      // … it does not throttle an uncapped type sharing the batch …
      expect(stdout).toContain(
        "MIXED_CLAIM_CONSOLIDATION_ONLY [('consolidation', 2), ('retain', 5)]"
      );
      // … and — the property the line above cannot see, because phase 2a
      // excludes consolidation in SQL anyway — a capped type that phase 2a DOES
      // claim must not spend the shared budget on rows it then discards. 12
      // older retain capped at 2, 5 graph_maintenance, shared_limit 9: a
      // post-selection filter claims 2 and 0 here, against upstream's 9.
      expect(stdout).toContain(
        "MIXED_CLAIM_SHARED_BUDGET [('graph_maintenance', 5), ('retain', 2)] TOTAL 7"
      );
      // At zero headroom phase 2b is skipped outright — no busy-banks scan, no
      // FOR UPDATE locks on rows this worker must discard — and the budget phase
      // 2a did not spend is not lost.
      expect(stdout).toContain(
        "AT_CEILING_BATCH [('retain', 1)] TOTAL 1 BUSY_BANK_SCANS 0"
      );
      // The same batch WITH headroom still reaches phase 2b, so the skip above
      // is the ceiling talking and not the probe missing the phase entirely.
      expect(stdout).toContain(
        "HEADROOM_BATCH [('consolidation', 4), ('retain', 1)] BUSY_BANK_SCANS 1"
      );
      // … and with no ceilings configured the claim path is upstream's.
      expect(stdout).toContain("UNCAPPED_CLAIMED 10");
      // The poller computes the headroom the claim path spends.
      expect(stdout).toContain("POLLER_CEILINGS {'consolidation': 0}");
      expect(stdout).toContain("POLLER_CEILINGS_IDLE {'consolidation': 4}");
      // Defaults and boot validation, driven through the real from_env().
      expect(stdout).toContain("DEFAULT_CEILINGS [('consolidation', 4)]");
      expect(stdout).toContain("REJECTS_CEILING_ABOVE_MAX_SLOTS True");

      // upstream #3016's rename, driven against the real config loader: both
      // spellings resolve alone, and setting BOTH is a hard boot failure. That
      // last one is what makes the emitter's alias normalisation load-bearing
      // rather than decorative (src/setup/hindsight-perf-defaults.ts).
      expect(stdout).toContain("ALIAS_RESERVATION 3");
      expect(stdout).toContain("CANONICAL_RESERVATION 3");
      expect(stdout).toContain("REJECTS_BOTH_SLOT_SPELLINGS True");
      expect(stdout).toContain("BOTH_SPELLINGS_ERROR_NAMES_CONFLICT True");
      expect(stdout).toContain("REJECTS_CEILING_BELOW_RESERVATION True");
      expect(stdout).toContain("REJECTS_ZERO_CEILING True");
      // An operator can switch the default cap off without rebuilding.
      expect(stdout).toContain("CEILING_OPT_OUT True");
      // Same rule as the admission reservation: the DEFAULT cap is clamped to
      // worker_max_slots, so lowering that knob cannot break boot either.
      expect(stdout).toContain("CEILING_DEFAULT_CLAMPED 2");

      // Fix 3: a zero wait is now a datum, the real waits still read the same,
      // and the conn= threshold is untouched (this fix is scoped to sem=).
      expect(stdout).toContain("WAIT_INFO_AT_ZERO ' | waits: sem=0.000s'");
      expect(stdout).toContain(
        "WAIT_INFO_AT_MEASURED_MEAN ' | waits: sem=5.430s'"
      );
      expect(stdout).toContain(
        "WAIT_INFO_CONN_SUBTHRESHOLD ' | waits: sem=0.000s'"
      );
      // …and the BACKGROUND population the reservation caps is observable: a
      // quiet recall emits exactly one line, carrying its admission wait. One,
      // not the whole buffer — _quiet still suppresses the noise it exists for.
      expect(stdout).toContain("QUIET_EMITTED 1 QUIET_SEM_LINES 1");
    }, 240_000);
  }
);
