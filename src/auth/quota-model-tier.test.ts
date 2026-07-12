/**
 * #3176 — `parseQuotaHeaders` must capture the model-tier (`7d_oi` /
 * `seven_day_overage_included`) bucket signals, using the EXACT header shapes
 * observed on 2026-07-12 (direct probe of a single account, same moment):
 *
 *   model=claude-fable-5  -> 429, unified-status=rejected, 7d_oi-status=rejected,
 *                            7d_oi-utilization=1.0,
 *                            representative-claim=seven_day_overage_included,
 *                            retry-after=10195, unified-reset=1783850400
 *   model=claude-opus-4-8 -> 200, unified-status=allowed, 5h util 0.01, 7d 0.58
 *   model=claude-haiku-4-5 -> 200 (healthy; carries no 7d_oi rejection)
 *
 * These tests FAIL on pristine main: `parseQuotaHeaders` there parses only the
 * 5h/7d/representative-claim/overage headers and returns `ok:false` on a
 * response that carries ONLY the 7d_oi tier headers (the fable 429).
 */

import { describe, expect, it } from "vitest";
import { parseQuotaHeaders } from "./quota.js";

/** The exact fable-5 429 header set from the 2026-07-12 evidence. */
function fableWalled429(): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    "anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
    "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
    "retry-after": "10195",
    "anthropic-ratelimit-unified-reset": "1783850400",
  });
}

/** The exact opus-4-8 200 header set (healthy) from the same moment. */
function opusOk200(): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.01",
    "anthropic-ratelimit-unified-7d-utilization": "0.58",
    "anthropic-ratelimit-unified-7d_oi-status": "allowed",
  });
}

describe("#3176 parseQuotaHeaders — model-tier (7d_oi) bucket", () => {
  it("parses a fable-5 429 that carries ONLY the tier headers (ok, not rejected as headerless)", () => {
    const now = new Date("2026-07-12T06:34:45Z");
    const res = parseQuotaHeaders(fableWalled429(), now);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unifiedStatus).toBe("rejected");
    expect(res.data.sevenDayOiStatus).toBe("rejected");
    expect(res.data.sevenDayOiUtilizationPct).toBe(100);
    expect(res.data.representativeClaim).toBe("seven_day_overage_included");
    expect(res.data.sevenDayOiPresent).toBe(true);
  });

  it("resolves the tier reset from unified-reset (preferred over retry-after here)", () => {
    const now = new Date("2026-07-12T06:34:45Z");
    const res = parseQuotaHeaders(fableWalled429(), now);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // unified-reset=1783850400 (epoch seconds) wins over retry-after.
    expect(res.data.sevenDayOiResetAt?.getTime()).toBe(1783850400 * 1000);
  });

  it("falls back to retry-after when no reset epoch header is present", () => {
    const now = new Date("2026-07-12T06:34:45Z");
    const h = new Headers({
      "anthropic-ratelimit-unified-7d_oi-status": "rejected",
      "anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
      "retry-after": "10195",
    });
    const res = parseQuotaHeaders(h, now);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sevenDayOiResetAt?.getTime()).toBe(now.getTime() + 10195 * 1000);
  });

  it("an opus-4-8 200 reads tier allowed, 5h/7d healthy", () => {
    const res = parseQuotaHeaders(opusOk200());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unifiedStatus).toBe("allowed");
    expect(res.data.sevenDayOiStatus).toBe("allowed");
    expect(res.data.fiveHourUtilizationPct).toBeCloseTo(1);
    expect(res.data.sevenDayUtilizationPct).toBeCloseTo(58);
  });

  it("a headerless response (no unified headers at all) still returns ok:false", () => {
    const res = parseQuotaHeaders(new Headers({ "content-type": "application/json" }));
    expect(res.ok).toBe(false);
  });

  it("a plain haiku 5h/7d probe leaves the tier fields null/absent (no false wall)", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.01",
      "anthropic-ratelimit-unified-7d-utilization": "0.58",
    });
    const res = parseQuotaHeaders(h);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sevenDayOiStatus).toBeNull();
    expect(res.data.sevenDayOiUtilizationPct).toBeNull();
    expect(res.data.sevenDayOiPresent).toBe(false);
  });
});
