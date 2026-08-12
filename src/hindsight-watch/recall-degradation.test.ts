/**
 * The three signals built for the 2026-08-01 → 08-07 recall degradation, tested
 * against the shape of the thing they missed.
 *
 * THE BAR THESE TESTS SET. The fourteen pre-existing signals were all absolute
 * floors, and the fleet ran a ~5× recall-quality regression for a week with
 * every one of them green. A test that merely proved the new evaluators return
 * a Verdict would have passed against that same week. So the assertions here
 * are two-sided and both sides are drawn from REAL fleet measurements, not
 * invented numbers:
 *
 *   1. Fed the 08-01 → 08-07 shape, each new signal must reach the severity it
 *      was designed for — and the existing floors must still be silent, which
 *      is the whole justification for adding them.
 *   2. Fed the repaired fleet (`repaired-fleet.fixture.ts`, the real 08-10 →
 *      08-12 capture), every recall signal must be `ok` — measured as a
 *      false-fire RATE across resampled tick windows, not as a single
 *      inequality over the pooled fixture. An alert that chatters gets muted,
 *      and a muted alert is worse than no alert.
 *
 * The sick-side numbers below are the measured daily aggregates from the
 * fleet's `recall_log.jsonl`, reproduced in the B12 block of `thresholds.ts`.
 */

import { describe, it, expect } from "vitest";

import { baselineFor, foldBaseline, fractionalDrop, utcDay } from "./baseline.js";
import {
  evaluateAll,
  evaluateRecallCandidateFloor,
  evaluateRecallDeadlinePinning,
  evaluateRecallInjectedScore,
  evaluateRecallLatency,
  evaluateRecallQualityRegression,
} from "./evaluate.js";
import { summarizeRecallRows, type RecallLogRow } from "./recall-log.js";
import { REPAIRED_FLEET_ROWS } from "./repaired-fleet.fixture.js";
import { normalizeBaseline } from "./state.js";
import {
  RECALL_BASELINE_DAYS,
  RECALL_BASELINE_MAX_OBS_PER_DAY,
  RECALL_BASELINE_MIN_DAYS,
  RECALL_MIN_SAMPLES,
  RECALL_P95_PAGE_MS,
  RECALL_P95_WARN_MS,
} from "./thresholds.js";
import type { RecallBaseline, Sample } from "./types.js";

const NOW = Date.parse("2026-08-12T12:00:00Z");

function iso(ts: number): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ringOf(rows: RecallLogRow[], ts = NOW): Sample[] {
  return [
    {
      ts,
      retainOk: 0,
      retainFail: 0,
      pending: 0,
      dead: 0,
      evicted: 0,
      drops: 0,
      restartCount: 0,
      startedAt: "2026-08-01T00:00:00Z",
      health: "healthy",
      recall: summarizeRecallRows(rows),
    },
  ];
}

/**
 * The repaired fleet, as `RecallLogRow`s inside the tick window.
 *
 * The fixture's own timestamps are replaced with an even spread across the
 * last hour for the same reason `healthy-fleet.fixture.ts` is re-stamped: no
 * SLI reads the timestamp except `withinWindow`, and a two-day-old capture
 * would otherwise be filtered out entirely and silently assert nothing.
 */
function repairedRows(n = REPAIRED_FLEET_ROWS.length, now = NOW): RecallLogRow[] {
  return REPAIRED_FLEET_ROWS.slice(0, n).map((r, i) => ({
    ts: iso(now - (n - i) * 10_000),
    bank_id: r.bank_id,
    result_count: r.result_count ?? undefined,
    total_elapsed_ms: r.total_elapsed_ms ?? undefined,
    deadline_hit: r.deadline_hit ?? undefined,
    deadline_effective_ms: r.deadline_effective_ms,
    pre_cap_count: r.pre_cap_count ?? undefined,
    overlap_dropped: r.overlap_dropped ?? undefined,
    injected_score_max: r.injected_score_max ?? undefined,
    cache_hit: false,
    error: null,
    bank_timings: r.bank_timings,
  })) as RecallLogRow[];
}

