/**
 * Percentile reduction for the recall-latency harness.
 *
 * Pure, no IO, no clock — every number in a result file comes through here, so
 * this is the one place a reviewer has to read to know what "p95" means in this
 * repo.
 *
 * **Nearest-rank, not interpolated.** `p95` of a sample set is the smallest
 * observed value at or above the 95th rank, i.e. an actually-observed latency,
 * never a synthesised one between two samples. That matters for AC1: a run-to-
 * run comparison of interpolated percentiles moves when a single sample shifts
 * across a boundary even if no observation changed, which manufactures noise in
 * exactly the number the epic grades everything by.
 */

import type { CellStats } from "./types.js";

/**
 * Nearest-rank percentile of `values` (ms), `p` in (0, 1].
 *
 * Sorts a copy — callers routinely pass the live sample array and a
 * percentile function that reorders its input silently corrupts
 * `CellResult.samplesMs`, which is persisted in completion order so a later
 * reader can re-reduce or spot drift within a cell.
 *
 * Returns `NaN` for an empty set rather than 0: zero is a plausible latency and
 * would read as an impossibly fast cell instead of as "no data".
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  if (!(p > 0) || p > 1) throw new RangeError(`percentile p must be in (0, 1], got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: ceil(p * N), clamped into [1, N].
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

/** Bootstrap resamples behind every reported p95 confidence interval. */
export const BOOTSTRAP_REPS = 2000;

/**
 * Deterministic PRNG (mulberry32).
 *
 * The bootstrap must not make a result file irreproducible: re-reducing the
 * same `samplesMs` has to yield the same interval, or `--compare` would report
 * a difference that came from the random number generator rather than from the
 * database. Seeded from the data, so it is stable across machines and runs.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95 % bootstrap confidence interval for the p95 of `values`.
 *
 * **Why this is in the result file and not left to the reader.** At n=40 the
 * nearest-rank p95 is a single order statistic — the 38th sorted sample — so
 * its own sampling error is large, and on this workload it is empirically wider
 * than the ±10 % gate AC1 asks for. Without the interval, two runs that differ
 * only by which samples they happened to draw look like a regression, and the
 * epic would chase a system change that never happened. With it, a reader can
 * tell "the system moved" from "the estimator moved".
 *
 * Percentile-method interval over `BOOTSTRAP_REPS` resamples with replacement.
 * Returns `[NaN, NaN]` for an empty set.
 */
export function bootstrapP95Ci(values: readonly number[], reps = BOOTSTRAP_REPS): [number, number] {
  const n = values.length;
  if (n === 0) return [NaN, NaN];
  if (n === 1) return [values[0] as number, values[0] as number];
  // Sort first: resampling draws BY INDEX, so an unsorted input would make the
  // interval depend on the order samples happened to complete in. Two readers
  // re-reducing the same cell must get the same interval.
  const pool = [...values].sort((a, b) => a - b);
  // Seed from the data itself: same samples ⇒ same interval, always.
  const seed = n * 2654435761 + Math.round(pool.reduce((a, b) => a + b, 0));
  const rnd = mulberry32(seed);
  const reduced = new Array<number>(reps);
  const draw = new Array<number>(n);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) draw[i] = pool[Math.floor(rnd() * n)] as number;
    reduced[r] = percentile(draw, 0.95);
  }
  reduced.sort((a, b) => a - b);
  const lo = reduced[Math.max(0, Math.floor(0.025 * reps) - 1)] as number;
  const hi = reduced[Math.min(reps - 1, Math.ceil(0.975 * reps) - 1)] as number;
  return [lo, hi];
}

/**
 * Reduce one cell's samples.
 *
 * `errors` is carried separately and never folded into the percentiles: a
 * timeout has no latency, and imputing the timeout value would make a cell look
 * *better* the more often it failed once the failures dominate the tail.
 *
 * An all-error cell yields `NaN` percentiles and `n: 0` — visible in the result
 * file as an absent measurement rather than as a suspiciously clean zero.
 */
export function summarize(samplesMs: readonly number[], errors: number): CellStats {
  const n = samplesMs.length;
  if (n === 0) {
    return {
      n: 0, errors, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN,
      mean: NaN, stddev: NaN, cv: NaN, p95CiLow: NaN, p95CiHigh: NaN,
    };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  // Population (not sample) variance: this is the whole set of observations for
  // the cell, not a draw from a larger one, and the n-1 correction would only
  // shift the reported noise figure without changing any comparison.
  const variance = sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const [p95CiLow, p95CiHigh] = bootstrapP95Ci(sorted);
  return {
    n,
    errors,
    min: sorted[0] as number,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[n - 1] as number,
    mean,
    stddev,
    cv: mean === 0 ? 0 : stddev / mean,
    p95CiLow,
    p95CiHigh,
  };
}

/** Round to `dp` decimals for display. Never used on persisted raw samples. */
export function round(v: number, dp = 1): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
