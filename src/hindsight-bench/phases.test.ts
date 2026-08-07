import { describe, expect, it } from "vitest";

import { anonymiseResult } from "./anonymise.js";
import { makeCell, makeConfig, makeDbState, makeResult } from "./fixtures.js";
import {
  DB_PHASES,
  extractPhases,
  isDiagnosticPhase,
  maxDbSideGainAcross,
  reducePhaseCell,
  type PhaseSample,
} from "./phases.js";
import type { RecallSample } from "./recall.js";
import { formatPhases } from "./report.js";
import { runPhaseSweep } from "./run.js";
import type { PhaseCell } from "./types.js";

/**
 * A real `trace.summary`, captured from the live Hindsight instance on
 * 2026-08-07 while grading #4476. Phase names and durations only — the bank
 * identity, the query and the result payload are all stripped, and nothing that
 * remains names a bank or carries memory content.
 *
 * Kept VERBATIM (float noise and all) rather than rounded, because the
 * diagnostic-overlay problem is not hypothetical: the four `retrieval_*`
 * entries are nested INSIDE `parallel_retrieval`'s span, and an extractor that
 * summed them would report the database at roughly 60 % of the request instead
 * of 23 %, inverting the conclusion this pass exists to reach.
 */
const LIVE_SUMMARY = {
  total_duration_seconds: 0.9379949569702148,
  phase_metrics: [
    { phase_name: "backend_acquisition", duration_seconds: 1.1920928955078125e-6, details: {} },
    { phase_name: "generate_query_embedding", duration_seconds: 0.29177236557006836, details: {} },
    {
      phase_name: "parallel_retrieval",
      duration_seconds: 0.2171189785003662,
      details: { semantic_count: 30, bm25_count: 30, graph_count: 30, temporal_count: 0 },
    },
    { phase_name: "retrieval_semantic", duration_seconds: 0.08392715454101562, details: { diagnostic: true } },
    { phase_name: "retrieval_bm25", duration_seconds: 0.08392715454101562, details: { diagnostic: true } },
    { phase_name: "retrieval_graph", duration_seconds: 0.04751944541931152, details: { diagnostic: true } },
    {
      phase_name: "retrieval_temporal_extraction",
      duration_seconds: 0.0006802082061767578,
      details: { diagnostic: true },
    },
    { phase_name: "rrf_merge", duration_seconds: 0.0001652240753173828, details: { candidates_merged: 87 } },
    {
      phase_name: "reranking",
      duration_seconds: 0.41556811332702637,
      details: { reranker_type: "cross-encoder", candidates_reranked: 87 },
    },
    { phase_name: "combined_scoring", duration_seconds: 0.0007784366607666016, details: { candidates_scored: 87 } },
    {
      phase_name: "token_filtering",
      duration_seconds: 0.0020329952239990234,
      details: { results_selected: 62, tokens_used: 4089, max_tokens: 4096 },
    },
    { phase_name: "result_serialization", duration_seconds: 0.0008933544158935547, details: { results_serialized: 62 } },
    { phase_name: "entity_build", duration_seconds: 0.004282951354980469, details: { entities_returned: 122 } },
    { phase_name: "semaphore_wait", duration_seconds: 7.62939453125e-6, details: { diagnostic: true } },
    { phase_name: "connection_wait", duration_seconds: 0.00023794174194335938, details: { diagnostic: true } },
    { phase_name: "trace_finalize", duration_seconds: 0.00226593017578125, details: { diagnostic: true } },
  ],
};

const liveTrace = { summary: LIVE_SUMMARY };

describe("isDiagnosticPhase", () => {
  it("recognises the overlay marker Hindsight actually emits", () => {
    expect(isDiagnosticPhase({ phase_name: "retrieval_bm25", details: { diagnostic: true } })).toBe(true);
    expect(isDiagnosticPhase({ phase_name: "reranking", details: { reranker_type: "cross-encoder" } })).toBe(false);
    expect(isDiagnosticPhase({ phase_name: "rrf_merge" })).toBe(false);
  });
});

