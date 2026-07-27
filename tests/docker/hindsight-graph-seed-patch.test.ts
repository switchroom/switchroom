/**
 * Behavioural proof for the upstream-#2968 graph-seed-reuse carry that
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * WHAT IS BEING CARRIED, AND WHY IT IS TEMPORARY. vectorize-io/hindsight PR
 * #2968 (merge b475f5cc, 2026-07-27T10:12:30Z) landed on upstream `main` AFTER
 * v0.8.5 — the digest this Dockerfile pins, and upstream's tip release — was
 * cut, so there is no release to upgrade to. The Dockerfile carries the diff as
 * a build-time patch until the base is >= v0.8.6, at which point the block and
 * this file are DELETED together.
 *
 * WHY A SHAPE TEST IS NOT ENOUGH. `dockerfile-hindsight-bakes.test.ts` pins the
 * patch block's literals, so it proves the patch is PRESENT, never that it
 * RUNS. The failure mode this file exists to catch is not an absent patch, it
 * is a patch that applies and silently NARROWS the graph seed set: hard-code
 * `graph_seed_threshold` to a non-None value and every literal the bakes test
 * greps for is still there, while any recall carrying
 * `min_scores.semantic > 0.3` quietly loses graph entry points. A quieter
 * recall is worse than a slower one, and only running the patched modules
 * catches it.
 *
 * THE FIVE PROPERTIES DRIVEN HERE, none of which the patch TEXT can show:
 *
 *  1. EQUIVALENCE — the seeds derived from the shared semantic/BM25 over-fetch
 *     pool are the SAME rows, in the same order, that the dedicated
 *     `_find_semantic_seeds` query returns from the same corpus. The probe runs
 *     both against one FakeConn that honours whatever floor/limit each SQL
 *     actually asks for (parsed out of the emitted SQL, not hand-fed), and
 *     compares ids. The corpus is sized so 22 rows clear the 0.3 floor while
 *     GRAPH_SEED_LIMIT is 20, so the cap BINDS; and the caller limit (the
 *     thinking budget) is 5, BELOW that cap, so a patch that trims the pool
 *     before deriving seeds loses 15 of them and this comparison goes red.
 *  2. THE CORRECTNESS GUARD — a per-request `min_scores.semantic` of 0.5,
 *     stricter than the 0.3 graph floor, must DECLINE reuse (`graph_seeds is
 *     None`) so the retriever falls back to its own query.
 *  3. OPT-OUT IS EXACT — a caller that passes no `graph_seed_min_similarity`
 *     (the consolidation dedup probe) gets the pre-#2968 behaviour unchanged.
 *  4. EMPTY IS AN ANSWER — `preselected_semantic_seeds=[]` means "no row
 *     cleared the floor" and must NOT re-trigger the scan; only `None` falls
 *     back. Conflating the two would reinstate the duplicate ANN query on every
 *     sparse-bank recall, i.e. exactly the cost the carry removes.
 *  5. THE UUID LOOKUP STAYS TOLERANT — `fetch_unit_dates` must stop casting the
 *     indexed `id` column (that cast is what forced the sequential scan) WITHOUT
 *     changing which inputs match. Uppercase, braced, unhyphenated and malformed
 *     ids matched nothing under `id::text` and must still match nothing; if they
 *     reached the new `::uuid` cast instead of being filtered out first, Postgres
 *     would raise 22P02 and fail the whole query.
 *
 * MEASUREMENT UPSTREAM CITES: the eliminated graph seed query accounted for
 * 302,602 calls / 2,072s of accumulated load, and the UUID lookup went
 * 120.049ms -> 0.240ms median (seq scan -> `pk_memory_units`).
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-retry-perturbation-patches.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass — and the probe runs each property in an isolated
 * section so the RED run reports all five rather than dying on the first.
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
const TEST_PHASE = "hindsight-graph-seed-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "graph-seed-reuse carry (upstream #2968)";

/**
 * The patch block under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by its unique patch name.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const hits = blocks.filter((b) => b.includes(PATCH_NAME));
  if (hits.length !== 1) {
    throw new Error(
      `Dockerfile.hindsight contains ${hits.length} "${PATCH_NAME}" RUN blocks ` +
        `(expected exactly 1) — if the carry was retired because the base image ` +
        `reached v0.8.6, delete this test with it.`,
    );
  }
  return hits;
}

/**
 * Python probe. Exits 0 only when all five properties above hold; prints the
 * offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES: it runs the real
 * `retrieve_semantic_bm25_combined` and the real
 * `LinkExpansionRetriever.retrieve` from the image against a stubbed
 * connection, and compares the seed ids the two code paths actually produce.
 * Nothing here greps the patched source.
 */
