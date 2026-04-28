/**
 * Tests for the VaultBroker server.
 *
 * Spins a real broker on a tmp socket with seeded in-memory secrets
 * (via the _testSecrets constructor option — no passphrase/KDF involved).
 * Tests the complete RPC round-trip: connect, send request, receive response.
 *
 * Covers:
 *   - get: returns the entry for a known key
 *   - get: returns LOCKED when vault is locked
 *   - get: returns UNKNOWN_KEY when key doesn't exist
 *   - list: returns all key names
 *   - status: returns { unlocked, keyCount, uptimeSec }
 *   - lock: zeroes in-memory state and responds ok
 *   - Oversized frame (>64 KiB) → BAD_REQUEST
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { VaultBroker } from "./server.js";
import {
  encodeRequest,
  decodeResponse,
  MAX_FRAME_BYTES,
  type BrokerResponse,
} from "./protocol.js";
import type { VaultEntry } from "../vault.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";

const TEST_SECRETS: Record<string, VaultEntry> = {
  foo: { kind: "string", value: "bar-value" },
  baz: { kind: "binary", value: "aGVsbG8=" },
  filekey: {
    kind: "files",
    files: { "cert.pem": { encoding: "utf8", value: "---CERT---" } },
  },
};

/**
 * Deep-clone TEST_SECRETS for each broker. `broker.lock()` mutates entry
 * values in place (zeros them as a best-effort wipe before GC), so a shallow
 * copy `{ ...TEST_SECRETS }` would leak that mutation across tests via the
 * shared entry objects. Concretely: once the "lock wipes secrets" test runs,
 * subsequent tests that read `foo` get `value: ""` instead of `bar-value`.
 * The Linux-skipped get tests masked this for a long time; the new
 * `_testIdentify` happy-path tests below run on Linux and surface the issue.
 */
function cloneSecrets(): Record<string, VaultEntry> {
  return JSON.parse(JSON.stringify(TEST_SECRETS));
}

// Minimal SwitchroomConfig for broker tests. On Linux the broker uses
// peercred + ACL to identify cron units; the test process isn't one, so
// `get` requests are denied. ACL behavior is covered by acl.test.ts; here
// we test the protocol/socket layer. On non-Linux there's no peercred, so
// the broker serves any same-user caller and `get` round-trips work end-to-end.

function makeMinimalConfig() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: {
        socket: "~/.switchroom/vault-broker.sock",
        enabled: true,
      },
    },
    agents: {},
  } as any;
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

