import { describe, it, expect } from "vitest";
import {
  evaluateAll,
  evaluateContainer,
  evaluateFailureRate,
  evaluateQueueGrowth,
  evaluateRetainLoss,
} from "./evaluate.js";
import {
  PARTS_PER_MEMORY,
  QUEUE_FLOOR,
  QUEUE_GROWTH_MIN_ABS,
} from "./thresholds.js";
import type { Sample } from "./types.js";

const T0 = Date.parse("2026-07-25T09:00:00Z");
const INTERVAL = 15 * 60_000;

function sample(i: number, over: Partial<Sample> = {}): Sample {
  return {
    ts: T0 + i * INTERVAL,
    retainOk: 0,
    retainFail: 0,
    pending: 0,
    dead: 0,
    evicted: 0,
    drops: 0,
    restartCount: 0,
    startedAt: "2026-07-25T09:06:18Z",
    health: "healthy",
    ...over,
  };
}

/** Build a window where each interval adds `ok` successes and `fail` failures. */
function rateWindow(n: number, ok: number, fail: number): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    out.push(sample(i, { retainOk: ok * i, retainFail: fail * i }));
  }
  return out;
}

describe("evaluateFailureRate — the retain-failure storm signal", () => {
  it("FIRES on the reported storm shape (~28% of memory writes failing)", () => {
    // 3 intervals × (18 ok + 7 fail) = 54 ok / 21 fail = 28.0%.
    const v = evaluateFailureRate(rateWindow(4, 18, 7));
    expect(v.state).toBe("breach");
    expect(v.measured?.rate).toBeCloseTo(0.28, 2);
    expect(v.detail).toContain("28.0%");
  });

  it("FIRES on the 2026-07-20 ledger shape (100% failure)", () => {
    const v = evaluateFailureRate(rateWindow(3, 0, 40));
    expect(v.state).toBe("breach");
    expect(v.measured?.rate).toBe(1);
  });

  it("stays quiet at the measured healthy rate (2.7%, worst healthy hour on record)", () => {
    // 4 intervals × (36 ok + 1 fail) = 108 ok / 3 fail = 2.7%.
    const v = evaluateFailureRate(rateWindow(4, 36, 1));
    expect(v.state).toBe("ok");
    expect(v.measured?.rate).toBeLessThan(0.03);
  });

  it("reports no-data below the sample floor rather than a scary rate", () => {
    // 1 of 2 failing is 50% — but 2 observations is noise, not a storm.
    const v = evaluateFailureRate(rateWindow(3, 0, 1));
    expect(v.state).toBe("no-data");
    expect(v.detail).toContain("sample floor");
  });

  it("survives a counter reset mid-window (container restart) and still fires", () => {
    // Two clean intervals, then hindsight restarts and comes back failing.
    const ring: Sample[] = [
      sample(0, { retainOk: 500, retainFail: 2 }),
      sample(1, { retainOk: 520, retainFail: 2 }),
      sample(2, { retainOk: 1, retainFail: 30 }), // counters reset to near-zero
      sample(3, { retainOk: 2, retainFail: 70 }),
    ];
    const v = evaluateFailureRate(ring);
    expect(v.state).toBe("breach");
    // Successes: 20 pre-reset, then the reset interval credits the post-reset
    // value (1) instead of a negative, then 1 more ⇒ 22. Without reset
    // handling this would be 20 + (1-520) + 1 = -498 and the rate would be
    // nonsense at exactly the moment the container crashed.
    expect(v.measured?.total).toBe(90);
    expect(v.measured?.fail).toBe(68);
    expect(v.measured?.rate).toBeCloseTo(68 / 90, 3);
  });
});

