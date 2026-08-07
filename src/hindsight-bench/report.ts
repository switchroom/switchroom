/**
 * Reductions over result files: the AC1 reproducibility verdict, the AC4
 * contention verdict, and the human-readable summary.
 *
 * Pure — takes `BenchResult` values, returns strings and verdict objects. The
 * CLI does the reading and printing. Keeping the verdicts here (rather than
 * inline in the CLI) is what lets a test assert that the ±10 % gate actually
 * fails when it should, instead of asserting that a function was called.
 */

import { round } from "./stats.js";
import type { BenchResult, CellComparison, PhaseCell, ReproducibilityReport } from "./types.js";

/** AC1's tolerance: p95 within ±10 % per cell across repeated idle runs. */
export const DEFAULT_TOLERANCE = 0.1;

const cellKey = (bank: string, concurrency: number): string => `${bank}@c${concurrency}`;

/**
 * `(bank, concurrency)` keys that appear more than once in a result file.
 *
 * A sweep never produces one — it walks distinct pairs — but a hand-edited or
 * concatenated file can, and both verdicts key cells by that pair. With
 * duplicates the lookup silently keeps only the last occurrence, so the verdict
 * would compare cells that are not the same cell and still print a confident
 * PASS/FAIL. The CLI refuses such a file rather than grading it.
 */
export function duplicateCellKeys(cells: ReadonlyArray<{ bank: string; concurrency: number }>): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const c of cells) {
    const key = cellKey(c.bank, c.concurrency);
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

/**
 * Highest per-cell error rate a verdict will still grade.
 *
 * Above this the cell's percentiles are computed from the calls that happened
 * to survive, which is a different population from the one the sweep set out to
 * measure — typically the fast ones, because the slow ones are what time out.
 */
export const MAX_CELL_ERROR_RATE = 0.1;

/**
 * Cells a verdict must not grade, with the reason.
 *
 * Two failure modes, both observed live on 2026-08-07 when the Hindsight
 * container was recreated mid-sweep:
 *
 *  - **`no-samples`** — every call errored, so there is no percentile at all.
 *  - **`error-rate`** — enough calls errored that the surviving samples are a
 *    biased subset. One cell in that sweep reported a p95 of 1728 ms from six
 *    successful calls out of forty; graded naively it would have read as the
 *    *fastest* cell in the run.
 *
 * The contention verdict used to skip such cells silently and grade the rest,
 * so a sweep that lost a fifth of its cells to an outage still printed a
 * confident PASS. Both verdicts now surface them and refuse to pass.
 */
export function ungradeableCells(r: BenchResult): string[] {
  return ungradeable(r).map((u) => u.label);
}

function ungradeable(r: BenchResult): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const c of r.cells) {
    const { n, errors } = c.stats;
    const key = cellKey(c.bank, c.concurrency);
    if (n === 0 || !Number.isFinite(c.stats.p95)) {
      out.push({ key, label: `${key} (no-samples, ${errors} errors)` });
    } else if (errors / (n + errors) > MAX_CELL_ERROR_RATE) {
      out.push({ key, label: `${key} (error-rate ${round((errors / (n + errors)) * 100, 0)}%, n=${n})` });
    }
  }
  return out;
}

/**
 * Compare two runs' p95 per (bank, concurrency) cell.
 *
 * `relDelta` is measured **against run A**, not against the mean of the two: A
 * is the reference run and B the repeat, which is the shape AC1 asks for ("run
 * it twice and diff p95 per cell"). Symmetric normalisation would report a
 * smaller number for the same disagreement and quietly loosen the gate.
 *
 * A cell present in one run and not the other is `unmatched` and fails the
 * report outright. Silently intersecting the two would let a run that measured
 * fewer cells pass by measuring less.
 *
 * A cell whose reference p95 is not finite (all calls errored) is also
 * unmatched: there is no baseline to be within ±10 % of.
 */
