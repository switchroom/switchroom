import { describe, it, expect } from "vitest";
import {
  parseAuditLine,
  filterAuditEntries,
  formatAuditEntry,
  formatAuditLines,
} from "../src/vault/audit-reader.js";
import type { AuditEntry } from "../src/vault/broker/audit-log.js";

// Fixture factory
function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-04-28T14:33:00.123Z",
    op: "get",
    key: "stripe/live-key",
    caller: "switchroom-my-agent-cron-0.service",
    pid: 12345,
    result: "allowed",
    ...overrides,
  };
}

function makeJsonLine(overrides: Partial<AuditEntry> = {}): string {
  return JSON.stringify(makeEntry(overrides));
}

// ── parseAuditLine ─────────────────────────────────────────────────────────

describe("parseAuditLine", () => {
  it("parses a valid JSON audit line", () => {
    const line = makeJsonLine();
    const entry = parseAuditLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.op).toBe("get");
    expect(entry!.key).toBe("stripe/live-key");
    expect(entry!.caller).toBe("switchroom-my-agent-cron-0.service");
    expect(entry!.result).toBe("allowed");
    expect(entry!.pid).toBe(12345);
  });

  it("returns null for blank lines", () => {
    expect(parseAuditLine("")).toBeNull();
    expect(parseAuditLine("   ")).toBeNull();
  });

  it("returns null for non-JSON lines", () => {
    expect(parseAuditLine("not json at all")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const partial = JSON.stringify({ ts: "2026-01-01T00:00:00Z", op: "get" });
    expect(parseAuditLine(partial)).toBeNull();
  });

  it("handles entry without a key field (e.g. unlock op)", () => {
    const line = JSON.stringify({
      ts: "2026-04-28T14:33:00.123Z",
      op: "unlock",
      caller: "pid:999",
      pid: 999,
      result: "allowed",
    });
    const entry = parseAuditLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.op).toBe("unlock");
    expect(entry!.key).toBeUndefined();
  });

  it("handles entry with cgroup field", () => {
    const line = makeJsonLine({ cgroup: "switchroom-my-agent-cron-0.service" });
    const entry = parseAuditLine(line);
    expect(entry!.cgroup).toBe("switchroom-my-agent-cron-0.service");
  });
});

// ── filterAuditEntries ─────────────────────────────────────────────────────

