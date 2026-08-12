import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  evaluateAll,
  evaluateRecallCandidateFloor,
  evaluateRecallInjectedScore,
  evaluateRecallOwnBankTimeout,
  evaluateRecallZeroMemory,
} from "./evaluate.js";
import {
  probeRecallLogs,
  readRecallLogTail,
  recallLogPath,
  summarizeRecallRows,
  withinWindow,
  RECALL_MAX_ROW_AGE_MS,
  type RecallLogRow,
} from "./recall-log.js";
import {
  RECALL_MIN_SAMPLES,
  RECALL_SCORE_P50_PAGE,
  RECALL_SCORE_P50_WARN,
} from "./thresholds.js";
import { HEALTHY_FLEET_ROWS } from "./healthy-fleet.fixture.js";
import type { Sample } from "./types.js";

/**
 * These tests assert OUTCOMES, not code paths.
 *
 * The bar: feed the reducer a log shaped like the incident that went
 * undetected for six weeks — 86 % own-bank timeouts, 47 % zero-memory turns, a
 * collapsed candidate pool, near-zero injected scores, p95 pinned to the
 * deadline — and require every signal to reach **page**, not merely "breach"
 * or "not ok". A test that only proved the function returns a Verdict would
 * have passed against the code as it stood before this change, when the
 * signals did not exist at all.
 *
 * The numbers below are the real fleet measurement taken on 2026-07-27 across
 * 2109 rows / 12 agents, not invented values.
 */

const NOW = Date.parse("2026-07-27T07:00:00Z");
const HEALTHY_SCORE = 0.31;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hw-recall-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RowOpts {
  ts?: number;
  ownTimedOut?: boolean;
  ownErrored?: boolean;
  resultCount?: number;
  preCap?: number;
  overlapDropped?: number;
  score?: number | null;
  elapsedMs?: number;
  error?: string | null;
}

/** A row shaped exactly like the live logs (verified against overlord's file). */
function row(o: RowOpts = {}): RecallLogRow {
  return {
    ts: new Date(o.ts ?? NOW - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    bank_id: "overlord",
    result_count: o.resultCount ?? 6,
    total_elapsed_ms: o.elapsedMs ?? 1200,
    deadline_hit: Boolean(o.ownTimedOut),
    pre_cap_count: o.preCap ?? 26,
    overlap_dropped: o.overlapDropped ?? 7,
    injected_score_max: o.score === undefined ? HEALTHY_SCORE : o.score,
    cache_hit: false,
    error: o.error ?? null,
    bank_timings: [
      {
        bank_id: "overlord",
        elapsed_ms: o.elapsedMs ?? 1200,
        timed_out: Boolean(o.ownTimedOut),
        errored: Boolean(o.ownErrored),
      },
      { bank_id: "ken-profile", elapsed_ms: 531, timed_out: false, errored: false },
    ],
  };
}

/**
 * The observed incident: of 100 rows, 86 own-bank timeouts, 47 zero-memory
 * turns, candidate pool collapsed to ~0, injected score p50 ~0.001, and
 * latency pinned to the 8 s deadline.
 */
function incidentRows(n = 100): RecallLogRow[] {
  const out: RecallLogRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      row({
        ts: NOW - (n - i) * 60_000,
        ownTimedOut: i < 86,
        resultCount: i < 47 ? 0 : 6,
        preCap: 0,
        overlapDropped: 0,
        score: 0.0011,
        elapsedMs: i < 86 ? 8023 : 900,
        error: i < 86 ? "ReadTimeout: HTTPConnectionPool(host='127.0.0.1', port=4010)" : null,
      }),
    );
  }
  return out;
}

/**
 * A healthy fleet — the REAL one, replayed from `healthy-fleet.fixture.ts`.
 *
 * Deliberately not synthesised. An earlier version of this helper built every
 * row at `elapsedMs: 1100` and a constant score of 0.31, which made the
 * "stays silent on a healthy fleet" test below unable to fail for any
 * threshold in the drafted range — it asserted the thresholds pointed the
 * right WAY, while its name promised they were SAFE. Two mis-set lines got
 * through it. These rows carry the distribution's real tails (score p10
 * 0.0005, wall time up to 11859 ms, pool as low as 3), so a threshold set
 * inside healthy noise now fails here instead of on the fleet.
 */
