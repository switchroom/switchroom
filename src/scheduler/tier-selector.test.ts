/**
 * Tests for the deterministic cron tier selector (the cheap-crons JTBD
 * value-gate). The decision space is small and fully enumerated here —
 * the operator's bar is "prove determinism by enumeration, not sampling".
 */

import { describe, it, expect } from "vitest";
import {
  recommendCronTier,
  resolveFrequentGapMin,
  resolveCronAutoTier,
  applyDefaultTier,
  DEFAULT_FREQUENT_GAP_MIN,
  type TierRecommendation,
  type TierableEntry,
} from "./tier-selector.js";

/** Type the literal as TierableEntry so `.context` is visible after augmentation. */
const tierable = (e: TierableEntry): TierableEntry => e;

describe("recommendCronTier — explicit hints win (override the cadence default)", () => {
  it("kind: poll → Tier 0, regardless of cadence", () => {
    for (const gap of [1, 60, 1440]) {
      const r = recommendCronTier({ smallestGapMin: gap, kind: "poll" });
      expect(r.tier).toBe("poll");
      expect(r.source).toBe("explicit");
    }
  });

  it("context: fresh → cheap; context: agent → main (even when cadence would say otherwise)", () => {
    // context: agent on a frequent cron — explicit beats the frequent→cheap default.
    expect(recommendCronTier({ smallestGapMin: 5, context: "agent" }).tier).toBe("main");
    // context: fresh on a daily cron — explicit beats the infrequent→main default.
    expect(recommendCronTier({ smallestGapMin: 1440, context: "fresh" }).tier).toBe("cheap");
  });

  it("a known-cheap model → cheap; opus/custom → main", () => {
    expect(recommendCronTier({ smallestGapMin: 1440, model: "sonnet" }).tier).toBe("cheap");
    expect(recommendCronTier({ smallestGapMin: 1440, model: "claude-haiku-4-5" }).tier).toBe("cheap");
    expect(recommendCronTier({ smallestGapMin: 5, model: "opus" }).tier).toBe("main");
    expect(recommendCronTier({ smallestGapMin: 5, model: "claude-opus-4-8" }).tier).toBe("main");
    // a custom/unknown id is conservatively the full session, not cheap.
    expect(recommendCronTier({ smallestGapMin: 5, model: "my-custom-id" }).tier).toBe("main");
  });

  it("every explicit-hint path is sourced 'explicit'", () => {
    const explicit: TierRecommendation[] = [
      recommendCronTier({ smallestGapMin: 5, kind: "poll" }),
      recommendCronTier({ smallestGapMin: 5, context: "fresh" }),
      recommendCronTier({ smallestGapMin: 5, context: "agent" }),
      recommendCronTier({ smallestGapMin: 5, model: "sonnet" }),
      recommendCronTier({ smallestGapMin: 5, model: "opus" }),
    ];
    for (const r of explicit) expect(r.source).toBe("explicit");
  });
});

describe("recommendCronTier — cadence default (no explicit hint)", () => {
  it("frequent (≤ threshold) defaults to cheap", () => {
    for (const gap of [1, 5, 15, 30, 59, 60]) {
      const r = recommendCronTier({ smallestGapMin: gap });
      expect(r.tier).toBe("cheap");
      expect(r.source).toBe("cadence-default");
    }
  });

  it("infrequent (> threshold) defaults to the agent session", () => {
    for (const gap of [61, 120, 1440, 10080]) {
      const r = recommendCronTier({ smallestGapMin: gap });
      expect(r.tier).toBe("main");
      expect(r.source).toBe("cadence-default");
    }
  });

  it("the boundary is inclusive at the threshold (60 → cheap, 61 → main)", () => {
    expect(recommendCronTier({ smallestGapMin: 60 }).tier).toBe("cheap");
    expect(recommendCronTier({ smallestGapMin: 61 }).tier).toBe("main");
  });

  it("respects an overridden threshold", () => {
    // With a 10-min threshold, a 15-min cron is now 'infrequent' → main.
    expect(recommendCronTier({ smallestGapMin: 15 }, 10).tier).toBe("main");
    expect(recommendCronTier({ smallestGapMin: 10 }, 10).tier).toBe("cheap");
  });

  it("is deterministic — identical input yields identical output", () => {
    const a = recommendCronTier({ smallestGapMin: 30 });
    const b = recommendCronTier({ smallestGapMin: 30 });
    expect(a).toEqual(b);
  });

  it("always produces a reason string", () => {
    for (const gap of [5, 60, 61, 1440]) {
      expect(recommendCronTier({ smallestGapMin: gap }).reason.length).toBeGreaterThan(0);
    }
  });

  it("explicit kind: 'prompt' (no model/context) falls through to the cadence default", () => {
    // 'prompt' is the no-op kind — it must NOT short-circuit; cadence decides.
    const frequent = recommendCronTier({ smallestGapMin: 5, kind: "prompt" });
    expect(frequent.tier).toBe("cheap");
    expect(frequent.source).toBe("cadence-default");
    const daily = recommendCronTier({ smallestGapMin: 1440, kind: "prompt" });
    expect(daily.tier).toBe("main");
    expect(daily.source).toBe("cadence-default");
  });

  it("degenerate gaps don't crash and resolve deterministically", () => {
    // smallestGapMin comes from extractCronSmallestGapMin (positive ints) upstream,
    // but the selector must still be total: 0/negative ≤ threshold → cheap;
    // NaN/Infinity fail the ≤ comparison → main. Never throws.
    expect(recommendCronTier({ smallestGapMin: 0 }).tier).toBe("cheap");
    expect(recommendCronTier({ smallestGapMin: -5 }).tier).toBe("cheap");
    expect(recommendCronTier({ smallestGapMin: Number.NaN }).tier).toBe("main");
    expect(recommendCronTier({ smallestGapMin: Number.POSITIVE_INFINITY }).tier).toBe("main");
  });
});