/**
 * Synthesise a window with the 08-01 → 08-07 SHAPE.
 *
 * Not a capture: those logs are the fleet's real query traffic and the numbers
 * that matter are the aggregates, which are reproduced exactly. Latency is
 * drawn so the p95 lands on the measured 9030 ms censoring point with a
 * realistic body beneath it, rather than every row sitting at the same value —
 * a flat set of constants is the defect the repaired fixture's header warns
 * about.
 */
function sickRows({
  score,
  pool,
  latP50,
  latP95,
  deadlineHitRate,
  n = 120,
  now = NOW,
}: {
  score: number;
  pool: number;
  latP50: number;
  latP95: number;
  deadlineHitRate: number;
  n?: number;
  now?: number;
}): RecallLogRow[] {
  const rows: RecallLogRow[] = [];
  for (let i = 0; i < n; i++) {
    const frac = (i + 1) / n;
    // Below the 95th percentile interpolate up from half the median to the
    // median; AT and above it, sit on the censoring point. `>=` and not `>`:
    // the nearest-rank p95 the reducer uses is the row at exactly frac 0.95,
    // so `>` would leave the generated p95 in the body and quietly assert
    // against a distribution that is not the one named.
    const elapsed = frac >= 0.95 ? latP95 : Math.round(latP50 * (0.5 + frac * 0.55));
    rows.push({
      ts: iso(now - (n - i) * 10_000),
      bank_id: "agent-01",
      result_count: 8,
      total_elapsed_ms: elapsed,
      deadline_hit: frac > 1 - deadlineHitRate,
      deadline_effective_ms: 9993,
      // Vary around the target so the median is the target but the
      // distribution is not a single constant.
      pre_cap_count: Math.max(0, Math.round(pool + (i % 2 === 0 ? -(i % 11) : i % 13))),
      overlap_dropped: 0,
      // Spread symmetrically about 1.0 so the MEDIAN is the measured daily
      // value rather than ~2.5 % above it — the signal divides by this, so a
      // skewed generator would silently shift every drop it computes.
      injected_score_max: Math.max(
        0,
        Number((score * (0.5 + ((i * 7) % 101) / 100)).toFixed(4)),
      ),
      cache_hit: false,
      error: null,
      bank_timings: [{ bank_id: "agent-01", elapsed_ms: elapsed, timed_out: false, errored: false }],
    });
  }
  return rows;
}

/** The measured daily aggregates. See the B12 block in `thresholds.ts`. */
const SICK_DAYS = {
  "08-01": { score: 0.5493, pool: 58, latP50: 6660, latP95: 9037, deadlineHitRate: 0.223 },
  "08-02": { score: 0.2856, pool: 61, latP50: 7801, latP95: 9033, deadlineHitRate: 0.372 },
  "08-03": { score: 0.1857, pool: 78, latP50: 7993, latP95: 9034, deadlineHitRate: 0.392 },
  "08-04": { score: 0.5593, pool: 89, latP50: 5749, latP95: 9029, deadlineHitRate: 0.125 },
  "08-05": { score: 0.6046, pool: 85, latP50: 6161, latP95: 9028, deadlineHitRate: 0.179 },
  "08-06": { score: 0.57, pool: 83, latP50: 6173, latP95: 9034, deadlineHitRate: 0.266 },
  "08-07": { score: 0.6593, pool: 87, latP50: 5111, latP95: 9031, deadlineHitRate: 0.157 },
} as const;

// ── 1. the sick week ────────────────────────────────────────────────────────

