/**
 * Tests for the deterministic cron tier selector (the cheap-crons JTBD
 * value-gate). The decision space is small and fully enumerated here —
 * the operator's bar is "prove determinism by enumeration, not sampling".
 */

import { describe, it, expect } from "vitest";
import {
  recommendCronTier,
  resolveFrequentGapMin,
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

describe("applyDefaultTier — cheap-by-default for hint-less frequent crons", () => {
  it("a frequent hint-less cron gets context: fresh (→ cheap Tier-1)", () => {
    expect(applyDefaultTier(tierable({ cron: "*/30 * * * *" })).context).toBe("fresh");
    expect(applyDefaultTier(tierable({ cron: "0 * * * *" })).context).toBe("fresh"); // hourly
  });

  it("an infrequent hint-less cron is left untouched (stays full-session default)", () => {
    // The regression that matters: a daily briefing must NOT be downgraded.
    expect(applyDefaultTier(tierable({ cron: "0 8 * * *" })).context).toBeUndefined();
    expect(applyDefaultTier(tierable({ cron: "0 18 * * 0" })).context).toBeUndefined(); // weekly
  });

  it("explicit hints are never overridden", () => {
    // context: agent on a frequent cron — operator said full session, we obey.
    expect(applyDefaultTier(tierable({ cron: "*/5 * * * *", context: "agent" })).context).toBe("agent");
    // explicit model on a frequent cron — untouched (no context injected).
    expect(applyDefaultTier(tierable({ cron: "*/5 * * * *", model: "opus" })).context).toBeUndefined();
    // a poll is explicit — untouched.
    const poll = applyDefaultTier(tierable({ cron: "*/5 * * * *", kind: "poll" }));
    expect(poll.context).toBeUndefined();
    expect(poll.kind).toBe("poll");
  });

  it("an unreadable cadence is treated as infrequent (conservative — never wrongly cheap)", () => {
    expect(applyDefaultTier(tierable({ cron: "0-10 * * * *" })).context).toBeUndefined();
    expect(applyDefaultTier(tierable({ cron: "garbage" })).context).toBeUndefined();
  });

  it("preserves all other fields", () => {
    const out = applyDefaultTier(tierable({ cron: "*/30 * * * *", kind: "prompt" }));
    expect(out.cron).toBe("*/30 * * * *");
    expect(out.kind).toBe("prompt");
    expect(out.context).toBe("fresh");
  });
});
