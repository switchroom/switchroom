/**
 * Wire types for the recall-latency benchmark harness (#4475, epic #4474).
 *
 * Kept in one file so the RESULT-FILE schema is reviewable in isolation: every
 * later phase of the epic (#4476 P2, #4477 P3, #4478 P4) reports its delta
 * against a file written to this shape, so the shape is the contract, not an
 * implementation detail. Same discipline as `hindsight-watch/types.ts`.
 *
 * Two rules the schema encodes deliberately:
 *
 *  - **Percentiles, never a bare mean.** The epic's goal is a statement about
 *    the tail ("consistent latency … including when we have contention"), and
 *    the dry-run that preceded it reported medians only, which is why nothing
 *    in the epic could be settled. `CellStats` therefore carries p50/p95/p99/
 *    max plus the dispersion needed to judge whether a cell is even
 *    trustworthy. The mean is carried too, but only beside the percentiles.
 *  - **A result without its configuration is not a result.** `BenchResult`
 *    embeds the run config AND the observed database state (`DbState`), so a
 *    file pasted into an issue comment months later still says what it was
 *    measured against.
 */

/** Result-file schema version. Bump on any breaking shape change. */
export const BENCH_SCHEMA_VERSION = 1;

/**
 * How the contention load generator was configured for a run.
 *
 * `off` is the default and the only profile that touches nothing beyond the
 * recall calls themselves.
 *
 * `read` runs a synthetic **buffer-cache churn** load: repeated wide scans over
 * `memory_units` that evict the recall working set from `shared_buffers`. It is
 * strictly `SELECT`-only, so it needs no write grant, and it reproduces the
 * mechanism the epic names as the decisive axis — working set vs pool — rather
 * than merely adding CPU.
 *
 * `write` adds a retain/consolidation-SHAPED write storm on top of the churn:
 * bulk INSERT/UPDATE/DELETE cycles against a harness-owned scratch table, which
 * generates the WAL, checkpoint and bgwriter pressure a real retain storm does.
 * It never touches `memory_units`, `reflections` or any bank. It still requires
 * `--allow-writes` because it opens a writable session against the production
 * database, and AC5 asks for that gate to be explicit rather than inferred.
 *
 * The 2026-08-06 ~9.1 s/call incident this exists to reproduce is a RECORDED
 * CLAIM, not a measurement: its container logs rotated out before anyone could
 * replay them (epic #4474 § "Recorded claims not re-verified this pass"). The
 * harness therefore reproduces the contention synthetically and never cites the
 * incident as evidence of its own correctness.
 */
export type ContentionProfile = "off" | "read" | "write";

/** Every knob a run was invoked with, captured verbatim into the result file. */
export interface BenchConfig {
  /** ISO-8601 UTC of when the run started. */
  startedAt: string;
  /** Hindsight REST base, e.g. `http://127.0.0.1:18888`. */
  apiUrl: string;
  /** Hindsight container the psql probes ran inside. */
  container: string;
  /** Banks measured, in the order they were swept. */
  banks: string[];
  /** Concurrency levels swept, ascending. */
  concurrency: number[];
  /** Recall calls recorded per cell (excludes warm-up). */
  samples: number;
  /** Recall calls discarded before recording, per cell. */
  warmup: number;
  /** Per-call timeout in ms. */
  timeoutMs: number;
  contention: ContentionProfile;
  /** Concurrent load workers when `contention !== "off"`. */
  contentionWorkers: number;
  /** Whether `pg_stat_reset()` was called before the sweep. */
  statsReset: boolean;
  /** Whether a writable session was authorised (`--allow-writes`). */
  allowWrites: boolean;
  /** Stable id of the query set the sweep replayed. */
  querySet: string;
  /** Recall `budget` sent on every call. */
  budget: string;
  /** Recall `max_tokens` sent on every call. */
  maxTokens: number;
  /** Free-form operator label, e.g. `post-index-drop baseline`. */
  label: string;
}

/** One index's size and lifetime scan count, for the working-set narrative. */
export interface IndexFact {
  name: string;
  bytes: number;
  /** `pg_stat_user_indexes.idx_scan` — cumulative since the stats epoch. */
  scans: number;
}

/**
 * The database state a result is measured against.
 *
 * Every field here answers a question someone will ask of a number in the
 * result file six weeks later. `statsResetAt` is `null` on a live instance that
 * has never been reset — the exact condition epic #4474 flags as making the
 * cache-hit ratios unusable — so it is recorded rather than assumed.
 */
