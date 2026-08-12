/**
 * Behavioural proof for the graph-maintenance BOUNDED SWEEP patch that
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED) and against upstream +
 * the patch blocks applied (must be GREEN). Nothing here greps the patched
 * source — every assertion drives real shipping code and observes what it does.
 *
 * TWO ARMS, because they prove different things:
 *
 *   1. the LOOP arm (`PROBE`) drives the real methods against a fake connection
 *      and a fake store, which is what lets it script timeouts and endless
 *      pages. It can see everything about the CALLER — and nothing about SQL
 *      semantics, since a fake connection never parses a statement;
 *   2. the SQL arm (`SQL_PROBE`) takes the statement the real shipping method
 *      builds and EXECUTES it against a real PostgreSQL on real rows. It is the
 *      only thing here that can prove the slice filter is a partition. A
 *      substring check cannot: `AND 0 * ('x' || substr(md5(…), 1, 4))::bit(16)
 *      ::int % $4::int = $5::int` contains every substring the arm-1 checks look
 *      for and collapses the entire bank into slice 0.
 *
 * THE DEFECT, in the real shipping source at the pinned digest.
 *
 * `graph_maintenance` Pass 3 (`prune_stale_cooccurrences`) is ONE bank-wide
 * statement whose cost grows with the bank. Measured read-only against this
 * fleet's live database on 2026-08-12:
 *
 *   bank      cooc rows   the predicate, READ-ONLY
 *   marko        60,890    3.4 s
 *   finn        159,076    8.2 s
 *   overlord    517,475   65.2 s   <- past the 60s asyncpg command_timeout
 *                                     BEFORE the sort, the locks and the DELETE
 *
 * So on the two largest banks the pass cannot finish, has never once finished,
 * and leaks stale cooccurrence rows for ever. The prior fix (#4604) removed the
 * 9x retry storm around it and the blank `error_message` it hid behind; it
 * deliberately did not make the statement finish. This one does.
 *
 * WHY THE SHAPE TEST IS NOT ENOUGH. Every property that actually bounds the
 * work is a property of BEHAVIOUR, invisible to grep:
 *
 *   - a `LIMIT` in the SQL text proves nothing unless the caller LOOPS — a
 *     single bounded page that never pages again silently stops pruning most of
 *     the bank while looking correct in the diff;
 *   - the keyset cursor must strictly ADVANCE, or the loop re-sweeps page one
 *     for ever and the job never terminates;
 *   - the shrink-on-timeout must retry the SAME cursor — a version that shrinks
 *     but advances skips exactly the rows it failed on, permanently;
 *   - the rotating slice must cover 0..N-1 over N consecutive runs, or part of
 *     the bank is never swept at all;
 *   - and the slice filter must actually PARTITION the bank — a filter that
 *     type-checks, greps clean and puts every row in one slice bounds nothing.
 *
 * Only running the patched modules distinguishes those. This probe drives the
 * REAL `PostgreSQLOps.prune_stale_cooccurrences` (against a fake connection
 * that captures the SQL and its bound parameters) and the REAL
 * `run_graph_maintenance_job` (against a fake store that records every Pass 3
 * call and scripts the pages it returns), rather than re-implementing either.
 *
 * The expected numbers below are HARD-CODED LITERALS, not reads of the module
 * constants they check — a fixture and an expectation derived from the same
 * constant cannot fail for any value of that constant. The probe asserts the
 * constants equal those literals AND that the loop behaves accordingly, so
 * changing a constant turns this test red on purpose.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. Note it
 * applies TWO: the bounded-sweep block anchors on text the #4604 retry-storm
 * block writes, so that block is its prerequisite and is applied first, in
 * Dockerfile order. It applies them by `docker exec` (not `docker build`) so it
 * runs on daemons without buildx, and it never touches the production
 * `switchroom-hindsight` container.
 *
 * SKIP DISCIPLINE: identical to
 * `hindsight-graph-maintenance-retry-storm.test.ts`. Locally, with no docker or
 * no cached image, this skips (never pull a 6.4GB third-party image onto a dev
 * box). In CI the `hindsight-probe` job pulls both pinned digests and sets
 * SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an unavailable
 * docker/image is a HARD FAILURE, never a green skip. Both runs assert a
 * `PROBE_EXECUTED` sentinel so a probe that dies early can never be mistaken
 * for a pass.
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
  "utf8",
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-graph-maintenance-bounded-sweep";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The blocks this file applies, named by their unique in-block markers, in the
 * order they must run. The retry-storm block is a PREREQUISITE, not a subject:
 * the bounded-sweep block anchors on the `_run_cooccurrence_prune` helper that
 * #4604 introduces, so applying it alone would fail its own anchor assertion.
 */
const PREREQUISITE_PATCH_NAME = "graph-maintenance retry-storm patch";
const PATCH_NAME = "graph-maintenance bounded sweep patch";

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
  for (const name of [PREREQUISITE_PATCH_NAME, PATCH_NAME]) {
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
  const [prereq, subject] = ordered;
  if (dockerfile.indexOf(prereq) > dockerfile.indexOf(subject)) {
    throw new Error(
      `"${PATCH_NAME}" must appear AFTER "${PREREQUISITE_PATCH_NAME}" in ` +
        `Dockerfile.hindsight — it anchors on text that block writes.`,
    );
  }
  return ordered;
}