const PROBE = String.raw`
import asyncio
import json
import re
import sys
import uuid

failures = []


def fail(msg):
    failures.append(msg)


from hindsight_api.engine.search import retrieval as R
from hindsight_api.engine.search import link_expansion_retrieval as LE

# ── corpus ────────────────────────────────────────────────────────────────
# 30 observation rows, similarity strictly descending 0.95 -> 0.08. Exactly 22
# clear the 0.3 graph seed floor, so the GRAPH_SEED_LIMIT=20 cap BINDS: a patch
# that forgot the cap returns 22 and this probe goes red.
N = 30
IDS = [str(uuid.UUID(int=i)) for i in range(N)]
SIMS = [round(0.95 - 0.03 * i, 4) for i in range(N)]
ABOVE_FLOOR = [i for i in range(N) if SIMS[i] >= 0.3]

COLS = [
    "id", "text", "context", "event_date", "occurred_start", "occurred_end",
    "mentioned_at", "fact_type", "document_id", "chunk_id", "tags", "metadata",
    "proof_count",
]


def row(i, source):
    r = {c: None for c in COLS}
    r["id"] = IDS[i]
    r["text"] = "obs %d" % i
    r["fact_type"] = "observation"
    r["tags"] = []
    r["metadata"] = {}
    r["proof_count"] = 1
    r["similarity"] = SIMS[i]
    r["bm25_score"] = None
    r["source"] = source
    return r


class FakeConn:
    """Answers both queries off the SAME corpus, honouring the floors/limits
    each SQL actually asks for (parsed out of the SQL, not hand-fed), so the
    id-set comparison below is a real equivalence check."""

    backend_type = "postgresql"

    def __init__(self):
        self.queries = []
        self.seed_query_count = 0

    async def fetch(self, sql, *params):
        self.queries.append(sql)
        if "'semantic' AS source" in sql:
            m = re.search(r">= ([0-9.]+)", sql)
            lim = int(re.search(r"LIMIT (\d+)\)", sql).group(1))
            floor = float(m.group(1))
            sem = [row(i, "semantic") for i in range(N) if SIMS[i] >= floor][:lim]
            # a couple of BM25 rows so the source discriminator is exercised
            bm = [row(0, "bm25"), row(7, "bm25")]
            for b in bm:
                b["similarity"] = None
                b["bm25_score"] = 1.0
            return sem + bm
        if "LIMIT $5" in sql and ">= $4" in sql:
            self.seed_query_count += 1
            threshold, lim = params[3], params[4]
            return [row(i, "semantic") for i in range(N) if SIMS[i] >= threshold][:lim]
        raise AssertionError("unexpected SQL: " + sql[:200])


async def combined(conn, *, limit, min_semantic, graph_floor):
    return await R.retrieve_semantic_bm25_combined(
        conn,
        "[0,0,0]",
        "probe query text",
        "bank-probe",
        ["observation"],
        limit,
        min_semantic=min_semantic,
        graph_seed_min_similarity=graph_floor,
    )


async def section(label, fn):
    """Run one section in isolation. On unpatched upstream the very first call
    raises TypeError (no such kwarg), and the point of this probe is that the
    RED run still prints every marker rather than dying at line one."""
    try:
        await fn()
    except Exception as e:
        print("SECTION_RAISED", label, type(e).__name__, str(e).replace("\n", " ")[:200])
        fail("section %s raised %s: %s" % (label, type(e).__name__, e))


async def s1():
    # ── 1. the derived seeds ARE the dedicated query's rows ───────────────
    # limit=5 is a deliberately small thinking budget: below GRAPH_SEED_LIMIT,
    # so a patch that trims the pool to the caller limit before deriving seeds loses 15
    # of them and this comparison goes red.
    conn = FakeConn()
    got = await combined(conn, limit=5, min_semantic=None, graph_floor=LE.GRAPH_SEED_MIN_SIMILARITY)
    derived = got["observation"].graph_seeds
    dedicated = await LE._find_semantic_seeds(
        conn, "[0,0,0]", "bank-probe", "observation",
        limit=LE.GRAPH_SEED_LIMIT, threshold=LE.GRAPH_SEED_MIN_SIMILARITY,
    )
    d_ids = [s.id for s in derived]
    o_ids = [s.id for s in dedicated]
    print("DERIVED_SEEDS", len(d_ids))
    print("DEDICATED_SEEDS", len(o_ids))
    print("SEED_IDS_EQUAL", d_ids == o_ids)
    if d_ids != o_ids:
        fail("derived seed ids != dedicated query ids: %r vs %r" % (d_ids, o_ids))
    if len(d_ids) != LE.GRAPH_SEED_LIMIT:
        fail("expected the GRAPH_SEED_LIMIT cap to bind at %d, got %d"
             % (LE.GRAPH_SEED_LIMIT, len(d_ids)))
    if len(ABOVE_FLOOR) <= LE.GRAPH_SEED_LIMIT:
        fail("probe corpus is too small to exercise the seed cap")

    # the semantic arm itself is still trimmed to the caller's limit
    print("SEMANTIC_TRIMMED", len(got["observation"].semantic))
    if len(got["observation"].semantic) != 5:
        fail("semantic results not trimmed to limit: %d" % len(got["observation"].semantic))
    print("BM25_ROWS", len(got["observation"].bm25))
    if len(got["observation"].bm25) != 2:
        fail("bm25 rows lost: %d" % len(got["observation"].bm25))
    # every seed cleared the floor
    if any(s.similarity < LE.GRAPH_SEED_MIN_SIMILARITY for s in derived):
        fail("a derived seed is below the graph floor")


async def s2():
    # ── 2. the correctness guard: a stricter semantic floor DECLINES reuse ─
    conn2 = FakeConn()
    strict = await combined(conn2, limit=5, min_semantic=0.5,
                            graph_floor=LE.GRAPH_SEED_MIN_SIMILARITY)
    _g = strict["observation"].graph_seeds
    print("STRICT_FLOOR_GRAPH_SEEDS", "None" if _g is None else len(_g))
    if strict["observation"].graph_seeds is not None:
        fail("min_scores.semantic=0.5 > 0.3 still reused the narrowed pool — "
             "the graph seed set would be silently smaller than upstream's")


async def s3():
    # ── 3. pre-#2968 behaviour is preserved when the caller opts out ───────
    conn3 = FakeConn()
    optout = await combined(conn3, limit=5, min_semantic=None, graph_floor=None)
    _o = optout["observation"].graph_seeds
    print("OPTOUT_GRAPH_SEEDS", "None" if _o is None else len(_o))
    if optout["observation"].graph_seeds is not None:
        fail("graph seeds were derived even though the caller passed no floor")


async def s4():
    # ── 4. retrieve() honours preselection, and [] is NOT a fallback ───────
    r = LE.LinkExpansionRetriever()
    probes = {}

    async def spy(*a, **k):
        probes["seed_query"] = probes.get("seed_query", 0) + 1
        return []

    import inspect
    sig = inspect.signature(r.retrieve)
    print("RETRIEVE_ACCEPTS_PRESELECTED", "preselected_semantic_seeds" in sig.parameters)
    if "preselected_semantic_seeds" not in sig.parameters:
        fail("LinkExpansionRetriever.retrieve does not accept preselected_semantic_seeds")

    # Drive the real branch: an EMPTY preselected list must reach the expansion
    # step with zero seeds and never call _find_semantic_seeds.
    orig = LE._find_semantic_seeds
    LE._find_semantic_seeds = spy
    try:
        for label, preselected in (("empty", []), ("none", None)):
            probes.pop("seed_query", None)
            try:
                await r.retrieve(
                    FakeConnPool(), "[0,0,0]", "bank-probe", "observation", 10,
                    preselected_semantic_seeds=preselected,
                )
            except Exception as e:
                if type(e).__name__ not in ("StopProbe",):
                    fail("retrieve(%s) raised %s: %s" % (label, type(e).__name__, e))
            print("SEED_QUERY_CALLS_%s" % label.upper(), probes.get("seed_query", 0))
            if label == "empty" and probes.get("seed_query", 0) != 0:
                fail("an EMPTY preselected seed list fell back to a second ANN scan")
            if label == "none" and probes.get("seed_query", 0) != 1:
                fail("preselected=None did not fall back to the dedicated seed query")
    finally:
        LE._find_semantic_seeds = orig


async def s5():
    # ── 5. fetch_unit_dates is sargable, and keeps its old tolerance ───────
    from hindsight_api.engine.db import ops_postgresql as OPS
    captured = {}

    class SqlConn:
        backend_type = "postgresql"

        async def fetch(self, sql, *params):
            captured["sql"] = sql
            captured["params"] = params
            return []

    await OPS.PostgreSQLOps().fetch_unit_dates(SqlConn(), "memory_units", IDS[:2])
    sql = captured.get("sql", "")
    print("UNIT_DATES_CASTS_COLUMN", "id::text = ANY($1)" in sql)
    if "id::text = ANY($1)" in sql:
        fail("fetch_unit_dates still casts the indexed id column to text")
    if "WHERE id = ANY(" not in sql:
        fail("fetch_unit_dates does not compare the id column directly: " + sql[:300])
    m = re.search(r"unit_id ~ '(\^[^']+\$)'", sql)
    if not m:
        fail("no canonical-UUID pre-filter in fetch_unit_dates SQL")
    else:
        pat = re.compile(m.group(1).replace("$", r"\Z"))
        # must contain hex LETTERS, or the uppercase case is a no-op
        good = "abcdef01-2345-6789-abcd-ef0123456789"
        bad = [good.upper(), "{" + good + "}", good.replace("-", ""), "not-a-uuid", ""]
        kept = [bool(pat.search(good))] + [bool(pat.search(b)) for b in bad]
        print("UUID_FILTER_KEEPS", json.dumps(kept))
        if kept != [True, False, False, False, False, False]:
            fail("the pre-filter changed which inputs are accepted: %r" % kept)


async def main():
    for label, fn in (("1", s1), ("2", s2), ("3", s3), ("4", s4), ("5", s5)):
        await section(label, fn)
    print("FAILURES", failures)
    print("PROBE_EXECUTED")


class StopProbe(Exception):
    pass


class _Acq:
    def __init__(self, c):
        self.c = c

    async def __aenter__(self):
        return self.c

    async def __aexit__(self, *a):
        return False


class FakeConnPool:
    """Backend-shaped pool whose connection aborts the probe at the first
    expansion query — only the seeding branch is under test here."""

    _wraps_backend = True

    def acquire(self):
        return _Acq(_ExpansionConn())


class _ExpansionConn:
    backend_type = "postgresql"

    async def fetch(self, sql, *params):
        if "LIMIT $5" in sql and ">= $4" in sql:
            raise AssertionError("the raw seed SQL ran despite the spy")
        raise StopProbe()

    async def fetchrow(self, sql, *params):
        raise StopProbe()


asyncio.run(main())
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
  const name = `sr-hs-seed-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
        // The block is self-verifying: every anchor is exact-once and every
        // patched file is re-parsed, so a non-zero exit here means upstream
        // drifted (or adopted the change) and the carry must be re-authored or
        // retired. It can never silently no-op.
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