function healthyRows(n = HEALTHY_FLEET_ROWS.length): RecallLogRow[] {
  return HEALTHY_FLEET_ROWS.slice(0, n).map((r, i) => ({
    // Spread the capture across the window so every row is in-window; the
    // fixture's own timestamps are irrelevant to every SLI it feeds.
    ts: new Date(NOW - (n - i) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    bank_id: r.bank_id,
    result_count: r.result_count,
    total_elapsed_ms: r.total_elapsed_ms,
    deadline_hit: false,
    pre_cap_count: r.pre_cap_count,
    overlap_dropped: r.overlap_dropped,
    injected_score_max: r.injected_score_max,
    cache_hit: false,
    error: null,
    bank_timings: r.bank_timings,
  })) as RecallLogRow[];
}

function ringOf(rows: RecallLogRow[]): Sample[] {
  return [
    {
      ts: NOW,
      retainOk: 0,
      retainFail: 0,
      pending: 0,
      dead: 0,
      evicted: 0,
      drops: 0,
      restartCount: 0,
      startedAt: "2026-07-27T00:00:00Z",
      health: "healthy",
      recall: summarizeRecallRows(rows),
    },
  ];
}

describe("summarizeRecallRows", () => {
  it("measures the incident's rates against per-SLI denominators", () => {
    const s = summarizeRecallRows(incidentRows());
    expect(s.rows).toBe(100);
    expect(s.ownBankDegraded / s.timeoutConsidered).toBeCloseTo(0.86, 5);
    expect(s.zeroResult / s.zeroConsidered).toBeCloseTo(0.47, 5);
    expect(s.poolMedian).toBe(0);
    expect(s.scoreP50).toBeCloseTo(0.0011, 6);
    expect(s.elapsedP95Ms).toBe(8023);
  });

  it("adds the overlap-gate drops back into the candidate pool", () => {
    // Scoring pre_cap_count alone would read 1 here and page for an "empty
    // index", pointing at the wrong fix when the gate is simply aggressive.
    const s = summarizeRecallRows([row({ preCap: 1, overlapDropped: 40 })]);
    expect(s.poolMedian).toBe(41);
  });

  it("excludes cache hits from every denominator", () => {
    const hit: RecallLogRow = {
      ts: new Date(NOW - 30_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      bank_id: "overlord",
      result_count: undefined,
      cache_hit: true,
      bank_timings: [],
      injected_score_max: null,
      total_elapsed_ms: undefined,
    };
    const s = summarizeRecallRows([...healthyRows(10), hit, hit, hit]);
    expect(s.rows).toBe(10);
    expect(s.zeroConsidered).toBe(10);
    expect(s.timeoutConsidered).toBe(10);
  });

  it("counts a row-carrying field only for its own SLI", () => {
    // Topic-filtered rows carry result_count but no bank_timings. A shared
    // denominator would dilute the timeout rate by these rows.
    const partial: RecallLogRow = { ts: "2026-07-27T06:59:00Z", bank_id: "x", result_count: 0 };
    const s = summarizeRecallRows([...incidentRows(100), partial, partial]);
    expect(s.timeoutConsidered).toBe(100);
    expect(s.zeroConsidered).toBe(102);
  });

  it("surfaces the modal error string, and nothing when rows predate the field", () => {
    expect(summarizeRecallRows(incidentRows()).topError).toBe(
      "ReadTimeout: HTTPConnectionPool(host='127.0.0.1', port=4010)",
    );
    expect(summarizeRecallRows(incidentRows()).errorRows).toBe(86);
    const legacy = incidentRows().map((r) => {
      const { error: _drop, ...rest } = r;
      return rest;
    });
    expect(summarizeRecallRows(legacy).topError).toBeNull();
    expect(summarizeRecallRows(legacy).errorRows).toBe(0);
  });
});

describe("recall signals fire at PAGE level on the real incident", () => {
  const ring = ringOf(incidentRows());

  it("own-bank timeout: 86% pages", () => {
    const v = evaluateRecallOwnBankTimeout(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.measured?.rate).toBeCloseTo(0.86, 5);
  });

  it("zero-memory: 47% pages", () => {
    const v = evaluateRecallZeroMemory(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("candidate floor pages — the signal that sees a fast, successful, empty recall", () => {
    const v = evaluateRecallCandidateFloor(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("injected score pages — the other signal for that same failure shape", () => {
    const v = evaluateRecallInjectedScore(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("surfaces the wall time as DM context on the own-bank alert", () => {
    // `recall-latency` is now its OWN signal, but this number still has to
    // reach the own-bank DM: it is what tells the operator "timed out at the
    // wall" rather than "errored instantly", and making them correlate two
    // separate alerts to learn that would be a regression in the message.
    const detail = evaluateRecallOwnBankTimeout(ring).detail;
    expect(detail).toContain("recall wall time p95");
    expect(detail).toContain("recall deadline");
  });

  it("puts the reason, not just the rate, into the operator DM", () => {
    expect(evaluateRecallOwnBankTimeout(ring).detail).toContain("ReadTimeout");
  });
});

describe("recall signals stay silent on a REAL healthy fleet", () => {
  const rows = healthyRows();
  const ring = ringOf(rows);

  /**
   * The four signals this fixture was CAPTURED to calibrate.
   *
   * Scoped deliberately, and the scope is the honest reading of what this
   * fixture is. It was taken 2026-07-27, while the fleet was running the
   * retired 8 s wall with a recall path that was itself degraded — its own
   * header says so, and asks for exactly the regeneration that
   * `repaired-fleet.fixture.ts` now provides. It is a valid "healthy" control
   * for the four rate/floor signals derived from it, and it is NOT a healthy
   * control for latency: this population was pinned against its deadline, and
   * the next test asserts that directly rather than letting it hide behind a
   * blanket green.
   *
   * `repaired-fleet.fixture.ts` carries the blanket green over ALL recall
   * signals — see `recall-degradation.test.ts`.
   */
  const CALIBRATED_HERE = [
    "recall-own-bank-timeout",
    "recall-zero-memory",
    "recall-candidate-floor",
    "recall-injected-score",
  ];

  it("no recall signal calibrated on this fixture breaches — not at warn, not at page", () => {
    const seen: string[] = [];
    for (const v of evaluateAll(ring)) {
      if (!CALIBRATED_HERE.includes(v.signal)) continue;
      seen.push(v.signal);
      expect(`${v.signal}=${v.state}`).toBe(`${v.signal}=ok`);
    }
    // Guards the scoping itself: if a signal is renamed out from under this
    // list, the loop silently asserts nothing.
    expect(seen.sort()).toEqual([...CALIBRATED_HERE].sort());
  });

  it("this 'healthy' fleet was itself deadline-pinned — which is why it cannot calibrate latency", () => {
    // The claim that killed the drafted latency signal twice, asserted rather
    // than asserted-about-in-a-comment: the 2026-07 population runs AT the
    // wall, so the restored signal fires on it. Restoring the old blanket
    // green over this fixture would therefore require lifting the latency
    // threshold above a distribution that is known-degraded, and this test is
    // what makes that trade visible instead of silent.
    const latency = evaluateAll(ring).find((v) => v.signal === "recall-latency")!;
    expect(latency.state).toBe("breach");
    expect(summarizeRecallRows(rows).elapsedP95Ms).toBeGreaterThanOrEqual(8000);
  });

  it("deadline pinning reports no-data on rows that predate the field, never ok", () => {
    // This fixture carries no `deadline_effective_ms`. The fail-open shape
    // would be scoring it against a hardcoded wall, or defaulting the missing
    // denominator to something and passing. It must be inert instead.
    const v = evaluateAll(ring).find((s) => s.signal === "recall-deadline-pinning")!;
    expect(v.state).toBe("no-data");
  });

  it("quality regression reports no-data with no persisted baseline, never ok", () => {
    const v = evaluateAll(ring).find((s) => s.signal === "recall-quality-regression")!;
    expect(v.state).toBe("no-data");
  });

  it("the fixture really is the live distribution, tails included", () => {
    // Guards the fixture itself. If a regeneration ever flattens it back into
    // comfortable constants, the safety tests above quietly stop testing
    // safety — which is exactly how the mis-set thresholds got through. These
    // are the measured properties recorded in the fixture header.
    const stats = summarizeRecallRows(rows);
    expect(stats.rows).toBe(183);
    // Wall time reaches the 8 s per-bank budget on a HEALTHY fleet. This is
    // the single number that killed the drafted `recall-latency` signal.
    expect(stats.elapsedP95Ms).toBeGreaterThanOrEqual(8000);
    // A bimodal score distribution with a real low tail, not one constant.
    const scores = rows
      .map((r) => r.injected_score_max)
      .filter((s): s is number => typeof s === "number");
    expect(scores.length).toBeGreaterThan(50);
    expect(Math.min(...scores)).toBeLessThan(0.001);
    expect(Math.max(...scores)).toBeGreaterThan(0.9);
    expect(new Set(scores).size).toBeGreaterThan(50);
  });

  /**
   * Resample the healthy fixture into tick-sized windows and measure how
   * often a candidate threshold WOULD fire. This is the assertion with teeth.
   *
   * A single point estimate over all 183 rows is not enough, and the rejected
   * injected-score warn of 0.05 is the proof: it sits BELOW the healthy p50
   * of 0.0850, so the "stays silent" test above passes it and stays green —
   * which is exactly how it survived to review. What condemns it is the
   * SPREAD. A real tick reads roughly a 60-row window, and on a bimodal
   * distribution spanning 3.5 orders of magnitude the window p50 swings far
   * enough to cross 0.05 about a quarter of the time.
   *
   * So the safety property being claimed is a false-positive RATE, not an
   * inequality, and this measures the rate. Seeded LCG rather than
   * `Math.random` so a failure is a regression and never a flake.
   */
  function falseFireRate(
    values: number[],
    fires: (windowValues: number[]) => boolean,
    { windowSize = 60, draws = 2000, seed = 0x5eed } = {},
  ): number {
    let s = seed >>> 0;
    const next = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    let fired = 0;
    for (let d = 0; d < draws; d++) {
      const w: number[] = [];
      for (let i = 0; i < windowSize; i++) w.push(values[Math.floor(next() * values.length)]!);
      if (fires(w)) fired++;
    }
    return fired / draws;
  }

  /** Nearest-rank quantile — the same rule `summarizeRecallRows` uses. */
  function quantile(values: number[], p: number): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(Math.max(1, Math.ceil(p * s.length)), s.length) - 1]!;
  }

  const healthyScores = rows
    .map((r) => r.injected_score_max)
    .filter((s): s is number => typeof s === "number");
  const healthyLatencies = rows
    .map((r) => r.total_elapsed_ms)
    .filter((n): n is number => typeof n === "number");

  it("the SHIPPED injected-score warn almost never fires on healthy traffic", () => {
    const rate = falseFireRate(healthyScores, (w) => quantile(w, 0.5) <= RECALL_SCORE_P50_WARN);
    expect(rate).toBeLessThan(0.05);
    expect(RECALL_SCORE_P50_WARN).toBeGreaterThan(RECALL_SCORE_P50_PAGE);
  });

  it("the REJECTED injected-score warn of 0.05 fires on healthy traffic — MAJOR 2's evidence", () => {
    // Restoring 0.05 must not be quietly green. The harm is asserted directly
    // against real healthy rows, so the constant cannot drift back up without
    // this stating what it costs.
    expect(falseFireRate(healthyScores, (w) => quantile(w, 0.5) <= 0.05)).toBeGreaterThan(0.1);
  });

  it("no recall-latency line below the 8 s budget was safe AGAINST THIS POPULATION — BLOCKER 1's evidence, preserved", () => {
    // Kept exactly as measured, because it is still true and still the reason
    // the signal could not ship in July: against the 2026-07 distribution the
    // drafted warn 4000 / page 6000 fire on essentially every window, and even
    // 8000 ms — the per-bank budget itself — fires on a large fraction.
    //
    // What CHANGED is not this arithmetic, it is the population. These rows
    // were drawn from a fleet whose recall was itself broken and running at
    // the wall (p50 6420 ms). The repaired fleet runs p50 1097 / p95 1486 ms,
    // and the identical bootstrap against THAT distribution fires 0 % of the
    // time at both lines — asserted in `recall-degradation.test.ts`. The
    // deletion note named a re-baseline on a repaired fleet as its own
    // precondition for restoration; this test records the "before" half of
    // that comparison and must keep passing.
    expect(falseFireRate(healthyLatencies, (w) => quantile(w, 0.95) >= 4000)).toBeGreaterThan(0.9);
    expect(falseFireRate(healthyLatencies, (w) => quantile(w, 0.95) >= 6000)).toBeGreaterThan(0.9);
    expect(falseFireRate(healthyLatencies, (w) => quantile(w, 0.95) >= 8000)).toBeGreaterThan(0.3);
  });
});

describe("the fast-empty failure shape specifically", () => {
  it("pages on pool+score while timeout and zero-memory both read clean", () => {
    // Every bank answered, quickly, with a non-empty result — the exact shape
    // `doctor-recall-health.ts` cannot see, and the reason the candidate-floor
    // and injected-score signals exist.
    const rows: RecallLogRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(
        row({
          ts: NOW - (100 - i) * 60_000,
          ownTimedOut: false,
          resultCount: 6,
          preCap: 2,
          overlapDropped: 0,
          score: 0.002,
          elapsedMs: 700,
        }),
      );
    }
    const ring = ringOf(rows);
    expect(evaluateRecallOwnBankTimeout(ring).state).toBe("ok");
    expect(evaluateRecallZeroMemory(ring).state).toBe("ok");
    expect(evaluateRecallCandidateFloor(ring).severity).toBe("page");
    expect(evaluateRecallInjectedScore(ring).severity).toBe("page");
  });
});

describe("fail-closed reduction", () => {
  it("reports no-data rather than ok below the sample floor", () => {
    const ring = ringOf(incidentRows(RECALL_MIN_SAMPLES - 1));
    for (const v of [
      evaluateRecallOwnBankTimeout(ring),
      evaluateRecallZeroMemory(ring),
      evaluateRecallCandidateFloor(ring),
      evaluateRecallInjectedScore(ring),
    ]) {
      expect(`${v.signal}=${v.state}`).toBe(`${v.signal}=no-data`);
    }
  });

  it("reports no-data, not ok, when no recall telemetry was collected at all", () => {
    const ring = ringOf([]);
    ring[0]!.recall = null;
    expect(evaluateRecallOwnBankTimeout(ring).state).toBe("no-data");
    expect(evaluateRecallCandidateFloor(ring).state).toBe("no-data");
  });
});

describe("withinWindow", () => {
  it("drops rows older than the age cap so a frozen log cannot page forever", () => {
    const stale = row({ ts: NOW - RECALL_MAX_ROW_AGE_MS - 60_000 });
    const fresh = row({ ts: NOW - 60_000 });
    expect(withinWindow([stale, fresh], NOW)).toEqual([fresh]);
  });

  it("keeps a row whose ts is unparseable (a torn write, not an old row)", () => {
    const torn = { ...row(), ts: "not-a-date" };
    expect(withinWindow([torn], NOW)).toHaveLength(1);
  });

  it("drops future-dated rows", () => {
    expect(withinWindow([row({ ts: NOW + 3_600_000 })], NOW)).toHaveLength(0);
  });
});

describe("readRecallLogTail / probeRecallLogs", () => {
  function writeLog(agent: string, rows: RecallLogRow[]): void {
    const p = recallLogPath(join(dir, agent));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  it("returns only the trailing window", () => {
    writeLog("a", incidentRows(50));
    expect(readRecallLogTail(recallLogPath(join(dir, "a")), 10)).toHaveLength(10);
  });

  it("skips a torn final line instead of failing the whole read", () => {
    const p = recallLogPath(join(dir, "a"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(row())}\n{"ts":"2026-07-27T06:5`);
    expect(readRecallLogTail(p)).toHaveLength(1);
  });

  it("returns [] for an absent log rather than throwing", () => {
    expect(readRecallLogTail(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("pages across a whole fleet read from disk", () => {
    writeLog("alpha", incidentRows(60));
    writeLog("beta", incidentRows(60));
    mkdirSync(join(dir, "gamma"), { recursive: true }); // agent with no log yet
    const stats = probeRecallLogs(dir, NOW);
    expect(stats.agents).toBe(2);
    expect(stats.rows).toBe(120);

    const ring = ringOf([]);
    ring[0]!.recall = stats;
    expect(evaluateRecallOwnBankTimeout(ring).severity).toBe("page");
    expect(evaluateRecallCandidateFloor(ring).severity).toBe("page");
    expect(evaluateRecallInjectedScore(ring).severity).toBe("page");
  });

  it("throws when the agents dir itself is unreadable — a blind probe is not a clean bill", () => {
    expect(() => probeRecallLogs(join(dir, "missing"), NOW)).toThrow();
  });
});