/**
 * Python probe. Exits 0 only when every property holds; prints the offending
 * assertions otherwise. Every check prints a NAME=OK/FAIL line, and both the
 * RED and the GREEN case below assert on the same names, so the two runs are
 * compared on identical observations.
 */
const PROBE = String.raw`
"""Behavioural probe for the graph-maintenance bounded-sweep patch.

RED against unpatched upstream, GREEN against the patched image. Every check is
wrapped so an unpatched module raises a recorded FAILURE rather than aborting
the run — both directions must reach PROBE_EXECUTED, or a crash would be
indistinguishable from a red assertion.
"""

import asyncio
import contextlib
import sys
import types
from dataclasses import dataclass

failures = []


def check(name, cond, detail=""):
    print(f"{name}={'OK' if cond else 'FAIL'}")
    if not cond:
        failures.append(f"{name}: {detail}")


def guard(name, fn):
    """Run fn; a raised exception is that check's failure, not a crash."""
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - the point is to survive anything
        check(name, False, f"{type(e).__name__}: {e}")
        return None


# The patched page-result type; a stand-in keeps the unpatched run alive.
try:
    from hindsight_api.engine.db.ops import CooccurrenceSweepBatch

    HAS_BATCH_TYPE = True
except Exception:
    HAS_BATCH_TYPE = False

    @dataclass
    class CooccurrenceSweepBatch:  # type: ignore[no-redef]
        deleted: int
        scanned: int
        last_entity_id_1: "str | None"
        last_entity_id_2: "str | None"


check("T_page_result_type_exists", HAS_BATCH_TYPE,
      "hindsight_api.engine.db.ops has no CooccurrenceSweepBatch")

# The shrink handler catches the BUILTIN TimeoutError and relies on asyncpg's
# command_timeout raising something that IS it. True on 3.11+, false below, and
# asserted here rather than assumed — the comment beside the handler makes the
# claim, so something has to check it.
check("T_asyncio_timeout_is_builtin", asyncio.TimeoutError is TimeoutError,
      f"asyncio.TimeoutError is {asyncio.TimeoutError!r}, not the builtin — the "
      "shrink-on-timeout handler would not fire on a command_timeout")

# ══════════════════════════════ B1: the statement itself is LIMIT-bounded ════
from hindsight_api.engine.db.ops_postgresql import PostgreSQLOps


class FakeConn:
    def __init__(self, deleted=0, scanned=0, last=(None, None)):
        self.calls = []
        self._row = {
            "deleted": deleted,
            "scanned": scanned,
            "last_entity_id_1": last[0],
            "last_entity_id_2": last[1],
        }

    async def fetchrow(self, sql, *params):
        self.calls.append((sql, params))
        return dict(self._row)

    async def execute(self, sql, *params):  # the unpatched upstream path
        self.calls.append((sql, params))
        return "DELETE 0"


conn = FakeConn(deleted=3, scanned=7, last=("aa", "bb"))
batch = guard("B1_call_accepts_paging_args", lambda: asyncio.run(
    PostgreSQLOps().prune_stale_cooccurrences(
        conn, "ec", "ue", "ent", "bank-x",
        slice_count=24, slice_index=5, batch_size=250,
        after_entity_id_1="cur1", after_entity_id_2="cur2",
    )
))
sql, params = conn.calls[0] if conn.calls else ("", ())

check("B1_returns_batch", getattr(batch, "scanned", None) == 7 and getattr(batch, "deleted", None) == 3,
      f"got {batch!r}")
check("B1_returns_cursor",
      (getattr(batch, "last_entity_id_1", None), getattr(batch, "last_entity_id_2", None)) == ("aa", "bb"),
      f"got {batch!r}")
# The cap must be a BOUND PARAMETER: that proves it travels with the call rather
# than being frozen into the SQL text, which is what lets B3 shrink it.
check("B1_limit_is_bound", "LIMIT $" in sql, "no bound LIMIT in the page CTE")
check("B1_batch_size_bound", 250 in params, f"batch_size not among params {params!r}")
check("B1_slice_bound", 24 in params and 5 in params, f"slice not among params {params!r}")
check("B1_cursor_bound", "cur1" in params and "cur2" in params, f"cursor not among params {params!r}")
check("B1_keyset_predicate", "(c.entity_id_1, c.entity_id_2) >" in sql, "no keyset predicate")
check("B1_slice_predicate", "md5(c.entity_id_1::text)" in sql, "no hash-slice predicate")
# Unchanged upstream invariants — the fix must not buy its bound with these.
check("B1_keeps_intersect", "INTERSECT" in sql, "the #2473 INTERSECT predicate was rewritten")
check("B1_keeps_ordered_lock", "FOR UPDATE OF c" in sql, "the #2529 ordered lock is gone")

empty = FakeConn(deleted=0, scanned=0, last=(None, None))
b0 = guard("B1_empty_page_call", lambda: asyncio.run(
    PostgreSQLOps().prune_stale_cooccurrences(empty, "ec", "ue", "ent", "b", batch_size=250)
))
check("B1_empty_page_terminates",
      getattr(b0, "scanned", None) == 0 and getattr(b0, "last_entity_id_1", "x") is None,
      f"got {b0!r}")

# ══════════════════════════ constants: hard-coded here, not read from there ══
from hindsight_api.engine import graph_maintenance as gm

check("C_batch_size", getattr(gm, "_SWEEP_BATCH_SIZE", None) == 1000,
      f"got {getattr(gm, '_SWEEP_BATCH_SIZE', None)}")
check("C_min_batch_size", getattr(gm, "_SWEEP_MIN_BATCH_SIZE", None) == 50,
      f"got {getattr(gm, '_SWEEP_MIN_BATCH_SIZE', None)}")
check("C_slice_target_rows", getattr(gm, "_SWEEP_SLICE_TARGET_ROWS", None) == 25000,
      f"got {getattr(gm, '_SWEEP_SLICE_TARGET_ROWS', None)}")
check("C_max_slice_count", getattr(gm, "_SWEEP_MAX_SLICE_COUNT", None) == 24,
      f"got {getattr(gm, '_SWEEP_MAX_SLICE_COUNT', None)}")
check("C_slice_seconds", getattr(gm, "_SWEEP_SLICE_SECONDS", None) == 1800,
      f"got {getattr(gm, '_SWEEP_SLICE_SECONDS', None)}")
check("C_max_pages", getattr(gm, "_SWEEP_MAX_PAGES", None) == 2000,
      f"got {getattr(gm, '_SWEEP_MAX_PAGES', None)}")
check("C_no_fixed_slice_count", not hasattr(gm, "_SWEEP_SLICE_COUNT"),
      "a fixed _SWEEP_SLICE_COUNT is back; the slice count must be derived from bank size")

# ═════════════ S: the slice COUNT is a function of BANK SIZE, not a constant ══
# This job is DEMAND-DRIVEN (submit_async_graph_maintenance fires on enqueued
# work and short-circuits on an empty queue), so runs are uncorrelated with the
# wall clock the slice index comes from and coverage is coupon-collector: N*H(N)
# expected runs, not N. A fixed N therefore puts a bank that runs 0.3x/day on a
# ~300-day rotation. Slicing a bank that already sweeps whole inside the timeout
# buys nothing and costs exactly that, so it must not happen.
_sc = getattr(gm, "_sweep_slice_count", None)
check("S_slice_count_is_derived", callable(_sc),
      "graph_maintenance has no _sweep_slice_count(total_rows)")
if callable(_sc):
    # Literals, not arithmetic on the constants — an expectation computed from
    # the same constant it checks cannot fail for any value of that constant.
    check("S_unknown_size_sweeps_whole", _sc(0) == 1, f"got {_sc(0)}")
    check("S_tiny_bank_is_one_slice", _sc(1) == 1, f"got {_sc(1)}")
    check("S_at_target_is_one_slice", _sc(25000) == 1, f"got {_sc(25000)}")
    check("S_just_over_target_is_two", _sc(25001) == 2, f"got {_sc(25001)}")
    check("S_largest_live_bank_is_21", _sc(516563) == 21,
          f"overlord (516,563 rows) -> {_sc(516563)} slices, expected 21")
    check("S_quietest_live_bank_is_1", _sc(15443) == 1,
          f"lawgpt (15,443 rows) -> {_sc(15443)} slices; it sweeps whole in 4.7s and "
          "runs 0.3x/day, so slicing it is a ~300-day rotation for no benefit")
    check("S_slice_count_is_capped", _sc(10**9) == 24, f"got {_sc(10**9)}")

_si = getattr(gm, "_sweep_slice_index", None)
check("S_slice_index_is_pure", callable(_si) and _si(0.0, 24) == 0 and _si(1800.0, 24) == 1
      and _si(24 * 1800.0, 24) == 0 and _si(5 * 1800.0, 1) == 0,
      "graph_maintenance._sweep_slice_index(now, slice_count) is missing or is not the "
      "documented pure function of the clock")

# ══════════════════════════ B2/B3: the paging loop in the real job ═══════════
import hindsight_api.engine.memories as memories_mod
import hindsight_api.engine.memory_engine as memory_engine_mod


class LoopConn:
    @contextlib.asynccontextmanager
    async def transaction(self):
        yield


@contextlib.asynccontextmanager
async def fake_acquire(backend):
    yield LoopConn()


class FakeEngine:
    async def _get_backend(self):
        return object()


class FakeStore:
    """Records every Pass 3 call and replays a scripted list of pages.

    total_rows is what the job's bank-sizing call sees; it is what decides
    how many slices the bank is cut into. The default is a LARGE bank, so the
    paging cases below exercise the sliced path.
    """

    def __init__(self, pages, timeout_on=(), total_rows=516563):
        self.pages = pages
        self.timeout_on = set(timeout_on)
        self.total_rows = total_rows
        self.calls = []
        self.size_calls = 0

    async def relink_pass(self, **kw):
        return {}

    async def prune_orphan_entities(self, **kw):
        return 0

    async def count_bank_cooccurrences(self, **kw):
        self.size_calls += 1
        return self.total_rows

    async def prune_stale_cooccurrences(self, **kw):
        self.calls.append(kw)
        n = len(self.calls) - 1
        if n in self.timeout_on:
            raise TimeoutError()
        idx = sum(1 for i in range(n) if i not in self.timeout_on)
        if idx >= len(self.pages):
            return CooccurrenceSweepBatch(0, 0, None, None)
        return self.pages[idx]


def run_job(store):
    memories_mod.get_memories = lambda: store
    memory_engine_mod.acquire_with_retry = fake_acquire
    return asyncio.run(
        gm.run_graph_maintenance_job(FakeEngine(), "bank-x", None, operation_id="op-1")
    )


def page(deleted, scanned, k1, k2):
    return CooccurrenceSweepBatch(deleted, scanned, k1, k2)


# --- B2a: full pages page on, the cursor advances, a SHORT page ends the slice.
store = FakeStore([
    page(2, 1000, "k1a", "k1b"),
    page(0, 1000, "k2a", "k2b"),   # deleted nothing, but is NOT a short page
    page(5, 400, "k3a", "k3b"),    # short -> stop
])
res = guard("B2_job_runs", lambda: run_job(store)) or {}
p3 = store.calls
check("B2_pages_more_than_once", len(p3) == 3, f"made {len(p3)} Pass 3 call(s), expected 3")
check("B2_sums_deletions_across_pages", res.get("stale_cooccurrences_pruned") == 7,
      f"got {res.get('stale_cooccurrences_pruned')}, expected 2+0+5=7")
if len(p3) == 3:
    check("B2_first_call_has_no_cursor",
          p3[0].get("after_entity_id_1") is None and p3[0].get("after_entity_id_2") is None,
          f"got {p3[0].get('after_entity_id_1')!r}")
    check("B2_cursor_advances",
          (p3[1].get("after_entity_id_1"), p3[1].get("after_entity_id_2")) == ("k1a", "k1b")
          and (p3[2].get("after_entity_id_1"), p3[2].get("after_entity_id_2")) == ("k2a", "k2b"),
          f"cursors {[(c.get('after_entity_id_1'), c.get('after_entity_id_2')) for c in p3]}")
    check("B2_batch_size_is_1000", all(c.get("batch_size") == 1000 for c in p3),
          f"sizes {[c.get('batch_size') for c in p3]}")
    check("B2_sizes_the_bank_once", store.size_calls == 1,
          f"the bank was sized {store.size_calls} time(s); it must be once per run, "
          "not once per page")
    check("B2_slice_count_matches_bank_size", all(c.get("slice_count") == 21 for c in p3),
          f"a 516,563-row bank got slice_counts {[c.get('slice_count') for c in p3]}, expected 21")
    check("B2_slice_index_in_range", all(0 <= (c.get("slice_index") or 0) < 21 for c in p3),
          f"slice_indexes {[c.get('slice_index') for c in p3]}")
    check("B2_slice_index_stable_within_run", len({c.get("slice_index") for c in p3}) == 1,
          "the slice index moved mid-run; the pages would cover different slices")

# --- B2b: A SMALL BANK IS NEVER SLICED. The regression this guards is not
# hypothetical: a fixed slice count moves every quiet bank on this fleet from
# "swept whole every run, in 2.7-4.3 s" to a rotation of 13-302 days, to fix a
# timeout only the two largest banks ever had.
small = FakeStore([page(0, 5, None, None)], total_rows=25000)
guard("B2_small_bank_job_runs", lambda: run_job(small))
check("B2_small_bank_swept_whole",
      bool(small.calls) and all(c.get("slice_count") == 1 for c in small.calls),
      f"a 25,000-row bank got slice_counts {[c.get('slice_count') for c in small.calls]}, "
      "expected 1 (the whole bank, every run)")
check("B2_small_bank_slice_index_is_0",
      bool(small.calls) and all(c.get("slice_index") == 0 for c in small.calls),
      f"slice_indexes {[c.get('slice_index') for c in small.calls]}")

# --- B2c: on a bank big enough to slice, the index rotates with the clock and
# reaches every slice. This is a property of the INDEX, not a coverage
# guarantee: the job is demand-driven, so consecutive runs do not land on
# consecutive ticks (see the S_ checks above).
real_time_mod = gm.time
seen = set()
try:
    for tick in range(21):
        gm.time = types.SimpleNamespace(time=(lambda t: (lambda: float(t)))(tick * 1800))
        s = FakeStore([page(0, 1, "z", "z")])
        guard("B2_rotation_job_runs", lambda: run_job(s))
        if s.calls:
            seen.add(s.calls[0].get("slice_index"))
finally:
    gm.time = real_time_mod
check("B2_slice_rotates_over_whole_bank", seen == set(range(21)),
      f"21 consecutive 30-min ticks on a 21-slice bank covered slices "
      f"{sorted(x for x in seen if x is not None)}, not 0..20")

# --- B3: a page timeout HALVES the page and retries the SAME cursor.
store = FakeStore(
    [page(0, 1000, "k1a", "k1b"), page(1, 10, "k2a", "k2b")],
    timeout_on={1},   # first attempt at the 2nd page times out
)
res = guard("B3_job_runs", lambda: run_job(store)) or {}
p3 = store.calls
check("B3_retried_after_timeout", len(p3) == 3, f"made {len(p3)} call(s), expected 3")
if len(p3) == 3:
    check("B3_halves_batch_size", p3[2].get("batch_size") == 500,
          f"retried at batch_size={p3[2].get('batch_size')}, expected 1000//2=500")
    # Against the LITERAL cursor the first page returned, not against the other
    # observation: comparing two observations to each other passes vacuously if
    # both are None, which is exactly what an unpatched/broken loop produces.
    check("B3_retries_the_same_cursor",
          (p3[1].get("after_entity_id_1"), p3[1].get("after_entity_id_2")) == ("k1a", "k1b")
          and (p3[2].get("after_entity_id_1"), p3[2].get("after_entity_id_2")) == ("k1a", "k1b"),
          f"the timed-out page was at {(p3[1].get('after_entity_id_1'), p3[1].get('after_entity_id_2'))} "
          f"and the retry ran at {(p3[2].get('after_entity_id_1'), p3[2].get('after_entity_id_2'))}; "
          "both must be the literal ('k1a', 'k1b') the first page returned, or those rows "
          "are skipped for ever")
    check("B3_shrunk_page_still_counted", res.get("stale_cooccurrences_pruned") == 1,
          f"got {res.get('stale_cooccurrences_pruned')}")

# --- B3b: the shrink has a FLOOR, and then gives up instead of looping.
store = FakeStore([], timeout_on=set(range(200)))
raised = None
try:
    run_job(store)
except TimeoutError as e:
    raised = e
except Exception as e:  # noqa: BLE001
    raised = e
sizes = [c.get("batch_size") for c in store.calls]
check("B3_floor_then_raises", isinstance(raised, TimeoutError),
      f"an always-timing-out page raised {raised!r} instead of TimeoutError")
check("B3_halving_sequence", sizes == [1000, 500, 250, 125, 62, 50],
      f"got {sizes}, expected 1000 halving to the floor of 50")


# --- B4: the _SWEEP_MAX_PAGES tripwire actually fires, and the job RETURNS.
# Previously nothing in any suite executed this branch. A store that hands back
# a full page with a fresh cursor for ever is the non-advancing-cursor shape it
# exists to catch; without it the loop would never terminate.
class EndlessStore(FakeStore):
    async def prune_stale_cooccurrences(self, **kw):
        self.calls.append(kw)
        n = len(self.calls)
        return CooccurrenceSweepBatch(1, 1000, f"k{n}a", f"k{n}b")


endless = EndlessStore([])
res = guard("B4_job_runs", lambda: run_job(endless)) or {}
check("B4_tripwire_stops_the_loop", len(endless.calls) == 2000,
      f"the loop made {len(endless.calls)} page call(s); _SWEEP_MAX_PAGES is 2000")
check("B4_tripwire_returns_not_raises", res.get("stale_cooccurrences_pruned") == 2000,
      f"got {res.get('stale_cooccurrences_pruned')}; the tripwire must return the rows it "
      "did prune, not discard them")

print("PROBE_EXECUTED")
for f in failures:
    print("FAILURE:", f)
sys.exit(1 if failures else 0)
`;

