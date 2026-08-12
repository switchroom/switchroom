/**
 * The trailing recall-quality baseline: a bounded, per-UTC-day fold over the
 * ticks the watchdog has already taken, and the trailing-median query
 * `recall-quality-regression` scores against.
 *
 * WHY THIS IS NOT THE RING. `Sample`s live in `state.ring`, which is capped at
 * `RING_MAX` = 8 entries AND pruned to `MAX_SAMPLE_AGE_MS` = 3 h. Both bounds
 * are deliberate and both are fatal here: the ring exists so that a watchdog
 * which was down re-baselines on current data rather than reasoning across a
 * gap, and a 3-hour window cannot answer "worse than the last WEEK". So the
 * baseline is a separate structure with the OPPOSITE property — it survives
 * gaps, because a regression that starts during an outage of the watchdog is
 * exactly the one you still want caught when it comes back.
 *
 * Everything here is pure: `foldBaseline` takes the old baseline and a tick
 * and returns a new one; `baselineFor` reads. No IO, no clock — the caller
 * passes `now`, so the tests drive real calendar days without faking time.
 */

import {
  RECALL_BASELINE_DAYS,
  RECALL_BASELINE_MAX_OBS_PER_DAY,
  RECALL_BASELINE_MIN_DAYS,
} from "./thresholds.js";
import type { RecallBaseline, RecallBaselineDay, RecallSample } from "./types.js";

/**
 * The UTC day key for a timestamp, `YYYY-MM-DD`.
 *
 * UTC and not local time, so the key cannot shift under a DST transition and
 * silently produce a 23- or 25-hour "day" whose median is drawn from a
 * different number of ticks than its neighbours. The fleet's `recall_log`
 * timestamps are UTC too, so the day boundary here is the same boundary the
 * underlying rows were bucketed by.
 */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Median of a numeric sample. `null` for an empty one — never 0. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A finite number, and nothing else. Guards the fold against NaN poisoning. */
