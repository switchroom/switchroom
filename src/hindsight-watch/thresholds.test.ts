import { describe, it, expect } from "vitest";
import {
  PARTS_PER_MEMORY,
  QUEUE_FLOOR,
  QUEUE_FLOOR_MEMORIES,
  QUEUE_GROWTH_MIN_ABS,
  QUEUE_GROWTH_MIN_ABS_MEMORIES,
} from "./thresholds.js";

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
