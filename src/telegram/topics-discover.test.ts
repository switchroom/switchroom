/**
 * Tests for the pure formatter half of `switchroom telegram topics`.
 *
 * The SQLite-fetching half lives in src/cli/telegram.ts and requires
 * bun:sqlite — exercised by integration / smoke tests run under bun,
 * not here. These vitest specs cover the formatter, the truncate
 * helper, and the relative-time formatter.
 */

import { describe, expect, it } from "vitest";
import { formatTopicsTable, truncate, formatAgo, type TopicRow } from "./topics-discover.js";

// Strip ANSI color codes — chalk is enabled in tests, but assertions
// are easier to write against plain strings.
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hi", 60)).toBe("hi");
  });

  it("appends an ellipsis past max length", () => {
    const long = "x".repeat(100);
    const out = truncate(long, 60);
    expect(out).toHaveLength(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses newlines to single spaces", () => {
    expect(truncate("hello\nworld\n\nfoo", 60)).toBe("hello world foo");
  });

  it("trims leading/trailing whitespace before truncating", () => {
    expect(truncate("   hello   ", 60)).toBe("hello");
  });
});

describe("formatAgo", () => {
  const NOW = 1_700_000_000;

  it("renders 'just now' for <60s", () => {
    expect(formatAgo(NOW - 30, NOW)).toBe("just now");
    expect(formatAgo(NOW - 59, NOW)).toBe("just now");
  });

  it("renders minutes for <60m", () => {
    expect(formatAgo(NOW - 90, NOW)).toBe("1m ago");
    expect(formatAgo(NOW - 1800, NOW)).toBe("30m ago");
  });

  it("renders hours for <24h", () => {
    expect(formatAgo(NOW - 3600, NOW)).toBe("1h ago");
    expect(formatAgo(NOW - 12 * 3600, NOW)).toBe("12h ago");
  });

  it("renders days for <30d", () => {
    expect(formatAgo(NOW - 86400, NOW)).toBe("1d ago");
    expect(formatAgo(NOW - 7 * 86400, NOW)).toBe("7d ago");
  });

  it("renders an ISO date past 30 days", () => {
    const old = NOW - 60 * 86400;
    const out = formatAgo(old, NOW);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("clamps negative deltas (future ts) to 'just now'", () => {
    expect(formatAgo(NOW + 100, NOW)).toBe("just now");
  });
});

describe("formatTopicsTable", () => {
  const ROW_BASE = {
    msg_count: 5,
    first_ts: Math.floor(Date.now() / 1000) - 3600,
    last_ts: Math.floor(Date.now() / 1000),
    first_role: "user",
  };

  it("renders a row per topic with thread_id, msg count, and preview", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: 17, first_text: "hi from planning" },
      { ...ROW_BASE, thread_id: 23, first_text: "cron digest goes here" },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("Topics observed in chat -1001234567890");
    expect(out).toContain("(agent: klanker)");
    expect(out).toContain("17");
    expect(out).toContain("23");
    expect(out).toContain("hi from planning");
    expect(out).toContain("cron digest goes here");
    expect(out).toContain("user:");
  });

  it("flags thread_id=1 as General (the Bot-API quirk reminder)", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: 1, first_text: "hello general" },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("(General)");
  });

  it("renders chat-root rows distinctly (thread_id=null)", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: null, first_text: "DM message" },
    ];
    const out = plain(formatTopicsTable(rows, "12345", "carrie"));
    expect(out).toContain("chat-root");
  });

  it("emits a copy-paste topic_aliases YAML snippet for numeric threads", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: 17, first_text: "x" },
      { ...ROW_BASE, thread_id: 23, first_text: "y" },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("topic_aliases:");
    expect(out).toContain("topic_17: 17");
    expect(out).toContain("topic_23: 23");
  });

  it("aliases General as 'general' in the YAML snippet", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: 1, first_text: "x" },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("general: 1");
  });

  it("omits chat-root rows from the YAML snippet (can't alias chat-root)", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: null, first_text: "x" },
      { ...ROW_BASE, thread_id: 17, first_text: "y" },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("topic_17: 17");
    // chat-root shouldn't appear as an alias entry
    expect(out).not.toMatch(/^\s*chat-root:/m);
  });

  it("skips the snippet entirely when no numeric threads observed", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: null, first_text: "x" },
    ];
    const out = plain(formatTopicsTable(rows, "12345", "carrie"));
    expect(out).not.toContain("topic_aliases:");
  });

  it("renders '(no message)' when first_text is null", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, thread_id: 17, first_text: null, first_role: null },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("(no message)");
  });

  it("singularizes 'msg' for count=1", () => {
    const rows: TopicRow[] = [
      { ...ROW_BASE, msg_count: 1, thread_id: 17, first_text: "x" },
      { ...ROW_BASE, msg_count: 2, thread_id: 18, first_text: "y" },
    ];
    const out = plain(formatTopicsTable(rows, "-1001234567890", "klanker"));
    expect(out).toContain("1 msg,");
    expect(out).toContain("2 msgs,");
  });
});