describe("filterAuditEntries", () => {
  const entries: AuditEntry[] = [
    makeEntry({ caller: "switchroom-my-agent-cron-0.service", key: "stripe/key", result: "allowed" }),
    makeEntry({ caller: "switchroom-other-cron-1.service", key: "google/key", result: "denied:scope-allow" }),
    makeEntry({ caller: "switchroom-my-agent-cron-1.service", key: "stripe/secret", result: "denied:missing" }),
    makeEntry({ op: "unlock", caller: "pid:9999", result: "allowed", key: undefined }),
  ];

  it("returns all entries when no filters set", () => {
    const result = filterAuditEntries(entries, {});
    expect(result).toHaveLength(entries.length);
  });

  it("filters by --who substring (case-insensitive)", () => {
    const result = filterAuditEntries(entries, { who: "my-agent" });
    expect(result).toHaveLength(2);
    for (const e of result) {
      expect(e.caller.toLowerCase()).toContain("my-agent");
    }
  });

  it("filters by --who with pid fallback format", () => {
    const result = filterAuditEntries(entries, { who: "pid:9999" });
    expect(result).toHaveLength(1);
    expect(result[0].caller).toBe("pid:9999");
  });

  it("filters by --key substring", () => {
    const result = filterAuditEntries(entries, { key: "stripe" });
    expect(result).toHaveLength(2);
    for (const e of result) {
      expect(e.key).toMatch(/stripe/);
    }
  });

  it("filters by --key regex", () => {
    const result = filterAuditEntries(entries, { key: "stripe/(key|secret)" });
    expect(result).toHaveLength(2);
  });

  it("filters by --denied", () => {
    const result = filterAuditEntries(entries, { denied: true });
    expect(result).toHaveLength(2);
    for (const e of result) {
      expect(e.result).toMatch(/^denied/);
    }
  });

  it("filters by --who and --denied combined", () => {
    const result = filterAuditEntries(entries, { who: "my-agent", denied: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("stripe/secret");
  });

  it("filters by --key and --denied combined", () => {
    const result = filterAuditEntries(entries, { key: "google", denied: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("google/key");
  });

  it("returns empty when entry has no key and --key filter set", () => {
    const result = filterAuditEntries(entries, { key: "stripe", who: "pid:9999" });
    expect(result).toHaveLength(0);
  });

  it("handles invalid regex in --key gracefully (falls back to substring)", () => {
    // The previous fixture (`"stripe"`) was a valid regex, so the
    // fallback branch was untested. Use `"[unclosed"` — genuinely
    // invalid — and a fixture whose literal key contains that substring,
    // so the substring-fallback returns it.
    const withBracketKey = [
      ...entries,
      makeEntry({ key: "broken[unclosed/key", result: "allowed" }),
    ];
    const result = filterAuditEntries(withBracketKey, { key: "[unclosed" });
    expect(result.length).toBe(1);
    expect(result[0].key).toBe("broken[unclosed/key");
  });
});

// ── formatAuditEntry ───────────────────────────────────────────────────────

describe("formatAuditEntry", () => {
  it("formats an entry with all fields", () => {
    const entry = makeEntry();
    const line = formatAuditEntry(entry);
    expect(line).toContain("2026-04-28");
    expect(line).toContain("get");
    expect(line).toContain("stripe/live-key");
    expect(line).toContain("switchroom-my-agent-cron-0.service");
    expect(line).toContain("allowed");
  });

  it("formats an entry without a key field", () => {
    const entry = makeEntry({ op: "unlock", key: undefined });
    const line = formatAuditEntry(entry);
    expect(line).toContain("(no key)");
    expect(line).toContain("unlock");
  });

  it("truncates very long caller names", () => {
    const longCaller = "switchroom-" + "a".repeat(60) + "-cron-0.service";
    const entry = makeEntry({ caller: longCaller });
    const line = formatAuditEntry(entry);
    expect(line).toContain("...");
    // Should not blow up the line
    expect(line.length).toBeLessThan(300);
  });

  it("formats denied result", () => {
    const entry = makeEntry({ result: "denied:scope-allow" });
    const line = formatAuditEntry(entry);
    expect(line).toContain("denied:scope-allow");
  });
});

// ── formatAuditLines ───────────────────────────────────────────────────────

describe("formatAuditLines", () => {
  const lines = [
    makeJsonLine({ result: "allowed", key: "a/key" }),
    makeJsonLine({ result: "denied:scope-allow", key: "b/key" }),
    makeJsonLine({ result: "allowed", key: "c/key" }),
    "not-json-garbage",
    "",
  ];

  it("returns formatted lines, skipping garbage", () => {
    const result = formatAuditLines(lines, {});
    expect(result).toHaveLength(3); // 3 valid JSON lines, 2 skipped
  });

  it("applies --denied filter", () => {
    const result = formatAuditLines(lines, { denied: true });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("denied:scope-allow");
  });

  it("applies limit (takes last N)", () => {
    const manyLines = Array.from({ length: 100 }, (_, i) =>
      makeJsonLine({ key: `key/${i}` })
    );
    const result = formatAuditLines(manyLines, {}, 10);
    expect(result).toHaveLength(10);
    // Last entry should be key/99
    expect(result[9]).toContain("key/99");
  });

  it("returns empty array when no lines match filters", () => {
    const result = formatAuditLines(lines, { who: "nonexistent-caller" });
    expect(result).toHaveLength(0);
  });

  it("defaults limit to 50", () => {
    const manyLines = Array.from({ length: 60 }, () => makeJsonLine());
    const result = formatAuditLines(manyLines, {});
    expect(result).toHaveLength(50);
  });
});
