/**
 * Telegram legacy accounts-table twin of the CLI honesty fix — the
 * legacy table renders exactly when the live probe FAILED, i.e. when
 * cached-data disclosure matters most.
 */
import { describe, it, expect } from "vitest";
import { formatQuotaUtilCell } from "../gateway/auth-command.js";

const NOW = 1_780_000_000_000;

describe("formatQuotaUtilCell (Telegram legacy table)", () => {
  it("no cached snapshot → 'no data'", () => {
    expect(formatQuotaUtilCell({ last_quota: null }, NOW)).toBe("no data");
  });

  it("renders both windows with the snapshot age", () => {
    const cell = formatQuotaUtilCell(
      { last_quota: { fiveHourUtilizationPct: 84.6, sevenDayUtilizationPct: 12.1, capturedAt: NOW - 90_000 } },
      NOW,
    );
    expect(cell).toBe("85%·12% (1m 30s ago)");
  });
});
