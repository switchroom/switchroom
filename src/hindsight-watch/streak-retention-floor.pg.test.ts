/**
 * #4620, end to end against a REAL PostgreSQL: a pair whose completions were
 * swept by the retention prune, and whose failures were kept, must not page.
 *
 * ### Why this test needs a database
 *
 * The defect lives in SQL and nowhere else. `docker/hindsight-maintenance.sh`
 * deletes `status='completed'` rows past the retention horizon and never
 * touches `failed` ones, so the two halves of a streak age differently. With
 * an unbounded `coalesce(…, '-infinity')` fallback the streak query then counts
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
 * `-infinity` semantics this PR replaced, reproduced by handing the query
 * builder a floor so wide it cannot bind, and it must PAGE. Without it, a
 * fixture that stopped discriminating (say, seeded inside the window) would
 * leave the GREEN arm green for ever.
 *
 * ### Skip discipline
 *
 * Same shape as the `tests/docker/` probes: no docker, or no cached
 * `postgres:16-alpine`, and this skips rather than pulling an image onto a dev
 * box. Set `SWITCHROOM_REQUIRE_PG_PROBE=1` to make that a hard failure instead
 * — that is the switch a CI job wires up. It is not wired into a workflow yet
 * (this PR is scoped to `src/hindsight-watch/`); tracked as follow-up.
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
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-q"], { stdio: "ignore" }).status === 0) {
        up = true;
        break;
      }
      // Deliberate busy-wait: no timers inside beforeAll, and 60 tries at
      // ~150ms of spawn overhead each is ~10s of budget for a cold pg.
      spawnSync("sh", ["-c", "sleep 0.25"], { stdio: "ignore" });
    }
    if (!up) throw new Error("throwaway postgres never became ready");

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

      -- (2) THE PROPERTY '-infinity' EXISTS FOR. A genuinely new pair whose
      -- very first ops failed, an hour ago, with no completion ever. It must
      -- still register — a floor that swallowed this would trade one blind
      -- spot for another.
      INSERT INTO async_operations
        SELECT 'newbank', 'graph_maintenance', 'failed', now() - interval '1 hour' FROM generate_series(1, 4);

      -- (3) A LIVE, DENSE STREAK with a completion 2h ago: unchanged behaviour.
      INSERT INTO async_operations
        SELECT 'klanker', 'consolidation', 'failed', now() - interval '10 minutes' FROM generate_series(1, 6);
      INSERT INTO async_operations VALUES ('klanker', 'consolidation', 'completed', now() - interval '2 hours');

      -- (4) A pair that completed AFTER its failures: no streak at all.
      INSERT INTO async_operations VALUES ('carrie', 'consolidation', 'failed', now() - interval '3 hours');
      INSERT INTO async_operations VALUES ('carrie', 'consolidation', 'completed', now() - interval '1 hour');

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
