import { describe, it, expect } from "vitest";
import { formatIdleFooter, type TurnRow } from "../idle-footer";

// Fixed "now" anchor for all tests: 2026-01-01T00:00:00Z
const NOW = 1_751_328_000_000;

function row(overrides: Partial<TurnRow> & { startedAt: number }): TurnRow {
  return {
    turnKey: "t1",
    chatId: "100",
    endedAt: null,
    ...overrides,
  };
}

describe("formatIdleFooter", () => {
  it("empty rows → quiet", () => {
    expect(formatIdleFooter([], NOW)).toBe("🟡 quiet · no turns yet");
  });

  it("single old turn ended 1h ago → idle 1h ago", () => {
    const r = row({ startedAt: NOW - 70 * 60_000, endedAt: NOW - 60 * 60_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply 1h ago");
  });

  it("single turn ended 3m ago → idle 3m ago", () => {
    const r = row({ startedAt: NOW - 5 * 60_000, endedAt: NOW - 3 * 60_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply 3m ago");
  });

  it("single turn ended 10s ago → idle <1m ago", () => {
    const r = row({ startedAt: NOW - 30_000, endedAt: NOW - 10_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply <1m ago");
  });

  it("currently running turn started 2m ago → working since 2m ago", () => {
    const r = row({ startedAt: NOW - 2 * 60_000 });
    expect(formatIdleFooter([r], NOW)).toBe("⚙️ working since 2m ago");
  });

  it("multiple turns, most recent is running → working since recent", () => {
    const old = row({ turnKey: "t1", startedAt: NOW - 10 * 60_000, endedAt: NOW - 8 * 60_000 });
    const running = row({ turnKey: "t2", startedAt: NOW - 90_000 }); // 1m 30s ago
    expect(formatIdleFooter([old, running], NOW)).toBe("⚙️ working since 1m ago");
  });

  it("multiple turns, most recent is ended → idle last reply", () => {
    const old = row({ turnKey: "t1", startedAt: NOW - 30 * 60_000, endedAt: NOW - 28 * 60_000 });
    const recent = row({ turnKey: "t2", startedAt: NOW - 6 * 60_000, endedAt: NOW - 4 * 60_000 });
    expect(formatIdleFooter([old, recent], NOW)).toBe("🟢 idle · last reply 4m ago");
  });

  it("day-old turn → 1d ago", () => {
    const r = row({ startedAt: NOW - 26 * 3_600_000, endedAt: NOW - 25 * 3_600_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply 1d ago");
  });

  it("unsorted rows — picks max startedAt", () => {
    // rows in reverse chronological order; function must not assume sorted
    const r1 = row({ turnKey: "t1", startedAt: NOW - 20 * 60_000, endedAt: NOW - 18 * 60_000 });
    const r2 = row({ turnKey: "t2", startedAt: NOW - 5 * 60_000, endedAt: NOW - 2 * 60_000 });
    const r3 = row({ turnKey: "t3", startedAt: NOW - 40 * 60_000, endedAt: NOW - 38 * 60_000 });
    // r2 has the largest startedAt, endedAt is 2m ago
    expect(formatIdleFooter([r1, r2, r3], NOW)).toBe("🟢 idle · last reply 2m ago");
  });
});
