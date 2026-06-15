import { describe, it, expect } from "vitest";
import { deriveAccountQuotaView, isoToMs, type AccountQuotaUsage } from "./api.js";
import type { AccountState } from "../auth/broker/client.js";

const TTL = 10 * 60 * 1000;
const NOW = 1_781_000_000_000;

function brokerWithLastQuota(over: Partial<AccountState["last_quota"]> = {}): AccountState {
  return {
    label: "acct@example.com",
    exhausted: false,
    last_quota: {
      fiveHourUtilizationPct: 56,
      sevenDayUtilizationPct: 12,
      fiveHourResetAt: "2026-06-15T03:20:00.000Z",
      sevenDayResetAt: "2026-06-21T10:00:00.000Z",
      representativeClaim: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      capturedAt: NOW - 60_000, // 1 min ago → fresh
      ...over,
    },
  };
}

const probeUsage: AccountQuotaUsage = {
  fiveHourPct: 81,
  sevenDayPct: 40,
  fiveHourResetAt: NOW + 3_600_000,
  sevenDayResetAt: NOW + 86_400_000,
  capturedAt: NOW - 30_000,
};

describe("isoToMs", () => {
  it("parses a valid ISO string to unix ms", () => {
    expect(isoToMs("2026-06-15T03:20:00.000Z")).toBe(Date.parse("2026-06-15T03:20:00.000Z"));
  });
  it("returns null for null / undefined / empty", () => {
    expect(isoToMs(null)).toBeNull();
    expect(isoToMs(undefined)).toBeNull();
    expect(isoToMs("")).toBeNull();
  });
  it("returns null for unparseable input", () => {
    expect(isoToMs("not-a-date")).toBeNull();
  });
});

describe("deriveAccountQuotaView", () => {
  it("prefers a fresh in-process probe (source=probe, not stale)", () => {
    const v = deriveAccountQuotaView(brokerWithLastQuota(), { usage: probeUsage, fetchedAt: NOW - 1000 }, NOW);
    expect(v.quotaUsageSource).toBe("probe");
    expect(v.quotaUsage?.fiveHourPct).toBe(81);
    expect(v.quotaStale).toBe(false);
  });

  it("falls back to the broker last_quota snapshot when there is no probe (free, source=broker-cache)", () => {
    const v = deriveAccountQuotaView(brokerWithLastQuota(), undefined, NOW);
    expect(v.quotaUsageSource).toBe("broker-cache");
    expect(v.quotaUsage?.fiveHourPct).toBe(56);
    expect(v.quotaUsage?.sevenDayPct).toBe(12);
    // ISO reset strings are converted to ms.
    expect(v.quotaUsage?.fiveHourResetAt).toBe(Date.parse("2026-06-15T03:20:00.000Z"));
    expect(v.quotaUsage?.sevenDayResetAt).toBe(Date.parse("2026-06-21T10:00:00.000Z"));
    expect(v.quotaStale).toBe(false); // captured 1 min ago
  });

  it("falls back to broker last_quota when the probe cache is STALE (older than TTL)", () => {
    const v = deriveAccountQuotaView(brokerWithLastQuota(), { usage: probeUsage, fetchedAt: NOW - TTL - 1 }, NOW);
    expect(v.quotaUsageSource).toBe("broker-cache");
    expect(v.quotaUsage?.fiveHourPct).toBe(56);
  });

  it("falls back to broker last_quota when the probe entry has null usage (probe failed)", () => {
    const v = deriveAccountQuotaView(brokerWithLastQuota(), { usage: null, fetchedAt: NOW - 1000 }, NOW);
    expect(v.quotaUsageSource).toBe("broker-cache");
    expect(v.quotaUsage?.fiveHourPct).toBe(56);
  });

  it("marks broker-cache as stale when the snapshot is older than the TTL", () => {
    const v = deriveAccountQuotaView(brokerWithLastQuota({ capturedAt: NOW - TTL - 1 }), undefined, NOW);
    expect(v.quotaUsageSource).toBe("broker-cache");
    expect(v.quotaStale).toBe(true);
  });

  it("handles null reset strings gracefully", () => {
    const v = deriveAccountQuotaView(
      brokerWithLastQuota({ fiveHourResetAt: null, sevenDayResetAt: null }),
      undefined,
      NOW,
    );
    expect(v.quotaUsage?.fiveHourResetAt).toBeNull();
    expect(v.quotaUsage?.sevenDayResetAt).toBeNull();
  });

  it("returns null usage when neither a probe nor a broker snapshot exists", () => {
    const v1 = deriveAccountQuotaView(null, undefined, NOW);
    expect(v1.quotaUsage).toBeNull();
    expect(v1.quotaUsageSource).toBeNull();
    expect(v1.quotaStale).toBe(true);

    const brokerNoSnapshot: AccountState = { label: "x", exhausted: false, last_quota: null };
    const v2 = deriveAccountQuotaView(brokerNoSnapshot, undefined, NOW);
    expect(v2.quotaUsage).toBeNull();
    expect(v2.quotaUsageSource).toBeNull();
  });
});
