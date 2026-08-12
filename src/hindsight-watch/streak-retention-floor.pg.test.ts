/**
 * #4620, end to end against a REAL PostgreSQL: a pair whose completions were
 * swept by the retention prune, and whose failures were kept, must not page.
 *
 * ### Why this test needs a database
 *
 * The defect lives in SQL and nowhere else. `docker/hindsight-maintenance.sh`
 * deletes `status='completed'` rows past the retention horizon and never
 * touches `failed` ones, so the two halves of a streak age differently. With
 * an unbounded failure scan the streak query then counts
 * failures that predate a completion which no longer exists: the pair reports a
 * large streak with no visible success, the evaluator's null arm cannot
 * discriminate it (those failures are ancient by construction — that is the
 * whole point), and nothing will ever complete to clear the page.
 *
 * Every cheaper layer is blind to this. A fixture fed to `probeBankConsolidation`
 * asserts the PARSER; a fixture fed to `evaluateConsolidationFailureStreak`
 * asserts the EVALUATOR; neither can see which rows PostgreSQL actually
 * aggregates, which is the only thing that decides the outcome. So this test
 * seeds real rows, runs the real statement, and carries the result through the
 * real parser into the real evaluator.
 *
 * ### Both arms run
 *
 * The floored query (GREEN) and the pre-#4620 unbounded one (RED) run against
 * the SAME seeded rows. The RED arm is the mutation, built in: it is the exact
 * pre-fix semantics this PR replaced, reproduced by handing the query builder
 * a floor so wide it cannot bind, and it must PAGE. Without it, a fixture that
 * stopped discriminating (say, seeded inside the window) would leave the GREEN
 * arm green for ever.
 *
 * ### Skip discipline
 *
 * Same shape as the `tests/docker/` probes: no docker, or no cached
 * `postgres:16-alpine`, and this skips rather than pulling an image onto a dev
 * box. Set `SWITCHROOM_REQUIRE_PG_PROBE=1` to make that a hard failure instead.
 * `.github/workflows/docker-e2e.yml`'s `hindsight-watch-pg-probe` job sets it,
 * so on CI this file cannot silently skip: the outcome assertions here are the
 * only ones in the repo that can fail on a semantics regression rather than on
 * a changed string.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { bankConsolidationQuery, probeBankConsolidation } from "./probe.js";
import type { Runner } from "./probe.js";
import { evaluateConsolidationFailureStreak } from "./evaluate.js";
import type { Sample } from "./types.js";

const IMAGE = "postgres:16-alpine";
const CONTAINER = `swr-streak-floor-${randomUUID().slice(0, 8)}`;
const REQUIRED = process.env.SWITCHROOM_REQUIRE_PG_PROBE === "1";

function have(): boolean {
  const r = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  return r.status === 0;
}

const available = have();
if (REQUIRED && !available) {
  throw new Error(`SWITCHROOM_REQUIRE_PG_PROBE=1 but docker or ${IMAGE} is unavailable`);
}

/**
 * The retention horizon the fixture is written against, in days. Hard-coded
 * here rather than imported: the floor is derived at runtime from the
 * container's `SWITCHROOM_HINDSIGHT_RETENTION_DAYS`, and a fixture that moved
 * with it could never fail for any value of it.
 */
const RETENTION_DAYS = 30;

/**
 * The line the `postgres:*` entrypoint prints AFTER the temporary init server
 * is gone and BEFORE the real one starts. See {@link waitForRealServer}.
 */
const INIT_COMPLETE = "PostgreSQL init process complete; ready for start up.";

/** One quantum of waiting. No timers inside `beforeAll`, so this is a spawn. */
function nap(): void {
  spawnSync("sh", ["-c", "sleep 0.25"], { stdio: "ignore" });
}

function poll(what: string, ready: () => boolean, tries: number): void {
  for (let i = 0; i < tries; i++) {
    if (ready()) return;
    nap();
  }
  throw new Error(`throwaway postgres: ${what} (gave up after ~${Math.round(tries / 4)}s)`);
}

/**
 * Wait for the REAL server, not the init one — the reason this file used to be
 * flaky.
 *
 * The `postgres:16-alpine` entrypoint runs a TEMPORARY server on the same unix
 * socket while it runs `initdb` and the `/docker-entrypoint-initdb.d` hooks,
 * then shuts it down and execs the real one. `pg_isready` returns 0 against
 * that temporary server, and so does `psql`. A readiness loop that breaks on
 * the FIRST success therefore returns while the socket is about to disappear,
 * and the next `docker exec … psql` dies with
 * `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed:
 * No such file or directory` — either in the seed (a broken run) or in
 * `beforeAll` itself (four skipped tests). Measured at 3 failures in 8 runs on
 * review; reproduced here with the old discipline at 1 seed failure in 10.
 * Retrying the seed would paper over it; two consecutive readies would still
 * be a race, just a narrower one.
 *
 * So the wait is deterministic instead. The entrypoint logs, in this order:
 *
 *     LOG:  database system is ready to accept connections   ← temp server
 *     PostgreSQL init process complete; ready for start up.  ← init done
 *     LOG:  database system is ready to accept connections   ← real server
 *
 * (verified on `postgres:16-alpine`.) The middle line is printed only once and
 * only after the temporary server has exited, so blocking on it first removes
 * the ambiguity entirely: any connection that succeeds after it is talking to
 * the real server. `select 1` rather than `pg_isready` for the second phase,
 * because a real query is the thing the seed is about to do.
 */