describe("extractPhases", () => {
  it("excludes the diagnostic overlays that are nested inside parallel_retrieval", () => {
    const { phases } = extractPhases(liveTrace);
    expect(phases.has("parallel_retrieval")).toBe(true);
    for (const overlay of [
      "retrieval_semantic",
      "retrieval_bm25",
      "retrieval_graph",
      "retrieval_temporal_extraction",
      "trace_finalize",
    ]) {
      expect(phases.has(overlay)).toBe(false);
    }
    // The outcome that matters: the retained phases must not exceed the
    // handler's own total. Summing the overlays in would push this over 1.
    const sum = [...phases.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(LIVE_SUMMARY.total_duration_seconds * 1000);
  });

  it("keeps the overlays in `diagnostics` rather than discarding them", () => {
    const { diagnostics } = extractPhases(liveTrace);
    expect(diagnostics.get("connection_wait")).toBeCloseTo(0.23794174194335938, 9);
    expect(diagnostics.has("semaphore_wait")).toBe(true);
    expect(diagnostics.has("parallel_retrieval")).toBe(false);
  });

  it("carries a phase name it has never seen through instead of dropping it", () => {
    const { phases } = extractPhases({
      summary: { total_duration_seconds: 1, phase_metrics: [{ phase_name: "brand_new_stage", duration_seconds: 0.5 }] },
    });
    expect(phases.get("brand_new_stage")).toBe(500);
  });

  it("adds a repeated phase up rather than keeping the last occurrence", () => {
    const { phases } = extractPhases({
      summary: {
        total_duration_seconds: 1,
        phase_metrics: [
          { phase_name: "reranking", duration_seconds: 0.2 },
          { phase_name: "reranking", duration_seconds: 0.3 },
        ],
      },
    });
    expect(phases.get("reranking")).toBeCloseTo(500, 6);
  });

  it("returns an empty breakdown rather than throwing on a trace-less response", () => {
    expect(extractPhases(undefined).phases.size).toBe(0);
    expect(extractPhases({}).serverMs).toBe(0);
    expect(extractPhases({ summary: { phase_metrics: "not an array" } }).phases.size).toBe(0);
  });
});

describe("reducePhaseCell", () => {
  const sample = (clientMs: number): PhaseSample => ({ clientMs, extracted: extractPhases(liveTrace) });

  it("bounds the database's share of end-to-end latency below the 30% #4476 asks for", () => {
    // The falsification, as a test rather than as prose. On real captured
    // production timings a perfect database removes ~22 % of a recall, so
    // #4476's "p95 ≥ 30 % below baseline from cache residency + contention
    // isolation" is unreachable by arithmetic. If Hindsight's phase mix ever
    // changes enough for this to stop holding, this test says so.
    const cell = reducePhaseCell("bank-01", 232375, 1, [sample(1000), sample(1000)], 0);
    expect(cell).not.toBeNull();
    expect((cell as PhaseCell).maxDbSideGainFraction).toBeLessThan(0.3);
    expect((cell as PhaseCell).maxDbSideGainFraction).toBeGreaterThan(0.1);
  });

  it("counts connection_wait as database time even though the engine marks it diagnostic", () => {
    // The trap: `connection_wait` carries `details.diagnostic = true`, so it is
    // kept OUT of `phases[]` (it overlaps other spans and would break the share
    // arithmetic) — but it is real database-attributable wait. Looking it up in
    // `phases` alone would score it as zero, under-counting the database and
    // over-strengthening every refutation built on this number.
    const cell = reducePhaseCell("bank-01", 1, 1, [sample(1000)], 0) as PhaseCell;
    const parallel = cell.phases.find((p) => p.name === "parallel_retrieval")?.meanMs ?? 0;
    const connWaitMs = 0.00023794174194335938 * 1000;
    expect(cell.dbMsMean).toBeCloseTo(parallel + connWaitMs, 6);
    expect(cell.dbMsMean).toBeGreaterThan(parallel);
    // …and no non-database phase leaked in: reranking alone is twice the whole
    // database attribution on this trace.
    const reranking = cell.phases.find((p) => p.name === "reranking")?.meanMs ?? 0;
    expect(cell.dbMsMean).toBeLessThan(reranking);
    expect(DB_PHASES).not.toContain("semaphore_wait");
  });

  it("measures the ceiling against CLIENT time, so pre-handler queueing counts against it", () => {
    const server = reducePhaseCell("b", 1, 1, [sample(LIVE_SUMMARY.total_duration_seconds * 1000)], 0) as PhaseCell;
    const queued = reducePhaseCell("b", 1, 1, [sample(LIVE_SUMMARY.total_duration_seconds * 1000 * 4)], 0) as PhaseCell;
    expect(queued.maxDbSideGainFraction).toBeLessThan(server.maxDbSideGainFraction);
    expect(queued.dbShareOfServer).toBeCloseTo(server.dbShareOfServer, 9);
  });

  it("returns null for a cell whose every call failed instead of a database-free cell of zeros", () => {
    expect(reducePhaseCell("b", 1, 8, [], 40)).toBeNull();
  });

  it("sorts phases by mean time so the dominant stage reads first", () => {
    const cell = reducePhaseCell("b", 1, 1, [sample(1000)], 0) as PhaseCell;
    expect(cell.phases[0]?.name).toBe("reranking");
    expect(cell.phases[1]?.name).toBe("generate_query_embedding");
  });
});

describe("maxDbSideGainAcross", () => {
  it("takes the cell most favourable to a database-side proposal, not the average", () => {
    const cells = [
      { maxDbSideGainFraction: 0.05 },
      { maxDbSideGainFraction: 0.41 },
      { maxDbSideGainFraction: 0.2 },
    ] as PhaseCell[];
    expect(maxDbSideGainAcross(cells)).toBeCloseTo(0.41, 9);
  });

  it("is null for no cells — an absent measurement is not a bound of zero", () => {
    expect(maxDbSideGainAcross([])).toBeNull();
  });
});

describe("runPhaseSweep", () => {
  const db = makeDbState();

  it("keeps every worker busy: a cell never issues fewer calls than its concurrency", async () => {
    // The bug this pins: `--phases 5` at c=16 would put five calls through a
    // sixteen-worker pool and label the result "c=16". That is a c=5
    // measurement, and the concurrency axis is the entire point of the pass.
    let live = 0;
    let peak = 0;
    const cells = await runPhaseSweep({
      config: makeConfig({ banks: ["big"], concurrency: [1, 16] }),
      db,
      samples: 5,
      settleMs: 0,
      deps: {
        recall: async (): Promise<RecallSample> => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 1));
          live--;
          return { ok: true, ms: 100, results: 5, trace: liveTrace };
        },
      },
    });
    expect(cells.find((c) => c.concurrency === 16)?.n).toBe(16);
    expect(cells.find((c) => c.concurrency === 1)?.n).toBe(5);
    // …and the pool really did keep sixteen calls in flight, so "c=16" is a
    // statement about the server rather than about the sample budget.
    expect(peak).toBe(16);
  });

  it("drops a cell whose calls all failed rather than emitting a zero-database cell", async () => {
    const cells = await runPhaseSweep({
      config: makeConfig({ banks: ["big"], concurrency: [4] }),
      db,
      samples: 4,
      settleMs: 0,
      deps: { recall: async () => ({ ok: false, ms: 30000, results: 0, error: "timeout" }) },
    });
    expect(cells).toEqual([]);
  });

  it("counts failed calls as errors on a cell that partly succeeded", async () => {
    let i = 0;
    const cells = await runPhaseSweep({
      config: makeConfig({ banks: ["big"], concurrency: [1] }),
      db,
      samples: 4,
      settleMs: 0,
      deps: {
        recall: async () =>
          i++ % 2 === 0
            ? { ok: true as const, ms: 100, results: 5, trace: liveTrace }
            : { ok: false as const, ms: 30000, results: 0, error: "timeout" },
      },
    });
    expect(cells[0]?.n).toBe(2);
    expect(cells[0]?.errors).toBe(2);
  });
});

