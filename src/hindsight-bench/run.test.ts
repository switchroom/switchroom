import { describe, it, expect } from "vitest";
import { makeConfig, makeDbState } from "./fixtures.js";
import { RECALL_QUERIES, type RecallSample } from "./recall.js";
import { extractArms, runArmSweep, runSweep } from "./run.js";

/** Records every call and replies with a scripted latency. */
function recorder(msFor: (bank: string, n: number) => number | "error") {
  const calls: Array<{ bank: string; query: string }> = [];
  let inFlight = 0;
  let peak = 0;
  const recall = async (bank: string, query: string): Promise<RecallSample> => {
    calls.push({ bank, query });
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const v = msFor(bank, calls.length);
    return v === "error" ? { ok: false, ms: 0, results: 0, error: "boom" } : { ok: true, ms: v, results: 3 };
  };
  return { recall, calls, peak: () => peak };
}

const deps = (recall: (b: string, q: string) => Promise<RecallSample>) => ({ recall, sleep: async () => {} });

describe("runSweep", () => {
  it("records exactly `samples` per cell and discards warm-up entirely", async () => {
    const rec = recorder(() => 100);
    const config = makeConfig({ banks: ["big"], concurrency: [1], samples: 10, warmup: 3 });
    const cells = await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(rec.recall) });
    expect(cells).toHaveLength(1);
    expect(cells[0]?.stats.n).toBe(10);
    expect(cells[0]?.samplesMs).toHaveLength(10);
    // 13 calls issued, only 10 recorded — the warm-up must not reach the stats.
    expect(rec.calls).toHaveLength(13);
  });

  it("does not fold warm-up latency into the distribution", async () => {
    let n = 0;
    // First 3 calls are slow (cold cache), the rest fast.
    const rec = recorder(() => (++n <= 3 ? 5000 : 100));
    const config = makeConfig({ banks: ["big"], concurrency: [1], samples: 10, warmup: 3 });
    const cells = await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(rec.recall) });
    expect(cells[0]?.stats.max).toBe(100);
  });

  it("produces one cell per (bank × concurrency), bank-major and concurrency-ascending", async () => {
    const rec = recorder(() => 100);
    const config = makeConfig({ banks: ["big", "small"], concurrency: [8, 1, 4], samples: 2, warmup: 0 });
    const cells = await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(rec.recall) });
    expect(cells.map((c) => `${c.bank}@${c.concurrency}`)).toEqual([
      "big@1",
      "big@4",
      "big@8",
      "small@1",
      "small@4",
      "small@8",
    ]);
  });

  it("attaches the bank's measured row count as the x-axis value", async () => {
    const rec = recorder(() => 100);
    const config = makeConfig({ banks: ["big", "small"], concurrency: [1], samples: 1, warmup: 0 });
    const cells = await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(rec.recall) });
    expect(cells.map((c) => c.rows)).toEqual([228761, 12]);
  });

  it("keeps `concurrency` calls genuinely in flight rather than batching", async () => {
    // A batching implementation would still reach the peak; what it would ALSO
    // do is stall on the slowest member of each wave. The peak assertion is the
    // cheap half; the count assertion below is what catches a broken pool.
    const rec = recorder(() => 50);
    const config = makeConfig({ banks: ["big"], concurrency: [4], samples: 10, warmup: 0 });
    await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(rec.recall) });
    expect(rec.peak()).toBe(4);
    // Exactly `samples` calls even though 10 is not a multiple of 4 — a
    // batch-based driver would over- or under-shoot on the ragged last wave.
    expect(rec.calls).toHaveLength(10);
  });

  it("counts errors separately and keeps them out of the percentiles", async () => {
    let n = 0;
    const rec = recorder(() => (++n % 2 === 0 ? "error" : 200));
    const config = makeConfig({ banks: ["big"], concurrency: [1], samples: 10, warmup: 0 });
    const cells = await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(rec.recall) });
    expect(cells[0]?.stats.errors).toBe(5);
    expect(cells[0]?.stats.n).toBe(5);
    expect(cells[0]?.stats.p95).toBe(200);
    expect(cells[0]?.errorSamples).toEqual(["boom"]);
  });

  it("caps and deduplicates error samples", async () => {
    let n = 0;
    const recall = async (): Promise<RecallSample> => ({ ok: false, ms: 0, results: 0, error: `e${n++}` });
    const config = makeConfig({ banks: ["big"], concurrency: [1], samples: 20, warmup: 0 });
    const cells = await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(recall) });
    expect(cells[0]?.errorSamples).toHaveLength(5);
  });

  it("issues an identical query multiset for the same cell across runs", async () => {
    const config = makeConfig({ banks: ["big"], concurrency: [4], samples: 12, warmup: 0 });
    const a = recorder(() => 100);
    const b = recorder(() => 100);
    await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(a.recall) });
    await runSweep({ config, db: makeDbState(), settleMs: 0, deps: deps(b.recall) });
    const sortQ = (r: typeof a) => r.calls.map((c) => c.query).sort();
    expect(sortQ(a)).toEqual(sortQ(b));
    // And they are drawn from the fixed set, not generated.
    for (const q of a.calls) expect(RECALL_QUERIES).toContain(q.query);
  });

  it("settles between cells so a cell does not bleed into the next", async () => {
    const rec = recorder(() => 10);
    let sleeps = 0;
    const config = makeConfig({ banks: ["big"], concurrency: [1, 4], samples: 1, warmup: 0 });
    await runSweep({
      config,
      db: makeDbState(),
      settleMs: 2000,
      deps: {
        recall: rec.recall,
        sleep: async (ms) => {
          expect(ms).toBe(2000);
          sleeps++;
        },
      },
    });
    expect(sleeps).toBe(2);
  });
});