export function compareRuns(a: BenchResult, b: BenchResult, tolerance = DEFAULT_TOLERANCE): ReproducibilityReport {
  const bByKey = new Map(b.cells.map((c) => [cellKey(c.bank, c.concurrency), c]));
  const seen = new Set<string>();
  const cells: CellComparison[] = [];
  const unmatched: string[] = [];
  const bad = [...ungradeable(a), ...ungradeable(b)];
  const badKeys = new Set(bad.map((u) => u.key));

  for (const ca of a.cells) {
    const key = cellKey(ca.bank, ca.concurrency);
    seen.add(key);
    const cb = bByKey.get(key);
    if (badKeys.has(key)) continue;
    if (cb === undefined || !Number.isFinite(ca.stats.p95) || !Number.isFinite(cb.stats.p95) || ca.stats.p95 === 0) {
      unmatched.push(key);
      continue;
    }
    const relDelta = Math.abs(cb.stats.p95 - ca.stats.p95) / ca.stats.p95;
    // The estimator's own precision, not the system's stability. Reported
    // alongside the gate so a reader can tell an unattainable gate from a
    // genuine regression; it deliberately does NOT relax `within`, because
    // widening the gate to whatever the noise happens to be is how a
    // measurement is tuned until it flatters itself.
    const ciLow = ca.stats.p95CiLow;
    const ciHigh = ca.stats.p95CiHigh;
    const noiseFloor =
      Number.isFinite(ciLow) && Number.isFinite(ciHigh) ? (ciHigh - ciLow) / 2 / ca.stats.p95 : NaN;
    cells.push({
      bank: ca.bank,
      concurrency: ca.concurrency,
      p95A: ca.stats.p95,
      p95B: cb.stats.p95,
      relDelta,
      within: relDelta <= tolerance,
      noiseFloor,
      explainedByNoise: Number.isFinite(noiseFloor) && relDelta <= noiseFloor,
    });
  }
  for (const key of bByKey.keys()) if (!seen.has(key) && !badKeys.has(key)) unmatched.push(key);

  const worstRelDelta = cells.reduce((m, c) => Math.max(m, c.relDelta), 0);
  const ungradeableLabels = [...new Set(bad.map((u) => u.label))];
  return {
    tolerance,
    cells,
    unmatched,
    ungradeable: ungradeableLabels,
    worstRelDelta,
    pass:
      unmatched.length === 0 &&
      ungradeableLabels.length === 0 &&
      cells.length > 0 &&
      cells.every((c) => c.within),
  };
}

/** One cell's idle-vs-contended p95 movement. */
export interface ContentionCell {
  bank: string;
  concurrency: number;
  idleP95: number;
  loadedP95: number;
  /** (loaded - idle) / idle. Positive means contention made things worse. */
  relDelta: number;
}

export interface ContentionReport {
  cells: ContentionCell[];
  /** Cells where the contended p95 exceeded the idle p95. */
  raised: number;
  /** Median relative movement across matched cells. */
  medianRelDelta: number;
  /**
   * AC4: contention mode demonstrably moves the number.
   *
   * Requires the contended p95 to be higher in a MAJORITY of cells AND the
   * median movement to clear `minRelDelta`. A single cell moving is noise; a
   * generator that only moves the mean while leaving p95 alone is not
   * reproducing the failure the epic exists to fix.
   */
  pass: boolean;
  minRelDelta: number;
  /**
   * Cells excluded because they could not be graded (see `ungradeableCells`).
   * Non-empty forces `pass: false`: a verdict over a sweep that partly failed
   * is a verdict over whichever cells happened to survive.
   */
  ungradeable: string[];
}

/** Minimum median p95 movement that counts as "demonstrably" raised. */
export const CONTENTION_MIN_REL_DELTA = 0.1;

export function compareContention(
  idle: BenchResult,
  loaded: BenchResult,
  minRelDelta = CONTENTION_MIN_REL_DELTA,
): ContentionReport {
  const loadedByKey = new Map(loaded.cells.map((c) => [cellKey(c.bank, c.concurrency), c]));
  const cells: ContentionCell[] = [];
  const bad = [...ungradeable(idle), ...ungradeable(loaded)];
  const badKeys = new Set(bad.map((u) => u.key));
  for (const ci of idle.cells) {
    if (badKeys.has(cellKey(ci.bank, ci.concurrency))) continue;
    const cl = loadedByKey.get(cellKey(ci.bank, ci.concurrency));
    if (cl === undefined || !Number.isFinite(ci.stats.p95) || ci.stats.p95 === 0 || !Number.isFinite(cl.stats.p95)) {
      continue;
    }
    cells.push({
      bank: ci.bank,
      concurrency: ci.concurrency,
      idleP95: ci.stats.p95,
      loadedP95: cl.stats.p95,
      relDelta: (cl.stats.p95 - ci.stats.p95) / ci.stats.p95,
    });
  }
  const raised = cells.filter((c) => c.relDelta > 0).length;
  const sorted = cells.map((c) => c.relDelta).sort((a, b) => a - b);
  const medianRelDelta = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] as number);
  const ungradeableLabels = [...new Set(bad.map((u) => u.label))];
  return {
    cells,
    raised,
    medianRelDelta,
    minRelDelta,
    ungradeable: ungradeableLabels,
    pass:
      cells.length > 0 &&
      ungradeableLabels.length === 0 &&
      raised > cells.length / 2 &&
      medianRelDelta >= minRelDelta,
  };
}

