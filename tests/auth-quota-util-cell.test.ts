/**
 * `switchroom auth list` honesty fix (2026-06-09 incident follow-up):
 * the accounts table previously rendered only the broker exhausted
 * flag, so a 99%-utilized account read "available —". The new
 * QUOTA 5h·7d cell surfaces the broker's cached utilization with its
 * age, and distinguishes "no data" from "not exhausted".
 */
import { describe, it, expect } from "vitest";
import { formatQuotaUtilCell } from "../src/cli/auth.js";

const NOW = 1_780_000_000_000;

function lq(five: number, seven: number, capturedAt: number) {
  return { fiveHourUtilizationPct: five, sevenDayUtilizationPct: seven, capturedAt };
}

describe("formatQuotaUtilCell (CLI)", () => {
  it("no cached snapshot → 'no data' (distinct from not-exhausted '—')", () => {
    expect(formatQuotaUtilCell({ last_quota: null }, NOW)).toBe("no data");
    expect(formatQuotaUtilCell({}, NOW)).toBe("no data");
  });

  it("renders both windows with rounded percentages and a coarse age", () => {
    expect(formatQuotaUtilCell({ last_quota: lq(16.4, 1.2, NOW - 3 * 60_000) }, NOW)).toBe("16%·1% (3m ago)");
    expect(formatQuotaUtilCell({ last_quota: lq(99, 42, NOW - 2 * 3_600_000) }, NOW)).toBe("99%·42% (2h ago)");
    expect(formatQuotaUtilCell({ last_quota: lq(0, 0, NOW - 3 * 86_400_000) }, NOW)).toBe("0%·0% (3d ago)");
  });

  it("a snapshot captured seconds ago reads 'just now'", () => {
    expect(formatQuotaUtilCell({ last_quota: lq(50, 10, NOW - 5_000) }, NOW)).toBe("50%·10% (just now)");
  });

  it("a 99%-utilized non-exhausted account is no longer invisible (the incident's under-report)", () => {
    const cell = formatQuotaUtilCell({ last_quota: lq(99, 3, NOW - 60_000) }, NOW);
    expect(cell).toContain("99%");
  });
});