describe("the 2026-08-01 → 08-07 degradation the fourteen existing signals missed", () => {
  it("recall-latency PAGES on every single day of it", () => {
    for (const [day, spec] of Object.entries(SICK_DAYS)) {
      const v = evaluateRecallLatency(ringOf(sickRows(spec)));
      expect(`${day}:${v.state}/${v.severity}`).toBe(`${day}:breach/page`);
    }
  });

  it("recall-deadline-pinning PAGES on every single day of it", () => {
    for (const [day, spec] of Object.entries(SICK_DAYS)) {
      const v = evaluateRecallDeadlinePinning(ringOf(sickRows(spec)));
      expect(`${day}:${v.state}/${v.severity}`).toBe(`${day}:breach/page`);
    }
  });

  it("recall-quality-regression fires on the ONSET, warn then page", () => {
    // Baseline warmed from the pre-incident week, then each day scored against
    // it. The measured pre-incident daily top-hit median was 0.6465.
    const baseline = warmBaseline({ score: 0.6465, pool: 60, days: 7, endingBefore: "2026-08-02" });
    const at = (day: string) => Date.parse(`2026-${day}T12:00:00Z`);

    const d02 = evaluateRecallQualityRegression(
      ringOf(sickRows(SICK_DAYS["08-02"]), at("08-02")),
      baseline,
      at("08-02"),
    );
    expect(d02.state).toBe("breach");
    expect(d02.severity).toBe("warn");

    const d03 = evaluateRecallQualityRegression(
      ringOf(sickRows(SICK_DAYS["08-03"]), at("08-03")),
      baseline,
      at("08-03"),
    );
    expect(d03.state).toBe("breach");
    expect(d03.severity).toBe("page");
    expect(d03.detail).toContain("injected top-hit score");
  });

  it("the existing absolute floors stay green throughout — which is why these were needed", () => {
    // The load-bearing claim of the whole change. If a floor DID catch this,
    // three new signals would be three new sources of noise.
    for (const [day, spec] of Object.entries(SICK_DAYS)) {
      const ring = ringOf(sickRows(spec));
      expect(`${day}:score=${evaluateRecallInjectedScore(ring).state}`).toBe(`${day}:score=ok`);
      expect(`${day}:pool=${evaluateRecallCandidateFloor(ring).state}`).toBe(`${day}:pool=ok`);
    }
  });

  it("the pool arm never fires, because the pool GREW during the incident", () => {
    // 58 → 87 across the week. Recorded as an OUTCOME rather than a comment:
    // it is why the signal ORs its two arms instead of requiring both, and a
    // future change making them conjunctive would blind the signal to this
    // incident entirely. 08-03 is used because its pool (78) is already above
    // the 60 baseline while its score (0.1857) is 71 % below.
    const baseline = warmBaseline({ score: 0.6465, pool: 60, days: 7, endingBefore: "2026-08-03" });
    const at = Date.parse("2026-08-03T12:00:00Z");
    const v = evaluateRecallQualityRegression(
      ringOf(sickRows(SICK_DAYS["08-03"]), at),
      baseline,
      at,
    );
    // Both arms are reported, so the operator can see the DIVERGENCE — that
    // the pool grew while the score collapsed is itself the diagnostic clue.
    expect(v.detail).toContain("median candidate pool");
    expect(v.detail).toContain("injected top-hit score");
    // …but the score arm is what carries the verdict; the pool arm's drop is 0.
    expect(v.measured?.drop).toBeGreaterThan(0.6);
    expect(v.severity).toBe("page");
  });

  it("a day whose DAILY MEDIAN recovered does not fire, even mid-incident", () => {
    // Honest limitation, asserted rather than glossed. 08-04's median top-hit
    // score (0.5593) is only 13 % below the pre-incident baseline even though
    // individual ticks that day ran far worse. A signal scored on a tick
    // aggregate reports the aggregate, and this one is genuinely near normal —
    // the absolute floors, not this signal, are what would have to catch a
    // partial-day dip.
    const baseline = warmBaseline({ score: 0.6465, pool: 60, days: 7, endingBefore: "2026-08-04" });
    const at = Date.parse("2026-08-04T12:00:00Z");
    const v = evaluateRecallQualityRegression(
      ringOf(sickRows(SICK_DAYS["08-04"]), at),
      baseline,
      at,
    );
    expect(v.state).toBe("ok");
    expect(v.measured?.drop as number).toBeLessThan(0.4);
  });

  it("latency alone cannot distinguish 'slow' from 'cut off' — which is why pinning is separate", () => {
    // 7 s against a 10 s wall: genuinely slow, pages on latency, and NOT
    // truncated. Collapsing the two signals would put the wrong remedy in the
    // DM for this shape.
    const slowButCompleting = sickRows({
      score: 0.7,
      pool: 90,
      latP50: 6000,
      latP95: 7000,
      deadlineHitRate: 0,
    });
    const ring = ringOf(slowButCompleting);
    expect(evaluateRecallLatency(ring).severity).toBe("page");
    expect(evaluateRecallDeadlinePinning(ring).state).toBe("ok");
  });
});

