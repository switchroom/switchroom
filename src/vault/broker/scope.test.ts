/**
 * Tests for per-entry scope ACL (issue #8).
 *
 * Covers:
 *   - VaultEntryScope schema: round-trips through VaultEntry correctly
 *   - agentSlugFromPeer: extracts slug from systemd unit name
 *   - checkEntryScope: pure function behavior for all rule combinations
 *   - Broker get: scope-allow and scope-deny enforcement via _testIdentify
 *   - Broker get: no scope = backwards compatible (all callers allowed)
 *   - Broker list: narrows visible keys by scope
 *   - Audit log: scope-deny reason recorded correctly
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { VaultBroker } from "./server.js";
import { checkEntryScope, agentSlugFromPeer } from "./acl.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";
import type { VaultEntry, VaultEntryScope } from "../vault.js";
import type { PeerInfo } from "./peercred.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function peer(
  systemdUnit: string | null,
  uid = 1000,
  pid = 1234,
): PeerInfo {
  return { uid, pid, exe: "/usr/bin/bash", systemdUnit };
}

async function rpc(
  socketPath: string,
  req: Parameters<typeof encodeRequest>[0],
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let buffer = "";
    client.on("error", reject);
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        client.destroy();
        try {
          resolve(decodeResponse(line));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on("connect", () => {
      client.write(encodeRequest(req));
    });
  });
}

function readAuditLines(logPath: string): AuditEntry[] {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VaultEntryScope schema — round-trip through JSON (simulates vault storage)
// ─────────────────────────────────────────────────────────────────────────────

describe("VaultEntryScope schema", () => {
  it("VaultEntry with no scope round-trips cleanly", () => {
    const entry: VaultEntry = { kind: "string", value: "hello" };
    const json = JSON.stringify(entry);
    const restored = JSON.parse(json) as VaultEntry;
    expect(restored).toEqual({ kind: "string", value: "hello" });
    expect((restored as { scope?: VaultEntryScope }).scope).toBeUndefined();
  });

  it("VaultEntry with allow scope round-trips", () => {
    const entry: VaultEntry = {
      kind: "string",
      value: "secret",
      scope: { allow: ["lawgpt", "clerk"] },
    };
    const json = JSON.stringify(entry);
    const restored = JSON.parse(json) as VaultEntry;
    expect((restored as { scope?: VaultEntryScope }).scope).toEqual({
      allow: ["lawgpt", "clerk"],
    });
  });

  it("VaultEntry with deny scope round-trips", () => {
    const entry: VaultEntry = {
      kind: "string",
      value: "secret",
      scope: { deny: ["untrusted-agent"] },
    };
    const json = JSON.stringify(entry);
    const restored = JSON.parse(json) as VaultEntry;
    expect((restored as { scope?: VaultEntryScope }).scope).toEqual({
      deny: ["untrusted-agent"],
    });
  });

  it("VaultEntry with both allow and deny scope round-trips", () => {
    const entry: VaultEntry = {
      kind: "string",
      value: "secret",
      scope: { allow: ["clerk"], deny: ["bad-agent"] },
    };
    const json = JSON.stringify(entry);
    const restored = JSON.parse(json) as VaultEntry;
    expect((restored as { scope?: VaultEntryScope }).scope).toEqual({
      allow: ["clerk"],
      deny: ["bad-agent"],
    });
  });

  it("binary VaultEntry with scope round-trips", () => {
    const entry: VaultEntry = {
      kind: "binary",
      value: "aGVsbG8=",
      scope: { allow: ["myagent"] },
    };
    const json = JSON.stringify(entry);
    const restored = JSON.parse(json) as VaultEntry;
    expect((restored as { scope?: VaultEntryScope }).scope).toEqual({
      allow: ["myagent"],
    });
  });

  it("files VaultEntry with scope round-trips", () => {
    const entry: VaultEntry = {
      kind: "files",
      files: { "key.pem": { encoding: "utf8", value: "PEM_DATA" } },
      scope: { deny: ["low-trust"] },
    };
    const json = JSON.stringify(entry);
    const restored = JSON.parse(json) as VaultEntry;
    expect((restored as { scope?: VaultEntryScope }).scope).toEqual({
      deny: ["low-trust"],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agentSlugFromPeer
// ─────────────────────────────────────────────────────────────────────────────

describe("agentSlugFromPeer", () => {
  it("returns the agent slug from a valid cron unit", () => {
    expect(agentSlugFromPeer(peer("switchroom-clerk-cron-0.service"))).toBe("clerk");
  });

  it("returns the agent slug from a multi-hyphen agent name", () => {
    expect(agentSlugFromPeer(peer("switchroom-my-cool-agent-cron-2.service"))).toBe("my-cool-agent");
  });

  it("returns the agent slug from schedule index > 0", () => {
    expect(agentSlugFromPeer(peer("switchroom-lawgpt-cron-3.service"))).toBe("lawgpt");
  });

  it("returns null when systemdUnit is null", () => {
    expect(agentSlugFromPeer(peer(null))).toBeNull();
  });

  it("returns null for a non-switchroom unit", () => {
    expect(agentSlugFromPeer(peer("some-other.service"))).toBeNull();
  });

  it("returns null for a malformed unit name", () => {
    expect(agentSlugFromPeer(peer("switchroom-myagent-cron-.service"))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkEntryScope — pure function unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("checkEntryScope", () => {
  it("allows when scope is undefined (back-compat — all callers)", () => {
    const result = checkEntryScope(undefined, "clerk");
    expect(result.allow).toBe(true);
  });

  it("allows when scope is empty object (no allow, no deny)", () => {
    const result = checkEntryScope({}, "clerk");
    expect(result.allow).toBe(true);
  });

  it("allows when scope has empty allow and deny arrays", () => {
    const result = checkEntryScope({ allow: [], deny: [] }, "clerk");
    expect(result.allow).toBe(true);
  });

  it("allows when caller is in the allow list", () => {
    const result = checkEntryScope({ allow: ["clerk", "lawgpt"] }, "clerk");
    expect(result.allow).toBe(true);
  });

  it("denies when caller is NOT in the allow list (scope-allow)", () => {
    const result = checkEntryScope({ allow: ["clerk"] }, "lawgpt");
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("lawgpt");
      expect(result.reason).toContain("scope-allow");
    }
  });

  it("denies when caller is in the deny list (scope-deny)", () => {
    const result = checkEntryScope({ deny: ["bad-agent"] }, "bad-agent");
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("bad-agent");
      expect(result.reason).toContain("scope-deny");
    }
  });

  it("deny takes precedence over allow: caller in both lists is denied", () => {
    const result = checkEntryScope(
      { allow: ["clerk", "lawgpt"], deny: ["clerk"] },
      "clerk",
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("scope-deny");
    }
  });

  it("allows a caller not in deny list, even when deny list is non-empty", () => {
    const result = checkEntryScope({ deny: ["bad-agent"] }, "clerk");
    expect(result.allow).toBe(true);
  });

  it("denies when agentSlug is null and allow list is non-empty", () => {
    const result = checkEntryScope({ allow: ["clerk"] }, null);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("scope-allow");
    }
  });

  it("allows when agentSlug is null and scope is undefined", () => {
    const result = checkEntryScope(undefined, null);
    expect(result.allow).toBe(true);
  });

  it("allows when agentSlug is null and deny list is non-empty but allow is empty", () => {
    // deny list: null caller can't be in it so we skip it.
    // allow list: empty = all callers allowed.
    const result = checkEntryScope({ deny: ["bad-agent"] }, null);
    expect(result.allow).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Broker integration tests for scope enforcement
//
// Uses _testIdentify + _testAuditLogger to avoid real peercred or audit log.
// The fake peer is `switchroom-myagent-cron-0.service` → slug "myagent".
// ─────────────────────────────────────────────────────────────────────────────

/** Build a SwitchroomConfig that grants the fake peer access to the given keys. */
function makeScopeConfig(allowedKeys: string[]) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {
      myagent: { schedule: [{ secrets: allowedKeys }] },
    },
  } as any;
}