describe("VaultBroker server", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    // The broker is Linux-only by design (see issue #129). Tests start the
    // broker on whatever the CI runner / dev box happens to be, so opt in
    // to the non-Linux escape hatch here. On Linux this env var is a no-op.
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  // ── status ──────────────────────────────────────────────────────────────

  it("status: returns unlocked=true with correct keyCount", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "status" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "status" in resp) {
      expect(resp.status.unlocked).toBe(true);
      expect(resp.status.keyCount).toBe(Object.keys(TEST_SECRETS).length);
      expect(resp.status.uptimeSec).toBeGreaterThanOrEqual(0);
    }
  });

  // ── list (non-Linux only — peercred skipped) ──────────────────────────

  it("list: returns all key names (non-Linux or ACL skip)", async () => {
    if (process.platform === "linux") {
      // On Linux, `list` requires peercred (PR #130 review fix). The test
      // process isn't a recognized cron unit, so identify() returns null
      // and the broker denies. Integration tests cover the cron path.
      return;
    }
    const resp = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) {
      expect(resp.keys.sort()).toEqual(Object.keys(TEST_SECRETS).sort());
    }
  });

  // ── get (non-Linux only — peercred skipped) ───────────────────────────

  it("get: returns entry for known key (non-Linux or ACL skip)", async () => {
    if (process.platform === "linux") {
      // On Linux, peercred is enforced. get requests are denied when
      // identify() returns null (no real ss/proc in unit tests).
      // This test is covered by integration tests.
      return;
    }
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }
  });

  it("get: returns UNKNOWN_KEY for non-existent key (non-Linux)", async () => {
    if (process.platform === "linux") return;
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "nonexistent" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("UNKNOWN_KEY");
    }
  });

  // ── lock ───────────────────────────────────────────────────────────────

  it("lock: wipes in-memory secrets and responds ok", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "lock" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "locked" in resp) {
      expect(resp.locked).toBe(true);
    }

    // Internal state should be null after lock
    expect(broker._getSecretsRef()).toBeNull();

    // Status should report locked
    const statusResp = await rpc(socketPath, { v: 1, op: "status" });
    if (statusResp.ok && "status" in statusResp) {
      expect(statusResp.status.unlocked).toBe(false);
      expect(statusResp.status.keyCount).toBe(0);
    }
  });

  it("get: returns LOCKED after lock()", async () => {
    await rpc(socketPath, { v: 1, op: "lock" });
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("LOCKED");
    }
  });

  it("list: returns LOCKED after lock()", async () => {
    await rpc(socketPath, { v: 1, op: "lock" });
    const resp = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("LOCKED");
    }
  });

  // ── bad request ────────────────────────────────────────────────────────

  it("BAD_REQUEST: malformed JSON", async () => {
    return new Promise<void>((resolve, reject) => {
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
            const resp = decodeResponse(line);
            expect(resp.ok).toBe(false);
            if (!resp.ok) {
              expect(resp.code).toBe("BAD_REQUEST");
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      });
      client.on("connect", () => {
        client.write("{invalid json\n");
      });
    });
  });

  it("BAD_REQUEST: oversized frame (>64 KiB)", async () => {
    return new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ path: socketPath });
      let buffer = "";
      client.on("error", (err) => {
        // Connection may be destroyed on oversized frame — that's acceptable
        if (err.message.includes("destroyed")) resolve();
        else reject(err);
      });
      client.on("close", () => resolve());
      client.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          const line = buffer.slice(0, idx);
          client.destroy();
          try {
            const resp = decodeResponse(line);
            expect(resp.ok).toBe(false);
            if (!resp.ok) {
              expect(resp.code).toBe("BAD_REQUEST");
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      });
      client.on("connect", () => {
        // Send a buffer larger than 64 KiB without a newline, then a newline
        const bigData = "x".repeat(MAX_FRAME_BYTES + 100) + "\n";
        client.write(bigData);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gated-paths coverage with a fake "I'm an allowed cron unit" identity.
//
// The broker's real `identify()` reads /proc and ss/SO_PEERCRED to resolve the
// caller's systemd unit. Under `vitest`/`bun test` the test process is not a
// switchroom cron unit, so on Linux the gated `list`/`get` ops correctly
// return DENIED — that's why the suite above skips them on Linux.
//
// The `_testIdentify` test hook on VaultBroker (server.ts) lets us inject a
// synthetic PeerInfo so the broker treats the test client as an allowed cron
// unit. That gives us Linux-side happy-path coverage without spinning up
// systemd-run (the realm of integration tests under tests/integration).
// ─────────────────────────────────────────────────────────────────────────────

describe("VaultBroker server: gated paths (allowed cron identity via _testIdentify)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let prevNonLinuxFlag: string | undefined;

  // Synthetic identity: caller is `switchroom-myagent-cron-0.service`.
  // The matching ACL config grants access to all keys in TEST_SECRETS for
  // that exact (agent, schedule index) pair.
  const FAKE_PEER = {
    uid: process.getuid?.() ?? 1000,
    pid: 99999,
    exe: "/usr/bin/bash",
    systemdUnit: "switchroom-myagent-cron-0.service" as string | null,
  };

  function makeAclConfig() {
    // ACL-allowed keys = every test-secret key + "nonexistent" so the
    // UNKNOWN_KEY test below actually reaches the key-lookup code path
    // instead of being short-circuited by ACL deny. See the comment on
    // that test for why this matters.
    const allowedKeys = [...Object.keys(TEST_SECRETS), "nonexistent"];
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "test", forum_chat_id: "123" },
      vault: {
        path: "~/.switchroom/vault.enc",
        broker: {
          socket: "~/.switchroom/vault-broker.sock",
          enabled: true,
        },
      },
      agents: {
        myagent: {
          schedule: [
            { secrets: allowedKeys },
          ],
        },
      },
    } as any;
  }

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-acl-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeAclConfig(),
      _testIdentify: () => FAKE_PEER,
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("list: returns all key names (allowed cron unit)", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) {
      expect(resp.keys.sort()).toEqual(Object.keys(TEST_SECRETS).sort());
    }
  });

  it("get: returns entry for ACL-allowed key", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }
  });

  it("get: returns UNKNOWN_KEY for non-existent key", async () => {
    // makeAclConfig() puts "nonexistent" in the ACL allowlist on purpose
    // — without that, this request would short-circuit to DENIED at the
    // ACL gate (key not in schedule.secrets) and never reach the
    // key-lookup branch we want to assert here.
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "nonexistent" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("UNKNOWN_KEY");
    }
  });

  it("get: returns DENIED for ACL-disallowed key", async () => {
    // "not-in-acl" is neither in TEST_SECRETS nor in the ACL allowlist,
    // so the ACL gate denies before we ever look up the key. This is
    // the security-relevant path: even when the caller is a real cron
    // unit, they can only read keys their schedule entry was granted.
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "not-in-acl" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
    }
  });
});

