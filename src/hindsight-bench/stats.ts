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
    return { n: 0, errors, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN, stddev: NaN, cv: NaN };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  // Population (not sample) variance: this is the whole set of observations for
  // the cell, not a draw from a larger one, and the n-1 correction would only
  // shift the reported noise figure without changing any comparison.
  const variance = sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
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
  };
}

/** Round to `dp` decimals for display. Never used on persisted raw samples. */
export function round(v: number, dp = 1): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
