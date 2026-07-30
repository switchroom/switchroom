import { describe, it, expect } from "vitest";
import {
  PARTS_PER_MEMORY,
  QUEUE_FLOOR,
  QUEUE_FLOOR_MEMORIES,
  QUEUE_GROWTH_MIN_ABS,
  QUEUE_GROWTH_MIN_ABS_MEMORIES,
  RECALL_WALL_MS,
} from "./thresholds.js";
import { resolveHindsightRecallTunables } from "../setup/hindsight-recall-tunables.js";

describe("the #3610 memories → parts conversion", () => {
  // These two numbers are what the operator sees in `--json` and in every
  // alert detail line, so they are pinned rather than left to whatever
  // IEEE-754 does with the factor. `Math.ceil` really did produce 441 from
  // the old 100 × 4.4 = 440.00000000000006 while 20 × 4.4 came out exact at
  // 88 — a threshold that moves with float representation is not a threshold.
  it("pins QUEUE_FLOOR at 600 parts (100 memories)", () => {
    expect(QUEUE_FLOOR).toBe(600);
  });

  it("pins QUEUE_GROWTH_MIN_ABS at 120 parts (20 memories)", () => {
    expect(QUEUE_GROWTH_MIN_ABS).toBe(120);
  });

  // #3693 lowered the content bound 48,000 → 33,000, so the SAME backlog
  // splits into more parts. If the conversion factor is ever left behind at a
  // bound change, every count threshold silently tightens and the watchdog
  // starts alerting on a queue that holds no more memory than before.
  it("is scaled for the post-#3693 content bound, not the pre-#3693 one", () => {
    expect(PARTS_PER_MEMORY).toBeGreaterThanOrEqual(4.4 * (45_000 / 33_000));
  });

  it("keeps both thresholds equal to their stated intent in memories", () => {
    expect(QUEUE_FLOOR / QUEUE_FLOOR_MEMORIES).toBeCloseTo(PARTS_PER_MEMORY, 6);
    expect(QUEUE_GROWTH_MIN_ABS / QUEUE_GROWTH_MIN_ABS_MEMORIES).toBeCloseTo(PARTS_PER_MEMORY, 6);
  });

  it("stays above the pre-#3610 entry-count thresholds it replaced", () => {
    // The whole point of the rescale is that a split queue is deeper for the
    // same amount of memory. If either ever fell back to the old value the
    // false positive B6 documents would return.
    expect(QUEUE_FLOOR).toBeGreaterThan(100);
    expect(QUEUE_GROWTH_MIN_ABS).toBeGreaterThan(20);
    // Five worst-case memories must not clear the floor. 23 parts is the
    // worst single entry in the live 2026-07-26 backlog re-split at the
    // post-#3693 33,000 bound (it was 17 at 45,000, B6).
    expect(5 * 23).toBeLessThan(QUEUE_GROWTH_MIN_ABS);
  });
});

describe("RECALL_WALL_MS — the recall latency wall the diagnostic p95 reads against", () => {
  // The wall the watchdog reports MUST track the live #3759 declarative
  // envelope, not the retired hardcoded 8 s per-bank timeout. Every assertion
  // here fails on the stale 8000 the alert used to state.
  it("is sourced from the declarative recall envelope, not a literal", () => {
    // The same resolver scaffold/reconcile stamp onto the deployed plugin,
    // called with no operator overrides = the stock fleet envelope.
    const stock = resolveHindsightRecallTunables(undefined);
    expect(RECALL_WALL_MS).toBe(stock.parallelDeadlineSeconds * 1000);
  });

  it("resolves to the post-#3759 10 s envelope (12 s hook − 2 s headroom)", () => {
    expect(RECALL_WALL_MS).toBe(10_000);
  });

  it("is the raised wall, not the retired 8000 ms per-bank budget", () => {
    expect(RECALL_WALL_MS).toBeGreaterThan(8000);
  });
});
