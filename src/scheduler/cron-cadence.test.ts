/**
 * Tests for the tier-selection cadence estimator. The load-bearing property
 * is the CONSERVATIVE bias: anything not confidently sub-hourly must read as
 * infrequent (large/Infinity), so the value gate never strips context from a
 * cron it couldn't classify.
 */

import { describe, it, expect } from "vitest";
import { estimateCronGapMin } from "./cron-cadence.js";

describe("estimateCronGapMin — sub-hour (minute field)", () => {
  it("every minute → 1", () => {
    expect(estimateCronGapMin("* * * * *")).toBe(1);
  });
  it("stepped minutes → the step", () => {
    expect(estimateCronGapMin("*/5 * * * *")).toBe(5);
    expect(estimateCronGapMin("*/30 * * * *")).toBe(30);
  });
  it("CSV minutes → smallest pairwise gap", () => {
    expect(estimateCronGapMin("0,30 * * * *")).toBe(30);
    expect(estimateCronGapMin("0,15,30,45 * * * *")).toBe(15);
    expect(estimateCronGapMin("0,1,2 * * * *")).toBe(1);
  });
});

describe("estimateCronGapMin — hourly and coarser (the cases the old helper got wrong)", () => {
  it("hourly (single minute, hour *) → 60", () => {
    expect(estimateCronGapMin("0 * * * *")).toBe(60);
    expect(estimateCronGapMin("30 * * * *")).toBe(60);
  });
  it("stepped hours → 60·N", () => {
    expect(estimateCronGapMin("0 */2 * * *")).toBe(120);
    expect(estimateCronGapMin("0 */6 * * *")).toBe(360);
  });
  it("CSV hours → 60·smallest pairwise hour gap", () => {
    expect(estimateCronGapMin("0 8,12,18 * * *")).toBe(240); // 12-8=4h
    expect(estimateCronGapMin("0 9,10 * * *")).toBe(60);
  });
  it("daily → 1440 (NOT 0 — the bug this fixes)", () => {
    expect(estimateCronGapMin("0 8 * * *")).toBe(1440);
    expect(estimateCronGapMin("5 7 * * 1-5")).toBe(1440); // weekday morning
    expect(estimateCronGapMin("0 18 * * 0")).toBe(1440); // weekly (floored at daily, still infrequent)
  });
});

describe("estimateCronGapMin — conservative on anything unreadable", () => {
  it("malformed / too-few fields → Infinity", () => {
    expect(estimateCronGapMin("garbage")).toBe(Infinity);
    expect(estimateCronGapMin("0 8")).toBe(Infinity);
    expect(estimateCronGapMin("")).toBe(Infinity);
  });
  it("minute ranges / mixed shapes → Infinity (don't guess)", () => {
    expect(estimateCronGapMin("0-10 * * * *")).toBe(Infinity);
  });
  it("step of zero → Infinity (never 'every 0 min')", () => {
    expect(estimateCronGapMin("*/0 * * * *")).toBe(Infinity);
  });

  it("REGRESSION GUARD: a daily cron must read as infrequent, never sub-hourly", () => {
    // The exact misclassification that would strip a morning brief's context.
    expect(estimateCronGapMin("0 8 * * *")).toBeGreaterThan(60);
  });
});