// ── 2. the repaired fleet ───────────────────────────────────────────────────

describe("the three new signals stay silent on the REAL repaired fleet", () => {
  const rows = repairedRows();
  const ring = ringOf(rows);

  it("every recall signal reads ok — no warn, no page", () => {
    const seen: string[] = [];
    for (const v of evaluateAll(ring, repairedBaseline(), NOW)) {
      if (!v.signal.startsWith("recall-")) continue;
      seen.push(v.signal);
      expect(`${v.signal}=${v.state}`).toBe(`${v.signal}=ok`);
    }
    // All seven, including the three added here — a renamed signal must not
    // silently drop out of this loop.
    expect(seen).toHaveLength(7);
  });

  it("the fixture really is the repaired distribution, tails included", () => {
    // Guards the fixture itself, exactly as `healthy-fleet.fixture.ts` is
    // guarded: if a regeneration ever flattens it into comfortable constants,
    // the safety assertions above quietly stop testing safety.
    const s = summarizeRecallRows(rows);
    expect(s.rows).toBe(278);
    // The measurement that made the latency signal restorable at all.
    expect(s.elapsedP95Ms!).toBeLessThan(RECALL_P95_WARN_MS);
    expect(s.elapsedP95Ms!).toBeGreaterThan(1000);
    // Real tails, not a constant: zero-result rows and near-zero scores are
    // present, and the score distribution spans orders of magnitude.
    const scores = rows
      .map((r) => r.injected_score_max)
      .filter((x): x is number => typeof x === "number");
    expect(Math.min(...scores)).toBeLessThan(0.01);
    expect(Math.max(...scores)).toBeGreaterThan(0.9);
    expect(new Set(scores).size).toBeGreaterThan(100);
    // The deadline field is populated — without it the pinning signal would be
    // permanently no-data and this file would assert nothing about it.
    expect(s.deadlineConsidered).toBeGreaterThanOrEqual(RECALL_MIN_SAMPLES);
    expect(s.deadlineEffectiveMedianMs!).toBeGreaterThan(9000);
  });

  /**
   * The assertion with teeth, and the one the deleted latency signal failed.
   *
   * A point estimate over the pooled fixture is not enough: a real tick reads
   * roughly a 60-row window, and what condemns a threshold is the SPREAD of
   * that window statistic, not its pooled value. Same seeded-LCG bootstrap as
   * `recall-log.test.ts` uses for the injected-score line, so a failure is a
   * regression rather than a flake.
   */
  function falseFireRate(
    values: number[],
    fires: (w: number[]) => boolean,
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

  function quantile(values: number[], p: number): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(Math.max(1, Math.ceil(p * s.length)), s.length) - 1]!;
  }

  const latencies = rows
    .map((r) => r.total_elapsed_ms)
    .filter((n): n is number => typeof n === "number");

  it("the SHIPPED latency lines never fire on repaired traffic — the re-baseline BLOCKER 1 asked for", () => {
    // The exact inverse of the "no line below the 8 s budget is safe" test in
    // `recall-log.test.ts`, run against the population that test's comment
    // said would be needed before the signal could ship. 4000 and 6000 ms
    // fired on >90 % of 2026-07 windows; here they fire on none.
    expect(falseFireRate(latencies, (w) => quantile(w, 0.95) >= RECALL_P95_WARN_MS)).toBe(0);
    expect(falseFireRate(latencies, (w) => quantile(w, 0.95) >= RECALL_P95_PAGE_MS)).toBe(0);
    expect(RECALL_P95_PAGE_MS).toBeGreaterThan(RECALL_P95_WARN_MS);
  });

  it("the deadline-pinning ratio never approaches its line on repaired traffic", () => {
    const deadline = summarizeRecallRows(rows).deadlineEffectiveMedianMs!;
    // Not merely under the 0.90 line — under a THIRD of it, so the thin
    // 0.4 % margin recorded on the constant is a property of the sick side
    // only and cannot flip this one.
    expect(falseFireRate(latencies, (w) => quantile(w, 0.95) / deadline >= 0.3)).toBe(0);
  });
});

