/**
 * #3185 — pure usage-ledger unit tests. Assert OUTCOMES: given probe/canary
 * header shapes in, the ledger records the right per-tier samples, trims the
 * ring, refill-normalizes at read time, and the headroom selector is
 * deterministic + order-stable. No I/O; the server wires persistence.
 */

import { describe, expect, it } from "vitest";
import type { QuotaResult } from "../quota.js";
import {
  standardSampleFromResult,
  premiumSampleFromResult,
  recordUsageSample,
  summarizeAccountUsage,
  premiumHeadroomPct,
  bestPremiumHeadroomAccount,
  resolveUsageRingCap,
  USAGE_RING_CAP_DEFAULT,
  STANDARD_WALL_PCT,
  type UsageLedger,
} from "./usage-ledger.js";

const NOW = 1_700_000_000_000;

function standardResult(
  five: number,
  seven: number,
  opts: {
    fiveReset?: number | null;
    sevenReset?: number | null;
    fivePresent?: boolean;
    sevenPresent?: boolean;
    unifiedStatus?: string | null;
  } = {},
): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: five,
      sevenDayUtilizationPct: seven,
      fiveHourResetAt: opts.fiveReset != null ? new Date(opts.fiveReset) : null,
      sevenDayResetAt: opts.sevenReset != null ? new Date(opts.sevenReset) : null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      fiveHourUtilPresent: opts.fivePresent,
      sevenDayUtilPresent: opts.sevenPresent,
      unifiedStatus: opts.unifiedStatus ?? null,
    },
  };
}

function premiumResult(
  opts: {
    oiUtil?: number | null;
    oiStatus?: string | null;
    unifiedStatus?: string | null;
    oiReset?: number | null;
    signalPresent?: boolean;
  },
): QuotaResult {
  const hasSignal = opts.signalPresent ?? true;
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 0,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      unifiedStatus: hasSignal ? opts.unifiedStatus ?? null : null,
      sevenDayOiStatus: hasSignal ? opts.oiStatus ?? null : null,
      sevenDayOiUtilizationPct: hasSignal ? opts.oiUtil ?? null : null,
      sevenDayOiResetAt: opts.oiReset != null ? new Date(opts.oiReset) : null,
      sevenDayOiPresent: hasSignal,
    },
  };
}

describe("standardSampleFromResult", () => {
  it("binds to the HIGHER-utilized window and carries its reset", () => {
    const r = standardResult(20, 60, { fiveReset: NOW + 3600_000, sevenReset: NOW + 7 * 86400_000 });
    const s = standardSampleFromResult(r, NOW);
    expect(s).not.toBeNull();
    expect(s!.utilizationPct).toBe(60); // 7d binds
    expect(s!.resetAt).toBe(NOW + 7 * 86400_000);
    expect(s!.walled).toBe(false);
  });

  it("flags a wall when the binding window is at/above the standard wall", () => {
    const s = standardSampleFromResult(standardResult(99.9, 10), NOW);
    expect(s!.utilizationPct).toBe(99.9);
    expect(s!.walled).toBe(true);
    expect(STANDARD_WALL_PCT).toBe(99.5);
  });

  it("returns null for a thin probe (both windows explicitly absent)", () => {
    const s = standardSampleFromResult(
      standardResult(0, 0, { fivePresent: false, sevenPresent: false }),
      NOW,
    );
    expect(s).toBeNull();
  });

  it("uses only the PRESENT window when one is absent", () => {
    const s = standardSampleFromResult(
      standardResult(0, 70, { fivePresent: false, sevenPresent: true, sevenReset: NOW + 100 }),
      NOW,
    );
    expect(s!.utilizationPct).toBe(70);
    expect(s!.resetAt).toBe(NOW + 100);
  });

  it("returns null for a failed probe (never fabricates a sample)", () => {
    expect(standardSampleFromResult({ ok: false, reason: "boom" }, NOW)).toBeNull();
  });
});

