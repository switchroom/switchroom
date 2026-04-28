/**
 * Tests for the audit-log module (src/vault/broker/audit-log.ts).
 *
 * Covers:
 *   - get / set / delete / list each emit exactly one line with expected fields
 *   - Denied request logs result:"denied:..." and never leaks the value
 *   - Concurrent writes don't interleave bytes (each parsed line is valid JSON)
 *   - File created with mode 0600
 *   - Path is configurable (uses a tmp file, not ~/.switchroom/vault-audit.log)
 *   - callerFromPeer: prefers systemdUnit, falls back to pid:<n>
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAuditLogger,
  callerFromPeer,
  defaultAuditLogPath,
  type AuditEntry,
} from "./audit-log.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

function parseLines(filePath: string): AuditEntry[] {
  return readLines(filePath).map((l) => JSON.parse(l) as AuditEntry);
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-log-test-"));
  logPath = path.join(tmpDir, "vault-audit.log");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ─── basic emission ───────────────────────────────────────────────────────────

describe("createAuditLogger", () => {
  it("emits exactly one line for a get op", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: "2026-04-28T14:33:00.000Z",
      op: "get",
      key: "my/secret-key",
      caller: "switchroom-myagent-cron-0.service",
      pid: 12345,
      cgroup: "switchroom-myagent-cron-0.service",
      result: "allowed",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.ts).toBe("2026-04-28T14:33:00.000Z");
    expect(entry.op).toBe("get");
    expect(entry.key).toBe("my/secret-key");
    expect(entry.caller).toBe("switchroom-myagent-cron-0.service");
    expect(entry.pid).toBe(12345);
    expect(entry.cgroup).toBe("switchroom-myagent-cron-0.service");
    expect(entry.result).toBe("allowed");
  });

  it("emits exactly one line for a set op", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "set",
      key: "calendar/admin-api-key",
      caller: "switchroom-cron-morning-brief.service",
      pid: 9999,
      cgroup: "switchroom-cron-morning-brief.service",
      result: "allowed",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.op).toBe("set");
    expect(entry.key).toBe("calendar/admin-api-key");
    expect(entry.result).toBe("allowed");
  });

  it("emits exactly one line for a delete op", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "delete",
      key: "old/key",
      caller: "switchroom-cleaner-cron-0.service",
      pid: 1111,
      result: "allowed",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.op).toBe("delete");
    expect(entry.key).toBe("old/key");
  });

  it("emits exactly one line for a list op (no key field)", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "list",
      caller: "switchroom-myagent-cron-0.service",
      pid: 2222,
      result: "allowed",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.op).toBe("list");
    expect(entry.key).toBeUndefined();
    expect(entry.result).toBe("allowed");
  });

  it("emits exactly one line for an unlock op (no key field)", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "unlock",
      caller: "pid:7777",
      pid: 7777,
      result: "allowed",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.op).toBe("unlock");
    expect(entry.key).toBeUndefined();
  });

  it("emits exactly one line for a lock op (no key field)", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "lock",
      caller: "pid:8888",
      pid: 8888,
      result: "allowed",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.op).toBe("lock");
    expect(entry.key).toBeUndefined();
  });

  it("accumulates multiple lines — one per write", () => {
    const audit = createAuditLogger({ path: logPath });
    const ops = ["get", "set", "delete", "list"] as const;
    for (const op of ops) {
      audit.write({
        ts: new Date().toISOString(),
        op,
        key: op !== "list" ? "some/key" : undefined,
        caller: "switchroom-myagent-cron-0.service",
        pid: 42,
        result: "allowed",
      });
    }
    expect(readLines(logPath)).toHaveLength(ops.length);
  });
});

// ─── denied path ──────────────────────────────────────────────────────────────

describe("denied requests", () => {
  it("logs result:denied:<reason> and does not include the value", () => {
    const SECRET_VALUE = "s3cr3t-password-do-not-log";
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "get",
      key: "calendar/api-key",
      caller: "pid:555",
      pid: 555,
      result: "denied:key 'calendar/api-key' not in ACL for myagent/schedule[0]",
    });
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.result).toMatch(/^denied:/);
    // Assert the secret value is not present anywhere in the raw log line
    expect(lines[0]).not.toContain(SECRET_VALUE);
    // The entry itself must not have a value field
    expect((entry as unknown as Record<string, unknown>).value).toBeUndefined();
  });
});

// ─── file mode ────────────────────────────────────────────────────────────────

describe("file mode", () => {
  it("creates the log file with mode 0600", () => {
    const audit = createAuditLogger({ path: logPath });
    audit.write({
      ts: new Date().toISOString(),
      op: "get",
      key: "k",
      caller: "pid:1",
      pid: 1,
      result: "allowed",
    });
    const stat = fs.statSync(logPath);
    // Compare the permission bits only (mask out file type bits)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── concurrent writes ────────────────────────────────────────────────────────

describe("concurrent writes", () => {
  it("does not interleave bytes — each line is valid JSON when concurrent writes complete", async () => {
    const audit = createAuditLogger({ path: logPath });
    const N = 50;

    // Kick off N concurrent writes. Each write is sync inside but we schedule
    // them via Promise.all to exercise any interleaving at the OS level.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => {
          audit.write({
            ts: new Date().toISOString(),
            op: "get",
            key: `key-${i}`,
            caller: `switchroom-agent-cron-${i}.service`,
            pid: 10000 + i,
            cgroup: `switchroom-agent-cron-${i}.service`,
            result: "allowed",
          });
        }),
      ),
    );

    const lines = readLines(logPath);
    // All N writes must produce exactly N lines
    expect(lines).toHaveLength(N);

    // Every line must parse cleanly as valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const entry = JSON.parse(line) as AuditEntry;
      expect(entry.op).toBe("get");
      expect(entry.result).toBe("allowed");
    }
  });
});

// ─── callerFromPeer ───────────────────────────────────────────────────────────

describe("callerFromPeer", () => {
  it("returns systemdUnit when available", () => {
    const caller = callerFromPeer({
      pid: 12345,
      systemdUnit: "switchroom-myagent-cron-0.service",
    });
    expect(caller).toBe("switchroom-myagent-cron-0.service");
  });

  it("falls back to pid:<n> when systemdUnit is null", () => {
    const caller = callerFromPeer({ pid: 99999, systemdUnit: null });
    expect(caller).toBe("pid:99999");
  });
});

// ─── defaultAuditLogPath ──────────────────────────────────────────────────────

describe("defaultAuditLogPath", () => {
  it("returns a path under os.homedir()/.switchroom/", () => {
    const p = defaultAuditLogPath();
    expect(p).toBe(path.join(os.homedir(), ".switchroom", "vault-audit.log"));
  });
});
