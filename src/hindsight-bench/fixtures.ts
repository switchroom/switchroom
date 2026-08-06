/**
 * Test fixtures for the bench harness.
 *
 * Kept in a non-`.test.ts` file so several suites share one definition of a
 * well-formed `BenchResult` — a result file whose shape drifts between tests is
 * how a schema regression hides.
 */

import { summarize } from "./stats.js";
import { BENCH_SCHEMA_VERSION, type BenchConfig, type BenchResult, type CellResult, type DbState } from "./types.js";

export function makeConfig(over: Partial<BenchConfig> = {}): BenchConfig {
  return {
    startedAt: "2026-08-07T00:00:00.000Z",
    apiUrl: "http://127.0.0.1:18888",
    container: "switchroom-hindsight",
    banks: ["big", "small"],
    concurrency: [1, 4],
    samples: 10,
    warmup: 2,
    timeoutMs: 30000,
    contention: "off",
    contentionWorkers: 0,
    statsReset: false,
    allowWrites: false,
    querySet: "generic-v1",
    budget: "mid",
    maxTokens: 4096,
    label: "fixture",
    ...over,
  };
}

export function makeDbState(over: Partial<DbState> = {}): DbState {
  return {
    sharedBuffersBytes: 6144 * 1024 * 1024,
    effectiveCacheSizeBytes: 8192 * 1024 * 1024,
    hnswEfSearch: 40,
    memoryUnitsTotalBytes: 5179 * 1024 * 1024,
    memoryUnitsHeapBytes: 3000 * 1024 * 1024,
    memoryUnitsIndexBytes: 2179 * 1024 * 1024,
    bankRows: [
      { bank: "big", rows: 228761 },
      { bank: "small", rows: 12 },
    ],
    largestIndexes: [],
    statsResetAt: null,
    heapHitRatio: 0.99,
    serverVersion: "PostgreSQL 18.0",
    ...over,
  };
}

/** A cell whose p95 is exactly `p95` (all samples identical). */
export function makeCell(bank: string, rows: number, concurrency: number, p95: number): CellResult {
  const samplesMs = Array.from({ length: 20 }, () => p95);
  return {
    bank,
    rows,
    concurrency,
    stats: summarize(samplesMs, 0),
    meanResults: 8,
    zeroResultCalls: 0,
    samplesMs,
    errorSamples: [],
  };
}

export function makeResult(cells: CellResult[], over: Partial<BenchConfig> = {}): BenchResult {
  return {
    schema: BENCH_SCHEMA_VERSION,
    config: makeConfig(over),
    db: makeDbState(),
    instance: { imageTag: "ghcr.io/example/hindsight:v0.8.6", rerankerMaxCandidates: 150 },
    cells,
    arms: null,
    durationS: 42,
  };
}
