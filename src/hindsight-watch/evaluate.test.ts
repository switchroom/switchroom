import { describe, it, expect } from "vitest";
import {
  evaluateAll,
  evaluateConsolidationQueueAge,
  evaluateContainer,
  evaluateFailureRate,
  evaluateLlmFallback,
  evaluateQueueGrowth,
  evaluateRecallOwnBankTimeout,
  evaluateRetainLoss,
} from "./evaluate.js";
import {
  PARTS_PER_MEMORY,
  QUEUE_FLOOR,
  QUEUE_GROWTH_MIN_ABS,
  RECALL_WALL_MS,
} from "./thresholds.js";
import type { RecallSample, Sample } from "./types.js";

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
    // #3610 caps retain content at `retain_content_limit()` — 45,000 chars
    // when this case was measured, 48,000 since the client deadline became
    // derived from the litellm routing chain (see B7a in ./thresholds.ts).
    // At the 45,000 of the measurement the largest entry on this fleet
    // (744,546 chars) becomes 17 parts. Five such memories failing once is
    // +85 entries with only five memories behind them, and must not read as
    // "the spool turned around". The scenario is kept at the measured
    // numbers; the bound moving to 48,000 lowers it to 16 parts and makes
    // this case strictly easier to pass, so it is still the worst case.
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

describe("evaluateQueueGrowth — a backlog is WARN, never a loss-grade page", () => {
  it("a high, under-cap backlog fires at most a WARN so it can never read as loss", () => {
    // The 2026-08-05 false alarm: a ~2,300-part fleet backlog (klanker 1,051 +
    // overlord 860, both under the 2,000-entry per-agent cap) rising and
    // draining slowly, with every loss channel at zero. It must alert as 🟠
    // "degraded" (severity `warn`), NOT the 🔴 red an operator reads as
    // "memories are being lost", and its wording must disclaim loss.
    const v = evaluateQueueGrowth([sample(0, { pending: 0 }), sample(4, { pending: 2308 })]);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("warn");
    expect(v.detail).toContain("NOT loss");
  });
});

describe("evaluateRetainLoss — memory that left the queue unpersisted", () => {
  it("does NOT fire on a high, under-cap backlog with archive-count trims present", () => {
    // The other half of the 2026-08-05 false alarm: pending-retains climbing
    // to ~2,300 parts (under the 2,000-entry per-agent cap) while
    // `pending-evictions.log` fills with `reason=archive-count` trims of the
    // DURABLE `pending-reconciled/` archive. Those trims are housekeeping of
    // already-persisted entries; this signal reads `pending-evicted/` (real
    // undrained eviction), never the archive-count ledger, so a deep-but-
    // draining spool with flat loss channels must NOT claim memory loss.
    const v = evaluateRetainLoss([
      sample(0, { pending: 1900, dead: 0, evicted: 0, drops: 0 }),
      sample(1, { pending: 2308, dead: 0, evicted: 0, drops: 0 }),
    ]);
    expect(v.state).toBe("ok");
    expect(v.detail).toContain("no new memory loss");
  });

  it("DOES fire when undrained entries are evicted at the per-agent cap", () => {
    // The real loss case the false alarm was drowning out: `pending-retains`
    // hit `HINDSIGHT_PENDING_MAX_ENTRIES` and `_evict_to_fit` shed undrained
    // (non-durable) entries into `pending-evicted/`. That IS memory leaving
    // the queue unpersisted and MUST fire the loss alarm.
    const v = evaluateRetainLoss([
      sample(0, { pending: 2000, evicted: 0 }),
      sample(1, { pending: 2000, evicted: 37 }),
    ]);
    expect(v.state).toBe("breach");
    expect(v.measured?.evictedAdded).toBe(37);
    expect(v.detail).toContain("memory left the queue unpersisted");
  });

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
      "consolidation-failure-streak",
      "consolidation-queue-age",
      "container",
      "llm-fallback-ineffective",
      "pending-consolidation-depth",
      "recall-candidate-floor",
      "recall-deadline-pinning",
      "recall-injected-score",
      "recall-latency",
      "recall-own-bank-timeout",
      "recall-quality-regression",
      "recall-zero-memory",
      "retain-failure-rate",
      "retain-loss",
      "retain-queue-growth",
      "vector-index-corruption",
    ]);
  });

  it("still emits no RETAIN latency signal — hindsight's histogram cannot resolve one", () => {
    // The exposition's largest finite `le` is 120s and a healthy post-#3610
    // backend already runs 19.4% of retains past it (measured 2026-07-25:
    // 52/268, with a 1.1% failure rate). Any threshold this instrument can
    // express fires permanently, so the signal was removed rather than
    // retuned. Restoring it needs `le` edges above the retain client deadline
    // (280s when this was measured, 310s since — see B7a in ./thresholds.ts).
    //
    // `recall-latency` is NOT a counter-example: it reads `total_elapsed_ms`
    // from `recall_log.jsonl`, an exact per-turn wall-clock number, not a
    // bucketed histogram — which is precisely why a latency SLI is expressible
    // on the recall side and still is not on the retain side.
    const verdicts = evaluateAll([sample(0), sample(1)]);
    expect(verdicts.some((v) => v.signal.includes("latency") && v.signal.startsWith("retain"))).toBe(
      false,
    );
  });

  it("reports no-data everywhere on a single sample — never a false all-clear", () => {
    const verdicts = evaluateAll([sample(0)]);
    expect(verdicts.filter((v) => v.signal !== "container").every((v) => v.state === "no-data")).toBe(true);
  });
});

