/**
 * Behavioural proof for the work-conserving recall-admission gate that
 * `docker/Dockerfile.hindsight` bakes on top of the recall-admission split.
 * `dockerfile-hindsight-bakes.test.ts` pins the SHAPE of the patch block
 * (grep-on-file, runs everywhere). This file proves the OUTCOME, and — because
 * the fix REPLACES an earlier fix's mechanism — it must be RED on BOTH
 * baselines:
 *
 *  - UNPATCHED UPSTREAM (one FIFO semaphore, no split at all): a foreground
 *    recall submitted behind a wall of queued background (consolidation)
 *    recalls waits behind every one of them, FIFO. The PRIORITY property
 *    fails.
 *  - THE STRICT RESERVATION (the recall-admission-split block alone — today's
 *    shipping behaviour): background is hard-capped at
 *    consolidation_recall_max_concurrent (2) of the recall_max_concurrent (8)
 *    admission slots even when ZERO foreground recalls are waiting, so a
 *    large consolidation drain crawls at 2/8 of the budget (measured ~23h on
 *    this host) while 6 slots sit idle. The WORK-CONSERVING property fails.
 *
 * The gate must be GREEN on both properties at once, plus the safety
 * properties the patch text alone cannot prove:
 *
 *  - Work-conserving: with zero foreground waiters and 20 queued background
 *    recalls, in-flight background reaches recall_max_concurrent (8), not 2.
 *  - Priority: with 50 queued 500 ms background recalls saturating all 8
 *    slots, one foreground recall is admitted in under 2x a single recall
 *    duration (< 1.0 s). Background there is far above its floor, so the
 *    head-of-line wait is exactly ONE completion; in general the bound is
 *    (floor deficit + 1) completions, because the floor is granted first.
 *    No preemption is needed for recalls that run seconds.
 *  - Total concurrency is UNCHANGED: the peak never exceeds (and does reach)
 *    recall_max_concurrent under mixed load — one boundary, not two budgets.
 *  - Background floor is a LIVE guarantee, both directions, deterministically:
 *    (i) with background AT its floor and one of each waiting, a freed slot
 *    goes to the FOREGROUND waiter, and background follows once foreground
 *    stops waiting; (ii) FLOOR LIVENESS — with background BELOW its floor
 *    under SUSTAINED foreground pressure (a standing foreground queue that
 *    would absorb every freed slot), the very first freed slot goes to
 *    background. (ii) is the scenario a foreground-first grant pass fails:
 *    an ungranted foreground waiter implies active == total at all times, so
 *    the floor clause alone is unreachable under contention and background
 *    starves to zero — worse than the strict reservation this gate replaces.
 *  - Cancellation safety: a foreground waiter cancelled mid-wait cannot leave
 *    background borrowing latched off, and under churn (300 admissions with
 *    120 random cancellations) every counter and waiter list returns to
 *    exactly zero — the borrow/return accounting is exact.
 *  - #4212 preservation (the through-built arm): `_reconcile_rerank_priority`
 *    still exists, `_background` is still threaded to `_search_with_retries`
 *    and the rerank site — the gate is the ADMISSION layer and must not
 *    regress the rerank-lane invariants.
 *
 * ARM CONSTRUCTION: the strict-baseline and gate arms apply the patch blocks
 * extracted from the Dockerfile itself (never duplicated here) by
 * `docker exec` onto the pinned upstream image, in Dockerfile order — the
 * work-conserving block's anchors are the split block's output, and both are
 * independent of the #3142/#4212 rerank-pool blocks (its #4212 preservation
 * check is presence-conditional by design). The through-built arm probes the
 * real `switchroom-hindsight` image (SWITCHROOM_HINDSIGHT_BUILT_IMAGE), which
 * carries every patch in order — that is where the #4212 invariants are
 * asserted GREEN alongside the gate.
 *
 * NOTE tests/docker/hindsight-recall-isolation-patches.test.ts pins the
 * INTERMEDIATE layer (upstream + split only, where background caps at 2);
 * that remains correct for the state it constructs. This file owns the final
 * admission semantics.
 *
 * SKIP DISCIPLINE: identical to hindsight-recall-isolation-patches.test.ts.
 * Locally, no docker or no cached upstream image skips (never pull a 6.4GB
 * image onto a dev box); the built arm additionally needs
 * SWITCHROOM_HINDSIGHT_BUILT_IMAGE. In CI the `hindsight-probe` job pulls the
 * pinned digest, builds the through-built image, and sets
 * SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an unavailable
 * docker/image is a HARD FAILURE, never a green skip. Every arm asserts a
 * `PROBE_EXECUTED` sentinel so a probe that dies early can never be mistaken
 * for a pass.
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
const TEST_PHASE = "hindsight-work-conserving-admission-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * Patch blocks pulled out of the Dockerfile's RUN heredocs by unique name.
 * Order matters: the work-conserving block's anchors are the split block's
 * output.
 */
