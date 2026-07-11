import { describe, it, expect } from "vitest";
import { violatesMinInterval } from "./reconcile-dry-run.js";

// #1783 — violatesMinInterval used to recognise only `*/N` and the bare
// every-minute form, so CSV / range / step-on-range minute fields bypassed
// the 5-minute floor at the reconcile layer. It now delegates to the shared
// cron-gap helper. Assert the rejection BOOLEAN outcome directly.
describe("violatesMinInterval (#1783)", () => {
  it.each([
    ["every minute `*`", "* * * * *"],
    ["CSV clustered `0,1,2`", "0,1,2 * * * *"],
    ["range `0-4`", "0-4 * * * *"],
    ["step-on-range `0-30/2`", "0-30/2 * * * *"],
    ["stepped `*/4`", "*/4 * * * *"],
    ["wraparound `58,59`", "58,59 * * * *"],
    ["every-minute-during-hour `* 1 * * *`", "* 1 * * *"],
  ])("rejects sub-floor cadence: %s", (_label, expr) => {
    expect(violatesMinInterval(expr)).toBe(true);
  });

  it.each([
    ["`0,30` (30-min)", "0,30 * * * *"],
    ["`*/5` (== floor)", "*/5 * * * *"],
    ["single minute `15` (hourly)", "15 * * * *"],
    ["daily `0 9 * * *`", "0 9 * * *"],
  ])("accepts at-or-above-floor cadence: %s", (_label, expr) => {
    expect(violatesMinInterval(expr)).toBe(false);
  });

  it.each([
    ["unknown shape `bogus`", "bogus"],
    ["out-of-range minute `75`", "75 * * * *"],
    ["too-few fields `* *`", "* *"],
  ])("passes through unparseable / out-of-range form: %s", (_label, expr) => {
    expect(violatesMinInterval(expr)).toBe(false);
  });
});
