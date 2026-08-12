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
  RECALL_DEADLINE_HIT_WARN,
  RECALL_MIN_SAMPLES,
  RECALL_P95_PAGE_MS,
  RECALL_P95_WARN_MS,
  RECALL_QUALITY_DROP_PAGE,
  RECALL_QUALITY_DROP_WARN,
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

  it("recall-deadline-pinning fires on every single day of it, graded by how much was cut off", () => {
    // Severity tracks the measured truncation rate rather than being flat, so
    // the three mildest days of the incident are a warn and the four worst are
    // a page. Asserted day-by-day against the aggregates in SICK_DAYS: a test
    // that only checked `state === "breach"` would pass just as happily if the
    // grading were inverted.
    const expected: Record<keyof typeof SICK_DAYS, string> = {
      "08-01": "breach/page", // 22.3%
      "08-02": "breach/page", // 37.2%
      "08-03": "breach/page", // 39.2%
      "08-04": "breach/warn", // 12.5%
      "08-05": "breach/warn", // 17.9%
      "08-06": "breach/page", // 26.6%
      "08-07": "breach/warn", // 15.7%
    };
    for (const [day, spec] of Object.entries(SICK_DAYS)) {
      const v = evaluateRecallDeadlinePinning(ringOf(sickRows(spec)));
      expect(`${day}:${v.state}/${v.severity}`).toBe(
        `${day}:${expected[day as keyof typeof SICK_DAYS]}`,
      );
    }
  });

  /**
   * The regression test for the defect review found in #4614's first cut.
   *
   * That version scored `p95 >= 0.90 × deadline_effective_ms`. Both of those
   * are config: the fan-out wall is `parallel_deadline_seconds` (10) and the
   * censoring point is the separate per-request `request_timeout_seconds`,
   * which `switchroom.yaml` records being revised 8 → 9 on 2026-07-29. So the
   * ratio was reporting 8/10 for the whole week of 07-20 → 07-26 and staying
   * silent, while 84-95 % of every recall on those days was being cut off —
   * blind to the worst week in the log, and scoring it as HEALTHIER than the
   * milder August incident it did catch.
   *
   * The rate is config-independent, so the July shape fires loudly. If anyone
   * reintroduces a deadline-relative ratio, this is the test that stops it.
   */
  it("fires on the July config shape, where a deadline-relative ratio was blind", () => {
    const july = sickRows({
      score: 0.62,
      pool: 70,
      latP50: 6500,
      latP95: 8095, // the measured 07-20 → 07-26 p95, against a ~9997ms deadline
      deadlineHitRate: 0.9, // 84-95% measured across those seven days
    });
    // The old ratio scored this 0.81, comfortably under its 0.90 line.
    expect(8095 / 9993).toBeLessThan(0.9);

    const v = evaluateRecallDeadlinePinning(ringOf(july));
    expect(`${v.state}/${v.severity}`).toBe("breach/page");
    expect(v.measured?.rate).toBeGreaterThan(0.8);
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
    expect(s.rows).toBe(258);
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
   * A point estimate over the pooled fixture is not enough: a real tick reads a
   * WINDOW, and what condemns a threshold is the spread of that window
   * statistic, not its pooled value.
   *
   * CONTIGUOUS, not a bootstrap. The first cut of this file drew each window by
   * sampling rows independently at random, which assumes recall latency is IID
   * across rows. It is not — the failure mode this whole PR exists to catch is
   * precisely a multi-day correlated excursion, and independent resampling
   * destroys exactly the autocorrelation that produces a bad window. An IID
   * bootstrap systematically UNDERSTATES the false-fire rate of a threshold,
   * which is the optimistic direction, on the one number this PR uses to argue
   * a previously-rejected signal is now safe. So every window here is a run of
   * adjacent rows in time order, and the claim is over the real sequence.
   *
   * Scope, stated rather than implied: the fixture is a stratified sample, so
   * `windowSize` adjacent entries span more wall-clock than the same count of
   * raw log rows. This measures the threshold against every contiguous stretch
   * of the repaired capture; it is not a claim about traffic outside it.
   */
  function contiguousFireRate(
    values: number[],
    fires: (w: number[]) => boolean,
    windowSize = 60,
  ): { rate: number; windows: number } {
    expect(values.length).toBeGreaterThan(windowSize);
    let fired = 0;
    let windows = 0;
    for (let start = 0; start + windowSize <= values.length; start++) {
      windows++;
      if (fires(values.slice(start, start + windowSize))) fired++;
    }
    return { rate: fired / windows, windows };
  }

  function quantile(values: number[], p: number): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(Math.max(1, Math.ceil(p * s.length)), s.length) - 1]!;
  }

  const latencies = rows
    .map((r) => r.total_elapsed_ms)
    .filter((n): n is number => typeof n === "number");

  it("the SHIPPED latency lines never fire on ANY contiguous window of repaired traffic", () => {
    // The exact inverse of the "no line below the 8 s budget is safe" test in
    // `recall-log.test.ts`, run against the population that test's comment
    // said would be needed before the signal could ship. 4000 and 6000 ms
    // fired on >90 % of 2026-07 windows; here they fire on none.
    for (const line of [RECALL_P95_WARN_MS, RECALL_P95_PAGE_MS]) {
      const { rate, windows } = contiguousFireRate(latencies, (w) => quantile(w, 0.95) >= line);
      // The window count is asserted too: a fixture that shrank below the
      // window size would make `rate` vacuously 0 via an empty loop.
      expect(`${line}:${rate}:${windows > 100}`).toBe(`${line}:0:true`);
    }
    expect(RECALL_P95_PAGE_MS).toBeGreaterThan(RECALL_P95_WARN_MS);
  });

  it("no contiguous window of repaired traffic comes near the truncation lines", () => {
    // The signal's own denominator, replayed the same way: not merely under
    // the 5 % warn line but at zero on every window, because a repaired fleet
    // does not truncate at all.
    const hits = rows.map((r) => (r.deadline_hit === true ? 1 : 0));
    const { rate } = contiguousFireRate(
      hits,
      (w) => w.reduce((a, b) => a + b, 0) / w.length >= RECALL_DEADLINE_HIT_WARN,
    );
    expect(rate).toBe(0);
    expect(summarizeRecallRows(rows).deadlineHitRows).toBe(0);
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

  it("excludes TODAY from its own baseline, and the exclusion changes the VERDICT", () => {
    // The crux of the signal, and a test that has to be built deliberately to
    // have teeth. A FLAT prior week cannot test this at all: seven days of a
    // constant 0.8 plus one bad day still has a median of 0.8, so `d.day <
    // today` and `d.day <= today` agree and the assertion passes either way.
    //
    // A monotone slide separates them. The prior week is already sagging, so
    // admitting today pulls the reference down with the measurement — the
    // self-referential failure this whole design exists to avoid, where a slow
    // decline normalises itself and the drop being detected shrinks toward
    // nothing exactly as the decline gets worse.
    //
    //   prior 7 days   0.65 0.64 0.62 0.60 0.30 0.28 0.25  → median 0.60
    //   today          0.20
    //   contaminated   median of all eight              → 0.45
    //
    //   drop against the correct 0.60 baseline   66.7 %  → PAGE
    //   drop against the contaminated 0.45       55.6 %  → warn
    //
    // So the mutation is visible as a severity change, not just a number.
    const week = [0.65, 0.64, 0.62, 0.6, 0.3, 0.28, 0.25];
    const now = Date.parse("2026-08-12T12:00:00Z");
    const end = Date.parse("2026-08-12T00:00:00Z");
    let b: RecallBaseline | undefined;
    week.forEach((score, i) => {
      // Pool held flat so the pool arm contributes nothing and the verdict is
      // unambiguously the score arm's.
      b = foldBaseline(b, sampleAt(score, 90), end - (week.length - i) * 86_400_000 + 43_200_000);
    });
    b = foldBaseline(b, sampleAt(0.2, 90), now);

    expect(baselineFor(b!, now).score.value).toBeCloseTo(0.6, 6);

    const v = evaluateRecallQualityRegression(
      ringOf(sickRows({ score: 0.2, pool: 90, latP50: 1100, latP95: 1500, deadlineHitRate: 0 }), now),
      b,
      now,
    );
    expect(`${v.state}/${v.severity}`).toBe("breach/page");
    expect(v.measured?.baseline as number).toBeCloseTo(0.6, 6);
    expect(v.measured?.drop as number).toBeGreaterThan(RECALL_QUALITY_DROP_PAGE);

    // …and the counterfactual, spelled out: scored against the CONTAMINATED
    // 0.45 the very same measurement is only a warn. This is the assertion the
    // flat-week version of this test could not make, and the one that fails if
    // `baselineFor`'s day filter is loosened to include today.
    const observed = (1 - (v.measured?.drop as number)) * 0.6;
    const contaminated = 1 - observed / 0.45;
    expect(contaminated).toBeGreaterThanOrEqual(RECALL_QUALITY_DROP_WARN);
    expect(contaminated).toBeLessThan(RECALL_QUALITY_DROP_PAGE);
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

  it("pinning still scores when the rows carry no deadline value at all", () => {
    // The whole point of moving off `p95 / deadline_effective_ms`: the verdict
    // must not depend on a config value the row may not even carry. The
    // non-parallel recall path logs `deadline_effective_ms` as null, and the
    // first cut of this signal went blind on exactly that.
    const rows = repairedRows().map((r) => ({ ...r, deadline_effective_ms: null }));
    const v = evaluateRecallDeadlinePinning(ringOf(rows));
    expect(v.state).toBe("ok");

    const cutOff = rows.map((r, i) => ({ ...r, deadline_hit: i % 2 === 0 }));
    const sick = evaluateRecallDeadlinePinning(ringOf(cutOff));
    expect(`${sick.state}/${sick.severity}`).toBe("breach/page");
  });

  it("excludes rows with no deadline_hit flag instead of counting them as completions", () => {
    // The fail-OPEN shape this guards: using `rows` as the denominator. 4 of
    // the 40 instrumented rows were cut off (10% — a warn), but 80 further
    // rows predate the flag. Against `rows` the rate dilutes to 4/120 = 3.3%
    // and the signal reports `ok` on a fleet that is truncating one recall in
    // ten, with the dilution worst exactly when the log is least trustworthy.
    const base = repairedRows(120);
    const rows = base.map((r, i) => ({
      ...r,
      deadline_hit: i >= 40 ? undefined : i < 4,
    }));
    const v = evaluateRecallDeadlinePinning(ringOf(rows));
    expect(`${v.state}/${v.severity}`).toBe("breach/warn");
    expect(v.measured?.deadlineHitConsidered).toBe(40);
    expect(v.measured?.rate).toBeCloseTo(0.1, 6);
  });

  it("rejects a garbled persisted truncation count instead of scoring NaN as ok", () => {
    // `normalizeRecallSample` tolerates these two fields as optional so an
    // older persisted sample stays usable, which means the evaluator is the
    // only thing standing between a corrupt state file and a false all-clear:
    // `"120" < 30` is false, so a bare floor check would pass, and the
    // resulting `NaN >= threshold` is false, so the signal would report `ok`
    // on a fleet it cannot see at all.
    const ring = ringOf(repairedRows());
    for (const bad of [{ deadlineHitConsidered: "120" }, { deadlineHitConsidered: 120, deadlineHitRows: 200 }, { deadlineHitConsidered: 120.5 }, { deadlineHitConsidered: 120, deadlineHitRows: -1 }]) {
      const poisoned = ringOf(repairedRows());
      poisoned[0]!.recall = { ...ring[0]!.recall!, ...bad } as (typeof ring)[0]["recall"];
      const v = evaluateRecallDeadlinePinning(poisoned);
      expect(`${JSON.stringify(bad)}=${v.state}`).toBe(`${JSON.stringify(bad)}=no-data`);
    }
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
