/**
 * #3176 — the pure model-tier (`7d_oi` / `seven_day_overage_included`) wall
 * decision layer. Uses the exact 2026-07-12 evidence shapes.
 *
 * FAILS on pristine main: this module does not exist there, and nothing
 * classifies a 7d_oi rejection as a tier wall.
 */

import { describe, expect, it } from "vitest";
import type { QuotaResult } from "../quota.js";
import {
  quotaIndicatesModelTierWall,
  quotaTierAllowed,
  isModelTierWalled,
  MODEL_TIER_WALL_PCT,
} from "./model-tier-quota.js";

/** The fable-5 429 probe result (walled on the flagship tier). */
function fableWalled(resetMs: number | null = 1783850400 * 1000): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 0,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: "seven_day_overage_included",
      overageStatus: null,
      overageDisabledReason: null,
      unifiedStatus: "rejected",
      sevenDayOiStatus: "rejected",
      sevenDayOiUtilizationPct: 100,
      sevenDayOiResetAt: resetMs != null ? new Date(resetMs) : null,
      sevenDayOiPresent: true,
    },
  };
}

/** The opus-4-8 200 probe result (flagship tier allowed). */
function opusHealthy(): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: 1,
      sevenDayUtilizationPct: 58,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      unifiedStatus: "allowed",
      sevenDayOiStatus: "allowed",
      sevenDayOiUtilizationPct: 58,
      sevenDayOiResetAt: null,
      sevenDayOiPresent: true,
    },
  };
}

/** A plain haiku 5h/7d probe — no tier headers at all. */
function haikuHealthy(): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: 1,
      sevenDayUtilizationPct: 58,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
    },
  };
}

describe("#3176 quotaIndicatesModelTierWall", () => {
  it("classifies a fable-5 429 (7d_oi rejected) as walled, with the tier reset", () => {
    const d = quotaIndicatesModelTierWall(fableWalled());
    expect(d.walled).toBe(true);
    expect(d.bucket).toBe("seven_day_overage_included");
    expect(d.until).toBe(1783850400 * 1000);
  });

  it("classifies rejection-by-representative-claim even without an explicit 7d_oi-status", () => {
    const res: QuotaResult = {
      ok: true,
      data: {
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 0,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: "seven_day_overage_included",
        overageStatus: null,
        overageDisabledReason: null,
        unifiedStatus: "rejected",
        sevenDayOiResetAt: null,
      },
    };
    expect(quotaIndicatesModelTierWall(res).walled).toBe(true);
  });

  it("classifies a >=wall 7d_oi utilization as walled even if status is absent", () => {
    const res: QuotaResult = {
      ok: true,
      data: {
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 0,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: null,
        overageStatus: null,
        overageDisabledReason: null,
        sevenDayOiUtilizationPct: MODEL_TIER_WALL_PCT,
        sevenDayOiResetAt: null,
      },
    };
    expect(quotaIndicatesModelTierWall(res).walled).toBe(true);
  });

  it("an opus 200 (tier allowed) is NOT a wall", () => {
    expect(quotaIndicatesModelTierWall(opusHealthy()).walled).toBe(false);
  });

  it("a haiku probe with no tier headers is NOT a wall (absence != rejection)", () => {
    expect(quotaIndicatesModelTierWall(haikuHealthy()).walled).toBe(false);
  });

  it("a FAILED probe is never a wall (transient error must not bench a tier)", () => {
    expect(quotaIndicatesModelTierWall({ ok: false, reason: "network" }).walled).toBe(false);
  });

  it("a transient rejection bound on a NON-7d_oi claim is NOT a tier wall (false-wall guard)", () => {
    // A 429 whose overall verdict is `rejected` but whose binding claim is a
    // burst/5h throttle — NOT `seven_day_overage_included` — with NO 7d_oi
    // bucket verdict must never mark the flagship tier walled: the account is
    // momentarily throttled, not on a weekly tier wall, and benching it for
    // hours would be a false wall. Only a loosened classifier (e.g. "any
    // rejected") would trip here — this locks the boundary.
    const res: QuotaResult = {
      ok: true,
      data: {
        fiveHourUtilizationPct: 100,
        sevenDayUtilizationPct: 60,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: "five_hour",
        overageStatus: null,
        overageDisabledReason: null,
        unifiedStatus: "rejected",
        sevenDayOiStatus: null,
        sevenDayOiUtilizationPct: null,
        sevenDayOiResetAt: null,
        sevenDayOiPresent: false,
      },
    };
    expect(quotaIndicatesModelTierWall(res).walled).toBe(false);
    // …and such a probe is not a clear "tier allowed" signal for self-heal
    // either — the overall verdict is rejected and the 7d_oi bucket gave no
    // verdict, so a real mark is left untouched (inconclusive, not cleared).
    expect(quotaTierAllowed(res)).toBe(false);
  });
});

describe("#3176 quotaTierAllowed", () => {
  it("true for an opus 200 (positive allowed signal → clears a stale mark)", () => {
    expect(quotaTierAllowed(opusHealthy())).toBe(true);
  });
  it("false for a fable 429 (rejected)", () => {
    expect(quotaTierAllowed(fableWalled())).toBe(false);
  });
  it("false for a haiku probe with no tier verdict (inconclusive, not a clear signal)", () => {
    expect(quotaTierAllowed(haikuHealthy())).toBe(false);
  });
  it("false for a failed probe", () => {
    expect(quotaTierAllowed({ ok: false, reason: "boom" })).toBe(false);
  });
});

describe("#3176 isModelTierWalled", () => {
  const now = 1_000_000;
  it("an unexpired mark walls the account", () => {
    expect(
      isModelTierWalled({ mark: { premium_walled_until: now + 1000 }, now }),
    ).toBe(true);
  });
  it("an expired mark does not", () => {
    expect(
      isModelTierWalled({ mark: { premium_walled_until: now - 1000 }, now }),
    ).toBe(false);
  });
  it("a fresh tier-allowed canary overrides an unexpired mark", () => {
    expect(
      isModelTierWalled({
        mark: { premium_walled_until: now + 1000 },
        now,
        snapshotTierAllowed: true,
      }),
    ).toBe(false);
  });
  it("no mark → not walled", () => {
    expect(isModelTierWalled({ now })).toBe(false);
  });
});