function isFinitePositiveOrZero(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/**
 * Fold one tick's recall summary into the baseline.
 *
 * Three bounds, all enforced here rather than at the call site so a future
 * caller cannot forget one:
 *
 *  1. At most `RECALL_BASELINE_DAYS + 1` days are retained — the seven the
 *     query reads, plus TODAY, which is being accumulated and is never its own
 *     baseline.
 *  2. At most `RECALL_BASELINE_MAX_OBS_PER_DAY` observations per day per
 *     series, dropping the OLDEST when full.
 *  3. Non-finite or absent statistics are skipped rather than recorded, per
 *     series independently. A tick where the pool was measured and the score
 *     was not contributes to `poolObs` only — the same fail-closed,
 *     own-denominator discipline the SLIs use.
 *
 * Days are kept sparse and oldest-first: a watchdog that was down for two days
 * simply has no entry for them, and the trailing median is then taken over
 * however many of the last seven days DO exist (subject to
 * `RECALL_BASELINE_MIN_DAYS`). Zero-filling a missing day would be a lie about
 * a period nobody measured.
 */
export function foldBaseline(
  prev: RecallBaseline | undefined,
  recall: RecallSample | null | undefined,
  now: number,
): RecallBaseline {
  const days = prev?.days ? [...prev.days] : [];
  if (!recall) return pruneDays(days, now);

  const key = utcDay(now);
  const existing = days.find((d) => d.day === key);
  const day: RecallBaselineDay = existing
    ? { day: key, scoreObs: [...existing.scoreObs], poolObs: [...existing.poolObs] }
    : { day: key, scoreObs: [], poolObs: [] };

  if (isFinitePositiveOrZero(recall.scoreP50)) push(day.scoreObs, recall.scoreP50);
  if (isFinitePositiveOrZero(recall.poolMedian)) push(day.poolObs, recall.poolMedian);

  const others = days.filter((d) => d.day !== key);
  return pruneDays([...others, day], now);
}

/** Append under the per-day cap, dropping the oldest observation when full. */
function push(obs: number[], value: number): void {
  obs.push(value);
  if (obs.length > RECALL_BASELINE_MAX_OBS_PER_DAY) {
    obs.splice(0, obs.length - RECALL_BASELINE_MAX_OBS_PER_DAY);
  }
}

/**
 * Sort oldest-first, drop empty days, and keep only the window.
 *
 * Days dated in the FUTURE relative to `now` are dropped outright — clock skew
 * or a restored state file would otherwise leave a phantom "today" that shadows
 * the real one and freezes the fold (every subsequent tick would compare
 * against, and append to, a day that never ends).
 */
function pruneDays(days: RecallBaselineDay[], now: number): RecallBaseline {
  const today = utcDay(now);
  const kept = days
    .filter((d) => typeof d.day === "string" && d.day <= today)
    .filter((d) => d.scoreObs.length > 0 || d.poolObs.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-(RECALL_BASELINE_DAYS + 1));
  return { days: kept };
}

/** One series' trailing baseline. */
export interface BaselineSeries {
  /**
   * Median of the per-day medians over the completed window, or `null` when
   * fewer than `RECALL_BASELINE_MIN_DAYS` days contributed. `null` means "not
   * warmed yet" and the evaluator turns it into `no-data`, never into a pass.
   */
  value: number | null;
  /** completed days that actually contributed — rendered in the DM */
  days: number;
}

/** What the regression evaluator needs to score one tick. */
export interface BaselineQuery {
  score: BaselineSeries;
  pool: BaselineSeries;
}

/**
 * The trailing baseline as of `now`: the median of the per-day medians over
 * the `RECALL_BASELINE_DAYS` completed days before today.
 *
 * TODAY IS EXCLUDED, and that is the crux of the signal. Include it and the
 * current degradation is inside its own reference, which drags the baseline
 * toward the measurement and shrinks the drop the signal is trying to see —
 * on the 2026-08-03 incident data, including today halves the computed drop.
 *
 * Median-of-medians rather than a pooled median so that a day with four times
 * the traffic does not get four times the vote: the baseline is "what a normal
 * DAY looks like", and each day should count once.
 *
 * Returns `null` for a series with fewer than `RECALL_BASELINE_MIN_DAYS`
 * contributing days. Each series is counted separately — a fleet where the
 * pool was measurable all week but the score was not gets a pool baseline and
 * no score baseline, rather than both or neither.
 */
export function baselineFor(baseline: RecallBaseline | undefined, now: number): BaselineQuery {
  const today = utcDay(now);
  const completed = (baseline?.days ?? [])
    .filter((d) => d.day < today)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-RECALL_BASELINE_DAYS);

  const reduce = (pick: (d: RecallBaselineDay) => number[]): BaselineSeries => {
    const dailyMedians = completed
      .map((d) => median(pick(d)))
      .filter((m): m is number => m !== null);
    const days = dailyMedians.length;
    return {
      value: days >= RECALL_BASELINE_MIN_DAYS ? median(dailyMedians) : null,
      days,
    };
  };

  return {
    score: reduce((d) => d.scoreObs),
    pool: reduce((d) => d.poolObs),
  };
}

/**
 * The fractional drop of `observed` below `baseline`, or `null` when the
 * comparison is not meaningful.
 *
 * Only DROPS are reported: an improvement returns 0, not a negative number, so
 * a caller comparing against a threshold cannot accidentally fire on recall
 * getting better. A non-positive baseline returns `null` rather than dividing
 * — "100 % worse than zero" is not a statement about anything.
 */
export function fractionalDrop(observed: number | null, baseline: number | null): number | null {
  if (observed === null || baseline === null) return null;
  if (!Number.isFinite(observed) || !Number.isFinite(baseline) || baseline <= 0) return null;
  return Math.max(0, (baseline - observed) / baseline);
}