describe("VaultBroker scope enforcement via _testIdentify", () => {
  let tmpDir: string;
  let socketPath: string;
  let auditLogPath: string;
  let prevNonLinuxFlag: string | undefined;

  // Fake peer: switchroom-myagent-cron-0.service → slug "myagent"
  const FAKE_PEER: PeerInfo = {
    uid: process.getuid?.() ?? 1000,
    pid: 77777,
    exe: "/usr/bin/bash",
    systemdUnit: "switchroom-myagent-cron-0.service",
  };

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-scope-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    auditLogPath = path.join(tmpDir, "vault-audit.log");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  async function startBroker(
    secrets: Record<string, VaultEntry>,
  ): Promise<VaultBroker> {
    const allKeys = Object.keys(secrets);
    const broker = new VaultBroker({
      _testSecrets: JSON.parse(JSON.stringify(secrets)),
      _testConfig: makeScopeConfig(allKeys),
      _testIdentify: () => FAKE_PEER,
      _testAuditLogger: createAuditLogger({ path: auditLogPath }),
    });
    await broker.start(socketPath, undefined, undefined);
    return broker;
  }

  // ── get: no scope → back-compat (allowed) ─────────────────────────────

  it("get: entry without scope is accessible to all callers (back-compat)", async () => {
    const secrets: Record<string, VaultEntry> = {
      "unscoped-key": { kind: "string", value: "open-value" },
    };
    const broker = await startBroker(secrets);
    try {
      const resp = await rpc(socketPath, { v: 1, op: "get", key: "unscoped-key" });
      expect(resp.ok).toBe(true);
      if (resp.ok && "entry" in resp) {
        expect((resp.entry as { value: string }).value).toBe("open-value");
      }
    } finally {
      broker.stop();
    }
  });

  // ── get: caller in allow list → allowed ───────────────────────────────

  it("get: caller in allow list is allowed", async () => {
    const secrets: Record<string, VaultEntry> = {
      "scoped-key": {
        kind: "string",
        value: "restricted-value",
        scope: { allow: ["myagent", "clerk"] },
      },
    };
    const broker = await startBroker(secrets);
    try {
      const resp = await rpc(socketPath, { v: 1, op: "get", key: "scoped-key" });
      expect(resp.ok).toBe(true);
    } finally {
      broker.stop();
    }
  });

  // ── get: caller NOT in allow list → denied (scope-allow) ─────────────

  it("get: caller not in allow list is denied (scope-allow)", async () => {
    const secrets: Record<string, VaultEntry> = {
      "clerk-only": {
        kind: "string",
        value: "clerk-secret",
        scope: { allow: ["clerk"] },
      },
    };
    const broker = await startBroker(secrets);
    try {
      // fake peer is "myagent" — not in allow list
      const resp = await rpc(socketPath, { v: 1, op: "get", key: "clerk-only" });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("DENIED");
        expect(resp.msg).toContain("scope-allow");
      }
    } finally {
      broker.stop();
    }
  });

  // ── get: caller in deny list → denied (scope-deny) ────────────────────

  it("get: caller in deny list is denied even if also in allow (scope-deny precedence)", async () => {
    const secrets: Record<string, VaultEntry> = {
      "paranoid-key": {
        kind: "string",
        value: "super-secret",
        scope: { allow: ["myagent", "clerk"], deny: ["myagent"] },
      },
    };
    const broker = await startBroker(secrets);
    try {
      // myagent is both in allow and deny → deny wins
      const resp = await rpc(socketPath, { v: 1, op: "get", key: "paranoid-key" });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("DENIED");
        expect(resp.msg).toContain("scope-deny");
      }
    } finally {
      broker.stop();
    }
  });

  // ── list: only scope-accessible keys are returned ─────────────────────

  it("list: returns only keys accessible to the calling agent", async () => {
    const secrets: Record<string, VaultEntry> = {
      "shared-key": { kind: "string", value: "shared" },
      "myagent-key": {
        kind: "string",
        value: "for-myagent",
        scope: { allow: ["myagent"] },
      },
      "clerk-only-key": {
        kind: "string",
        value: "for-clerk",
        scope: { allow: ["clerk"] },
      },
      "denied-key": {
        kind: "string",
        value: "not-for-myagent",
        scope: { deny: ["myagent"] },
      },
    };
    const broker = await startBroker(secrets);
    try {
      const resp = await rpc(socketPath, { v: 1, op: "list" });
      expect(resp.ok).toBe(true);
      if (resp.ok && "keys" in resp) {
        const keys = resp.keys.sort();
        // shared-key (no scope) + myagent-key (allow includes myagent) are visible.
        // clerk-only-key (allow=["clerk"], myagent not in it) is hidden.
        // denied-key (deny=["myagent"]) is hidden.
        expect(keys).toContain("shared-key");
        expect(keys).toContain("myagent-key");
        expect(keys).not.toContain("clerk-only-key");
        expect(keys).not.toContain("denied-key");
      }
    } finally {
      broker.stop();
    }
  });

  // ── audit log: scope-deny reason recorded ─────────────────────────────

  it("audit log records scope-deny reason on denied get", async () => {
    const secrets: Record<string, VaultEntry> = {
      "audit-test-key": {
        kind: "string",
        value: "audit-secret",
        scope: { deny: ["myagent"] },
      },
    };
    const broker = await startBroker(secrets);
    try {
      await rpc(socketPath, { v: 1, op: "get", key: "audit-test-key" });
      const lines = readAuditLines(auditLogPath);
      expect(lines).toHaveLength(1);
      const entry = lines[0];
      expect(entry.op).toBe("get");
      expect(entry.key).toBe("audit-test-key");
      expect(entry.result).toMatch(/^denied:/);
      expect(entry.result).toContain("scope-deny");
      // Secret value must not appear in the audit log
      const rawLog = fs.readFileSync(auditLogPath, "utf8");
      expect(rawLog).not.toContain("audit-secret");
    } finally {
      broker.stop();
    }
  });

  it("audit log records scope-allow reason on denied get", async () => {
    const secrets: Record<string, VaultEntry> = {
      "allow-test-key": {
        kind: "string",
        value: "restricted-value",
        scope: { allow: ["clerk"] }, // myagent not in list
      },
    };
    const broker = await startBroker(secrets);
    try {
      await rpc(socketPath, { v: 1, op: "get", key: "allow-test-key" });
      const lines = readAuditLines(auditLogPath);
      expect(lines).toHaveLength(1);
      const entry = lines[0];
      expect(entry.result).toMatch(/^denied:/);
      expect(entry.result).toContain("scope-allow");
      const rawLog = fs.readFileSync(auditLogPath, "utf8");
      expect(rawLog).not.toContain("restricted-value");
    } finally {
      broker.stop();
    }
  });
});