export interface DbState {
  /** `shared_buffers` in bytes. */
  sharedBuffersBytes: number;
  /** `effective_cache_size` in bytes. */
  effectiveCacheSizeBytes: number;
  /** `hnsw.ef_search`, or null when the GUC is not present. */
  hnswEfSearch: number | null;
  /** `pg_total_relation_size('memory_units')` — heap + toast + indexes. */
  memoryUnitsTotalBytes: number;
  /** `pg_table_size('memory_units')` — heap + toast, no indexes. */
  memoryUnitsHeapBytes: number;
  /** `pg_indexes_size('memory_units')`. */
  memoryUnitsIndexBytes: number;
  /** Rows per bank, descending. The bank-size axis, measured not assumed. */
  bankRows: Array<{ bank: string; rows: number }>;
  /** The largest indexes on `memory_units`, descending by size. */
  largestIndexes: IndexFact[];
  /** `pg_stat_database.stats_reset` for this database, or null. */
  statsResetAt: string | null;
  /** `memory_units` heap block hit ratio since the stats epoch, 0-1. */
  heapHitRatio: number | null;
  /** `version()` of the server. */
  serverVersion: string;
}

/**
 * The Hindsight *service* configuration a result was measured against, as
 * distinct from the database's (`DbState`).
 *
 * #4475 item 7 names the image tag and `HINDSIGHT_API_RERANKER_MAX_CANDIDATES`
 * specifically: the reranker candidate cap is a first-order latency knob, so a
 * result file that omits it cannot be compared against one taken after someone
 * changed it. Each field is read by NAME — the harness never dumps a container's
 * environment, which would print injected secrets.
 */
export interface InstanceState {
  /** `docker inspect .Config.Image`, or null when it could not be read. */
  imageTag: string | null;
  /** `HINDSIGHT_API_RERANKER_MAX_CANDIDATES`, or null when unset. */
  rerankerMaxCandidates: number | null;
}

/** Reduction of one cell's samples. Percentiles are nearest-rank on ms. */
export interface CellStats {
  /** recorded samples (successful calls only) */
  n: number;
  /** calls that errored or timed out; excluded from every percentile */
  errors: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** carried BESIDE the percentiles, never instead of them */
  mean: number;
  /** population standard deviation, ms */
  stddev: number;
  /** coefficient of variation (stddev / mean); the per-cell noise figure */
  cv: number;
}

/** One (bank, concurrency) measurement. */
export interface CellResult {
  bank: string;
  /** `memory_units` rows for this bank at run time — the x-axis. */
  rows: number;
  concurrency: number;
  stats: CellStats;
  /**
   * Mean number of memories returned by the successful calls.
   *
   * A validity check, not a quality metric: a cell that returns nothing is fast
   * for an uninteresting reason, and a latency table with no result counts
   * beside it cannot distinguish "recall got quicker" from "recall stopped
   * finding anything". Recorded so a reader can rule that out.
   */
  meanResults: number;
  /** Successful calls that returned zero memories. Should be 0 on a real bank. */
  zeroResultCalls: number;
  /** Every recorded latency in ms, in completion order. Enables re-reduction. */
  samplesMs: number[];
  /** Distinct error strings observed, capped and deduplicated. */
  errorSamples: string[];
}

/** Per-retrieval-arm attribution from an opt-in traced pass. */
export interface ArmTiming {
  bank: string;
  /** `trace.retrieval_results[].method_name`, e.g. `semantic` / `bm25` / `graph`. */
  method: string;
  fact_type: string;
  /** samples contributing to this row */
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/** The whole result file. */
export interface BenchResult {
  schema: typeof BENCH_SCHEMA_VERSION;
  config: BenchConfig;
  db: DbState;
  instance: InstanceState;
  cells: CellResult[];
  /**
   * Arm attribution, or null when the run did not include a traced pass.
   *
   * A traced recall returns the query embedding and every arm's full result
   * list, which is megabytes of JSON — measuring latency with `trace: true`
   * would measure the serializer. So arms are a SEPARATE low-sample pass and
   * the numbers here must never be compared against `cells`.
   */
  arms: ArmTiming[] | null;
  /** Wall-clock seconds the whole sweep took. */
  durationS: number;
}

/** One cell's verdict in an AC1 reproducibility comparison. */
export interface CellComparison {
  bank: string;
  concurrency: number;
  p95A: number;
  p95B: number;
  /** |b - a| / a, as a fraction. */
  relDelta: number;
  within: boolean;
}

/** The AC1 reproducibility verdict over two runs. */
export interface ReproducibilityReport {
  /** the tolerance applied, as a fraction (0.10 for ±10 %) */
  tolerance: number;
  cells: CellComparison[];
  /** cells present in one run but not the other */
  unmatched: string[];
  /** the largest observed |relDelta| across matched cells */
  worstRelDelta: number;
  /** true only when every matched cell is within tolerance AND none is unmatched */
  pass: boolean;
}