// ── 3. the baseline ─────────────────────────────────────────────────────────

/** A baseline of `days` completed days, each with a constant daily value. */
function warmBaseline({
  score,
  pool,
  days,
  endingBefore,
}: {
  score: number;
  pool: number;
  days: number;
  endingBefore: string;
}): RecallBaseline {
  const end = Date.parse(`${endingBefore}T00:00:00Z`);
  let b: RecallBaseline | undefined;
  for (let d = days; d >= 1; d--) {
    const ts = end - d * 86_400_000 + 43_200_000;
    for (let tick = 0; tick < 4; tick++) {
      b = foldBaseline(
        b,
        {
          rows: 100,
          agents: 1,
          timeoutConsidered: 100,
          ownBankDegraded: 0,
          zeroConsidered: 100,
          zeroResult: 0,
          poolConsidered: 100,
          poolMedian: pool,
          scoreConsidered: 100,
          scoreP50: score,
          elapsedConsidered: 100,
          elapsedP95Ms: 1400,
        },
        ts + tick * 3_600_000,
      );
    }
  }
  return b!;
}

/** A settled baseline matching the repaired fleet, for the green-path tests. */
function repairedBaseline(): RecallBaseline {
  return warmBaseline({ score: 0.864, pool: 94, days: 7, endingBefore: "2026-08-12" });
}