function patchBlocks(names: string[]): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  return names.map((name) => {
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

const SPLIT_BLOCK = "recall-admission-split patch";
const WC_BLOCK = "work-conserving-admission patch";

/**
 * Python probe. Pure asyncio/stdlib plus an import of the shipping
 * memory_engine — no model load, no database. It detects which admission
 * mechanism the module ships (gate / strict helper / bare semaphore) and runs
 * the SAME scenarios through whatever is there, so each baseline reports its
 * own defect as a probe failure rather than an import crash.
 */
const PROBE = String.raw`
import ast
import asyncio
import inspect
import random
import sys
import textwrap

failures = []


def fail(msg):
    failures.append(msg)


import hindsight_api.engine.memory_engine as me
from hindsight_api.engine.memory_engine import MemoryEngine

GATE = getattr(me, "_RecallAdmissionGate", None)
STRICT = getattr(me, "_recall_admission", None)
MODE = "gate" if GATE is not None else ("strict" if STRICT is not None else "upstream")
print("ADMISSION_MODE", MODE)

TOTAL = 8  # HINDSIGHT_API_RECALL_MAX_CONCURRENT in this deployment
FLOOR = 2  # consolidation_recall_max_concurrent


def make_admit(total=TOTAL, floor=FLOOR):
    """One fresh admission mechanism per scenario, matching what ships."""
    if MODE == "gate":
        g = GATE(total, floor)
        return lambda is_bg: g.admit(is_bg)
    shared = asyncio.Semaphore(total)
    bg = asyncio.Semaphore(floor)
    if MODE == "strict":
        return lambda is_bg: STRICT(shared, bg, is_bg)
    return lambda is_bg: shared  # upstream: one FIFO semaphore, no split


# =====================================================================
# (a) WORK-CONSERVING: zero foreground waiters + 20 queued background
#     recalls -> in-flight background must reach TOTAL, not cap at FLOOR.
#     RED on the strict reservation (today's shipping behaviour).
# =====================================================================
async def work_conserving_scenario():
    admit = make_admit()
    release = asyncio.Event()
    live = 0
    peak = 0

    async def bg():
        nonlocal live, peak
        async with admit(True):
            live += 1
            peak = max(peak, live)
            await release.wait()
            live -= 1

    tasks = [asyncio.create_task(bg()) for _ in range(20)]
    await asyncio.sleep(0.1)  # let everything that CAN be admitted be admitted
    observed = peak
    release.set()
    await asyncio.gather(*tasks)
    return observed


bg_peak = asyncio.run(work_conserving_scenario())
print("WORK_CONSERVING_BG_PEAK", bg_peak)
if bg_peak < TOTAL:
    fail(
        f"NOT WORK-CONSERVING: with zero foreground recalls waiting, 20 queued "
        f"background recalls only reached {bg_peak} in flight of "
        f"{TOTAL} admission slots — idle capacity is wasted and a large "
        f"consolidation drain crawls"
    )
if bg_peak > TOTAL:
    fail(f"background exceeded the total admission budget: {bg_peak} > {TOTAL}")


# =====================================================================
# (b) PRIORITY: 50 queued 500 ms background recalls, then ONE foreground
#     recall -> its admission wait must be < 2x a single recall duration.
#     RED on unpatched upstream (FIFO: the foreground waits ~3 s).
# =====================================================================
RECALL_S = 0.5


async def priority_scenario():
    admit = make_admit()
    live_bg = 0

    async def bg():
        nonlocal live_bg
        async with admit(True):
            live_bg += 1
            try:
                await asyncio.sleep(RECALL_S)
            finally:
                live_bg -= 1

    tasks = [asyncio.create_task(bg()) for _ in range(50)]
    await asyncio.sleep(0.2)  # in-flight set is saturated, queue is deep
    bg_at_submit = live_bg
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    async with admit(False):
        waited = loop.time() - t0
    await asyncio.gather(*tasks)
    return bg_at_submit, waited


bg_at_submit, fg_wait = asyncio.run(priority_scenario())
print(f"PRIORITY_BG_INFLIGHT_AT_SUBMIT {bg_at_submit} FG_WAIT {fg_wait:.3f}s")
if fg_wait >= 2 * RECALL_S:
    fail(
        f"NO PRIORITY: a foreground recall waited {fg_wait:.3f}s behind queued "
        f"background recalls — head-of-line wait must be bounded by one recall "
        f"duration (< {2 * RECALL_S:.1f}s), or the drain slows every live turn"
    )
if MODE == "gate" and bg_at_submit != TOTAL:
    fail(
        f"the priority scenario is not exercising full borrowing: background "
        f"held {bg_at_submit} of {TOTAL} slots at foreground submit time"
    )


# =====================================================================
# total concurrency: the gate is ONE boundary, not two budgets — the peak
# under mixed load reaches and never exceeds TOTAL.
# =====================================================================
async def total_concurrency_scenario():
    admit = make_admit()
    release = asyncio.Event()
    live = 0
    peak = 0

    async def one(is_bg):
        nonlocal live, peak
        async with admit(is_bg):
            live += 1
            peak = max(peak, live)
            await release.wait()
            live -= 1

    tasks = [asyncio.create_task(one(i % 2 == 0)) for i in range(TOTAL * 5)]
    await asyncio.sleep(0.1)
    observed = peak
    release.set()
    await asyncio.gather(*tasks)
    return observed


peak = asyncio.run(total_concurrency_scenario())
print("TOTAL_CONCURRENCY_PEAK", peak)
if peak > TOTAL:
    fail(f"admission let {peak} recalls run concurrently, above {TOTAL}")
if peak < TOTAL:
    fail(f"admission only reached {peak} concurrent recalls, below {TOTAL}")


# =====================================================================
# gate-only: deterministic floor + starvation freedom, both directions.
# 6 fg + 2 bg (its full floor) in flight, one fg + one bg waiting. Free ONE
# slot: it must go to the FOREGROUND waiter (bg is at floor while fg waits).
# Free another once fg stops waiting: the bg waiter must get in. Everything
# must then drain — driven, not argued, so a lost wakeup or deadlock fails
# here rather than in production.
# =====================================================================
if MODE == "gate":

    async def floor_scenario():
        gate = GATE(TOTAL, FLOOR)
        release_fg = [asyncio.Event() for _ in range(6)]
        release_bg = [asyncio.Event() for _ in range(2)]
        fgw_admitted = asyncio.Event()
        bgw_admitted = asyncio.Event()
        release_fgw = asyncio.Event()

        async def holder(is_bg, ev):
            async with gate.admit(is_bg):
                await ev.wait()

        async def fg_waiter():
            async with gate.admit(False):
                fgw_admitted.set()
                await release_fgw.wait()

        async def bg_waiter():
            async with gate.admit(True):
                bgw_admitted.set()

        holders = [asyncio.create_task(holder(False, e)) for e in release_fg]
        holders += [asyncio.create_task(holder(True, e)) for e in release_bg]
        await asyncio.sleep(0.05)  # all 8 slots held, bg at its floor of 2
        fgw = asyncio.create_task(fg_waiter())
        await asyncio.sleep(0.02)
        bgw = asyncio.create_task(bg_waiter())
        await asyncio.sleep(0.05)
        neither_early = not fgw_admitted.is_set() and not bgw_admitted.is_set()

        release_fg[0].set()  # ONE slot frees while both wait
        await asyncio.wait_for(fgw_admitted.wait(), 2)
        await asyncio.sleep(0.05)
        fg_won = not bgw_admitted.is_set()  # bg at floor + fg was waiting

        release_fg[1].set()  # fg no longer waiting -> bg borrows the next slot
        await asyncio.wait_for(bgw_admitted.wait(), 2)

        release_fgw.set()
        for e in release_fg[2:] + release_bg:
            e.set()
        await asyncio.wait_for(asyncio.gather(*holders, fgw, bgw), 5)
        return neither_early, fg_won

    neither_early, fg_won = asyncio.run(floor_scenario())
    print("FLOOR_NEITHER_ADMITTED_EARLY", neither_early, "FLOOR_FG_WON_SLOT", fg_won)
    if not neither_early:
        fail("a waiter was admitted while every slot was held")
    if not fg_won:
        fail(
            "a freed slot went to a BACKGROUND waiter at its floor while a "
            "foreground recall was waiting — priority inverted"
        )

    # FLOOR LIVENESS — the scenario a foreground-first grant pass fails.
    # 8 foreground in flight, a STANDING queue of 5 more foreground waiting
    # (so an ungranted foreground waiter exists at every completion), one
    # background waiter with background_active = 0 (below its floor of 2).
    # Free ONE slot: it must go to BACKGROUND — the floor is granted FIRST.
    # A gate that grants foreground unconditionally first keeps
    # active == total through every release (the standing queue re-takes each
    # freed slot inside the same grant pass), the floor clause is dead code,
    # and background starves to zero for as long as the pressure lasts —
    # strictly worse than the strict reservation, whose background waiters at
    # least queued FIFO on the shared semaphore with a bounded wait.
    # Deterministic: no timing races, only explicit releases.
    async def floor_liveness_scenario():
        gate = GATE(TOTAL, FLOOR)
        release_fg = [asyncio.Event() for _ in range(TOTAL)]
        release_q = asyncio.Event()
        bg_admitted = asyncio.Event()

        async def holder(ev):
            async with gate.admit(False):
                await ev.wait()

        async def fg_queued():
            async with gate.admit(False):
                await release_q.wait()

        async def bg():
            async with gate.admit(True):
                bg_admitted.set()

        holders = [asyncio.create_task(holder(e)) for e in release_fg]
        await asyncio.sleep(0.05)  # all 8 slots held by foreground
        queue = [asyncio.create_task(fg_queued()) for _ in range(5)]
        await asyncio.sleep(0.02)  # standing foreground queue in place
        b = asyncio.create_task(bg())
        await asyncio.sleep(0.05)  # bg waiting, below floor, under fg pressure

        releases_needed = 0
        for i in range(FLOOR + 1):  # the documented bound: floor deficit + 1
            release_fg[i].set()
            releases_needed = i + 1
            await asyncio.sleep(0.05)
            if bg_admitted.is_set():
                break
        alive = bg_admitted.is_set()

        release_q.set()
        for e in release_fg:
            e.set()
        await asyncio.wait_for(asyncio.gather(*holders, *queue, b), 5)
        return alive, releases_needed

    floor_alive, floor_releases = asyncio.run(floor_liveness_scenario())
    print("FLOOR_LIVENESS_BG_ADMITTED", floor_alive, "RELEASES_NEEDED", floor_releases)
    if not floor_alive:
        fail(
            "FLOOR NOT LIVE: a background waiter below its floor was never "
            "admitted under sustained foreground pressure — the floor is dead "
            "code and consolidation starves to zero for as long as the "
            "foreground queue persists"
        )
    elif floor_releases != 1:
        fail(
            f"the floor-first grant pass should admit a below-floor background "
            f"waiter on the FIRST freed slot; it took {floor_releases} releases"
        )

    # Cancellation: a foreground waiter cancelled mid-wait must not leave
    # background borrowing latched off (its queued future must be removed and
    # the grant pass re-run). Floor 0 on purpose: with any floor > 0 a leaked
    # foreground waiter entry would be masked by the floor pass re-admitting
    # background anyway, and the leak would go undetected.
    async def cancel_scenario():
        gate = GATE(2, 0)
        rel = asyncio.Event()
        admitted3 = asyncio.Event()

        async def bg_hold():
            async with gate.admit(True):
                await rel.wait()

        async def fg():
            async with gate.admit(False):
                pass

        async def bg3():
            async with gate.admit(True):
                admitted3.set()

        b1 = asyncio.create_task(bg_hold())
        b2 = asyncio.create_task(bg_hold())
        await asyncio.sleep(0.05)  # both bg borrowed (2/2, all via idle borrow)
        f = asyncio.create_task(fg())
        await asyncio.sleep(0.05)  # fg waits -> borrowing latched off
        t3 = asyncio.create_task(bg3())
        await asyncio.sleep(0.05)  # bg3 blocked: fg waiting, bg at/above floor
        f.cancel()
        try:
            await f
        except asyncio.CancelledError:
            pass
        rel.set()  # slots free with NO foreground waiting any more
        await asyncio.wait_for(admitted3.wait(), 2)
        await asyncio.wait_for(asyncio.gather(b1, b2, t3), 5)
        return True

    print("CANCEL_SAFE", asyncio.run(cancel_scenario()))

    # Accounting under churn: 300 admissions (every third background) holding
    # for random sub-20ms intervals, with 120 of them cancelled at random —
    # cancels land before admission, after grant, and mid-hold. When the dust
    # settles every counter and both waiter lists must be EXACTLY zero: any
    # leak here compounds in production until admission capacity is gone.
    async def churn_scenario():
        gate = GATE(TOTAL, FLOOR)

        async def job(i):
            async with gate.admit(i % 3 == 0):
                await asyncio.sleep(random.uniform(0, 0.02))

        tasks = [asyncio.create_task(job(i)) for i in range(300)]
        await asyncio.sleep(0.05)
        for t in random.sample(tasks, 120):
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        return (
            gate._active,
            gate._background_active,
            len(gate._fg_waiters),
            len(gate._bg_waiters),
        )

    churn = asyncio.run(churn_scenario())
    print("CHURN_COUNTERS", churn)
    if churn != (0, 0, 0, 0):
        fail(
            f"borrow/return accounting leaked under churn: (active, "
            f"background_active, fg_waiters, bg_waiters) = {churn}, expected "
            f"all zero"
        )


# =====================================================================
# wiring: recall_async must admit through the shipping mechanism exactly
# once — structural (AST), because reaching it live needs a database.
# =====================================================================
recall_src = textwrap.dedent(inspect.getsource(MemoryEngine.recall_async))
tree = ast.parse(recall_src)
gate_calls = []
for n in ast.walk(tree):
    if isinstance(n, ast.AsyncWith):
        for item in n.items:
            c = item.context_expr
            if (
                isinstance(c, ast.Call)
                and isinstance(c.func, ast.Attribute)
                and c.func.attr == "admit"
                and isinstance(c.func.value, ast.Attribute)
                and c.func.value.attr == "_recall_admission_gate"
            ):
                gate_calls.append(c)
bare_or_strict = [
    item
    for n in ast.walk(tree)
    if isinstance(n, ast.AsyncWith)
    for item in n.items
    if (
        isinstance(item.context_expr, ast.Attribute)
        and item.context_expr.attr == "_search_semaphore"
    )
    or (
        isinstance(item.context_expr, ast.Call)
        and isinstance(item.context_expr.func, ast.Name)
        and item.context_expr.func.id == "_recall_admission"
    )
]
gate_args = [
    a.id if isinstance(a, ast.Name) else repr(getattr(a, "value", a))
    for c in gate_calls
    for a in c.args
]
print("GATE_CALLS", len(gate_calls), "OLD_ADMISSIONS", len(bare_or_strict), "GATE_ARGS", gate_args)
if MODE == "gate":
    if len(gate_calls) != 1 or bare_or_strict:
        fail("recall_async does not admit through the gate exactly once")
    # The ARGUMENT, pinned: admit(False) reverts the whole priority split while
    # the class, the init and the call site all survive.
    if gate_args != ["_background"]:
        fail(
            f"recall_async passes {gate_args!r} to the gate, expected the "
            f"caller's _background flag"
        )
    params = inspect.signature(MemoryEngine.recall_async).parameters
    if "_background" not in params or params["_background"].default is not False:
        fail("recall_async lost the _background parameter (default False)")


# =====================================================================
# #4212 preservation: the gate is the ADMISSION layer; the rerank-lane
# dual-signal invariants must survive it. Presence-conditional so the
# minimal split+gate arm stays runnable; the through-built arm asserts
# these GREEN.
# =====================================================================
reconcile = getattr(me, "_reconcile_rerank_priority", None)
print("RECONCILE_PRESENT", reconcile is not None)
if reconcile is not None:
    class _RC:
        def __init__(self, internal):
            self.internal = internal

    if reconcile(True, _RC(False)) is not True:
        fail("#4212 harmful mismatch no longer repairs to background priority")
    if reconcile(False, _RC(True)) is not True:
        fail("#4212 reflect divergence no longer reranks as background")
    if reconcile(False, _RC(False)) is not False:
        fail("#4212 normal recall no longer reranks as foreground")
    sw_src = inspect.getsource(MemoryEngine._search_with_retries)
    routed = "_reconcile_rerank_priority(_background, request_context)" in sw_src
    threaded = "_background=_background,  # switchroom #4212" in recall_src
    print("RERANK_ROUTES_THROUGH_HELPER", routed, "BG_THREADED", threaded)
    if not routed:
        fail("#4212 rerank site no longer routes through _reconcile_rerank_priority")
    if not threaded:
        fail("#4212 recall_async no longer forwards _background to _search_with_retries")

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
 * absent image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml`'s hindsight-probe job sets it after
 * pulling the pinned digest and building the through-built image.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

/** The through-built `switchroom-hindsight` image (every patch, in order). */
const BUILT_IMAGE = (process.env.SWITCHROOM_HINDSIGHT_BUILT_IMAGE ?? "").trim();

const dockerOk = hasDocker();
const upstreamOk = dockerOk && hasImage(UPSTREAM_IMAGE);
const builtOk = dockerOk && BUILT_IMAGE !== "" && hasImage(BUILT_IMAGE);

type ProbeResult = { status: number; stdout: string };

/**
 * Run the probe in a throwaway container from `image`, applying `blocks`
 * (extracted from the Dockerfile, in Dockerfile order) first. Each block is
 * self-verifying — a non-zero exit on application means upstream drifted and
 * the patch must be re-authored, surfaced here as a test failure.
 */
async function runProbe(image: string, role: string, blocks: string[]): Promise<ProbeResult> {
  const name = `sr-hs-wc-${role}-${RUN_ID.slice(0, 8)}`;
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
        image,
        "sleep",
        "300",
      ]);

    for (const block of blocks) {
      await execFileAsync("docker", ["exec", "-i", name, "python3", "-"], { input: block });
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

describe("Dockerfile.hindsight work-conserving admission probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts both admission patch blocks, in Dockerfile order", () => {
    const [split, wc] = patchBlocks([SPLIT_BLOCK, WC_BLOCK]);
    expect(split).toContain("async def _recall_admission(");
    expect(wc).toContain("class _RecallAdmissionGate:");
    // Order in the Dockerfile itself: the gate block's anchors are the split
    // block's output, so the split block must come first.
    expect(dockerfile.indexOf(SPLIT_BLOCK)).toBeGreaterThan(-1);
    expect(dockerfile.indexOf(WC_BLOCK)).toBeGreaterThan(
      dockerfile.indexOf(SPLIT_BLOCK)
    );
  });

  it("the #4212 admission-invariant asserts still stand in the Dockerfile", () => {
    // Requirement (c): the gate must not regress the dual-signal invariants.
    // Their build-time asserts run in the #3142/#4212 block BEFORE the gate
    // block; the gate block re-checks presence-preservation after its edits.
    expect(dockerfile).toContain(
      'assert "background_rerank = _reconcile_rerank_priority(_background, request_context)" in me,'
    );
    expect(dockerfile).toContain(
      'assert "_background=_background,  # switchroom #4212" in me,'
    );
    expect(dockerfile).toContain(
      '"_background=_background,  # switchroom #4212",'
    );
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
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
      upstreamOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite"
    ).toBe(true);
    expect(
      builtOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but no through-built hindsight image " +
        `is present (SWITCHROOM_HINDSIGHT_BUILT_IMAGE=${JSON.stringify(BUILT_IMAGE)}) — ` +
        "the workflow must build docker/Dockerfile.hindsight and export its tag"
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !upstreamOk)(
  "work-conserving recall-admission gate changes real behaviour",
  () => {
    afterAll(() => {
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

    it("unpatched upstream is RED: no priority — foreground queues FIFO behind the drain", async () => {
      const { status, stdout } = await runProbe(UPSTREAM_IMAGE, "upstream", []);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);
      expect(stdout).toContain("ADMISSION_MODE upstream");
      // Upstream's single FIFO semaphore IS work-conserving (background
      // reaches all 8 slots) …
      expect(stdout).toContain("WORK_CONSERVING_BG_PEAK 8");
      // … but has no priority: the foreground recall waits multiple full
      // recall durations behind the queued background wall.
      expect(stdout).toMatch(/PRIORITY_BG_INFLIGHT_AT_SUBMIT 8 FG_WAIT [2-9]\.\d+s/);
      expect(stdout).toContain("NO PRIORITY: a foreground recall waited");
    }, 240_000);

    it("the strict reservation (today's shipping behaviour) is RED: not work-conserving", async () => {
      const { status, stdout } = await runProbe(
        UPSTREAM_IMAGE,
        "strict",
        patchBlocks([SPLIT_BLOCK])
      );
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);
      expect(stdout).toContain("ADMISSION_MODE strict");
      // The defect this PR fixes: with ZERO foreground waiters, background is
      // still pinned at its reservation of 2 — 6 of 8 slots sit idle.
      expect(stdout).toContain("WORK_CONSERVING_BG_PEAK 2");
      expect(stdout).toContain(
        "NOT WORK-CONSERVING: with zero foreground recalls waiting, 20 queued " +
          "background recalls only reached 2 in flight"
      );
      // Priority itself is fine under the strict cap (that is what it bought).
      expect(stdout).toMatch(/PRIORITY_BG_INFLIGHT_AT_SUBMIT 2 FG_WAIT 0\.0\d+s/);
    }, 240_000);

    it("split + gate is GREEN: work-conserving AND priority AND every safety property", async () => {
      const { status, stdout } = await runProbe(
        UPSTREAM_IMAGE,
        "gate",
        patchBlocks([SPLIT_BLOCK, WC_BLOCK])
      );
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");
      expect(stdout).toContain("ADMISSION_MODE gate");

      // (a) Work-conserving: background reaches the full budget when nothing
      // foreground is waiting — the ~23h drain becomes a 8/2 = 4x wider pipe.
      expect(stdout).toContain("WORK_CONSERVING_BG_PEAK 8");
      // (b) Priority: with all 8 slots borrowed by background, one foreground
      // recall is admitted within one recall duration (< 2x = 1.0 s).
      expect(stdout).toMatch(/PRIORITY_BG_INFLIGHT_AT_SUBMIT 8 FG_WAIT 0\.[0-9]+s/);
      // One admission boundary, not two budgets.
      expect(stdout).toContain("TOTAL_CONCURRENCY_PEAK 8");
      // Deterministic floor, direction (i): the freed slot goes to the
      // waiting foreground when background is AT its floor, and background
      // gets in as soon as foreground stops waiting.
      expect(stdout).toContain(
        "FLOOR_NEITHER_ADMITTED_EARLY True FLOOR_FG_WON_SLOT True"
      );
      // Direction (ii), FLOOR LIVENESS: below its floor, under a standing
      // foreground queue that would absorb every freed slot, background is
      // admitted on the FIRST release — the floor is granted first, not dead
      // code. A foreground-first grant pass fails exactly this pin.
      expect(stdout).toContain(
        "FLOOR_LIVENESS_BG_ADMITTED True RELEASES_NEEDED 1"
      );
      // A cancelled foreground waiter cannot latch borrowing off.
      expect(stdout).toContain("CANCEL_SAFE True");
      // The borrow/return accounting is exact under churn with random
      // cancellations: every counter and waiter list back to zero.
      expect(stdout).toContain("CHURN_COUNTERS (0, 0, 0, 0)");
      // Wiring: exactly one gate admission, no old mechanism, the caller's
      // _background flag pinned as the argument.
      expect(stdout).toContain(
        "GATE_CALLS 1 OLD_ADMISSIONS 0 GATE_ARGS ['_background']"
      );
    }, 240_000);
  }
);

describe.skipIf(!dockerOk || !builtOk)(
  "through-built image: gate + #4212 invariants GREEN together",
  () => {
    afterAll(() => {
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

    it("the shipping bytes carry the gate AND preserve the #4212 rerank-lane invariants", async () => {
      const { status, stdout } = await runProbe(BUILT_IMAGE, "built", []);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");
      expect(stdout).toContain("ADMISSION_MODE gate");
      expect(stdout).toContain("WORK_CONSERVING_BG_PEAK 8");
      expect(stdout).toContain("TOTAL_CONCURRENCY_PEAK 8");
      // Requirement (c): the #4212 dual-signal invariants still hold in the
      // final image — reconciliation present, repairing, routed, threaded.
      expect(stdout).toContain("RECONCILE_PRESENT True");
      expect(stdout).toContain(
        "RERANK_ROUTES_THROUGH_HELPER True BG_THREADED True"
      );
    }, 240_000);
  }
);