describe("evaluateRecallOwnBankTimeout — the diagnostic latency suffix", () => {
  function recallSample(over: Partial<RecallSample> = {}): RecallSample {
    return {
      rows: 100,
      agents: 1,
      timeoutConsidered: 100,
      ownBankDegraded: 0,
      zeroConsidered: 100,
      zeroResult: 0,
      poolConsidered: 100,
      poolMedian: 40,
      scoreConsidered: 100,
      scoreP50: 0.5,
      elapsedConsidered: 100,
      elapsedP95Ms: 7000,
      ...over,
    };
  }

  function ringWith(r: RecallSample): Sample[] {
    return [sample(0, { recall: r }), sample(1, { recall: r })];
  }

  // The alert text used to hardcode "the 8000ms per-bank budget"; #3759 raised
  // the live recall deadline to a 10 s declarative envelope. The operator-facing
  // wall MUST report the live envelope, not the retired 8 s number.
  it("reports the live 10 s recall deadline, never the retired 8000ms budget", () => {
    const v = evaluateRecallOwnBankTimeout(ringWith(recallSample()));
    expect(RECALL_WALL_MS).toBe(10_000);
    expect(v.detail).toContain(`${RECALL_WALL_MS}ms recall deadline`);
    expect(v.detail).not.toContain("8000ms per-bank budget");
  });

  it("renders the measured p95 alongside the wall it is read against", () => {
    const v = evaluateRecallOwnBankTimeout(ringWith(recallSample({ elapsedP95Ms: 7421 })));
    expect(v.detail).toContain("recall wall time p95 7421ms");
  });
});

/**
 * Consolidation queue age. Measured live 2026-07-27: 77 pending, oldest
 * 14 327 s (3.98 h) — a real warn that is deliberately NOT a page.
 */
describe("evaluateConsolidationQueueAge", () => {
  function ringWith(c: Sample["consolidation"]): Sample[] {
    return [sample(0, { consolidation: c }), sample(1, { consolidation: c })];
  }

  it("pages past the 12h cap", () => {
    const v = evaluateConsolidationQueueAge(ringWith({ pending: 40, oldestAgeS: 13 * 3600 }));
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
  });

  it("warns — not pages — at the fleet's measured 3.98h backlog", () => {
    const v = evaluateConsolidationQueueAge(ringWith({ pending: 77, oldestAgeS: 14_327 }));
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("warn");
  });

  it("is clean under the warn threshold", () => {
    expect(evaluateConsolidationQueueAge(ringWith({ pending: 3, oldestAgeS: 120 })).state).toBe("ok");
  });

  it("is clean on an empty queue regardless of a stale age reading", () => {
    expect(evaluateConsolidationQueueAge(ringWith({ pending: 0, oldestAgeS: 99_999 })).state).toBe("ok");
  });

  it("reports no-data (not ok) when the psql probe could not run", () => {
    expect(evaluateConsolidationQueueAge(ringWith(null)).state).toBe("no-data");
  });
});