describe("the trailing baseline is bounded and cannot contaminate itself", () => {
  it("never retains more than the window plus today, however long it runs", () => {
    let b: RecallBaseline | undefined;
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let d = 0; d < 90; d++) {
      b = foldBaseline(b, sampleAt(0.8, 90), start + d * 86_400_000);
      expect(b.days.length).toBeLessThanOrEqual(RECALL_BASELINE_DAYS + 1);
    }
    expect(b!.days).toHaveLength(RECALL_BASELINE_DAYS + 1);
  });

  it("caps observations per day, keeping the newest — a fast cadence cannot grow it without bound", () => {
    let b: RecallBaseline | undefined;
    const day = Date.parse("2026-08-11T00:00:00Z");
    for (let i = 0; i < RECALL_BASELINE_MAX_OBS_PER_DAY * 3; i++) {
      b = foldBaseline(b, sampleAt(i / 1000, 90), day + i * 1000);
    }
    const today = b!.days.find((d) => d.day === "2026-08-11")!;
    expect(today.scoreObs).toHaveLength(RECALL_BASELINE_MAX_OBS_PER_DAY);
    // Newest kept, not oldest: the day's median must describe its most recent
    // ticks rather than a stale prefix.
    expect(today.scoreObs[today.scoreObs.length - 1]).toBeCloseTo(
      (RECALL_BASELINE_MAX_OBS_PER_DAY * 3 - 1) / 1000,
      6,
    );
  });

  it("excludes TODAY from its own baseline", () => {
    // The crux of the signal. Include today and the current degradation drags
    // the reference toward the measurement and shrinks the drop being
    // detected. Asserted as a value, not a comment.
    let b = warmBaseline({ score: 0.8, pool: 90, days: 7, endingBefore: "2026-08-12" });
    const now = Date.parse("2026-08-12T12:00:00Z");
    b = foldBaseline(b, sampleAt(0.05, 90), now);
    expect(baselineFor(b, now).score.value).toBeCloseTo(0.8, 6);
  });

  it("reports no-data below the minimum warm-up rather than firing on one day of history", () => {
    let b: RecallBaseline | undefined;
    const start = Date.parse("2026-08-01T00:00:00Z");
    for (let d = 0; d < RECALL_BASELINE_MIN_DAYS - 1; d++) {
      b = foldBaseline(b, sampleAt(0.8, 90), start + d * 86_400_000);
    }
    const now = start + (RECALL_BASELINE_MIN_DAYS - 1) * 86_400_000;
    expect(baselineFor(b, now).score.value).toBeNull();
    const v = evaluateRecallQualityRegression(ringOf(repairedRows()), b, now);
    expect(v.state).toBe("no-data");
  });

  it("survives a watchdog outage instead of re-baselining like the 3-hour ring does", () => {
    // The reason this is not stored in `state.ring`: a gap must not erase the
    // history, because a regression that begins during an outage is precisely
    // the one still worth catching on return.
    const b = warmBaseline({ score: 0.8, pool: 90, days: 7, endingBefore: "2026-08-05" });
    const afterOutage = Date.parse("2026-08-06T12:00:00Z");
    expect(baselineFor(b, afterOutage).score.value).toBeCloseTo(0.8, 6);
  });

  it("drops future-dated days so clock skew cannot freeze the fold", () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const skewed = foldBaseline(undefined, sampleAt(0.8, 90), now + 5 * 86_400_000);
    const folded = foldBaseline(skewed, sampleAt(0.8, 90), now);
    expect(folded.days.map((d) => d.day)).toEqual([utcDay(now)]);
  });

  it("skips a series it cannot measure rather than recording a zero for it", () => {
    // A zero here is indistinguishable from a real measurement of zero and
    // would drag the baseline down, making a later real regression invisible.
    const now = Date.parse("2026-08-12T12:00:00Z");
    const b = foldBaseline(undefined, { ...sampleAt(0.8, 90), scoreP50: null }, now);
    const day = b.days[0]!;
    expect(day.scoreObs).toHaveLength(0);
    expect(day.poolObs).toHaveLength(1);
  });
});

describe("a corrupt persisted baseline degrades to no-data, never to a pass", () => {
  it("rejects a non-numeric observation instead of letting NaN compare false", () => {
    const loaded = normalizeBaseline({
      days: [
        { day: "2026-08-09", scoreObs: [0.8, "wat", null, 0.82], poolObs: [90] },
        { day: "2026-08-10", scoreObs: [0.81], poolObs: [91] },
        { day: "2026-08-11", scoreObs: [0.79], poolObs: [92] },
      ],
    })!;
    expect(loaded.days[0]!.scoreObs).toEqual([0.8, 0.82]);
    const v = baselineFor(loaded, Date.parse("2026-08-12T00:00:00Z"));
    expect(Number.isNaN(v.score.value!)).toBe(false);
  });

  it("rejects a malformed day key, so ordering comparisons stay meaningful", () => {
    const loaded = normalizeBaseline({
      days: [{ day: "yesterday", scoreObs: [0.8], poolObs: [90] }],
    });
    expect(loaded).toBeNull();
  });

  it("re-applies the per-day cap on LOAD, not only on fold", () => {
    const loaded = normalizeBaseline({
      days: [
        {
          day: "2026-08-11",
          scoreObs: Array.from({ length: 5000 }, (_, i) => i / 10_000),
          poolObs: [],
        },
      ],
    })!;
    expect(loaded.days[0]!.scoreObs).toHaveLength(RECALL_BASELINE_MAX_OBS_PER_DAY);
  });

  it("a garbage block yields no-data from the evaluator, not ok", () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const v = evaluateRecallQualityRegression(
      ringOf(repairedRows()),
      normalizeBaseline("nonsense") ?? undefined,
      now,
    );
    expect(v.state).toBe("no-data");
  });
});

