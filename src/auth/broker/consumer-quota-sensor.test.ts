/**
 * Tests for the pure consumer-quota-sensor decision layer. The loop + I/O
 * (probe → mark) live in server.ts and are covered there via the
 * _testFetchQuota seam; here we pin the exhaustion decision itself.
 */
import { describe, it, expect } from "vitest";
import {
  quotaIndicatesExhaustion,
  resolveConsumerProbeIntervalMs,
  EXHAUSTION_PCT,
  DEFAULT_CONSUMER_PROBE_INTERVAL_MS,
} from "./consumer-quota-sensor.js";
import type { QuotaResult } from "../quota.js";

function ok(part: Partial<{
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
}>): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: part.fiveHourUtilizationPct ?? 0,
      sevenDayUtilizationPct: part.sevenDayUtilizationPct ?? 0,
      fiveHourResetAt: part.fiveHourResetAt ?? null,
      sevenDayResetAt: part.sevenDayResetAt ?? null,
      representativeClaim: null,
      overageStatus: part.overageStatus ?? null,
      overageDisabledReason: part.overageDisabledReason ?? null,
    },
  };
}

describe("quotaIndicatesExhaustion", () => {
  it("not exhausted when both windows are below the wall", () => {
    expect(quotaIndicatesExhaustion(ok({ fiveHourUtilizationPct: 80, sevenDayUtilizationPct: 50 })))
      .toEqual({ exhausted: false, until: null });
  });

  it("exhausted when the 5h window is at/above the wall; until = its reset", () => {
    const reset = new Date("2026-06-07T05:00:00Z");
    const d = quotaIndicatesExhaustion(ok({ fiveHourUtilizationPct: 100, fiveHourResetAt: reset }));
    expect(d.exhausted).toBe(true);
    expect(d.until).toBe(reset.getTime());
  });

  it("exhausted when the 7d window is walled even if 5h is fine", () => {
    const reset = new Date("2026-06-10T00:00:00Z");
    const d = quotaIndicatesExhaustion(ok({
      fiveHourUtilizationPct: 10,
      sevenDayUtilizationPct: EXHAUSTION_PCT,
      sevenDayResetAt: reset,
    }));
    expect(d.exhausted).toBe(true);
    expect(d.until).toBe(reset.getTime());
  });

  it("when both windows are walled, until = the LATER reset", () => {
    const five = new Date("2026-06-07T05:00:00Z");
    const seven = new Date("2026-06-10T00:00:00Z");
    const d = quotaIndicatesExhaustion(ok({
      fiveHourUtilizationPct: 100, fiveHourResetAt: five,
      sevenDayUtilizationPct: 100, sevenDayResetAt: seven,
    }));
    expect(d.until).toBe(seven.getTime());
  });

  it("exhausted with until=null when the probe carried no reset", () => {
    expect(quotaIndicatesExhaustion(ok({ fiveHourUtilizationPct: 100 })))
      .toEqual({ exhausted: true, until: null });
  });

  it("a FAILED probe is NEVER exhaustion (no fail-over on transient errors)", () => {
    const failed: QuotaResult = { ok: false, reason: "HTTP 503" };
    expect(quotaIndicatesExhaustion(failed)).toEqual({ exhausted: false, until: null });
  });

  it("out_of_credits at 0% util ⇒ NOT exhausted (informational only — serves fine from quota)", () => {
    // THE KEY CHANGE: out_of_credits is informational. A consumer pinned to a
    // 0%-util out_of_credits account serves fine from quota. Exhaustion is only
    // via a real util wall (≥99.5%), not via the credits flag.
    // Failover safety is preserved via mark-exhausted on a real 429.
    expect(
      quotaIndicatesExhaustion(ok({
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 0,
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
      })),
    ).toEqual({ exhausted: false, until: null });
  });

  it("org_level_disabled at 75% util ⇒ NOT exhausted (benign — live active account)", () => {
    // overageStatus:"rejected" + the benign reason must NOT trip exhaustion.
    expect(
      quotaIndicatesExhaustion(ok({
        fiveHourUtilizationPct: 75,
        sevenDayUtilizationPct: 40,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
      })),
    ).toEqual({ exhausted: false, until: null });
  });
});

describe("quotaIndicatesExhaustion — allow_overage matrix", () => {
  it("flagged + util 100% + overageStatus allowed + reason null → NOT exhausted (pixsoul case)", () => {
    // Consumer pinned to pixsoul (7d=100%, overageStatus:'allowed', no reason).
    // With allowOverage=true, the util wall must NOT mark exhausted.
    expect(
      quotaIndicatesExhaustion(ok({
        sevenDayUtilizationPct: 100,
        overageStatus: "allowed",
        overageDisabledReason: null,
      }), true),
    ).toEqual({ exhausted: false, until: null });
  });

  it("flagged + util 100% + overageStatus allowed + reason out_of_credits → EXHAUSTED (credit gone — stop spending)", () => {
    // Credit is exhausted — must mark exhausted even when flagged.
    const reset = new Date("2026-07-03T00:00:00Z");
    const result = quotaIndicatesExhaustion(ok({
      sevenDayUtilizationPct: 100,
      sevenDayResetAt: reset,
      overageStatus: "allowed",
      overageDisabledReason: "out_of_credits",
    }), true);
    expect(result.exhausted).toBe(true);
    expect(result.until).toBe(reset.getTime());
  });

  it("flagged + util 100% + overageStatus rejected → EXHAUSTED (Anthropic rejects overage)", () => {
    expect(
      quotaIndicatesExhaustion(ok({
        sevenDayUtilizationPct: 100,
        overageStatus: "rejected",
        overageDisabledReason: null,
      }), true),
    ).toMatchObject({ exhausted: true });
  });

  it("NOT flagged + util 100% + overageStatus allowed → EXHAUSTED (opt-in; default behavior unchanged)", () => {
    // allowOverage=false (the default) — util wall applies as before.
    expect(
      quotaIndicatesExhaustion(ok({
        sevenDayUtilizationPct: 100,
        overageStatus: "allowed",
        overageDisabledReason: null,
      }), false),
    ).toMatchObject({ exhausted: true });
  });

  it("flagged + util 50% → NOT exhausted (normal, no overage needed)", () => {
    expect(
      quotaIndicatesExhaustion(ok({ sevenDayUtilizationPct: 50 }), true),
    ).toEqual({ exhausted: false, until: null });
  });
});

describe("resolveConsumerProbeIntervalMs", () => {
  it("defaults when unset", () => {
    expect(resolveConsumerProbeIntervalMs({})).toBe(DEFAULT_CONSUMER_PROBE_INTERVAL_MS);
  });
  it("kill-switch disables (returns 0)", () => {
    expect(resolveConsumerProbeIntervalMs({ SWITCHROOM_DISABLE_CONSUMER_QUOTA_PROBE: "1" })).toBe(0);
  });
  it("honors an explicit override", () => {
    expect(resolveConsumerProbeIntervalMs({ SWITCHROOM_CONSUMER_QUOTA_PROBE_MS: "60000" })).toBe(60000);
  });
  it("explicit 0 disables", () => {
    expect(resolveConsumerProbeIntervalMs({ SWITCHROOM_CONSUMER_QUOTA_PROBE_MS: "0" })).toBe(0);
  });
  it("ignores a garbage override (falls back to default)", () => {
    expect(resolveConsumerProbeIntervalMs({ SWITCHROOM_CONSUMER_QUOTA_PROBE_MS: "abc" }))
      .toBe(DEFAULT_CONSUMER_PROBE_INTERVAL_MS);
  });
});