/**
 * `llm-fallback-ineffective`. The pre-existing OpenRouter-adjacent checks all
 * alert on OpenRouter *being used*, so a fallback that never fires reads as
 * clean. This signal inverts that: because LiteLLM's router fallback happens
 * INSIDE one hindsight request, a `success="false"` means the local
 * deployment failed AND the OpenRouter hop did not rescue it.
 */
describe("evaluateLlmFallback", () => {
  function llmWindow(n: number, ok: number, fail: number): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) out.push(sample(i, { llmOk: ok * i, llmFail: fail * i }));
    return out;
  }

  it("pages when a tenth of calls fail outright despite the fallback", () => {
    // 4 intervals × (36 ok + 4 fail) = 144 ok / 16 fail = 160 calls, 10.0%.
    const v = evaluateLlmFallback(llmWindow(5, 36, 4));
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.measured?.rate).toBeCloseTo(0.1, 6);
  });

  it("warns in the 2-10% band", () => {
    const v = evaluateLlmFallback(llmWindow(5, 40, 2));
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("warn");
  });

  it("is clean at the fleet's measured 0/800", () => {
    expect(evaluateLlmFallback(llmWindow(5, 200, 0)).state).toBe("ok");
  });

  it("reports no-data below the call floor rather than pass on one bad call", () => {
    // 1 failure out of 2 calls is 50%, but two calls is not evidence.
    const v = evaluateLlmFallback(llmWindow(2, 1, 1));
    expect(v.state).toBe("no-data");
  });

  it("credits the whole value on a counter reset instead of a negative delta", () => {
    // hindsight restarts mid-window: fail goes 500 → 30. A naive next-prev is
    // -470, which would read as a healthy window at the exact moment the
    // backend crashed.
    const ring = [
      sample(0, { llmOk: 5000, llmFail: 500 }),
      sample(1, { llmOk: 40, llmFail: 30 }),
    ];
    const v = evaluateLlmFallback(ring);
    expect(v.measured?.fail).toBe(30);
    expect(v.measured?.total).toBe(70);
  });

  it("reports no-data when the exposition carries no LLM counter at all", () => {
    expect(evaluateLlmFallback([sample(0), sample(1)]).state).toBe("no-data");
  });
});

// ── the three signals added for the 2026-07-29 consolidation outage ──────

import {
  evaluateConsolidationFailureStreak,
  evaluatePendingConsolidationDepth,
  evaluateVectorIndexCorruption,
} from "./evaluate.js";
import {
  CONSOLIDATION_FAILURE_STREAK_PAGE,
  CONSOLIDATION_FAILURE_STREAK_WARN,
  CONSOLIDATION_STREAK_NO_SUCCESS_S,
  CONSOLIDATION_STREAK_RECENCY_S,
  PENDING_CONSOLIDATION_FLOOR,
} from "./thresholds.js";
import type { BankSample } from "./types.js";

function banks(over: Partial<BankSample> = {}): BankSample {
  return { streaks: [], pending: [], ...over };
}

