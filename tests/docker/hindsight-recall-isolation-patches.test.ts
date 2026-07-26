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
 *     HINDSIGHT_API_WORKER_<TYPE>_MAX_SLOTS knobs are reservations, i.e. a
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
    """Enough of asyncpg to drive the real claim_tasks end to end."""

    def __init__(self, pending):
        self.pending = list(pending)
        self.claimed = []

    async def fetch(self, sql, *params):
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
        excluded = set()
        for p in params[:-1]:
            if isinstance(p, list) and p and isinstance(p[0], uuid.UUID):
                excluded = {str(x) for x in p}
        rows = [r for r in rows if str(r["operation_id"]) not in excluded]
        return rows[:limit]

    async def execute(self, sql, *params):
        if "SET status = 'processing'" in sql:
            self.claimed = [str(x) for x in params[1]]
        return None


def pending(n_consolidation, n_retain=0):
    rows = []

    def row(op_type):
        return {
            "operation_id": uuid.uuid4(),
            "operation_type": op_type,
            "task_payload": "{}",
            "retry_count": 0,
            "bank_id": f"bank-{len(rows)}",
        }

    for _ in range(n_consolidation):
        rows.append(row("consolidation"))
    for _ in range(n_retain):
        rows.append(row("retain"))
    return rows


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
        "per-type CEILING exists, only the ..._MAX_SLOTS reservation FLOOR"
    )
if len(conn.claimed) != len(rows):
    fail("claim_tasks marked a different number of rows processing than it returned")
if {str(r["operation_id"]) for r in rows} != set(conn.claimed):
    fail("rows dropped by the ceiling were still marked processing (half-claimed)")

if supports_ceilings:
    # A ceiling on one type must not throttle another, and an uncapped type
    # must be claimed in full.
    conn3 = FakeConn(pending(12, n_retain=5))
    rows3 = asyncio.run(
        ops.claim_tasks(
            conn3,
            "async_operations",
            "w1",
            {},
            9,
            consolidation_bank_priority=None,
            type_ceilings={"consolidation": 2},
        )
    )
    by_type = {}
    for r in rows3:
        by_type[r["operation_type"]] = by_type.get(r["operation_type"], 0) + 1
    print("MIXED_CLAIM", sorted(by_type.items()))
    if by_type.get("consolidation", 0) > 2:
        fail("the ceiling did not bound consolidation in a mixed batch")
    if by_type.get("retain", 0) != 5:
        fail("the uncapped retain type was throttled by another type's ceiling")

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

    under, _ = cfg_with(
        HINDSIGHT_API_WORKER_MAX_SLOTS=10,
        HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS=5,
        HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT=2,
    )
    print("REJECTS_CEILING_BELOW_RESERVATION", under is None)
    if under is not None:
        fail("a ceiling below the type's own reservation was accepted - the floor is unsatisfiable")

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
# fix 3 - sem= is emitted on EVERY recall
# =====================================================================
# Execute the REAL shipping wait-line assembly with a zero admission wait.
# (It lives in MemoryEngine._search_with_retries, the recall search path.)
engine_src = inspect.getsource(me)
m = re.search(r"^( *)wait_parts = \[\]\n(?:.*?\n)??\1wait_info = [^\n]*", engine_src, re.S | re.M)
if not m:
    fail("could not locate the recall wait-line assembly - re-author this probe")