describe("VaultBroker server: gated paths (denied identity via _testIdentify)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-deny-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      // Simulate "unidentified caller" — same shape as production when
      // identify() can't resolve the peer (foreign UID, exited process, etc.)
      _testIdentify: () => null,
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  // The deny path is Linux-specific: on non-Linux the broker doesn't gate on
  // peercred (socket-file mode is the only check), so list/get pass through.
  it.skipIf(process.platform !== "linux")(
    "list: DENIED when caller cannot be identified",
    async () => {
      const resp = await rpc(socketPath, { v: 1, op: "list" });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("DENIED");
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "get: DENIED when caller cannot be identified",
    async () => {
      const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo" });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("DENIED");
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit log emission tests
//
// Verifies that each broker operation emits exactly one audit line with the
// correct fields. Uses _testAuditLogger + _testIdentify to exercise the full
// request path without hitting the real audit log or peercred.
// ─────────────────────────────────────────────────────────────────────────────

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

describe("VaultBroker server: audit log emission (allowed cron unit)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let auditLogPath: string;
  let prevNonLinuxFlag: string | undefined;

  const FAKE_PEER = {
    uid: process.getuid?.() ?? 1000,
    pid: 55555,
    exe: "/usr/bin/bash",
    systemdUnit: "switchroom-myagent-cron-0.service" as string | null,
  };

  function makeAuditAclConfig() {
    const allowedKeys = [...Object.keys(TEST_SECRETS), "nonexistent"];
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

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-audit-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    auditLogPath = path.join(tmpDir, "vault-audit.log");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeAuditAclConfig(),
      _testIdentify: () => FAKE_PEER,
      _testAuditLogger: createAuditLogger({ path: auditLogPath }),
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("get (allowed): emits exactly one audit line with correct fields", async () => {
    await rpc(socketPath, { v: 1, op: "get", key: "foo" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("get");
    expect(entry.key).toBe("foo");
    expect(entry.caller).toBe("switchroom-myagent-cron-0.service");
    expect(entry.pid).toBe(55555);
    expect(entry.cgroup).toBe("switchroom-myagent-cron-0.service");
    expect(entry.result).toBe("allowed");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("get (allowed): does not log the secret value", async () => {
    await rpc(socketPath, { v: 1, op: "get", key: "foo" });
    const rawLog = fs.readFileSync(auditLogPath, "utf8");
    // "bar-value" is the secret for key "foo" — must not appear in the log
    expect(rawLog).not.toContain("bar-value");
  });

  it("list (allowed): emits exactly one audit line", async () => {
    await rpc(socketPath, { v: 1, op: "list" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("list");
    expect(entry.key).toBeUndefined();
    expect(entry.result).toBe("allowed");
    expect(entry.caller).toBe("switchroom-myagent-cron-0.service");
  });

  it("lock: emits exactly one audit line", async () => {
    await rpc(socketPath, { v: 1, op: "lock" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("lock");
    expect(entry.key).toBeUndefined();
    expect(entry.result).toBe("allowed");
  });

  it("status: does NOT emit an audit line (informational only)", async () => {
    await rpc(socketPath, { v: 1, op: "status" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(0);
  });

  it("get (denied by ACL): emits result:denied:<reason> and no value", async () => {
    // "not-in-acl" is not in the allowlist — will be denied by ACL
    await rpc(socketPath, { v: 1, op: "get", key: "not-in-acl" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("get");
    expect(entry.key).toBe("not-in-acl");
    expect(entry.result).toMatch(/^denied:/);
    // Assert no secret value leaks into the log line
    const rawLog = fs.readFileSync(auditLogPath, "utf8");
    expect(rawLog).not.toContain("bar-value");
    expect(rawLog).not.toContain("aGVsbG8=");
  });

  it("get (UNKNOWN_KEY): emits result:error:UNKNOWN_KEY", async () => {
    // "nonexistent" is in the ACL allowlist (makeAuditAclConfig) but not in secrets
    await rpc(socketPath, { v: 1, op: "get", key: "nonexistent" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("get");
    expect(entry.key).toBe("nonexistent");
    expect(entry.result).toBe("error:UNKNOWN_KEY");
  });

  it("multiple ops each emit one line each", async () => {
    await rpc(socketPath, { v: 1, op: "get", key: "foo" });
    await rpc(socketPath, { v: 1, op: "list" });
    await rpc(socketPath, { v: 1, op: "lock" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(3);
    expect(lines[0].op).toBe("get");
    expect(lines[1].op).toBe("list");
    expect(lines[2].op).toBe("lock");
  });
});

describe("VaultBroker server: audit log emission (denied identity)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let auditLogPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-audit-deny-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    auditLogPath = path.join(tmpDir, "vault-audit.log");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testIdentify: () => null, // simulate unidentified caller
      _testAuditLogger: createAuditLogger({ path: auditLogPath }),
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it.skipIf(process.platform !== "linux")(
    "get (unidentified caller): emits result:denied: and no value",
    async () => {
      await rpc(socketPath, { v: 1, op: "get", key: "foo" });
      const lines = readAuditLines(auditLogPath);
      expect(lines).toHaveLength(1);
      const entry = lines[0];
      expect(entry.op).toBe("get");
      expect(entry.key).toBe("foo");
      expect(entry.result).toMatch(/^denied:/);
      const rawLog = fs.readFileSync(auditLogPath, "utf8");
      expect(rawLog).not.toContain("bar-value");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "list (unidentified caller): emits result:denied:",
    async () => {
      await rpc(socketPath, { v: 1, op: "list" });
      const lines = readAuditLines(auditLogPath);
      expect(lines).toHaveLength(1);
      const entry = lines[0];
      expect(entry.op).toBe("list");
      expect(entry.result).toMatch(/^denied:/);
    },
  );
});