describe("evaluateConsolidationFailureStreak — the signal that was missing", () => {
  it("FIRES on the live incident shape: 103 consecutive failures, EMPTY pending queue", () => {
    // The exact row read off production during the incident:
    //   overlord | consolidation | 103 | 668
    // …while `consolidation` (pending/processing) was 0.
    const ring = [
      sample(0, {
        consolidation: { pending: 0, oldestAgeS: 0 },
        banks: banks({ streaks: [{ bank: "overlord", operationType: "consolidation", streak: 103, newestFailureAgeS: 668 }] }),
      }),
    ];
    const v = evaluateConsolidationFailureStreak(ring);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.measured?.bank).toBe("overlord");
    expect(v.measured?.streak).toBe(103);

    // …and the pre-existing signal, on the SAME window, reports health. If
    // this ever stops being true the blind spot was fixed elsewhere and this
    // test should be re-derived, not deleted.
    const old = evaluateConsolidationQueueAge(ring);
    expect(old.state).toBe("ok");
    // Still reads OK on the same window (the blind spot is real), but the
    // detail no longer says "consolidation queue empty" — #3989 replaced that
    // all-clear string with one that names where failures ARE counted.
    expect(old.detail).not.toContain("consolidation queue empty");
    expect(old.detail).toContain("failures are not counted here");
    expect(old.detail).toContain("consolidation-failure-streak");
  });

  it("warns at the threshold and pages at the page line", () => {
    const at = (streak: number) =>
      evaluateConsolidationFailureStreak([
        sample(0, {
          banks: banks({ streaks: [{ bank: "b", operationType: "consolidation", streak, newestFailureAgeS: 60 }] }),
        }),
      ]);
    expect(at(CONSOLIDATION_FAILURE_STREAK_WARN - 1).state).toBe("ok");
    expect(at(CONSOLIDATION_FAILURE_STREAK_WARN).state).toBe("breach");
    expect(at(CONSOLIDATION_FAILURE_STREAK_WARN).severity).toBe("warn");
    expect(at(CONSOLIDATION_FAILURE_STREAK_PAGE).severity).toBe("page");
  });

  it("scores the PAIR, not the bank — successful retains must not mask a wedged consolidator", () => {
    // During the incident `overlord` completed 3,753 retains while its
    // consolidation failed 112 times. A bank-wide streak would read 0.
    const v = evaluateConsolidationFailureStreak([
      sample(0, {
        banks: banks({
          streaks: [
            { bank: "overlord", operationType: "consolidation", streak: 112, newestFailureAgeS: 90 },
            // `retain` has no streak at all — it keeps completing.
          ],
        }),
      }),
    ]);
    expect(v.state).toBe("breach");
    expect(v.measured?.operationType).toBe("consolidation");
  });

  it("ignores a STALE streak — a fixed-but-idle bank must not alert for ever", () => {
    const v = evaluateConsolidationFailureStreak([
      sample(0, {
        banks: banks({
          streaks: [
            {
              bank: "overlord",
              operationType: "consolidation",
              streak: 500,
              newestFailureAgeS: CONSOLIDATION_STREAK_RECENCY_S + 1,
              // Fixed: a completion landed after the streak, 10 minutes ago.
              lastCompletedAgeS: 600,
            },
          ],
        }),
      }),
    ]);
    expect(v.state).toBe("ok");
  });

  // ── the sparse-job blind spot (#4618) ────────────────────────────────────
  //
  // Every fixture below is HARD-CODED in seconds, deliberately not derived
  // from the constants it exercises: a fixture written as
  // `CONSOLIDATION_STREAK_NO_SUCCESS_S + 1` moves with the constant and the
  // test can then never fail for any value of it. The two pins at the top are
  // the tripwire that keeps the literals honest.
  describe("a SPARSE, demand-driven op type that is 100% broken", () => {
    it("pins the constants these fixtures are written against", () => {
      // If either of these changes, the literal fixtures below stop meaning
      // what their comments say — re-derive them, do not retune this pin.
      expect(CONSOLIDATION_STREAK_NO_SUCCESS_S).toBe(172_800); // 48h
      expect(CONSOLIDATION_STREAK_RECENCY_S).toBe(7_200); // 2h
      expect(CONSOLIDATION_FAILURE_STREAK_WARN).toBe(3);
    });

    it("FIRES on the live 2026-08-12 shape the old guard read as healthy", () => {
      // Read verbatim off the production `state.json` + `async_operations`:
      //   overlord | graph_maintenance | streak 19 | newest failure 133,977s
      //             (37.2h) | last SUCCESS 791,908s (220h) ago
      //   klanker  | graph_maintenance | streak  9 | newest failure 328,555s
      //             (91.3h) | last SUCCESS 791,676s (220h) ago
      // Both failed the 2h recency guard, so the candidate list emptied and
      // the signal reported {"status":"ok","breaches":0} while the job was
      // completely broken. `graph_maintenance` is not a cron — it runs only
      // when work is enqueued — so it CANNOT produce a recent failure.
      const v = evaluateConsolidationFailureStreak([
        sample(0, {
          consolidation: { pending: 0, oldestAgeS: 0 },
          banks: banks({
            streaks: [
              {
                bank: "klanker",
                operationType: "graph_maintenance",
                streak: 9,
                newestFailureAgeS: 328_555,
                lastCompletedAgeS: 791_676,
              },
              {
                bank: "overlord",
                operationType: "graph_maintenance",
                streak: 19,
                newestFailureAgeS: 133_977,
                lastCompletedAgeS: 791_908,
              },
            ],
          }),
        }),
      ]);
      expect(v.state).toBe("breach");
      expect(v.severity).toBe("page");
      expect(v.measured?.bank).toBe("overlord");
      expect(v.measured?.streak).toBe(19);
      expect(v.measured?.operationType).toBe("graph_maintenance");
      expect(v.measured?.lastCompletedAgeS).toBe(791_908);
      // Both pairs breach, not just the worst one.
      expect(v.measured?.breachingPairs).toBe(2);
      expect(v.detail).toContain("klanker/graph_maintenance×9");
    });

    it("does NOT fire while a success is recent — the dense case is unchanged", () => {
      // The exact shape the recency guard was added for: old failures, but the
      // pair completed since. 46h < 48h, so the sparse arm must abstain and
      // the old arm already rejects the 100h-old failure.
      const v = evaluateConsolidationFailureStreak([
        sample(0, {
          banks: banks({
            streaks: [
              {
                bank: "overlord",
                operationType: "consolidation",
                streak: 500,
                newestFailureAgeS: 360_000, // 100h
                lastCompletedAgeS: 165_600, // 46h — inside the window
              },
            ],
          }),
        }),
      ]);
      expect(v.state).toBe("ok");
      expect(v.measured?.streak).toBe(0);
    });

    it("fires the moment the no-success window is CROSSED, not before", () => {
      const at = (lastCompletedAgeS: number) =>
        evaluateConsolidationFailureStreak([
          sample(0, {
            banks: banks({
              streaks: [
                {
                  bank: "overlord",
                  operationType: "graph_maintenance",
                  streak: 19,
                  newestFailureAgeS: 133_977, // 37h — fails the recency arm
                  lastCompletedAgeS,
                },
              ],
            }),
          }),
        ]).state;
      expect(at(172_799)).toBe("ok"); // 48h − 1s
      expect(at(172_800)).toBe("ok"); // exactly 48h — strictly greater required
      expect(at(172_801)).toBe("breach"); // 48h + 1s
    });

    it("breaches when the pair has NEVER completed — no success is not a fresh one", () => {
      const v = evaluateConsolidationFailureStreak([
        sample(0, {
          banks: banks({
            streaks: [
              {
                bank: "newbank",
                operationType: "graph_maintenance",
                streak: 12,
                newestFailureAgeS: 500_000,
                lastCompletedAgeS: null,
              },
            ],
          }),
        }),
      ]);
      expect(v.state).toBe("breach");
      expect(v.detail).toContain("last SUCCESS NEVER");
      expect(v.measured?.lastCompletedAgeS).toBe("never");
    });

    it("a NEVER-completed pair is still held to the clock — absence alone must not page", () => {
      // The only clock available when nothing has ever completed is the
      // streak's own age. Firing on absence alone would page a pair whose
      // history simply fell out of the retention window, or a brand-new pair
      // whose first three ops failed an hour ago and is already retrying.
      const at = (newestFailureAgeS: number) =>
        evaluateConsolidationFailureStreak([
          sample(0, {
            banks: banks({
              streaks: [
                {
                  bank: "newbank",
                  operationType: "graph_maintenance",
                  streak: 12,
                  newestFailureAgeS,
                  lastCompletedAgeS: null,
                },
              ],
            }),
          }),
        ]).state;
      expect(at(172_799)).toBe("ok"); // 48h − 1s since the newest failure
      expect(at(172_800)).toBe("ok"); // exactly 48h — strictly greater required
      expect(at(172_801)).toBe("breach"); // 48h + 1s
      // …and the recency arm still fires independently of any of this.
      expect(at(60)).toBe("breach");
    });

    it("says UNKNOWN, and omits the key, when the row predates the field", () => {
      // A legacy row that breaches on the RECENCY arm still reports. The
      // distinction the operator needs is "never succeeded" vs "we did not
      // read it": the detail must not claim the former, and `measured` must
      // omit the key entirely rather than emit a null the reader would have
      // to guess at.
      const v = evaluateConsolidationFailureStreak([
        sample(0, {
          banks: banks({
            streaks: [
              {
                bank: "overlord",
                operationType: "consolidation",
                streak: 12,
                newestFailureAgeS: 60, // fresh — breaches on the old arm
              },
            ],
          }),
        }),
      ]);
      expect(v.state).toBe("breach");
      expect(v.detail).toContain("last SUCCESS unknown (state predates the field)");
      expect(v.detail).not.toContain("NEVER");
      expect(v.measured).not.toHaveProperty("lastCompletedAgeS");
    });

    it("reports a KNOWN last success as an age, not as 'never'", () => {
      const v = evaluateConsolidationFailureStreak([
        sample(0, {
          banks: banks({
            streaks: [
              {
                bank: "overlord",
                operationType: "graph_maintenance",
                streak: 19,
                newestFailureAgeS: 133_977,
                lastCompletedAgeS: 791_908, // 219.97h
              },
            ],
          }),
        }),
      ]);
      expect(v.detail).toContain("last SUCCESS 220.0h ago");
      expect(v.measured?.lastCompletedAgeS).toBe(791_908);
    });

    it("needs a real streak: 2 stale failures with no success are still not a breach", () => {
      // The conjunction is what keeps the 48h window safe. A healthy sparse
      // pair legitimately goes ~28h between completions (measured p99), so the
      // window alone would be noise — it is only ever asked about a pair that
      // has already failed ≥3 times in a row.
      const at = (streak: number) =>
        evaluateConsolidationFailureStreak([
          sample(0, {
            banks: banks({
              streaks: [
                {
                  bank: "overlord",
                  operationType: "graph_maintenance",
                  streak,
                  newestFailureAgeS: 133_977,
                  lastCompletedAgeS: 791_908,
                },
              ],
            }),
          }),
        ]);
      expect(at(2).state).toBe("ok");
      expect(at(2).measured?.streak).toBe(0); // not even a live candidate
      expect(at(3).state).toBe("breach");
      expect(at(3).severity).toBe("warn");
    });

    it("ABSTAINS on a row persisted before the field existed — unknown is not 'never'", () => {
      // A state file written by an older build has no `lastCompletedAgeS`.
      // Reading that as "never completed" would page on hydration alone.
      const at = (newestFailureAgeS: number) =>
        evaluateConsolidationFailureStreak([
          sample(0, {
            banks: banks({
              streaks: [
                {
                  bank: "overlord",
                  operationType: "graph_maintenance",
                  streak: 19,
                  newestFailureAgeS,
                },
              ],
            }),
          }),
        ]).state;
      expect(at(133_977)).toBe("ok"); // 37h
      // The interesting one: an absent field must abstain even when the
      // streak is old enough that a genuine `null` WOULD breach. `undefined`
      // and `null` differ here, and a loose `== null` check erases that.
      expect(at(500_000)).toBe("ok"); // 139h — a null here breaches; unknown must not
    });
  });

  // ── the recency arm's own boundary (#4621) ───────────────────────────────
  //
  // Pre-existing on `main`: `newestFailureAgeS <= CONSOLIDATION_STREAK_RECENCY_S`
  // survived mutation to `<` with the whole suite green — nothing pinned a
  // streak whose newest failure is EXACTLY 7,200 s old. The mutation is
  // behaviourally real: at the boundary the `<` variant drops through to the
  // sparse arm, where this pair (a recent success) reads `ok` instead of
  // `breach`. Same discipline as the block above — literal seconds, pinned
  // against the constant rather than derived from it.
  it("holds a streak whose newest failure is EXACTLY at the recency line", () => {
    expect(CONSOLIDATION_STREAK_RECENCY_S).toBe(7_200); // 2h — the fixtures below are written against this
    const at = (newestFailureAgeS: number) =>
      evaluateConsolidationFailureStreak([
        sample(0, {
          banks: banks({
            streaks: [
              {
                bank: "overlord",
                operationType: "consolidation",
                streak: 5,
                newestFailureAgeS,
                // A success 1h ago, so the SPARSE arm cannot fire and the
                // recency arm is the only thing deciding this verdict.
                lastCompletedAgeS: 3_600,
              },
            ],
          }),
        }),
      ]).state;
    expect(at(7_199)).toBe("breach"); // inside the window
    expect(at(7_200)).toBe("breach"); // exactly at it — the comparison is inclusive
    expect(at(7_201)).toBe("ok"); // past it, with no other arm satisfied
  });

  it("reports no-data — never a pass — when the per-bank block is missing", () => {
    expect(evaluateConsolidationFailureStreak([sample(0)]).state).toBe("no-data");
    expect(evaluateConsolidationFailureStreak([sample(0, { banks: null })]).state).toBe("no-data");
  });
});