/**
 * Postgres for the SQL arm, digest-pinned like the upstream image so the proof
 * cannot drift under a moving tag. 18-alpine: same major as the pg0 build the
 * fleet runs (18.1), and every construct under test — `md5`, `substr`,
 * `::bit(16)`, `INTERSECT`, `FOR UPDATE OF`, row-wise `>` — is long-stable.
 */
const PG_IMAGE =
  "postgres@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const PG_USER = "probe";
const PG_DB = "probe";
/** Throwaway container on a private netns; never reachable off the host. */
const PG_PASSWORD = "probe";

/**
 * SQL arm. Takes the statement the REAL shipping
 * `PostgreSQLOps.prune_stale_cooccurrences` builds and EXECUTES it against a
 * real PostgreSQL, on real tables, with real rows. Every assertion below is a
 * count Postgres computed — nothing here inspects the SQL as a string.
 *
 * It exists because substring checks cannot prove a partition, and the
 * partition is the property the whole rotation rests on. This mutation
 *
 *     AND 0 * ('x' || substr(md5(c.entity_id_1::text), 1, 4))::bit(16)::int
 *         % $4::int = $5::int
 *
 * contains every substring a grep-style check looks for, collapses the entire
 * bank into slice 0 and empties slices 1..23 — i.e. destroys the sweep — and
 * was green against the string-only probe. Under this arm it fails
 * SLICES_ARE_NONEMPTY, SLICE_IS_A_PROPER_SUBSET and SLICES_ARE_BALANCED.
 */