describe("evaluateQueueGrowth — rising vs draining", () => {
  it("stays quiet through a large legitimate DRAIN (5636 → 616, as measured today)", () => {
    const ring = [sample(0, { pending: 5636 }), sample(4, { pending: 616 })];
    const v = evaluateQueueGrowth(ring);
    expect(v.state).toBe("ok");
    expect(v.detail).toContain("5636 → 616");
  });

  it("FIRES when the spool turns around and grows past the floor", () => {
    const ring = [sample(0, { pending: 400 }), sample(4, { pending: 900 })];
    expect(evaluateQueueGrowth(ring).state).toBe("breach");
  });

  it("ignores small absolute growth on a small base", () => {
    // 40 → 55 is +37% but only 15 files across the whole fleet.
    expect(evaluateQueueGrowth([sample(0, { pending: 40 }), sample(4, { pending: 55 })]).state).toBe("ok");
  });

  it("ignores sub-threshold growth on a large base (retry churn, not a storm)", () => {
    // 600 → 615 is +15 — below both the 88-part absolute floor and the
    // 10% (60-part) fraction.
    expect(evaluateQueueGrowth([sample(0, { pending: 600 }), sample(4, { pending: 615 })]).state).toBe("ok");
  });

  it("stays quiet on a flat queue", () => {
    expect(evaluateQueueGrowth([sample(0, { pending: 616 }), sample(4, { pending: 616 })]).state).toBe("ok");
  });
});

describe("evaluateQueueGrowth — recalibrated for #3610's split (parts, not memories)", () => {
  it("does NOT fire on five worst-case memories splitting into 85 parts", () => {
    // #3610 caps retain content at 45,000 chars; the largest entry measured
    // on this fleet (744,546 chars) becomes 17 parts. Five such memories
    // failing once is +85 entries with only five memories behind them, and
    // must not read as "the spool turned around".
    //
    // The pre-#3610 thresholds WOULD have fired here: floor 100 (< 440) and
    // growth need max(20, 10%×440 = 44) = 44, which +85 clears. That is
    // exactly the false positive the rescale removes.
    const ring = [sample(0, { pending: QUEUE_FLOOR }), sample(4, { pending: QUEUE_FLOOR + 5 * 17 })];
    const v = evaluateQueueGrowth(ring);
    expect(v.state).toBe("ok");
    expect(85).toBeLessThan(QUEUE_GROWTH_MIN_ABS);
  });

  it("still fires for the twenty-failing-memories case the floor was written for", () => {
    // The original intent of the absolute floor: ~20 distinct memories
    // failed and stayed failed. In parts that is 20 × PARTS_PER_MEMORY.
    const growth = Math.ceil(20 * PARTS_PER_MEMORY);
    const ring = [sample(0, { pending: QUEUE_FLOOR }), sample(4, { pending: QUEUE_FLOOR + growth })];
    expect(evaluateQueueGrowth(ring).state).toBe("breach");
  });

  it("is silent below the rescaled depth floor even on steep growth", () => {
    // 100 → 300 parts is ~23 → 68 memories: real churn, not an incident,
    // and beneath the depth this signal wakes anyone for. Under the
    // pre-#3610 floor of 100 entries this fired.
    const v = evaluateQueueGrowth([sample(0, { pending: 100 }), sample(4, { pending: 300 })]);
    expect(v.state).toBe("ok");
    expect(300).toBeLessThan(QUEUE_FLOOR);
  });

  it("FIRES once on the measured pre-split backlog migrating to parts (174 → 765)", () => {
    // Documented, accepted behaviour rather than a bug: when this fleet's
    // 174 pre-split entries are re-enqueued through the #3610 path they
    // become 765 parts carrying not one new memory. A >4x jump in spool
    // depth is worth telling the operator about once, and suppressing it
    // would mean teaching a watchdog to ignore a quadrupling queue.
    const v = evaluateQueueGrowth([sample(0, { pending: 174 }), sample(4, { pending: 765 })]);
    expect(v.state).toBe("breach");
  });
});