describe("fractionalDrop", () => {
  it("reports improvement as zero, so recall getting BETTER can never fire", () => {
    expect(fractionalDrop(0.9, 0.5)).toBe(0);
  });

  it("refuses to divide by a non-positive baseline", () => {
    expect(fractionalDrop(0.5, 0)).toBeNull();
    expect(fractionalDrop(0.5, null)).toBeNull();
    expect(fractionalDrop(null, 0.5)).toBeNull();
  });
});

describe("the relative signal never duplicates the absolute floors", () => {
  it("stays no-data when the baseline itself is already at the floor", () => {
    // A fleet whose baseline top-hit score is 0.002 is not regressing, it is
    // broken, and `recall-injected-score` is already paging. Firing here too
    // would double-alert one failure.
    const now = Date.parse("2026-08-12T12:00:00Z");
    const b = warmBaseline({ score: 0.002, pool: 4, days: 7, endingBefore: "2026-08-12" });
    const collapsed = sickRows({
      score: 0.0005,
      pool: 1,
      latP50: 900,
      latP95: 1400,
      deadlineHitRate: 0,
    });
    const ring = ringOf(collapsed);
    expect(evaluateRecallQualityRegression(ring, b, now).state).toBe("no-data");
    // …and the floors ARE the ones speaking, so the failure is not silent.
    expect(evaluateRecallInjectedScore(ring).severity).toBe("page");
    expect(evaluateRecallCandidateFloor(ring).severity).toBe("page");
  });
});

describe("fail-closed reduction for the new signals", () => {
  it("reports no-data rather than ok below the sample floor", () => {
    const ring = ringOf(repairedRows(RECALL_MIN_SAMPLES - 1));
    for (const v of [evaluateRecallLatency(ring), evaluateRecallDeadlinePinning(ring)]) {
      expect(`${v.signal}=${v.state}`).toBe(`${v.signal}=no-data`);
    }
  });

  it("reports no-data, not ok, when no recall telemetry was collected at all", () => {
    const ring = ringOf([]);
    ring[0]!.recall = null;
    expect(evaluateRecallLatency(ring).state).toBe("no-data");
    expect(evaluateRecallDeadlinePinning(ring).state).toBe("no-data");
    expect(evaluateRecallQualityRegression(ring, repairedBaseline(), NOW).state).toBe("no-data");
  });

  it("pinning refuses to substitute a constant for an absent per-row deadline", () => {
    // The fail-open shape: scoring against the compiled-in RECALL_WALL_MS when
    // the rows carry no deadline. On a fleet that RAISED its deadline that
    // would invent breaches; on one that lowered it, it would hide them.
    const rows = repairedRows().map((r) => ({ ...r, deadline_effective_ms: null }));
    const v = evaluateRecallDeadlinePinning(ringOf(rows));
    expect(v.state).toBe("no-data");
  });
});

/** A minimal recall summary for baseline folding. */
function sampleAt(score: number, pool: number) {
  return {
    rows: 100,
    agents: 1,
    timeoutConsidered: 100,
    ownBankDegraded: 0,
    zeroConsidered: 100,
    zeroResult: 0,
    poolConsidered: 100,
    poolMedian: pool,
    scoreConsidered: 100,
    scoreP50: score,
    elapsedConsidered: 100,
    elapsedP95Ms: 1400,
  };
}