const SQL_PROBE = String.raw`
"""Executable partition proof for the bounded-sweep slice filter."""

import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/api")

import asyncpg

failures = []


def check(name, cond, detail=""):
    print(f"{name}={'OK' if cond else 'FAIL'}")
    if not cond:
        failures.append(f"{name}: {detail}")


from hindsight_api.engine.db.ops_postgresql import PostgreSQLOps


class CaptureConn:
    """Records the statement the real method builds; returns a canned row."""

    def __init__(self):
        self.sql = None

    async def fetchrow(self, sql, *params):
        self.sql = sql
        return {"deleted": 0, "scanned": 0, "last_entity_id_1": None, "last_entity_id_2": None}


cap = CaptureConn()
asyncio.run(
    PostgreSQLOps().prune_stale_cooccurrences(
        cap, "entity_cooccurrences", "unit_entities", "entities", "b",
        slice_count=1, slice_index=0, batch_size=1,
    )
)
SWEEP_SQL = cap.sql
check("SQL_captured_from_shipping_code", bool(SWEEP_SQL) and "WITH page" in (SWEEP_SQL or ""),
      f"got {SWEEP_SQL!r}")

BANK = "probe-bank"
OTHER = "other-bank"
N_ENT = 1200
FANOUT = 8
SLICES = 24

SCHEMA = """
DROP TABLE IF EXISTS entity_cooccurrences, unit_entities, entities;
CREATE TABLE entities (id uuid PRIMARY KEY, bank_id text NOT NULL);
CREATE TABLE unit_entities (unit_id uuid NOT NULL, entity_id uuid NOT NULL);
CREATE TABLE entity_cooccurrences (
    entity_id_1 uuid NOT NULL,
    entity_id_2 uuid NOT NULL,
    PRIMARY KEY (entity_id_1, entity_id_2),
    CONSTRAINT entity_cooccurrence_order_check CHECK (entity_id_1 < entity_id_2)
);
CREATE INDEX ON unit_entities (entity_id, unit_id);
CREATE INDEX ON entities (bank_id);
"""


def ids(bank, n):
    """Deterministic uuids, so any failure is reproducible."""
    ns = uuid.uuid5(uuid.NAMESPACE_DNS, bank)
    return sorted(str(uuid.uuid5(ns, str(i))) for i in range(n))


async def seed(conn):
    await conn.execute(SCHEMA)
    out = {}
    for bank in (BANK, OTHER):
        ent = ids(bank, N_ENT)
        await conn.executemany(
            "INSERT INTO entities (id, bank_id) VALUES ($1, $2)", [(e, bank) for e in ent]
        )
        pairs = [
            (a, ent[i + j])
            for i, a in enumerate(ent)
            for j in range(1, FANOUT + 1)
            if i + j < len(ent)
        ]
        await conn.executemany(
            "INSERT INTO entity_cooccurrences (entity_id_1, entity_id_2) VALUES ($1, $2)", pairs
        )
        # Every 3rd pair is WITNESSED by a live unit; the other two thirds are
        # exactly the stale-count rows this pass exists to remove.
        witnessed = []
        for k, (a, b) in enumerate(pairs):
            if k % 3 == 0:
                u = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{bank}/{k}"))
                witnessed += [(u, a), (u, b)]
        await conn.executemany(
            "INSERT INTO unit_entities (unit_id, entity_id) VALUES ($1, $2)", witnessed
        )
        out[bank] = (len(pairs), sum(1 for k in range(len(pairs)) if k % 3 != 0))
    return out


async def run_page(conn, slice_count, slice_index, batch, a1=None, a2=None):
    """One page of the shipping statement, ROLLED BACK so the next call sees
    the same rows — the statement deletes, and these are comparisons."""
    tx = conn.transaction()
    await tx.start()
    try:
        return dict(await conn.fetchrow(SWEEP_SQL, BANK, a1, a2, slice_count, slice_index, batch))
    finally:
        await tx.rollback()


async def bank_count(conn, bank):
    return await conn.fetchval(
        "SELECT count(*) FROM entity_cooccurrences c JOIN entities e ON e.id = c.entity_id_1 "
        "WHERE e.bank_id = $1",
        bank,
    )


async def main():
    conn = await asyncpg.connect(os.environ["PROBE_DSN"])
    try:
        sizes = await seed(conn)
        total, stale_total = sizes[BANK]

        # ── THE SLICES PARTITION THE BANK ────────────────────────────────────
        # batch >> any slice, so scanned is the slice's whole size and paging
        # cannot confound the counts.
        BIG = 10 ** 9
        scanned = [ (await run_page(conn, SLICES, i, BIG))["scanned"] for i in range(SLICES) ]

        check("SLICES_COVER_THE_BANK_EXACTLY_ONCE", sum(scanned) == total,
              f"the slices scanned {sum(scanned)} rows; the bank has {total}")
        check("SLICES_ARE_NONEMPTY", all(s > 0 for s in scanned),
              f"empty slices at {[i for i, s in enumerate(scanned) if s == 0]}: {scanned}")
        check("SLICE_IS_A_PROPER_SUBSET", all(0 < s < total for s in scanned),
              f"a single slice covered the whole bank: {scanned}")
        # Evenness. A filter that partitions but is wildly lopsided puts the
        # timeout back on whichever run draws the big slice.
        check("SLICES_ARE_BALANCED", max(scanned) <= 4 * max(1, min(scanned)),
              f"min {min(scanned)}, max {max(scanned)} over {SLICES} slices: {scanned}")

        whole = await run_page(conn, 1, 0, BIG)
        check("SLICE_COUNT_1_IS_THE_WHOLE_BANK", whole["scanned"] == total,
              f"scanned {whole['scanned']} of {total} — the small-bank path is not the whole bank")

        # ── THE PAGE DELETES THE STALE ROWS, ONLY THOSE, ONLY IN THIS BANK ───
        tx = conn.transaction()
        await tx.start()
        try:
            r = await conn.fetchrow(SWEEP_SQL, BANK, None, None, 1, 0, BIG)
            left_here = await bank_count(conn, BANK)
            left_other = await bank_count(conn, OTHER)
            check("DELETES_EXACTLY_THE_STALE_ROWS", r["deleted"] == stale_total,
                  f"deleted {r['deleted']}, expected the {stale_total} stale of {total}")
            check("WITNESSED_ROWS_SURVIVE", left_here == total - stale_total,
                  f"{left_here} rows left, expected {total - stale_total}")
            check("OTHER_BANKS_UNTOUCHED", left_other == sizes[OTHER][0],
                  f"{left_other} rows left in {OTHER}, expected {sizes[OTHER][0]}")
        finally:
            await tx.rollback()

        # ── REAL PAGING: the pages TILE their slice, no gap and no overlap ───
        BATCH = 25
        a1 = a2 = None
        seen = pages = 0
        cursors = []
        while True:
            r = await run_page(conn, SLICES, 3, BATCH, a1, a2)
            pages += 1
            seen += r["scanned"]
            if r["scanned"] < BATCH or r["last_entity_id_1"] is None:
                break
            a1, a2 = str(r["last_entity_id_1"]), str(r["last_entity_id_2"])
            cursors.append((a1, a2))
            if pages > 500:
                break
        check("PAGES_TILE_THE_SLICE", seen == scanned[3],
              f"paging saw {seen} rows; the same slice unpaged has {scanned[3]}")
        check("CURSOR_STRICTLY_ADVANCES", cursors == sorted(set(cursors)),
              f"the cursor did not advance strictly: {cursors[:6]}")
        check("PAGING_TERMINATES", pages <= 500, f"{pages} pages and still going")

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

/**
 * Run a docker command, folding stderr into the returned text.
 *
 * Load-bearing: when a patch block stops applying, ALL the diagnosis is on
 * stderr (the block's own assertion message names the drifted anchor). Dropping
 * it turns that into `expected '' to contain 'PROBE_EXECUTED'` with no cause.
 */
function dockerText(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
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
 * the patch must be re-authored — and the message is on the stderr `dockerText`
 * preserves.
 */
function applyPatches(container: string): void {
  for (const block of patchBlocks()) {
    dockerText(["exec", "-i", container, "python3", "-"], block);
  }
}

/** Run the probe in a throwaway container, optionally patching first. */
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-gmsweep-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8,
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
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    if (patched) applyPatches(name);

    const res = dockerText(
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      PROBE,
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number };
    return { status: err.status ?? -1, stdout: errText(e) };
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
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
function runSqlProbe(): ProbeResult {
  const tag = RUN_ID.slice(0, 8);
  const pg = `sr-hs-gmsweep-pg-${tag}`;
  const app = `sr-hs-gmsweep-sql-${tag}`;
  const labels = [
    "--label",
    `switchroom.test=${TEST_PHASE}`,
    "--label",
    `switchroom.test.run=${RUN_ID}-sql`,
  ];
  try {
    execFileSync(
      "docker",
      [
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
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    // Readiness: pg_isready, not a fixed sleep.
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        execFileSync("docker", ["exec", pg, "pg_isready", "-U", PG_USER], {
          stdio: "ignore",
        });
        ready = true;
        break;
      } catch {
        execFileSync("sleep", ["1"], { stdio: "ignore" });
      }
    }
    if (!ready) {
      return { status: -1, stdout: `postgres never became ready:\n${dockerLogs(pg)}` };
    }

    execFileSync(
      "docker",
      [
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
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    applyPatches(app);

    const out = dockerText(
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
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
  }
}

function dockerLogs(name: string): string {
  try {
    return dockerText(["logs", "--tail", "40", name]);
  } catch (e) {
    return errText(e);
  }
}

describe("Dockerfile.hindsight bounded-sweep probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts the subject block and its prerequisite, in Dockerfile order", () => {
    const blocks = patchBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain(PREREQUISITE_PATCH_NAME);
    expect(blocks[1]).toContain(PATCH_NAME);
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
        "the SQL arm is the only executable proof that the slice filter partitions " +
        "the bank, so CI must pull this digest too",
    ).toBe(true);
  });

  it("pins the SQL arm's Postgres by digest as well", () => {
    expect(PG_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight bounded-sweep patch changes real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" },
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

    it("unpatched upstream is RED — one unbounded statement, no paging, no shrink", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The statement is unbounded: no page result type, and no way to even ASK
      // for a bounded page.
      expect(stdout).toContain("T_page_result_type_exists=FAIL");
      expect(stdout).toContain("B1_call_accepts_paging_args=FAIL");
      expect(stdout).toContain("unexpected keyword argument 'slice_count'");
      expect(stdout).toContain("B1_limit_is_bound=FAIL");

      // The job calls Pass 3 exactly ONCE and never pages, which is the fault.
      expect(stdout).toContain("B2_pages_more_than_once=FAIL");
      expect(stdout).toContain("made 1 Pass 3 call(s), expected 3");

      // Nothing rotates: every run sweeps the whole bank, which is why the
      // largest banks time out on every single run.
      expect(stdout).toContain("B2_slice_rotates_over_whole_bank=FAIL");

      // There is no size-derived slice count upstream — no helper at all.
      expect(stdout).toContain("S_slice_count_is_derived=FAIL");
      expect(stdout).toContain("C_slice_target_rows=FAIL");

      // Nothing bounds the page loop, because there is no page loop.
      expect(stdout).toContain("B4_tripwire_stops_the_loop=FAIL");

      // A timeout is fatal to the pass — there is no page to shrink.
      expect(stdout).toContain("B3_retried_after_timeout=FAIL");
      expect(stdout).toContain("B3_halving_sequence=FAIL");
    }, 240_000);

    it("patched is GREEN — bounded pages, an advancing cursor, a rotating slice, a shrinking retry", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(stdout, `probe reported failures:\n${stdout}`).not.toContain(
        "FAILURE:",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).not.toContain("=FAIL");

      // B1 — the statement is bounded by a BOUND parameter, and the bound
      // travels with the call (which is what lets B3 shrink it).
      expect(stdout).toContain("B1_limit_is_bound=OK");
      expect(stdout).toContain("B1_batch_size_bound=OK");
      expect(stdout).toContain("B1_keyset_predicate=OK");
      expect(stdout).toContain("B1_slice_predicate=OK");
      // The bound must not have been bought by weakening the sweep.
      expect(stdout).toContain("B1_keeps_intersect=OK");
      expect(stdout).toContain("B1_keeps_ordered_lock=OK");

      // B2 — the caller really pages, the cursor really advances, and only a
      // SHORT page ends the slice (a page that deleted nothing does not).
      expect(stdout).toContain("B2_pages_more_than_once=OK");
      expect(stdout).toContain("B2_cursor_advances=OK");
      expect(stdout).toContain("B2_sums_deletions_across_pages=OK");
      expect(stdout).toContain("B2_slice_index_stable_within_run=OK");
      // Consecutive 30-minute ticks visit every slice — i.e. the rotation
      // covers the WHOLE bank rather than resampling part of it.
      expect(stdout).toContain("B2_slice_rotates_over_whole_bank=OK");

      // S — how many slices is DERIVED FROM BANK SIZE, which is the whole
      // reason a quiet bank is not condemned to a 24-run coupon-collector
      // wait for a sweep it used to get on every run.
      expect(stdout).toContain("S_slice_count_is_derived=OK");
      expect(stdout).toContain("S_tiny_bank_is_one_slice=OK");
      expect(stdout).toContain("S_at_target_is_one_slice=OK");
      expect(stdout).toContain("S_just_over_target_is_two=OK");
      expect(stdout).toContain("S_largest_live_bank_is_21=OK");
      expect(stdout).toContain("S_quietest_live_bank_is_1=OK");
      expect(stdout).toContain("S_slice_count_is_capped=OK");
      expect(stdout).toContain("S_slice_index_is_pure=OK");
      // …and the caller really uses it: it sizes the bank once per run and
      // the slice index it derives stays inside the derived range.
      expect(stdout).toContain("B2_sizes_the_bank_once=OK");
      expect(stdout).toContain("B2_slice_count_matches_bank_size=OK");
      expect(stdout).toContain("B2_slice_index_in_range=OK");
      // The small-bank regression the review named: a 25k bank is swept WHOLE,
      // every run, exactly as it was before this change.
      expect(stdout).toContain("B2_small_bank_swept_whole=OK");
      expect(stdout).toContain("B2_small_bank_slice_index_is_0=OK");

      // B3 — a page that times out is halved and retried at the SAME cursor,
      // down to a floor, and then gives up instead of looping.
      expect(stdout).toContain("B3_halves_batch_size=OK");
      expect(stdout).toContain("B3_retries_the_same_cursor=OK");
      expect(stdout).toContain("B3_floor_then_raises=OK");
      expect(stdout).toContain("B3_halving_sequence=OK");
      expect(stdout).toContain("B3_shrunk_page_still_counted=OK");

      // B4 — the page-count tripwire actually FIRES on a store that never runs
      // out of pages, and returns rather than raising.
      expect(stdout).toContain("B4_tripwire_stops_the_loop=OK");
      expect(stdout).toContain("B4_tripwire_returns_not_raises=OK");

      // The constants are what this file's hard-coded expectations assume.
      expect(stdout).toContain("C_batch_size=OK");
      expect(stdout).toContain("C_min_batch_size=OK");
      expect(stdout).toContain("C_slice_target_rows=OK");
      expect(stdout).toContain("C_max_slice_count=OK");
      expect(stdout).toContain("C_slice_seconds=OK");
      expect(stdout).toContain("C_max_pages=OK");
      expect(stdout).toContain("C_no_fixed_slice_count=OK");

      // asyncio.TimeoutError IS the builtin on this interpreter — the `except
      // TimeoutError` the patch installs only catches the command timeout
      // because that identity holds.
      expect(stdout).toContain("T_asyncio_timeout_is_builtin=OK");
    }, 240_000);
  },
);

