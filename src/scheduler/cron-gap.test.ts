import { describe, it, expect } from "vitest";
import { cronMinuteSmallestGapMin, expandMinuteField } from "./cron-gap.js";

// #1783 — shared minute-cadence helper backing both the reconcile-layer
// `violatesMinInterval` and the write-path `extractCronSmallestGapMin`.
describe("cronMinuteSmallestGapMin (#1783)", () => {
  it.each([
    ["every minute `*`", "* * * * *", 1],
    ["stepped `*/5`", "*/5 * * * *", 5],
    ["stepped `*/4`", "*/4 * * * *", 4],
    ["single value `15` → hourly", "15 * * * *", 60],
    ["CSV `0,1,2`", "0,1,2 * * * *", 1],
    ["CSV `0,30`", "0,30 * * * *", 30],
    ["CSV `0,15,30,45`", "0,15,30,45 * * * *", 15],
    ["wraparound `58,59`", "58,59 * * * *", 1],
    ["range `0-4`", "0-4 * * * *", 1],
    ["range `0-30`", "0-30 * * * *", 1],
    ["step-on-range `0-30/2`", "0-30/2 * * * *", 2],
    ["step-on-list `0,10,20/1` (list ∪ 20-59)", "0,10,20/1 * * * *", 1],
    ["bare-N step `5/10` → 5,15,25,35,45,55", "5/10 * * * *", 10],
    ["every-minute-during-hour `* 1 * * *`", "* 1 * * *", 1],
  ])("%s → %d", (_label, expr, expected) => {
    expect(cronMinuteSmallestGapMin(expr)).toBe(expected);
  });

  it.each([
    ["unknown shape `bogus`", "bogus"],
    ["out-of-range minute `75`", "75 * * * *"],
    ["out-of-range in CSV `0,75`", "0,75 * * * *"],
    ["out-of-range in range `0-75`", "0-75 * * * *"],
    ["too-few fields `* *`", "* *"],
    ["zero step `*/0`", "*/0 * * * *"],
  ])("returns 0 (unknown) for %s", (_label, expr) => {
    expect(cronMinuteSmallestGapMin(expr)).toBe(0);
  });
});

describe("expandMinuteField (#1783)", () => {
  it("expands a CSV of mixed terms, de-duped and sorted", () => {
    expect(expandMinuteField("0-4,30,58,59")).toEqual([0, 1, 2, 3, 4, 30, 58, 59]);
  });
  it("returns null on an out-of-range value", () => {
    expect(expandMinuteField("60")).toBeNull();
  });
});