describe("premiumSampleFromResult", () => {
  it("records a rejected 7d_oi wall with util + reset", () => {
    const s = premiumSampleFromResult(
      premiumResult({ oiUtil: 100, oiStatus: "rejected", unifiedStatus: "rejected", oiReset: NOW + 9999 }),
      NOW,
    );
    expect(s!.utilizationPct).toBe(100);
    expect(s!.status).toBe("rejected");
    expect(s!.walled).toBe(true);
    expect(s!.resetAt).toBe(NOW + 9999);
  });

  it("records an allowed tier as not walled", () => {
    const s = premiumSampleFromResult(premiumResult({ oiUtil: 40, oiStatus: "allowed", unifiedStatus: "allowed" }), NOW);
    expect(s!.utilizationPct).toBe(40);
    expect(s!.walled).toBe(false);
  });

  it("walls on util >= wall even without a rejected status", () => {
    const s = premiumSampleFromResult(premiumResult({ oiUtil: 99.6, oiStatus: "allowed" }), NOW);
    expect(s!.walled).toBe(true);
  });

  it("falls back to the unified status when the per-bucket status is absent", () => {
    const s = premiumSampleFromResult(premiumResult({ oiUtil: 10, oiStatus: null, unifiedStatus: "allowed" }), NOW);
    expect(s!.status).toBe("allowed");
  });

  it("returns null when the result carries NO tier signal (haiku / rotted canary)", () => {
    const s = premiumSampleFromResult(premiumResult({ signalPresent: false }), NOW);
    expect(s).toBeNull();
  });
});

describe("recordUsageSample + ring", () => {
  it("appends and increments observations; null is a no-op", () => {
    const ledger: UsageLedger = {};
    recordUsageSample(ledger, "acct", "premium", premiumSampleFromResult(premiumResult({ oiUtil: 30, oiStatus: "allowed" }), NOW));
    recordUsageSample(ledger, "acct", "premium", null); // no-op
    const tl = ledger["acct"]!.premium!;
    expect(tl.samples.length).toBe(1);
    expect(tl.observations).toBe(1);
    expect(tl.firstObservedAt).toBe(NOW);
    expect(tl.lastObservedAt).toBe(NOW);
  });

  it("trims to the ring cap but keeps observations monotonic", () => {
    const ledger: UsageLedger = {};
    for (let i = 0; i < 10; i++) {
      const s = premiumSampleFromResult(premiumResult({ oiUtil: i, oiStatus: "allowed" }), NOW + i);
      recordUsageSample(ledger, "acct", "premium", s, 3);
    }
    const tl = ledger["acct"]!.premium!;
    expect(tl.samples.length).toBe(3); // trimmed to cap
    expect(tl.observations).toBe(10); // but the honest count survives trimming
    // The retained samples are the NEWEST three (util 7,8,9).
    expect(tl.samples.map((x) => x.utilizationPct)).toEqual([7, 8, 9]);
  });

  it("resolveUsageRingCap falls back to the default on garbage", () => {
    expect(resolveUsageRingCap(undefined)).toBe(USAGE_RING_CAP_DEFAULT);
    expect(resolveUsageRingCap("")).toBe(USAGE_RING_CAP_DEFAULT);
    expect(resolveUsageRingCap("0")).toBe(USAGE_RING_CAP_DEFAULT);
    expect(resolveUsageRingCap("nope")).toBe(USAGE_RING_CAP_DEFAULT);
    expect(resolveUsageRingCap("50")).toBe(50);
  });
});