describe("Dockerfile.hindsight graph-seed probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the one carried patch block it claims to prove", () => {
    expect(patchBlocks()).toHaveLength(1);
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
  "the upstream-#2968 graph-seed-reuse carry changes real behaviour",
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

    it("unpatched upstream is RED — no seed reuse, and the id lookup casts the column", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // v0.8.5 has neither the shared seed constants nor the plumbing, so the
      // duplicate ANN scan is unconditional...
      expect(stdout).toContain("has no attribute 'GRAPH_SEED_MIN_SIMILARITY'");
      expect(stdout).toContain(
        "retrieve_semantic_bm25_combined() got an unexpected keyword argument 'graph_seed_min_similarity'",
      );
      expect(stdout).toContain("RETRIEVE_ACCEPTS_PRESELECTED False");
      // ...and fetch_unit_dates still casts the indexed column to text.
      expect(stdout).toContain("UNIT_DATES_CASTS_COLUMN True");
    }, 240_000);

    it("upstream + the carried patch block is GREEN on all five properties", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");
      expect(stdout).not.toContain("SECTION_RAISED");

      // 1. EQUIVALENCE, with the cap binding and the small thinking budget not
      //    starving the seed pool.
      expect(stdout).toContain("DERIVED_SEEDS 20");
      expect(stdout).toContain("DEDICATED_SEEDS 20");
      expect(stdout).toContain("SEED_IDS_EQUAL True");
      expect(stdout).toContain("SEMANTIC_TRIMMED 5");
      expect(stdout).toContain("BM25_ROWS 2");
      // 2. the correctness guard declines reuse under a stricter semantic floor
      expect(stdout).toContain("STRICT_FLOOR_GRAPH_SEEDS None");
      // 3. an opting-out caller (the consolidation dedup probe) is unaffected
      expect(stdout).toContain("OPTOUT_GRAPH_SEEDS None");
      // 4. [] is an answer; only None falls back to the dedicated ANN query
      expect(stdout).toContain("RETRIEVE_ACCEPTS_PRESELECTED True");
      expect(stdout).toContain("SEED_QUERY_CALLS_EMPTY 0");
      expect(stdout).toContain("SEED_QUERY_CALLS_NONE 1");
      // 5. the id lookup is sargable AND still ignores non-canonical inputs
      //    (canonical kept; uppercase / braced / unhyphenated / malformed /
      //    empty all rejected BEFORE the ::uuid cast that would raise 22P02).
      expect(stdout).toContain("UNIT_DATES_CASTS_COLUMN False");
      expect(stdout).toContain(
        "UUID_FILTER_KEEPS [true, false, false, false, false, false]",
      );
    }, 240_000);
  },
);