else:
    indent = m.group(1)
    block = "\n".join(
        line[len(indent) :] if line.startswith(indent) else line
        for line in m.group(0).splitlines()
    )
    scope = {"semaphore_wait": 0.0, "max_conn_wait": 0.0}
    exec(compile(block, "<recall-wait-line>", "exec"), scope)
    print("WAIT_INFO_AT_ZERO %r" % scope["wait_info"])
    if "sem=" not in scope["wait_info"]:
        fail(
            "sem= is absent when the admission wait is 0.000s - the >0.01s gate hides that a "
            "recall did not queue, so no log scrape can recover the wait distribution"
        )
    elif "sem=0.000s" not in scope["wait_info"]:
        fail(f"expected sem=0.000s in the zero-wait line, got {scope['wait_info']!r}")

    scope2 = {"semaphore_wait": 5.43, "max_conn_wait": 0.0}
    exec(compile(block, "<recall-wait-line>", "exec"), scope2)
    print("WAIT_INFO_AT_MEASURED_MEAN %r" % scope2["wait_info"])
    if "sem=5.430s" not in scope2["wait_info"]:
        fail("a real 5.43s admission wait is no longer reported")

    scope3 = {"semaphore_wait": 0.0, "max_conn_wait": 0.0053}
    exec(compile(block, "<recall-wait-line>", "exec"), scope3)
    print("WAIT_INFO_CONN_SUBTHRESHOLD %r" % scope3["wait_info"])
    if "conn=" in scope3["wait_info"]:
        fail("the connection-wait threshold was changed - this fix is scoped to sem= only")


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
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-iso-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8
  )}`;
  try {
    execFileSync(
      "docker",
      [
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
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    if (patched) {
      for (const block of patchBlocks()) {
        // Each block is self-verifying: it asserts its upstream anchors exist
        // exactly once and re-asserts the result, so a non-zero exit here means
        // upstream drifted and the patch must be re-authored.
        execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
          input: block,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" }
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
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

    it("unpatched upstream is RED on all three defects (proves the probe bites)", () => {
      const { status, stdout } = runProbe(false);
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
      expect(stdout).toContain("CONSOLIDATOR_RECALLS 1 MARKED_BACKGROUND 0");
      expect(stdout).toContain("CONFIG_HAS_BG_FIELD False");

      // Defect 2 — with a consolidation reservation of 1 and a 9-slot shared
      // pool, consolidation claims all 10 worker slots.
      expect(stdout).toContain("CLAIM_TASKS_SUPPORTS_CEILINGS False");
      expect(stdout).toContain("CEILING_CLAIMED 10 MARKED_PROCESSING 10");
      expect(stdout).toContain(
        "consolidation claimed 10 worker slots under a ceiling of 4 - no " +
          "per-type CEILING exists, only the ..._MAX_SLOTS reservation FLOOR"
      );
      expect(stdout).toContain("POLLER_CEILINGS None");
      expect(stdout).toContain("CONFIG_HAS_SLOT_LIMITS False");

      // Defect 3 — a recall that did not queue produces NO wait information at
      // all, so the 0-wait population is unrecoverable from the logs.
      expect(stdout).toContain("WAIT_INFO_AT_ZERO ''");
      expect(stdout).toContain(
        "sem= is absent when the admission wait is 0.000s"
      );
      // The >0.01s lines upstream DID emit are unchanged by the fix.
      expect(stdout).toContain(
        "WAIT_INFO_AT_MEASURED_MEAN ' | waits: sem=5.430s'"
      );
    }, 240_000);

    it("upstream + the baked patch blocks is GREEN, including every safety property", () => {
      const { status, stdout } = runProbe(true);
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
        "MIXED_CLAIM [('consolidation', 2), ('retain', 5)]"
      );
      // … and with no ceilings configured the claim path is upstream's.
      expect(stdout).toContain("UNCAPPED_CLAIMED 10");
      // The poller computes the headroom the claim path spends.
      expect(stdout).toContain("POLLER_CEILINGS {'consolidation': 0}");
      expect(stdout).toContain("POLLER_CEILINGS_IDLE {'consolidation': 4}");
      // Defaults and boot validation, driven through the real from_env().
      expect(stdout).toContain("DEFAULT_CEILINGS [('consolidation', 4)]");
      expect(stdout).toContain("REJECTS_CEILING_ABOVE_MAX_SLOTS True");
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
    }, 240_000);
  }
);