describe.skipIf(!dockerOk || !imageOk || !pgOk)(
  "the slice filter really partitions the bank (executed SQL, real Postgres)",
  () => {
    afterAll(() => {
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}-sql`,
          { encoding: "utf8" },
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

    it("executes the shipping statement against real rows", () => {
      const { status, stdout } = runSqlProbe();
      expect(stdout, `SQL probe did not run to completion:\n${stdout}`).toContain(
        "SQL_PROBE_EXECUTED",
      );
      expect(stdout, `SQL probe reported failures:\n${stdout}`).not.toContain(
        "FAILURE:",
      );
      expect(status, `SQL probe failed:\n${stdout}`).toBe(0);

      // The statement under test came from the shipping class, not a copy.
      expect(stdout).toContain("SQL_captured_from_shipping_code=OK");

      // THE partition property. `AND 0 * (…hash…) % $4 = $5` keeps every
      // substring a grep-style check looks for and fails all three of these.
      expect(stdout).toContain("SLICES_COVER_THE_BANK_EXACTLY_ONCE=OK");
      expect(stdout).toContain("SLICES_ARE_NONEMPTY=OK");
      expect(stdout).toContain("SLICE_IS_A_PROPER_SUBSET=OK");
      expect(stdout).toContain("SLICES_ARE_BALANCED=OK");
      expect(stdout).toContain("SLICE_COUNT_1_IS_THE_WHOLE_BANK=OK");

      // Slicing did not change WHAT the sweep deletes.
      expect(stdout).toContain("DELETES_EXACTLY_THE_STALE_ROWS=OK");
      expect(stdout).toContain("WITNESSED_ROWS_SURVIVE=OK");
      expect(stdout).toContain("OTHER_BANKS_UNTOUCHED=OK");

      // Real keyset paging over real rows: no gap, no overlap, it terminates.
      expect(stdout).toContain("PAGES_TILE_THE_SLICE=OK");
      expect(stdout).toContain("CURSOR_STRICTLY_ADVANCES=OK");
      expect(stdout).toContain("PAGING_TERMINATES=OK");
    }, 600_000);
  },
);