function waitForRealServer(): void {
  poll(
    "the entrypoint never finished initdb",
    () => {
      const r = spawnSync("docker", ["logs", CONTAINER], { encoding: "utf8" });
      return `${r.stdout ?? ""}${r.stderr ?? ""}`.includes(INIT_COMPLETE);
    },
    240,
  );
  poll(
    "the post-init server never accepted a query",
    () =>
      spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-tAc", "select 1"], {
        stdio: "ignore",
      }).status === 0,
    120,
  );
}

function psql(sql: string): string {
  return execFileSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-tAc", sql], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** A `Runner` that answers the probe's `docker exec` with a real psql run. */
function runnerFor(query: string): Runner {
  return () => {
    try {
      return { status: 0, stdout: psql(query), stderr: "" };
    } catch (e) {
      return { status: 1, stdout: "", stderr: String(e) };
    }
  };
}

function sampleWith(banks: ReturnType<typeof probeBankConsolidation>): Sample {
  return {
    ts: Date.now(),
    pending: 0,
    dead: 0,
    evicted: 0,
    drops: 0,
    restartCount: 0,
    startedAt: "2026-08-12T00:00:00Z",
    health: "healthy",
    banks,
  };
}

describe.skipIf(!available)("#4620 — the streak query cannot count across a pruned completion", () => {
  beforeAll(() => {
    execFileSync("docker", ["run", "-d", "--name", CONTAINER, "--network", "none", "-e", "POSTGRES_PASSWORD=probe", IMAGE], {
      encoding: "utf8",
      timeout: 120_000,
    });
    waitForRealServer();

    psql(`
      CREATE TABLE async_operations(bank_id text, operation_type text, status text, created_at timestamptz);
      CREATE TABLE memory_units(bank_id text, consolidated_at timestamptz, fact_type text);

      -- (1) THE DEFECT'S SHAPE. 112 failures from the 2026-07-18→07-29 incident
      -- (the real count, off production), aged past the horizon, and NO
      -- completed row: its successes were swept by the prune, which never
      -- touches these failures. 40 days back — a day-level literal, not
      -- RETENTION_DAYS ± 1, so the fixture does not move with the knob.
      INSERT INTO async_operations
        SELECT 'overlord', 'consolidation', 'failed', now() - interval '40 days' + (g || ' minutes')::interval
          FROM generate_series(1, 112) g;

      -- (2) THE NEVER-COMPLETED CASE. A genuinely new pair whose very first
      -- ops failed, an hour ago, with no completion ever. greatest() ignores
      -- the NULL subselect, so the floor is the only bound and this must still
      -- register — a floor that swallowed it would trade one blind spot for
      -- another. (This pair clears the floor trivially; fixture 5 is the one
      -- that STRADDLES it.)
      INSERT INTO async_operations
        SELECT 'newbank', 'graph_maintenance', 'failed', now() - interval '1 hour' FROM generate_series(1, 4);

      -- (3) A LIVE, DENSE STREAK with a completion 2h ago: unchanged behaviour.
      INSERT INTO async_operations
        SELECT 'klanker', 'consolidation', 'failed', now() - interval '10 minutes' FROM generate_series(1, 6);
      INSERT INTO async_operations VALUES ('klanker', 'consolidation', 'completed', now() - interval '2 hours');

      -- (4) A pair that completed AFTER its failures: no streak at all.
      INSERT INTO async_operations VALUES ('carrie', 'consolidation', 'failed', now() - interval '3 hours');
      INSERT INTO async_operations VALUES ('carrie', 'consolidation', 'completed', now() - interval '1 hour');

      -- (5) THE COST OF THE FLOOR, pinned. A never-completed pair failing too
      -- slowly to accumulate 3 attempts inside a 30-day horizon: 5 failures
      -- over 60 days, THREE outside the horizon and TWO inside it. Unbounded
      -- it is a streak of 5 and breaches; floored it is a streak of 2, below
      -- CONSOLIDATION_FAILURE_STREAK_WARN, and reads ok. Day literals on both
      -- sides of the edge, deliberately far from it, so the fixture does not
      -- move with the knob.
      INSERT INTO async_operations VALUES
        ('sparsebank', 'graph_maintenance', 'failed', now() - interval '55 days'),
        ('sparsebank', 'graph_maintenance', 'failed', now() - interval '50 days'),
        ('sparsebank', 'graph_maintenance', 'failed', now() - interval '45 days'),
        ('sparsebank', 'graph_maintenance', 'failed', now() - interval '20 days'),
        ('sparsebank', 'graph_maintenance', 'failed', now() - interval '10 days');

      INSERT INTO memory_units VALUES ('overlord', NULL, 'experience');
    `);
  }, 180_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  });

  /** The shipped query, with the floor the container's env resolves to. */
  const floored = () => probeBankConsolidation("unused", runnerFor(bankConsolidationQuery(String(RETENTION_DAYS))));

  /**
   * The pre-#4620 query. `now() - make_interval(days => 100000)` is ~274 years
   * back — older than every row any Hindsight database will ever hold, so the
   * `greatest(…)` can never bind and this is `-infinity` semantics exactly, on
   * the same statement. (A literally astronomical figure is not usable:
   * PostgreSQL raises `timestamp out of range` well before `-infinity`.)
   */
  const unbounded = () => probeBankConsolidation("unused", runnerFor(bankConsolidationQuery("100000")));

  it("RED — the unbounded fallback pages, permanently, on the swept pair", () => {
    const banks = unbounded();
    const retired = banks?.streaks.find((s) => s.bank === "overlord");
    expect(retired).toBeDefined();
    // Every failure the pair ever had, and no success on record: the exact
    // reading the issue predicted.
    expect(retired?.streak).toBe(112);
    expect(retired?.lastCompletedAgeS).toBeNull();
    // …and it is at least 40 days old, so no recency guard can discriminate it.
    expect(retired?.newestFailureAgeS).toBeGreaterThan(39 * 86_400);

    const v = evaluateConsolidationFailureStreak([sampleWith(banks)]);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.measured?.bank).toBe("overlord");
    expect(v.measured?.streak).toBe(112);
  });

  it("GREEN — floored at the retention horizon, the swept pair does not page", () => {
    const banks = floored();
    // Not merely below the warn line: it is not a candidate at all, because
    // none of its failures survive the floor.
    expect(banks?.streaks.find((s) => s.bank === "overlord")).toBeUndefined();

    const v = evaluateConsolidationFailureStreak([sampleWith(banks)]);
    expect(v.measured?.bank).not.toBe("overlord");
    expect(v.detail).not.toContain("overlord");
  });

  it("GREEN — a brand-new pair whose FIRST ops failed still registers", () => {
    const newbank = floored()?.streaks.find((s) => s.bank === "newbank");
    expect(newbank?.streak).toBe(4);
    expect(newbank?.lastCompletedAgeS).toBeNull();
    // 4 ≥ warn(3) and the failures are an hour old, so this one DOES page —
    // the floor must not have made new pairs invisible.
    const v = evaluateConsolidationFailureStreak([sampleWith(floored())]);
    expect(v.state).toBe("breach");
  });

  /**
   * The verdict for ONE pair. The evaluator reports the worst live streak in
   * the fleet, so a pair-level claim has to be asked pair-by-pair or the loud
   * fixtures (klanker, newbank) answer for it.
   */
  const verdictFor = (banks: ReturnType<typeof probeBankConsolidation>, bank: string) =>
    evaluateConsolidationFailureStreak([
      sampleWith(banks === null ? null : { ...banks, streaks: banks.streaks.filter((s) => s.bank === bank) }),
    ]);

  it("CAVEAT — truncation drops a straddling sparse pair BELOW the warn line", () => {
    // This is a documented COST of the floor, not a bug, and it is pinned here
    // so it cannot widen unnoticed: the count is truncated at the horizon, not
    // just the window, so a pair failing slower than 3 attempts per retention
    // window loses the sparse arm (`probe.ts`, "The floor also TRUNCATES a
    // count"; `evaluate.ts`, the null-arm doc block). Restoring the old count
    // would restore #4620 itself, so the narrowing is accepted — but silently
    // reopening #4618's sparse blind spot further is not.
    const before = unbounded()?.streaks.find((s) => s.bank === "sparsebank");
    expect(before?.streak).toBe(5);
    expect(before?.lastCompletedAgeS).toBeNull();
    expect(verdictFor(unbounded(), "sparsebank").state).toBe("breach");

    const after = floored()?.streaks.find((s) => s.bank === "sparsebank");
    // Present — the pair is NOT the all-or-nothing case the docs used to
    // describe as the only narrowing — but truncated to what survives.
    expect(after?.streak).toBe(2);
    expect(after?.lastCompletedAgeS).toBeNull();
    expect(after?.newestFailureAgeS).toBeGreaterThan(9 * 86_400);
    const v = verdictFor(floored(), "sparsebank");
    expect(v.state).toBe("ok");
    expect(v.severity).toBeUndefined();
  });

  it("GREEN — a live streak with a recent completion is counted exactly as before", () => {
    const banks = floored();
    const klanker = banks?.streaks.find((s) => s.bank === "klanker");
    expect(klanker?.streak).toBe(6); // only the failures newer than the 2h-old completion
    expect(klanker?.lastCompletedAgeS).toBeGreaterThan(7_000);
    // A pair that completed after failing has no streak under either query.
    expect(banks?.streaks.find((s) => s.bank === "carrie")).toBeUndefined();
    expect(unbounded()?.streaks.find((s) => s.bank === "carrie")).toBeUndefined();
  });
});
