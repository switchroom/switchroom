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
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply **1h ago**");
  });

  it("single turn ended 3m ago → idle 3m ago", () => {
    const r = row({ startedAt: NOW - 5 * 60_000, endedAt: NOW - 3 * 60_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply **3m ago**");
  });

  it("single turn ended 10s ago → idle <1m ago", () => {
    const r = row({ startedAt: NOW - 30_000, endedAt: NOW - 10_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply **<1m ago**");
  });

  it("currently running turn started 2m ago → working since **2m ago**", () => {
    const r = row({ startedAt: NOW - 2 * 60_000 });
    expect(formatIdleFooter([r], NOW)).toBe("⚙️ working since **2m ago**");
  });

  it("multiple turns, most recent is running → working since recent", () => {
    const old = row({ turnKey: "t1", startedAt: NOW - 10 * 60_000, endedAt: NOW - 8 * 60_000 });
    const running = row({ turnKey: "t2", startedAt: NOW - 90_000 }); // 1m 30s ago
    expect(formatIdleFooter([old, running], NOW)).toBe("⚙️ working since **1m ago**");
  });

  it("multiple turns, most recent is ended → idle last reply", () => {
    const old = row({ turnKey: "t1", startedAt: NOW - 30 * 60_000, endedAt: NOW - 28 * 60_000 });
    const recent = row({ turnKey: "t2", startedAt: NOW - 6 * 60_000, endedAt: NOW - 4 * 60_000 });
    expect(formatIdleFooter([old, recent], NOW)).toBe("🟢 idle · last reply **4m ago**");
  });

  it("day-old turn → 1d ago", () => {
    const r = row({ startedAt: NOW - 26 * 3_600_000, endedAt: NOW - 25 * 3_600_000 });
    expect(formatIdleFooter([r], NOW)).toBe("🟢 idle · last reply **1d ago**");
  });

  it("no-data (quiet) state carries NO ** markup", () => {
    const out = formatIdleFooter([], NOW);
    expect(out).toBe("🟡 quiet · no turns yet");
    expect(out).not.toContain("**");
  });

  it("working state bolds ONLY the elapsed value, not the whole line", () => {
    const r = row({ startedAt: NOW - 4 * 60_000 });
    const out = formatIdleFooter([r], NOW);
    // The bold span wraps the time and only the time.
    const bold = out.match(/\*\*(.+?)\*\*/);
    expect(bold).not.toBeNull();
    expect(bold![1]).toBe("4m ago");
    // The label "⚙️ working since " is outside the bold span.
    expect(out).toBe("⚙️ working since **4m ago**");
    // Exactly one bold span (two `**` delimiters).
    expect((out.match(/\*\*/g) ?? []).length).toBe(2);
  });

  it("idle state bolds ONLY the last-reply value, not the whole line", () => {
    const r = row({ startedAt: NOW - 6 * 60_000, endedAt: NOW - 3 * 60_000 });
    const out = formatIdleFooter([r], NOW);
    const bold = out.match(/\*\*(.+?)\*\*/);
    expect(bold).not.toBeNull();
    expect(bold![1]).toBe("3m ago");
    expect(out).toBe("🟢 idle · last reply **3m ago**");
    expect((out.match(/\*\*/g) ?? []).length).toBe(2);
  });

  // Table-driven across elapsed magnitudes: a future change to formatAgo that
  // drops the bold (or widens it past the time value) is caught here.
  it.each([
    { label: "seconds", deltaMs: 10_000, ago: "<1m ago" },
    { label: "minutes", deltaMs: 7 * 60_000, ago: "7m ago" },
    { label: "hours", deltaMs: 5 * 3_600_000, ago: "5h ago" },
    { label: "days", deltaMs: 3 * 86_400_000, ago: "3d ago" },
  ])("idle footer bolds the $label-magnitude elapsed value", ({ deltaMs, ago }) => {
    const r = row({ startedAt: NOW - deltaMs - 1000, endedAt: NOW - deltaMs });
    const out = formatIdleFooter([r], NOW);
    expect(out).toBe(`🟢 idle · last reply **${ago}**`);
    const bold = out.match(/\*\*(.+?)\*\*/);
    expect(bold![1]).toBe(ago);
  });

  it("unsorted rows — picks max startedAt", () => {
    // rows in reverse chronological order; function must not assume sorted
    const r1 = row({ turnKey: "t1", startedAt: NOW - 20 * 60_000, endedAt: NOW - 18 * 60_000 });
    const r2 = row({ turnKey: "t2", startedAt: NOW - 5 * 60_000, endedAt: NOW - 2 * 60_000 });
    const r3 = row({ turnKey: "t3", startedAt: NOW - 40 * 60_000, endedAt: NOW - 38 * 60_000 });
    // r2 has the largest startedAt, endedAt is 2m ago
    expect(formatIdleFooter([r1, r2, r3], NOW)).toBe("🟢 idle · last reply **2m ago**");
  });
});