describe("anonymiseResult with phase cells", () => {
  const phaseCell = (bank: string): PhaseCell => ({
    bank,
    rows: 1,
    concurrency: 8,
    n: 8,
    errors: 0,
    clientMsMean: 1000,
    serverMsMean: 900,
    dbMsMean: 200,
    dbShareOfServer: 0.22,
    maxDbSideGainFraction: 0.2,
    phases: [],
  });

  it("pseudonymises the bank on every phase cell", () => {
    const base = makeResult([makeCell("big", 228761, 1, 100), makeCell("small", 12, 1, 100)]);
    const { result } = anonymiseResult({ ...base, phases: [phaseCell("big"), phaseCell("small")] });
    expect(result.phases?.map((p) => p.bank)).toEqual(["bank-01", "bank-02"]);
  });

  it("does not crash on a pre-#4476 result file that has no phases field at all", () => {
    const base = makeResult([makeCell("big", 228761, 1, 100)]);
    // Exactly what a committed P1 baseline looks like on disk.
    const legacy = JSON.parse(JSON.stringify(base)) as typeof base;
    delete (legacy as { phases?: unknown }).phases;
    delete (legacy as { arms?: unknown }).arms;
    const { result } = anonymiseResult(legacy);
    expect(result.phases).toBeNull();
    expect(result.arms).toBeNull();
    expect(result.cells[0]?.bank).toBe("bank-01");
  });
});

describe("formatPhases", () => {
  it("prints the refutation ceiling as a number a reader can act on", () => {
    const cells: PhaseCell[] = [
      {
        bank: "bank-01",
        rows: 232375,
        concurrency: 16,
        n: 16,
        errors: 0,
        clientMsMean: 14817,
        serverMsMean: 12604,
        dbMsMean: 3108,
        dbShareOfServer: 0.2466,
        maxDbSideGainFraction: 0.2097,
        phases: [
          { name: "reranking", meanMs: 4638, p95Ms: 9092, shareOfServer: 0.368 },
          { name: "generate_query_embedding", meanMs: 3987, p95Ms: 6332, shareOfServer: 0.316 },
          { name: "parallel_retrieval", meanMs: 2912, p95Ms: 5827, shareOfServer: 0.231 },
        ],
      },
    ];
    const out = formatPhases(cells).join("\n");
    expect(out).toContain("removes at most 21% of end-to-end recall latency");
    expect(out).toContain("refuted by this number");
    expect(out).toContain("reranking");
    expect(out).toContain("not comparable to the latency table");
  });

  it("renders nothing when the run had no phase pass", () => {
    expect(formatPhases(null)).toEqual([]);
    expect(formatPhases([])).toEqual([]);
  });
});