describe("summarizeAccountUsage — refill-aware", () => {
  it("computes headroom from the latest sample", () => {
    const ledger: UsageLedger = {};
    recordUsageSample(ledger, "a", "premium", premiumSampleFromResult(premiumResult({ oiUtil: 30, oiStatus: "allowed", oiReset: NOW + 86400_000 }), NOW));
    const sum = summarizeAccountUsage(ledger, "a", NOW);
    expect(sum.premium!.currentUtilizationPct).toBe(30);
    expect(sum.premium!.headroomPct).toBe(70);
    expect(sum.premium!.refilled).toBe(false);
    expect(sum.premium!.walled).toBe(false);
  });

  it("treats a passed reset as REFILLED — 0% used / 100% headroom, no probe", () => {
    const ledger: UsageLedger = {};
    // Latest sample was walled with a reset in the past relative to `now`.
    recordUsageSample(ledger, "a", "premium", premiumSampleFromResult(premiumResult({ oiUtil: 100, oiStatus: "rejected", oiReset: NOW - 1 }), NOW - 10));
    const sum = summarizeAccountUsage(ledger, "a", NOW);
    expect(sum.premium!.refilled).toBe(true);
    expect(sum.premium!.currentUtilizationPct).toBe(0);
    expect(sum.premium!.headroomPct).toBe(100);
    expect(sum.premium!.walled).toBe(false); // refill overrides the stale wall
  });

  it("reports the peak across the retained ring", () => {
    const ledger: UsageLedger = {};
    for (const u of [20, 80, 55]) {
      recordUsageSample(ledger, "a", "premium", premiumSampleFromResult(premiumResult({ oiUtil: u, oiStatus: "allowed" }), NOW));
    }
    const sum = summarizeAccountUsage(ledger, "a", NOW);
    expect(sum.premium!.peakUtilizationPct).toBe(80);
    expect(sum.premium!.observations).toBe(3);
  });

  it("returns null tiers for an unknown account", () => {
    const sum = summarizeAccountUsage({}, "ghost", NOW);
    expect(sum.premium).toBeNull();
    expect(sum.standard).toBeNull();
  });
});

describe("premiumHeadroomPct + bestPremiumHeadroomAccount", () => {
  function seed(ledger: UsageLedger, acct: string, oiUtil: number, reset?: number): void {
    recordUsageSample(
      ledger,
      acct,
      "premium",
      premiumSampleFromResult(premiumResult({ oiUtil, oiStatus: "allowed", oiReset: reset ?? null }), NOW),
    );
  }

  it("premiumHeadroomPct is null when unobserved, else 100-util", () => {
    const ledger: UsageLedger = {};
    seed(ledger, "a", 25);
    expect(premiumHeadroomPct(ledger, "a", NOW)).toBe(75);
    expect(premiumHeadroomPct(ledger, "b", NOW)).toBeNull();
  });

  it("picks the candidate with the MOST premium headroom", () => {
    const ledger: UsageLedger = {};
    seed(ledger, "a", 90); // 10 headroom
    seed(ledger, "b", 20); // 80 headroom
    seed(ledger, "c", 55); // 45 headroom
    expect(bestPremiumHeadroomAccount(ledger, ["a", "b", "c"], NOW)).toBe("b");
  });

  it("returns null when NO candidate has premium data (caller keeps its order)", () => {
    expect(bestPremiumHeadroomAccount({}, ["a", "b"], NOW)).toBeNull();
  });

  it("is order-stable on ties — first candidate wins", () => {
    const ledger: UsageLedger = {};
    seed(ledger, "a", 40);
    seed(ledger, "b", 40);
    expect(bestPremiumHeadroomAccount(ledger, ["a", "b"], NOW)).toBe("a");
    expect(bestPremiumHeadroomAccount(ledger, ["b", "a"], NOW)).toBe("b");
  });

  it("prefers a known-headroom candidate over an unobserved one", () => {
    const ledger: UsageLedger = {};
    seed(ledger, "b", 10);
    // a is unobserved (headroom null → skipped); b is the only known one.
    expect(bestPremiumHeadroomAccount(ledger, ["a", "b"], NOW)).toBe("b");
  });

  it("counts a refilled candidate as full (100) headroom", () => {
    const ledger: UsageLedger = {};
    seed(ledger, "a", 30); // 70 headroom
    seed(ledger, "b", 100, NOW - 1); // walled but reset passed → refilled → 100
    expect(bestPremiumHeadroomAccount(ledger, ["a", "b"], NOW)).toBe("b");
  });
});