const mb = (bytes: number): string => (Number.isFinite(bytes) ? `${Math.round(bytes / 1024 / 1024)} MB` : "?");

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/** The human-readable summary printed after a run and pasted into issues. */
export function formatSummary(r: BenchResult): string {
  const L: string[] = [];
  const c = r.config;
  L.push(`hindsight recall bench — ${c.label || "(unlabelled)"}`);
  L.push(`  started ${c.startedAt}  ·  ${round(r.durationS, 0)}s  ·  schema v${r.schema}`);
  L.push(
    `  banks=${c.banks.length} concurrency=${c.concurrency.join(",")} samples=${c.samples} ` +
      `warmup=${c.warmup} query-set=${c.querySet} budget=${c.budget}`,
  );
  L.push(
    `  contention=${c.contention}${c.contention === "off" ? "" : ` workers=${c.contentionWorkers}`}` +
      `  stats-reset=${c.statsReset}  allow-writes=${c.allowWrites}`,
  );
  L.push("");
  L.push(
    `  instance image=${r.instance.imageTag ?? "unknown"}  ` +
      `reranker_max_candidates=${r.instance.rerankerMaxCandidates ?? "unset"}`,
  );
  L.push("");
  L.push("  db state");
  L.push(
    `    shared_buffers=${mb(r.db.sharedBuffersBytes)}  effective_cache_size=${mb(r.db.effectiveCacheSizeBytes)}` +
      `  hnsw.ef_search=${r.db.hnswEfSearch ?? "unset"}`,
  );
  L.push(
    `    memory_units total=${mb(r.db.memoryUnitsTotalBytes)} (heap ${mb(r.db.memoryUnitsHeapBytes)} + ` +
      `indexes ${mb(r.db.memoryUnitsIndexBytes)})`,
  );
  const fit = r.db.memoryUnitsTotalBytes / r.db.sharedBuffersBytes;
  L.push(`    working set / shared_buffers = ${round(fit * 100, 1)}%`);
  L.push(
    `    stats_reset=${r.db.statsResetAt ?? "NEVER (cache-hit ratios are cumulative since initdb)"}` +
      `  heap_hit=${r.db.heapHitRatio === null ? "n/a" : `${round(r.db.heapHitRatio * 100, 2)}%`}`,
  );
  L.push("");
  L.push(
    `  ${pad("bank", 16)}${padL("rows", 8)}${padL("conc", 6)}${padL("n", 6)}${padL("err", 5)}` +
      `${padL("p50", 9)}${padL("p95", 9)}${padL("p99", 9)}${padL("max", 9)}${padL("cv", 7)}${padL("hits", 7)}`,
  );
  for (const cell of r.cells) {
    const s = cell.stats;
    L.push(
      `  ${pad(cell.bank, 16)}${padL(String(cell.rows), 8)}${padL(String(cell.concurrency), 6)}` +
        `${padL(String(s.n), 6)}${padL(String(s.errors), 5)}` +
        `${padL(Number.isFinite(s.p50) ? s.p50.toFixed(0) : "-", 9)}` +
        `${padL(Number.isFinite(s.p95) ? s.p95.toFixed(0) : "-", 9)}` +
        `${padL(Number.isFinite(s.p99) ? s.p99.toFixed(0) : "-", 9)}` +
        `${padL(Number.isFinite(s.max) ? s.max.toFixed(0) : "-", 9)}` +
        `${padL(Number.isFinite(s.cv) ? s.cv.toFixed(2) : "-", 7)}` +
        `${padL(cell.meanResults.toFixed(1), 7)}`,
    );
  }
  const empties = r.cells.filter((c) => c.zeroResultCalls > 0);
  if (empties.length > 0) {
    // Loud, because a zero-result cell is fast for a reason that has nothing to
    // do with the thing being measured.
    L.push("");
    L.push("  ! cells with zero-result recalls (latency there is not measuring retrieval):");
    for (const c of empties) L.push(`      ${c.bank} c=${c.concurrency}: ${c.zeroResultCalls}/${c.stats.n} empty`);
  }
  if (r.arms !== null && r.arms.length > 0) {
    L.push("");
    L.push("  arm attribution (SEPARATE traced pass — not comparable to the latency table above)");
    L.push(`  ${pad("bank", 16)}${pad("method", 12)}${pad("fact_type", 12)}${padL("n", 5)}${padL("p50", 9)}${padL("p95", 9)}`);
    for (const a of r.arms) {
      L.push(
        `  ${pad(a.bank, 16)}${pad(a.method, 12)}${pad(a.fact_type, 12)}${padL(String(a.n), 5)}` +
          `${padL(a.p50.toFixed(1), 9)}${padL(a.p95.toFixed(1), 9)}`,
      );
    }
  }
  L.push(...formatPhases(r.phases ?? null));
  return L.join("\n");
}

