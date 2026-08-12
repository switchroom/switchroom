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
 *     the bank is never swept at all.
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
 * box). In CI the `hindsight-probe` job pulls the pinned digest and sets
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
check("C_slice_count", getattr(gm, "_SWEEP_SLICE_COUNT", None) == 24,
      f"got {getattr(gm, '_SWEEP_SLICE_COUNT', None)}")
check("C_slice_seconds", getattr(gm, "_SWEEP_SLICE_SECONDS", None) == 1800,
      f"got {getattr(gm, '_SWEEP_SLICE_SECONDS', None)}")
check("C_max_pages", getattr(gm, "_SWEEP_MAX_PAGES", None) == 2000,
      f"got {getattr(gm, '_SWEEP_MAX_PAGES', None)}")

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
    """Records every Pass 3 call and replays a scripted list of pages."""

    def __init__(self, pages, timeout_on=()):
        self.pages = pages
        self.timeout_on = set(timeout_on)
        self.calls = []

    async def relink_pass(self, **kw):
        return {}

    async def prune_orphan_entities(self, **kw):
        return 0

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
    check("B2_slice_count_is_24", all(c.get("slice_count") == 24 for c in p3),
          f"slice_counts {[c.get('slice_count') for c in p3]}")
    check("B2_slice_index_in_range", all(0 <= (c.get("slice_index") or 0) < 24 for c in p3),
          f"slice_indexes {[c.get('slice_index') for c in p3]}")
    check("B2_slice_index_stable_within_run", len({c.get("slice_index") for c in p3}) == 1,
          "the slice index moved mid-run; the pages would cover different slices")

# --- B2b: the slice index rotates with the clock and covers EVERY slice.
# 24 consecutive 30-minute ticks must visit 0..23 exactly, or the bank is never
# fully covered and the rotating sweep silently leaks rows for ever.
real_time_mod = gm.time
seen = set()
try:
    for tick in range(24):
        gm.time = types.SimpleNamespace(time=(lambda t: (lambda: float(t)))(tick * 1800))
        s = FakeStore([page(0, 1, "z", "z")])
        guard("B2_rotation_job_runs", lambda: run_job(s))
        if s.calls:
            seen.add(s.calls[0].get("slice_index"))
finally:
    gm.time = real_time_mod
check("B2_slice_rotates_over_whole_bank", seen == set(range(24)),
      f"24 consecutive 30-min ticks covered slices {sorted(x for x in seen if x is not None)}, not 0..23")

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
    check("B3_retries_the_same_cursor",
          (p3[2].get("after_entity_id_1"), p3[2].get("after_entity_id_2"))
          == (p3[1].get("after_entity_id_1"), p3[1].get("after_entity_id_2")),
          "the cursor advanced past the page that timed out — those rows are skipped for ever")
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

print("PROBE_EXECUTED")
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

type ProbeResult = { status: number; stdout: string };

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

    if (patched) {
      for (const block of patchBlocks()) {
        // Each block is self-verifying: it asserts every upstream anchor exists
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
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
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
      // 24 consecutive 30-minute ticks visit slices 0..23 — i.e. the rotation
      // covers the WHOLE bank rather than resampling part of it.
      expect(stdout).toContain("B2_slice_rotates_over_whole_bank=OK");

      // B3 — a page that times out is halved and retried at the SAME cursor,
      // down to a floor, and then gives up instead of looping.
      expect(stdout).toContain("B3_halves_batch_size=OK");
      expect(stdout).toContain("B3_retries_the_same_cursor=OK");
      expect(stdout).toContain("B3_floor_then_raises=OK");
      expect(stdout).toContain("B3_halving_sequence=OK");

      // The constants are what this file's hard-coded expectations assume.
      expect(stdout).toContain("C_batch_size=OK");
      expect(stdout).toContain("C_min_batch_size=OK");
      expect(stdout).toContain("C_slice_count=OK");
      expect(stdout).toContain("C_slice_seconds=OK");
      expect(stdout).toContain("C_max_pages=OK");
    }, 240_000);
  },
);