describe("extractArms", () => {
  // Shape as returned by hindsight v0.8.6 `trace.retrieval_results[]`.
  const trace = {
    retrieval_results: [
      { method_name: "semantic", fact_type: "world", duration_seconds: 0.412, results: [] },
      { method_name: "bm25", fact_type: "world", duration_seconds: 0.031 },
      { method_name: "graph", fact_type: "experience", duration_seconds: 1.5 },
    ],
  };

  it("converts seconds to ms and keeps method/fact_type attribution", () => {
    expect(extractArms(trace)).toEqual([
      { method: "semantic", fact_type: "world", ms: 412 },
      { method: "bm25", fact_type: "world", ms: 31 },
      { method: "graph", fact_type: "experience", ms: 1500 },
    ]);
  });

  it("returns [] for a response with no trace instead of throwing", () => {
    expect(extractArms(undefined)).toEqual([]);
    expect(extractArms({})).toEqual([]);
    expect(extractArms({ retrieval_results: "nope" })).toEqual([]);
  });

  it("skips malformed rows rather than emitting NaN timings", () => {
    const arms = extractArms({
      retrieval_results: [{ method_name: "semantic", duration_seconds: "slow" }, { duration_seconds: 1 }, null],
    });
    expect(arms).toEqual([]);
  });

  it("defaults a missing fact_type to empty rather than dropping the arm", () => {
    expect(extractArms({ retrieval_results: [{ method_name: "semantic", duration_seconds: 0.1 }] })).toEqual([
      { method: "semantic", fact_type: "", ms: 100 },
    ]);
  });
});

describe("runArmSweep", () => {
  it("buckets arms per (bank, method, fact_type) and reduces to percentiles", async () => {
    const config = makeConfig({ banks: ["big"] });
    const recall = async (): Promise<RecallSample> => ({
      ok: true,
      ms: 1,
      results: 3,
      trace: { retrieval_results: [{ method_name: "semantic", fact_type: "world", duration_seconds: 0.2 }] },
    });
    const arms = await runArmSweep({ config, samples: 4, deps: { recall } });
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ bank: "big", method: "semantic", fact_type: "world", n: 4, p50: 200 });
  });

  it("ignores failed traced calls instead of counting them as zero-cost arms", async () => {
    const config = makeConfig({ banks: ["big"] });
    const recall = async (): Promise<RecallSample> => ({ ok: false, ms: 0, results: 0, error: "boom" });
    expect(await runArmSweep({ config, samples: 3, deps: { recall } })).toEqual([]);
  });
});