describe("resolveFrequentGapMin", () => {
  it("defaults to 60 and floors invalid/non-positive overrides", () => {
    expect(resolveFrequentGapMin({})).toBe(DEFAULT_FREQUENT_GAP_MIN);
    expect(resolveFrequentGapMin({ SWITCHROOM_CRON_FREQUENT_GAP_MIN: "30" })).toBe(30);
    expect(resolveFrequentGapMin({ SWITCHROOM_CRON_FREQUENT_GAP_MIN: "0" })).toBe(60);
    expect(resolveFrequentGapMin({ SWITCHROOM_CRON_FREQUENT_GAP_MIN: "-5" })).toBe(60);
    expect(resolveFrequentGapMin({ SWITCHROOM_CRON_FREQUENT_GAP_MIN: "nope" })).toBe(60);
  });
});

describe("applyDefaultTier — kill-switch tripped (autoTierEnabled=false): pass-through", () => {
  // v0.15.17: the cadence auto-router is DEFAULT-ON. The kill-switch
  // (SWITCHROOM_CRON_AUTO_TIER=0/off → autoTierEnabled false) reverts to the
  // #2305 pass-through, every frequent cron stays a full Tier-2 turn.
  const off = (e: TierableEntry) => applyDefaultTier(e, DEFAULT_FREQUENT_GAP_MIN, false);

  it("a frequent hint-less cron is NOT auto-routed to cheap (kill-switch on)", () => {
    expect(off(tierable({ cron: "*/30 * * * *" })).context).toBeUndefined();
    expect(off(tierable({ cron: "0 * * * *" })).context).toBeUndefined(); // hourly
    expect(off(tierable({ cron: "*/5 * * * *" })).context).toBeUndefined();
  });

  it("is a pure pass-through — nothing injected", () => {
    const out = off(tierable({ cron: "*/30 * * * *", kind: "prompt" }));
    expect(out).toEqual({ cron: "*/30 * * * *", kind: "prompt" });
  });

  it("recommendCronTier still surfaces the advisory (recommender intact)", () => {
    expect(recommendCronTier({ smallestGapMin: 30 }).tier).toBe("cheap");
  });
});

describe("applyDefaultTier — flag ON: cadence re-enabled (#2307 PR4)", () => {
  // The cron session is capability-complete (PRs 1–3), so cadence is a sound
  // automatic signal again. autoTierEnabled passed true explicitly (the canary
  // sets SWITCHROOM_CRON_AUTO_TIER=1).
  const on = (e: TierableEntry) => applyDefaultTier(e, DEFAULT_FREQUENT_GAP_MIN, true);

  it("a frequent hint-less cron gets context:fresh injected (→ cheap Tier-1)", () => {
    expect(on(tierable({ cron: "*/30 * * * *" })).context).toBe("fresh");
    expect(on(tierable({ cron: "0 * * * *" })).context).toBe("fresh"); // hourly == 60min == frequent
    expect(on(tierable({ cron: "*/5 * * * *" })).context).toBe("fresh");
  });

  it("daily / weekly stay on the main session (infrequent → no injection)", () => {
    expect(on(tierable({ cron: "0 8 * * *" })).context).toBeUndefined(); // daily
    expect(on(tierable({ cron: "0 9 * * 1" })).context).toBeUndefined(); // weekly
  });

  it("an UNREADABLE cadence stays full (Infinity → main, never a starved guess)", () => {
    expect(on(tierable({ cron: "bogus" })).context).toBeUndefined();
    expect(on(tierable({ cron: "15-30 * * * *" })).context).toBeUndefined(); // minute range → unknown
  });

  it("explicit author hints are honoured untouched (kind / context / model win)", () => {
    expect(on(tierable({ cron: "*/5 * * * *", context: "agent" })).context).toBe("agent");
    expect(on(tierable({ cron: "*/5 * * * *", context: "fresh" })).context).toBe("fresh");
    expect(on(tierable({ cron: "*/5 * * * *", model: "opus" })).context).toBeUndefined(); // explicit model → no inject
    expect(on(tierable({ cron: "*/5 * * * *", kind: "poll" })).context).toBeUndefined();
    expect(on(tierable({ cron: "*/5 * * * *", kind: "action" })).context).toBeUndefined();
  });

  it("respects a custom frequent-gap threshold", () => {
    // gap 30min with a 15min threshold → not frequent → main.
    expect(applyDefaultTier(tierable({ cron: "*/30 * * * *" }), 15, true).context).toBeUndefined();
  });
});

describe("resolveCronAutoTier — DEFAULT-ON kill-switch (only 0/false/off disables)", () => {
  it.each([
    // unset / empty / anything else → ON (the default — it's a kill-switch now)
    ["", true],
    [undefined, true],
    ["1", true],
    ["true", true],
    ["on", true],
    ["anything", true],
    // the kill-switch values
    ["0", false],
    ["false", false],
    ["off", false],
    ["OFF", false],
  ])("SWITCHROOM_CRON_AUTO_TIER=%s → %s", (val, expected) => {
    expect(resolveCronAutoTier({ SWITCHROOM_CRON_AUTO_TIER: val } as NodeJS.ProcessEnv)).toBe(expected);
  });
});
