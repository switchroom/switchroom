/**
 * The sweep: (bank × concurrency) → latency distribution.
 *
 * Every IO dependency is injected, so the orchestration — warm-up discarding,
 * exact sample budgeting, cell ordering, error accounting — is unit-testable
 * without a database or an HTTP server. That is deliberate: this is the
 * instrument every later phase of epic #4474 is graded by, and "the harness
 * counted wrong" must be a thing a test can catch.
 */

import { extractPhases, reducePhaseCell, type PhaseSample } from "./phases.js";
import { summarize } from "./stats.js";
import { QUERY_SET_ID, RECALL_QUERIES, recallOnce, type RecallSample } from "./recall.js";
import type { ArmTiming, BenchConfig, CellResult, DbState, PhaseCell } from "./types.js";

/** Distinct error strings kept per cell. Enough to diagnose, bounded on disk. */
const MAX_ERROR_SAMPLES = 5;

export interface SweepDeps {
  /** One timed recall. Defaults to the real HTTP call. */
  recall?: (bank: string, query: string) => Promise<RecallSample>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface SweepOptions {
  config: BenchConfig;
  db: DbState;
  /** Quiet period between cells, ms — lets queues drain so cells don't bleed. */
  settleMs?: number;
  deps?: SweepDeps;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drive exactly `count` recalls against `bank` with `concurrency` in flight.
 *
 * A fixed worker pool pulling from a shared cursor, NOT `count/concurrency`
 * batches: batching makes every wave wait for its slowest call, which measures
 * the max of each batch and systematically inflates p50 while flattening the
 * tail. A pull-based pool keeps `concurrency` requests genuinely in flight for
 * the whole cell, which is what "concurrency 8" is supposed to mean.
 *
 * Queries are drawn round-robin from a fixed list by absolute call index, so
 * the multiset of queries issued is identical across runs of the same cell —
 * the precondition for AC1 being a statement about the system.
 */
async function driveCell(
  bank: string,
  concurrency: number,
  count: number,
  recall: (bank: string, query: string) => Promise<RecallSample>,
): Promise<RecallSample[]> {
  const out: RecallSample[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= count) return;
      const query = RECALL_QUERIES[i % RECALL_QUERIES.length] as string;
      out.push(await recall(bank, query));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return out;
}

/**
 * Run the full sweep.
 *
 * Cell order is **bank-major, concurrency ascending**. Bank-major because the
 * per-bank partial HNSW indexes and heap pages a bank touches stay warm across
 * its own concurrency ladder, so the concurrency axis measures concurrency
 * rather than cache luck; ascending because stepping down from a saturating
 * level leaves the box recovering into the next cell.
 */
export async function runSweep(opts: SweepOptions): Promise<CellResult[]> {
  const { config, db } = opts;
  const deps = opts.deps ?? {};
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? ((): void => {});
  const settleMs = opts.settleMs ?? 2000;
  const recall =
    deps.recall ??
    ((bank: string, query: string): Promise<RecallSample> =>
      recallOnce(bank, query, {
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
        budget: config.budget,
        maxTokens: config.maxTokens,
      }));

  const rowsFor = new Map(db.bankRows.map((b) => [b.bank, b.rows]));
  const cells: CellResult[] = [];

  for (const bank of config.banks) {
    for (const concurrency of [...config.concurrency].sort((a, b) => a - b)) {
      if (config.warmup > 0) {
        // Discarded outright, never merged into the samples. A warm-up folded
        // into the distribution is a cold-cache tail masquerading as a p99.
        await driveCell(bank, concurrency, config.warmup, recall);
      }
      const raw = await driveCell(bank, concurrency, config.samples, recall);
      const ok = raw.filter((s) => s.ok);
      const okMs = ok.map((s) => s.ms);
      const errs = raw.filter((s) => !s.ok);
      const errorSamples = [...new Set(errs.map((e) => e.error ?? "unknown"))].slice(0, MAX_ERROR_SAMPLES);
      const stats = summarize(okMs, errs.length);
      cells.push({
        bank,
        rows: rowsFor.get(bank) ?? 0,
        concurrency,
        stats,
        meanResults: ok.length === 0 ? 0 : ok.reduce((a, s) => a + s.results, 0) / ok.length,
        zeroResultCalls: ok.filter((s) => s.results === 0).length,
        samplesMs: okMs,
        errorSamples,
      });
      log(
        `  ${bank} c=${concurrency}: n=${stats.n} err=${stats.errors} ` +
          `p50=${stats.p50.toFixed(0)}ms p95=${stats.p95.toFixed(0)}ms p99=${stats.p99.toFixed(0)}ms`,
      );
      if (settleMs > 0) await sleep(settleMs);
    }
  }
  return cells;
}

export interface ArmSweepOptions {
  config: BenchConfig;
  /** Traced calls per bank. Small by design — see the note on `BenchResult.arms`. */
  samples: number;
  deps?: { recall?: (bank: string, query: string) => Promise<RecallSample>; log?: (m: string) => void };
}

/** One arm's timing rows as they arrive in `trace.retrieval_results[]`. */
interface RawArm {
  method_name?: unknown;
  fact_type?: unknown;
  duration_seconds?: unknown;
}

/**
 * Extract per-arm durations from a traced recall's `trace.retrieval_results`.
 *
 * Exported so the parser is testable against a real captured trace without a
 * live server: this is the one place a Hindsight response-shape change would
 * silently zero out arm attribution.
 */
export function extractArms(trace: unknown): Array<{ method: string; fact_type: string; ms: number }> {
  const rr = (trace as { retrieval_results?: unknown })?.retrieval_results;
  if (!Array.isArray(rr)) return [];
  const out: Array<{ method: string; fact_type: string; ms: number }> = [];
  for (const entry of rr as RawArm[]) {
    const method = typeof entry?.method_name === "string" ? entry.method_name : null;
    const factType = typeof entry?.fact_type === "string" ? entry.fact_type : "";
    const secs = Number(entry?.duration_seconds);
    if (method === null || !Number.isFinite(secs)) continue;
    out.push({ method, fact_type: factType, ms: secs * 1000 });
  }
  return out;
}

/**
 * A separate, low-sample TRACED pass for arm attribution (#4475 item 6).
 *
 * Sequential and small on purpose. A traced recall returns the query embedding
 * plus every arm's full result list — megabytes of JSON — so timing a traced
 * call measures the serializer, not the engine. These numbers answer "which arm
 * dominates", never "how fast is recall"; the two must not be compared.
 */
export async function runArmSweep(opts: ArmSweepOptions): Promise<ArmTiming[]> {
  const { config } = opts;
  const log = opts.deps?.log ?? ((): void => {});
  const recall =
    opts.deps?.recall ??
    ((bank: string, query: string): Promise<RecallSample> =>
      recallOnce(bank, query, {
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
        budget: config.budget,
        maxTokens: config.maxTokens,
        trace: true,
      }));

  const buckets = new Map<string, { bank: string; method: string; fact_type: string; ms: number[] }>();
  for (const bank of config.banks) {
    for (let i = 0; i < opts.samples; i++) {
      const query = RECALL_QUERIES[i % RECALL_QUERIES.length] as string;
      const sample = await recall(bank, query);
      if (!sample.ok) continue;
      for (const arm of extractArms(sample.trace)) {
        const key = `${bank}\u0000${arm.method}\u0000${arm.fact_type}`;
        const b = buckets.get(key) ?? { bank, method: arm.method, fact_type: arm.fact_type, ms: [] };
        b.ms.push(arm.ms);
        buckets.set(key, b);
      }
    }
    log(`  arms: ${bank} traced ${opts.samples}x`);
  }

  const rows: ArmTiming[] = [];
  for (const b of buckets.values()) {
    const s = summarize(b.ms, 0);
    rows.push({ bank: b.bank, method: b.method, fact_type: b.fact_type, n: s.n, p50: s.p50, p95: s.p95, max: s.max });
  }
  rows.sort((a, b) => a.bank.localeCompare(b.bank) || b.p50 - a.p50);
  return rows;
}

export interface PhaseSweepOptions {
  config: BenchConfig;
  db: DbState;
  /**
   * Traced calls per cell. Kept small — a traced recall serialises the query
   * embedding and every arm's full result list.
   */
  samples: number;
  settleMs?: number;
  deps?: SweepDeps;
}

/**
 * The opt-in `--phases` pass: where does a recall's time actually go, and how
 * does that change with concurrency? (#4476.)
 *
 * Unlike `runArmSweep` this sweeps the **full concurrency ladder**, because the
 * question it answers is a question about contention: the epic's premise is
 * that concurrency pressure lands on the database, and a c=1 measurement cannot
 * confirm or refute that. Running it at the same levels as the latency sweep is
 * what makes `maxDbSideGainFraction` comparable to the latency AC it bounds.
 *
 * Traced, so — exactly as with arms — these milliseconds must never be compared
 * against `cells[]`. What survives the distortion is the SHARE, and tracing
 * inflates the non-database stages hardest, so the database's share here is if
 * anything generous.
 */
export async function runPhaseSweep(opts: PhaseSweepOptions): Promise<PhaseCell[]> {
  const { config, db } = opts;
  const deps = opts.deps ?? {};
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? ((): void => {});
  const settleMs = opts.settleMs ?? 2000;
  const recall =
    deps.recall ??
    ((bank: string, query: string): Promise<RecallSample> =>
      recallOnce(bank, query, {
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
        budget: config.budget,
        maxTokens: config.maxTokens,
        trace: true,
      }));

  const rowsFor = new Map(db.bankRows.map((b) => [b.bank, b.rows]));
  const out: PhaseCell[] = [];

  for (const bank of config.banks) {
    for (const concurrency of [...config.concurrency].sort((a, b) => a - b)) {
      // At least one call per worker. `--phases 5` at c=16 would otherwise put
      // five calls through a sixteen-worker pool and label the result "c=16",
      // which is a c=5 measurement wearing the wrong label — and the whole
      // point of this pass is the concurrency axis.
      const count = Math.max(opts.samples, concurrency);
      const raw = await driveCell(bank, concurrency, count, recall);
      const ok = raw.filter((s) => s.ok);
      const samples: PhaseSample[] = ok.map((s) => ({
        clientMs: s.ms,
        extracted: extractPhases(s.trace),
      }));
      const cell = reducePhaseCell(bank, rowsFor.get(bank) ?? 0, concurrency, samples, raw.length - ok.length);
      if (cell === null) {
        log(`  phases: ${bank} c=${concurrency}: no successful traced calls`);
      } else {
        out.push(cell);
        log(
          `  phases: ${bank} c=${concurrency}: n=${cell.n} db=${(cell.dbShareOfServer * 100).toFixed(1)}% of server, ` +
            `max end-to-end gain from a perfect DB = ${(cell.maxDbSideGainFraction * 100).toFixed(1)}%`,
        );
      }
      if (settleMs > 0) await sleep(settleMs);
    }
  }
  return out;
}

/** The query-set id this build replays; recorded into every result file. */
export { QUERY_SET_ID };