/**
 * Render the `--phases` pass.
 *
 * Split out of {@link formatSummary} and exported so the falsification
 * arithmetic — the `maxDbSideGainFraction` ceiling line — has a test that reads
 * the rendered text an operator actually sees, not just the JSON behind it.
 *
 * Returns an empty array when the run had no phase pass, so the caller can
 * splat it unconditionally.
 */
export function formatPhases(phases: readonly PhaseCell[] | null): string[] {
  if (phases === null || phases.length === 0) return [];
  const L: string[] = [];
  L.push("");
  L.push("  phase attribution (SEPARATE traced pass — not comparable to the latency table above)");
  L.push(
    `  ${pad("bank", 16)}${padL("conc", 6)}${padL("n", 5)}${padL("client ms", 11)}${padL("server ms", 11)}` +
      `${padL("db ms", 9)}${padL("db/server", 11)}${padL("max gain", 10)}`,
  );
  for (const c of phases) {
    L.push(
      `  ${pad(c.bank, 16)}${padL(String(c.concurrency), 6)}${padL(String(c.n), 5)}` +
        `${padL(c.clientMsMean.toFixed(0), 11)}${padL(c.serverMsMean.toFixed(0), 11)}` +
        `${padL(c.dbMsMean.toFixed(0), 9)}${padL(`${round(c.dbShareOfServer * 100, 1)}%`, 11)}` +
        `${padL(`${round(c.maxDbSideGainFraction * 100, 1)}%`, 10)}`,
    );
  }
  const worst = Math.max(...phases.map((c) => c.maxDbSideGainFraction));
  L.push("");
  L.push(
    `  ceiling: a PERFECT database (every PostgreSQL call instantaneous) removes at most ` +
      `${round(worst * 100, 1)}% of end-to-end recall latency, at the most database-bound cell measured.`,
  );
  L.push("  Any database-side proposal claiming more than that is refuted by this number.");
  // The dominant non-DB phase, named. Without it the ceiling reads as a
  // dead end; with it the reader is pointed at where the time actually is.
  const totals = new Map<string, number>();
  for (const c of phases) {
    for (const p of c.phases) totals.set(p.name, (totals.get(p.name) ?? 0) + p.meanMs);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (ranked.length > 0) {
    L.push(`  largest phases by mean time across all cells: ${ranked.map(([n]) => n).join(", ")}`);
  }
  return L;
}

/** The AC1 verdict, rendered. */
export function formatReproducibility(rep: ReproducibilityReport): string {
  const L: string[] = [];
  L.push(`reproducibility (AC1) — tolerance ±${round(rep.tolerance * 100, 0)}% on p95 per cell`);
  L.push(
    `  ${pad("bank", 16)}${padL("conc", 6)}${padL("p95 A", 10)}${padL("p95 B", 10)}` +
      `${padL("delta", 9)}${padL("±noise", 9)}   verdict`,
  );
  for (const c of rep.cells) {
    L.push(
      `  ${pad(c.bank, 16)}${padL(String(c.concurrency), 6)}${padL(c.p95A.toFixed(0), 10)}` +
        `${padL(c.p95B.toFixed(0), 10)}${padL(`${round(c.relDelta * 100, 1)}%`, 9)}` +
        `${padL(Number.isFinite(c.noiseFloor) ? `${round(c.noiseFloor * 100, 1)}%` : "-", 9)}   ` +
        `${c.within ? "ok" : c.explainedByNoise ? "OUT*" : "OUT"}`,
    );
  }
  for (const u of rep.unmatched) L.push(`  ${u}: UNMATCHED (present in only one run, or no usable p95)`);
  for (const u of rep.ungradeable) L.push(`  ${u}: UNGRADEABLE — the measurement failed here`);
  L.push(`  worst delta ${round(rep.worstRelDelta * 100, 1)}%  →  ${rep.pass ? "PASS" : "FAIL"}`);
  const noisy = rep.cells.filter((c) => c.explainedByNoise).length;
  const floors = rep.cells.map((c) => c.noiseFloor).filter((v) => Number.isFinite(v));
  if (floors.length > 0) {
    const median = [...floors].sort((a, b) => a - b)[Math.floor(floors.length / 2)] as number;
    L.push(
      `  median ±noise ${round(median * 100, 1)}% — the smallest delta this sample count can ` +
        `distinguish from luck; ${noisy}/${rep.cells.length} cells (OUT*) are inside it`,
    );
    if (median > rep.tolerance) {
      L.push(
        `  NOTE: the median noise floor EXCEEDS the ±${round(rep.tolerance * 100, 0)}% gate — ` +
          `at this sample count the gate is not attainable regardless of how stable the ` +
          `system is. Raise --samples or grade a lower percentile; do not widen the tolerance to fit.`,
      );
    }
  }
  return L.join("\n");
}

/** The AC4 verdict, rendered. */
export function formatContention(rep: ContentionReport): string {
  const L: string[] = [];
  L.push(
    `contention (AC4) — contended p95 must exceed idle p95 in a majority of cells, ` +
      `median movement ≥ ${round(rep.minRelDelta * 100, 0)}%`,
  );
  L.push(`  ${pad("bank", 16)}${padL("conc", 6)}${padL("idle p95", 11)}${padL("load p95", 11)}${padL("delta", 9)}`);
  for (const c of rep.cells) {
    L.push(
      `  ${pad(c.bank, 16)}${padL(String(c.concurrency), 6)}${padL(c.idleP95.toFixed(0), 11)}` +
        `${padL(c.loadedP95.toFixed(0), 11)}${padL(`${round(c.relDelta * 100, 1)}%`, 9)}`,
    );
  }
  for (const u of rep.ungradeable) L.push(`  ${u}: UNGRADEABLE — the measurement failed here`);
  L.push(
    `  raised in ${rep.raised}/${rep.cells.length} cells, median ${round(rep.medianRelDelta * 100, 1)}%  →  ` +
      `${rep.pass ? "PASS" : "FAIL"}`,
  );
  if (rep.ungradeable.length > 0) {
    L.push(
      `  FAIL is on the MEASUREMENT, not the generator: ${rep.ungradeable.length} cell(s) could not ` +
        `be graded, so the cells above are whichever ones survived. Re-run before concluding anything.`,
    );
  }
  return L.join("\n");
}

/** Flat CSV of every cell, for pasting into a sheet or diffing across runs. */
export function toCsv(r: BenchResult): string {
  const head = "label,bank,rows,concurrency,n,errors,p50_ms,p95_ms,p95_ci_low_ms,p95_ci_high_ms,p99_ms,max_ms,mean_ms,stddev_ms,cv,mean_results,zero_result_calls,contention";
  const rows = r.cells.map((c) =>
    [
      JSON.stringify(r.config.label),
      c.bank,
      c.rows,
      c.concurrency,
      c.stats.n,
      c.stats.errors,
      round(c.stats.p50, 2),
      round(c.stats.p95, 2),
      round(c.stats.p95CiLow, 2),
      round(c.stats.p95CiHigh, 2),
      round(c.stats.p99, 2),
      round(c.stats.max, 2),
      round(c.stats.mean, 2),
      round(c.stats.stddev, 2),
      round(c.stats.cv, 4),
      round(c.meanResults, 2),
      c.zeroResultCalls,
      r.config.contention,
    ].join(","),
  );
  return [head, ...rows].join("\n");
}