describe("evaluatePendingConsolidationDepth — growth, not absolute depth", () => {
  const window = (from: Array<[string, number]>, to: Array<[string, number]>) => [
    sample(0, { banks: banks({ pending: from.map(([b, n]) => ({ bank: b, pending: n })) }) }),
    sample(8, { banks: banks({ pending: to.map(([b, n]) => ({ bank: b, pending: n })) }) }),
  ];

  it("FIRES and PAGES on the incident's growth (0 → 38,130 in one window)", () => {
    const v = evaluatePendingConsolidationDepth(window([["overlord", 0]], [["overlord", 38130]]));
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.measured?.bank).toBe("overlord");
    expect(v.measured?.growth).toBe(38130);
  });

  it("stays quiet on a bank that legitimately runs DEEP but is not growing", () => {
    // The reason this signal is a growth rate: klanker holds 202,549 units.
    // A flat — or draining — deep bank is healthy, and an absolute threshold
    // would have paged on it every tick.
    expect(evaluatePendingConsolidationDepth(window([["klanker", 40000]], [["klanker", 40000]])).state).toBe("ok");
    expect(evaluatePendingConsolidationDepth(window([["klanker", 40000]], [["klanker", 1000]])).state).toBe("ok");
  });

  it("stays quiet below the depth floor however fast it grew", () => {
    const to = PENDING_CONSOLIDATION_FLOOR - 1;
    expect(evaluatePendingConsolidationDepth(window([["b", 0]], [["b", to]])).state).toBe("ok");
  });

  it("ignores a bank that did not exist at the window start — ingest is not a stall", () => {
    expect(evaluatePendingConsolidationDepth(window([["old", 0]], [["brand-new", 9000]])).state).toBe("ok");
  });

  it("reports no-data with fewer than two ticks carrying a per-bank block", () => {
    expect(evaluatePendingConsolidationDepth([sample(0), sample(1)]).state).toBe("no-data");
  });
});

describe("evaluateVectorIndexCorruption — the HNSW canary", () => {
  it("FIRES, pages, and names the index on the incident's error", () => {
    const v = evaluateVectorIndexCorruption([
      sample(0, {
        vectorIndex: {
          probed: 88,
          corrupt: ["idx_mu_emb_obsv_81cef5f6a42e4b4d=different vector dimensions 384 and 0"],
        },
      }),
    ]);
    expect(v.state).toBe("breach");
    expect(v.severity).toBe("page");
    expect(v.detail).toContain("idx_mu_emb_obsv_81cef5f6a42e4b4d");
    expect(v.detail).toContain("REINDEX");
  });

  it("passes on the measured healthy sweep (89 indexes, 0 corrupt)", () => {
    const v = evaluateVectorIndexCorruption([sample(0, { vectorIndex: { probed: 89, corrupt: [] } })]);
    expect(v.state).toBe("ok");
    expect(v.measured?.probed).toBe(89);
  });

  it("reports no-data — never a pass — when the canary did not run", () => {
    expect(evaluateVectorIndexCorruption([sample(0)]).state).toBe("no-data");
  });
});