describe("evaluateRetainLoss — memory that left the queue unpersisted", () => {
  it("FIRES on a single new .dead marker", () => {
    const v = evaluateRetainLoss([sample(0, { dead: 135 }), sample(1, { dead: 136 })]);
    expect(v.state).toBe("breach");
    expect(v.measured?.deadAdded).toBe(1);
    expect(v.detail).toContain("1 new .dead marker(s)");
  });

  it("FIRES on a new #3599 eviction, which the .dead count alone cannot see", () => {
    const v = evaluateRetainLoss([sample(0, { evicted: 0 }), sample(1, { evicted: 12 })]);
    expect(v.state).toBe("breach");
    expect(v.measured?.evictedAdded).toBe(12);
    expect(v.detail).toContain("12 new evicted entry(s)");
  });

  it("FIRES on a new #3599 residual drop (record_drop ledger)", () => {
    const v = evaluateRetainLoss([sample(0, { drops: 0 }), sample(1, { drops: 1 })]);
    expect(v.state).toBe("breach");
    expect(v.measured?.dropsAdded).toBe(1);
    expect(v.detail).toContain("1 new dropped retain(s)");
  });

  it("names every channel that moved in one DM", () => {
    const v = evaluateRetainLoss([
      sample(0, { dead: 1, evicted: 1, drops: 1 }),
      sample(1, { dead: 2, evicted: 4, drops: 3 }),
    ]);
    expect(v.state).toBe("breach");
    expect(v.detail).toContain(".dead marker");
    expect(v.detail).toContain("evicted entry");
    expect(v.detail).toContain("dropped retain");
  });

  it("does not fire on steady non-zero counts", () => {
    const v = evaluateRetainLoss([
      sample(0, { dead: 18, evicted: 5, drops: 2 }),
      sample(1, { dead: 18, evicted: 5, drops: 2 }),
    ]);
    expect(v.state).toBe("ok");
    expect(v.detail).toContain("18 dead, 5 evicted, 2 dropped");
  });

  it("treats a DECREASE (operator cleaned .dead, archive trimmed) as a re-baseline", () => {
    const v = evaluateRetainLoss([
      sample(0, { dead: 135, evicted: 500 }),
      sample(1, { dead: 0, evicted: 200 }),
    ]);
    expect(v.state).toBe("ok");
  });
});

describe("evaluateContainer", () => {
  it("FIRES on unhealthy", () => {
    const v = evaluateContainer([sample(0), sample(1, { health: "unhealthy" })]);
    expect(v.state).toBe("breach");
    expect(v.detail).toContain("health=unhealthy");
  });

  it("FIRES when RestartCount advances", () => {
    const v = evaluateContainer([sample(0, { restartCount: 0 }), sample(1, { restartCount: 1 })]);
    expect(v.state).toBe("breach");
    expect(v.detail).toContain("RestartCount 0 → 1");
  });

  it("FIRES on a recreate, which RESETS RestartCount to 0", () => {
    // The blind spot this closes: docker recreate zeroes RestartCount, so
    // restart-count alone reads a crash-recreate loop as perfectly calm.
    const ring = [
      sample(0, { restartCount: 3, startedAt: "2026-07-25T09:06:18Z" }),
      sample(1, { restartCount: 0, startedAt: "2026-07-25T09:41:02Z" }),
    ];
    const v = evaluateContainer(ring);
    expect(v.state).toBe("breach");
    expect(v.detail).toContain("recreated");
  });

  it("is quiet on a steady healthy container", () => {
    expect(evaluateContainer([sample(0), sample(1)]).state).toBe("ok");
  });

  it("does not fire when the image simply defines no healthcheck", () => {
    expect(evaluateContainer([sample(0, { health: "none" }), sample(1, { health: "none" })]).state).toBe("ok");
  });
});

describe("evaluateAll", () => {
  it("returns one verdict per level/edge signal", () => {
    const verdicts = evaluateAll([sample(0), sample(1)]);
    expect(verdicts.map((v) => v.signal).sort()).toEqual([
      "container",
      "retain-failure-rate",
      "retain-loss",
      "retain-queue-growth",
    ]);
  });

  it("no longer emits a latency signal — hindsight's histogram cannot resolve one", () => {
    // The exposition's largest finite `le` is 120s and a healthy post-#3610
    // backend already runs 19.4% of retains past it (measured 2026-07-25:
    // 52/268, with a 1.1% failure rate). Any threshold this instrument can
    // express fires permanently, so the signal was removed rather than
    // retuned. Restoring it needs `le` edges above the 280s client deadline.
    const verdicts = evaluateAll([sample(0), sample(1)]);
    expect(verdicts.some((v) => v.signal.includes("latency"))).toBe(false);
  });

  it("reports no-data everywhere on a single sample — never a false all-clear", () => {
    const verdicts = evaluateAll([sample(0)]);
    expect(verdicts.filter((v) => v.signal !== "container").every((v) => v.state === "no-data")).toBe(true);
  });
});
