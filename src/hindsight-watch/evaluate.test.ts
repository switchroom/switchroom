import { describe, it, expect } from "vitest";
import {
  evaluateAll,
  evaluateContainer,
  evaluateDeadRetains,
  evaluateFailureRate,
  evaluateLatencyP95,
  evaluateQueueGrowth,
} from "./evaluate.js";
import type { Sample } from "./types.js";

const T0 = Date.parse("2026-07-25T09:00:00Z");
const INTERVAL = 15 * 60_000;

function sample(i: number, over: Partial<Sample> = {}): Sample {
  return {
    ts: T0 + i * INTERVAL,
    retainOk: 0,
    retainFail: 0,
    retainBuckets: {},
    pending: 0,
    dead: 0,
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
    // 600 → 615 is +15 — below the 60-file (10%) growth requirement.
    expect(evaluateQueueGrowth([sample(0, { pending: 600 }), sample(4, { pending: 615 })]).state).toBe("ok");
  });

  it("stays quiet on a flat queue", () => {
    expect(evaluateQueueGrowth([sample(0, { pending: 616 }), sample(4, { pending: 616 })]).state).toBe("ok");
  });
});

describe("evaluateDeadRetains — permanently lost memories", () => {
  it("FIRES on a single new .dead marker", () => {
    const v = evaluateDeadRetains([sample(0, { dead: 135 }), sample(1, { dead: 136 })]);
    expect(v.state).toBe("breach");
    expect(v.measured?.added).toBe(1);
  });

  it("does not fire on a steady non-zero dead count", () => {
    expect(evaluateDeadRetains([sample(0, { dead: 135 }), sample(1, { dead: 135 })]).state).toBe("ok");
  });

  it("treats a DECREASE (operator cleaned the spool) as a re-baseline, not a fault", () => {
    expect(evaluateDeadRetains([sample(0, { dead: 135 }), sample(1, { dead: 0 })]).state).toBe("ok");
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

describe("evaluateLatencyP95 — early warning ahead of the 300s client timeout", () => {
  function latencyRing(perInterval: Record<string, number>, n = 3): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
      const buckets: Record<string, number> = {};
      for (const [le, v] of Object.entries(perInterval)) buckets[le] = v * i;
      out.push(sample(i, { retainBuckets: buckets }));
    }
    return out;
  }

  it("is quiet at the measured baseline (p95 ≈ 70s)", () => {
    // Per interval: 14 retains ≤60s, 1 in the 60–120 band. p95 lands ~64s.
    const v = evaluateLatencyP95(latencyRing({ "30.0": 10, "60.0": 14, "120.0": 15, "+Inf": 15 }, 4));
    expect(v.state).toBe("ok");
    expect(Number(v.measured?.p95Seconds)).toBeLessThan(120);
  });

  it("FIRES when p95 saturates the top bucket (retains past 120s)", () => {
    // Per interval: 8 fast, 4 past +Inf ⇒ 33% over 120s ⇒ p95 saturated.
    const v = evaluateLatencyP95(latencyRing({ "60.0": 8, "120.0": 8, "+Inf": 12 }, 4));
    expect(v.state).toBe("breach");
    expect(v.measured?.p95Seconds).toBe(">120");
  });

  it("reports no-data below the sample floor instead of a p95 from 2 retains", () => {
    const v = evaluateLatencyP95(latencyRing({ "60.0": 1, "+Inf": 1 }, 3));
    expect(v.state).toBe("no-data");
  });
});

describe("evaluateAll", () => {
  it("returns one verdict per level/edge signal", () => {
    const verdicts = evaluateAll([sample(0), sample(1)]);
    expect(verdicts.map((v) => v.signal).sort()).toEqual([
      "container",
      "retain-dead",
      "retain-failure-rate",
      "retain-latency-p95",
      "retain-queue-growth",
    ]);
  });

  it("reports no-data everywhere on a single sample — never a false all-clear", () => {
    const verdicts = evaluateAll([sample(0)]);
    expect(verdicts.filter((v) => v.signal !== "container").every((v) => v.state === "no-data")).toBe(true);
  });
});
