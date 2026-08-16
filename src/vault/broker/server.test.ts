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
import { createVault, setStringSecret, getStringSecret } from "../vault.js";
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
    // RFC B's approval_lookup uses `state`, not `status`, so there's no
    // collision with BrokerStatus on this union — narrow on `"status" in resp`.
    if (resp.ok && "status" in resp) {
      const s = resp.status;
      expect(s.unlocked).toBe(true);
      expect(s.keyCount).toBe(Object.keys(TEST_SECRETS).length);
      expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
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
      const s = statusResp.status;
      expect(s.unlocked).toBe(false);
      expect(s.keyCount).toBe(0);
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
      // #1192: identity is the per-agent socket path. _testAgentName pins the
      // agent slug the way the real per-agent listener would; checkAclByAgent
      // gates on it. FAKE_PEER stays for the informational audit fields.
      _testAgentName: "myagent",
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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #207 — Item 1: list ACL scope narrowing
//
// Verifies that a cron unit whose schedule only grants a SUBSET of keys sees
// only those keys in `list`, even though the vault contains more. Regression:
// the interactive (non-Linux / no-peer) path must still see all keys.
// ─────────────────────────────────────────────────────────────────────────────

describe("VaultBroker server: list ACL scope narrowing (issue #207)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let prevNonLinuxFlag: string | undefined;

  // Cron unit that is only allowed to read "foo" — not "baz" or "filekey"
  const FAKE_PEER_NARROW = {
    uid: process.getuid?.() ?? 1000,
    pid: 77777,
    exe: "/usr/bin/bash",
    systemdUnit: "switchroom-myagent-cron-0.service" as string | null,
  };

  function makeNarrowAclConfig() {
    // schedule[0] only grants "foo" — the other two test keys must be hidden
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "test", forum_chat_id: "123" },
      vault: {
        path: "~/.switchroom/vault.enc",
        broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
      },
      agents: {
        myagent: {
          schedule: [{ secrets: ["foo"] }],
        },
      },
    } as any;
  }

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-list-acl-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),      // vault has foo + baz + filekey
      _testConfig: makeNarrowAclConfig(), // agent only allowed to see "foo"
      _testAgentName: "myagent",          // #1192: per-agent socket identity
      _testIdentify: () => FAKE_PEER_NARROW,
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

  it("list: cron scope sees only ACL-allowed keys (not the full vault)", async () => {
    // Vault has ["foo", "baz", "filekey"]; cron ACL only grants ["foo"]
    const resp = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) {
      expect(resp.keys).toEqual(["foo"]);
    }
  });

  it("list: cron scope does NOT reveal keys outside its allowlist", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) {
      // "baz" and "filekey" are in the vault but outside the cron's ACL
      expect(resp.keys).not.toContain("baz");
      expect(resp.keys).not.toContain("filekey");
    }
  });
});

describe("VaultBroker server: list full set on non-Linux (regression guard, issue #207)", () => {
  // Regression: the interactive / non-Linux path must still return all keys
  // after the ACL-filter change. We spin a broker with no _testIdentify, which
  // means peer===null (same as non-Linux behaviour), and verify all keys come back.
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-list-full-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      // No _testIdentify → peer will be null on Linux (blocked by peercred gate)
      // but absent the guard we exercise on non-Linux: no peer, no filter.
      _testIdentify: () => null,
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

  it("list: non-Linux (no peer) sees all keys — no scope filter applied", async () => {
    if (process.platform === "linux") {
      // On Linux peer===null triggers the peercred deny gate before we reach
      // the ACL-filter code — that deny path is already tested in the
      // "denied identity" suite above. This regression guard is non-Linux only.
      return;
    }
    const resp = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) {
      expect(resp.keys.sort()).toEqual(Object.keys(TEST_SECRETS).sort());
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
      _testAgentName: "myagent",          // #1192: per-agent socket identity
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
    // #1192: caller is the socket-path agent identity ("agent:<name>"); the
    // cgroup field still carries the informational systemd unit from peercred.
    expect(entry.caller).toBe("agent:myagent");
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

  it("list (allowed): emits exactly one audit line with visible-key count", async () => {
    await rpc(socketPath, { v: 1, op: "list" });
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("list");
    expect(entry.key).toBeUndefined();
    // #207 review-fix: result includes the visible-key count so an operator
    // can grep for `result: "allowed:0"` (a likely misconfig signal).
    expect(entry.result).toMatch(/^allowed:\d+$/);
    expect(entry.caller).toBe("agent:myagent");
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

  // ── preflight_access: operator-only gate ────────────────────────────────
  // The operator-ALLOWED path needs a real /run/switchroom/broker/
  // operator socket (peercred's SOCKET_PATH regexes are hard-anchored
  // there — that path-shape IS the security root, so a unit test can't
  // bind one; no broker test does). The GATE — a non-operator
  // (per-agent/default) caller is refused — is the new security-
  // critical behaviour and is fully testable here. The operator-
  // allowed computation is covered by composition: checkAclByAgent/
  // checkEntryScope (acl.test.ts) + the consumer mapping incl.
  // locked→skip (doctor-secret-access.test.ts, injected preflight).
  it("preflight_access: DENIED on a non-operator socket, and audited without secret material", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "preflight_access",
      agent: "anyone",
      keys: ["foo", "baz"],
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const row = readAuditLines(auditLogPath).find(
      (e) => e.op === "preflight_access",
    );
    expect(row).toBeDefined();
    expect(row!.result).toMatch(/^denied:operator-only/);
    // Never carries a secret value.
    expect(JSON.stringify(row)).not.toContain("bar-value");
  });
});

// ── reload (SIGHUP hot-reload) ───────────────────────────────────────────────
// Regression: the vault-broker used to cache switchroom.yaml at boot with no
// reload path, so secret-ACL / agent-admin / approval-posture edits silently
// no-op'd until a `docker restart`. reload(config) swaps the live config the
// authorization decisions read — and MUST NOT disturb the decrypted vault
// (the load-bearing safety property: unlock state lives in separate fields).
describe("VaultBroker.reload (SIGHUP hot-reload)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-reload-"));
    socketPath = path.join(tmpDir, "test.sock");
  });

  afterEach(() => {
    if (broker) broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("swaps the live config WITHOUT disturbing the decrypted vault", async () => {
    const cfgA = { ...makeMinimalConfig(), agents: { a1: { admin: false } } } as any;
    broker = new VaultBroker({ _testSecrets: cloneSecrets(), _testConfig: cfgA });
    await broker.start(socketPath, undefined, undefined);

    // Boot state: unlocked, config A (a1 not admin).
    expect(broker._getConfigRef()?.agents?.a1?.admin).toBe(false);
    const secretsBefore = broker._getSecretsRef();
    expect(secretsBefore).not.toBeNull();

    // Hot-reload to a config where a1 IS admin.
    const cfgB = { ...makeMinimalConfig(), agents: { a1: { admin: true } } } as any;
    broker.reload(cfgB);

    // Config swapped — the gate now sees a1 as admin...
    expect(broker._getConfigRef()?.agents?.a1?.admin).toBe(true);
    // ...and the decrypted vault is the SAME object, untouched. reload must
    // never re-unlock, re-run auto-unlock, or drop secrets.
    expect(broker._getSecretsRef()).toBe(secretsBefore);
    expect(broker._getSecretsRef()).not.toBeNull();
  });

  it("status RPC still reports unlocked + full keyCount after reload", async () => {
    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
    });
    await broker.start(socketPath, undefined, undefined);

    broker.reload({ ...makeMinimalConfig(), agents: { x: { admin: true } } } as any);

    const resp = await rpc(socketPath, { v: 1, op: "status" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "status" in resp) {
      expect(resp.status.unlocked).toBe(true);
      expect(resp.status.keyCount).toBe(Object.keys(TEST_SECRETS).length);
    }
  });
});

// ── #4736 follow-up: the stat-on-access refresh fails OPEN, and that must
//    not leak onto the write path or downgrade the layout-drift fatal ──────────
//
// PR #4736 made the broker re-read `vault.enc` when the file changes so that
// operator writes become visible. `refreshVaultIfChanged` deliberately fails
// OPEN when the changed file will not decrypt: it warns once and keeps serving
// the previously loaded dict, so a torn write never costs the fleet its vault
// access. Defensible for READS. These suites pin the two places it must not
// reach, plus the unlock stat ordering that decides whether a boot-time race
// is ever noticed.
//
// NOTE: bun-run only (VaultBroker → grants-db → bun:sqlite); this file is
// vitest-excluded and on the #3756 known-orphan allowlist.

function makeVaultBackedAclConfig(vaultPath: string, keys: string[]) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: vaultPath,
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: { myagent: { schedule: [{ secrets: keys }] } },
  } as any;
}

describe("VaultBroker op:put refuses to persist over a vault it could not re-open (#4736)", () => {
  const PASSPHRASE = "broker-put-guard-passphrase";
  const OTHER_PASSPHRASE = "operator-restored-from-backup-passphrase";
  const KEY = "myagent/rotating-token";

  let broker: VaultBroker;
  let tmpDir: string;
  let vaultPath: string;
  let socketPath: string;
  let auditPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-put-guard-"));
    vaultPath = path.join(tmpDir, "vault.enc");
    socketPath = path.join(tmpDir, "test.sock");
    auditPath = path.join(tmpDir, "audit.log");

    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, KEY, "OLD_TOKEN");

    broker = new VaultBroker({
      // Seeded empty so start() never reaches _tryAutoUnlock (hermeticity);
      // the unlock below installs the REAL on-disk vault + its stamp.
      _testSecrets: {},
      _testConfig: makeVaultBackedAclConfig(vaultPath, [KEY]),
      _testVaultPath: vaultPath,
      _testAgentName: "myagent",
      _testAuditLogger: createAuditLogger({ path: auditPath }),
    });
    await broker.start(socketPath, undefined, undefined);
    broker.unlockFromPassphrase(PASSPHRASE);
  });

  afterEach(() => {
    if (broker) broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  // Positive control: with a healthy vault the rotation this guard protects
  // still works end-to-end. Without this, "refuse everything" would pass.
  it("persists a normal rotation when the vault on disk is the one it loaded", async () => {
    const resp = await rpc(socketPath, {
      v: 1, op: "put", key: KEY, entry: { kind: "string", value: "ROTATED_TOKEN" },
    });
    expect(resp.ok).toBe(true);
    expect(getStringSecret(PASSPHRASE, vaultPath, KEY)).toBe("ROTATED_TOKEN");
  });

  it("refuses the put — and leaves the operator's file byte-identical — after a failed re-open", async () => {
    // Operator restores vault.enc from a backup encrypted under a DIFFERENT
    // passphrase. The broker stats a new inode, cannot decrypt it, warns once
    // and keeps serving its pre-restore dict (the fail-open read path).
    fs.rmSync(vaultPath);
    createVault(OTHER_PASSPHRASE, vaultPath);
    setStringSecret(OTHER_PASSPHRASE, vaultPath, KEY, "RESTORED_FROM_BACKUP");
    const bytesBefore = fs.readFileSync(vaultPath);

    const resp = await rpc(socketPath, {
      v: 1, op: "put", key: KEY, entry: { kind: "string", value: "ROTATED_TOKEN" },
    });

    // The assertion that actually matters, and it goes FIRST: the operator's
    // restored file is untouched. Asserting only the error code would still
    // pass if saveVault had already re-encrypted the stale dict over it.
    expect(fs.readFileSync(vaultPath).equals(bytesBefore)).toBe(true);
    expect(getStringSecret(OTHER_PASSPHRASE, vaultPath, KEY)).toBe("RESTORED_FROM_BACKUP");

    // The response is a refusal...
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("INTERNAL");
      expect(resp.msg).toContain("put refused");
      // Never a secret value in an error message.
      expect(resp.msg).not.toContain("OLD_TOKEN");
      expect(resp.msg).not.toContain("ROTATED_TOKEN");
      expect(resp.msg).not.toContain("RESTORED_FROM_BACKUP");
    }

    // Audited as a refusal, with the key name only.
    const rows = readAuditLines(auditPath).filter((r) => r.op === "put");
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("denied:vault-file-unreadable");
    expect(JSON.stringify(rows[0])).not.toContain("ROTATED_TOKEN");
  });
});

describe("VaultBroker runtime vault-layout drift fails closed, never fail-open (#4736)", () => {
  const PASSPHRASE = "broker-drift-runtime-passphrase";
  const KEY = "myagent/rotating-token";

  let broker: VaultBroker;
  let tmpHome: string;
  let switchroomDir: string;
  let vaultPath: string;
  let legacyPath: string;
  let socketPath: string;
  let auditPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "broker-drift-runtime-"));
    switchroomDir = path.join(tmpHome, ".switchroom");
    const vaultDir = path.join(switchroomDir, "vault");
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    vaultPath = path.join(vaultDir, "vault.enc");
    legacyPath = path.join(switchroomDir, "vault.enc");
    socketPath = path.join(tmpHome, "test.sock");
    auditPath = path.join(tmpHome, "audit.log");

    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, KEY, "OLD_TOKEN");
    // Post-migration shape (state D): legacy path is a symlink to the new one.
    fs.symlinkSync("vault/vault.enc", legacyPath);

    broker = new VaultBroker({
      _testSecrets: {},
      _testConfig: makeVaultBackedAclConfig(vaultPath, [KEY]),
      _testVaultPath: vaultPath,
      _testAgentName: "myagent",
      _testAuditLogger: createAuditLogger({ path: auditPath }),
    });
    await broker.start(socketPath, undefined, undefined);
    broker.unlockFromPassphrase(PASSPHRASE);
  });

  afterEach(() => {
    if (broker) broker.stop();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("stops serving when the legacy path diverges after unlock", async () => {
    // Sanity: the broker serves the key before drift appears.
    const before = await rpc(socketPath, { v: 1, op: "get", key: KEY });
    expect(before.ok).toBe(true);

    // An older CLI writes the LEGACY path (rename replaces the symlink) with
    // different content, and the canonical file also moves — broker and CLI
    // are now writing different files. At unlock this is fatal by design.
    fs.rmSync(legacyPath);
    fs.writeFileSync(legacyPath, "divergent-legacy-vault-content", { mode: 0o600 });
    setStringSecret(PASSPHRASE, vaultPath, KEY, "NEWER_TOKEN");

    const after = await rpc(socketPath, { v: 1, op: "get", key: KEY });
    // Pre-fix this returned ok with a value: the drift throw was swallowed by
    // the refresh's generic catch, which warned once and kept serving.
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("LOCKED");

    // Fail-closed for real: the broker dropped its secrets and reports locked.
    expect(broker._getSecretsRef()).toBeNull();
    const status = await rpc(socketPath, { v: 1, op: "status" });
    expect(status.ok).toBe(true);
    if (status.ok && "status" in status) expect(status.status.unlocked).toBe(false);

    // And the escalation is on the record, without secret material.
    const rows = readAuditLines(auditPath);
    const drift = rows.filter((r) => r.result === "error:vault-layout-drift");
    expect(drift).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("OLD_TOKEN");
    expect(JSON.stringify(rows)).not.toContain("NEWER_TOKEN");
  });
});

describe("VaultBroker unlock stamps the vault BEFORE decrypting it (#4736)", () => {
  const PASSPHRASE = "broker-unlock-stamp-passphrase";
  const KEY = "myagent/rotating-token";

  let broker: VaultBroker;
  let tmpDir: string;
  let vaultPath: string;
  let socketPath: string;
  let prevNonLinuxFlag: string | undefined;
  let child: import("node:child_process").ChildProcess | null = null;

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-unlock-stamp-"));
    vaultPath = path.join(tmpDir, "vault.enc");
    socketPath = path.join(tmpDir, "test.sock");
  });

  afterEach(() => {
    if (child) { try { child.kill(); } catch { /* ignore */ } child = null; }
    if (broker) broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("sees a write that lands inside the KDF window (apply racing boot)", async () => {
    // The whole scenario is a race the broker cannot avoid: openVault pays a
    // ~50ms scrypt derivation, and unlock runs at boot — exactly when
    // `switchroom apply` may be rewriting the vault. Stamping AFTER the
    // decrypt records the NEW file's identity against the OLD content, and
    // the stat-on-access reload then sees "unchanged" and serves the stale
    // value indefinitely. Stamping first fails the safe way.
    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, KEY, "OLD_TOKEN");

    // Stage the operator's new vault ahead of time so the racing step is a
    // bare rename (microseconds) — the test must not depend on a second
    // scrypt fitting inside the window.
    const stagedPath = path.join(tmpDir, "staged.enc");
    createVault(PASSPHRASE, stagedPath);
    setStringSecret(PASSPHRASE, stagedPath, KEY, "NEW_TOKEN");

    // A separate PROCESS is required: unlockFromPassphrase is synchronous, so
    // nothing on this event loop can run during the derivation.
    const goPath = path.join(tmpDir, "go");
    const donePath = path.join(tmpDir, "done");
    const readyPath = path.join(tmpDir, "ready");
    const racerPath = path.join(tmpDir, "racer.mjs");
    fs.writeFileSync(racerPath, [
      "import * as fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, '');`,
      "const sleeper = new Int32Array(new SharedArrayBuffer(4));",
      `while (!fs.existsSync(${JSON.stringify(goPath)})) { Atomics.wait(sleeper, 0, 0, 1); }`,
      `fs.renameSync(${JSON.stringify(stagedPath)}, ${JSON.stringify(vaultPath)});`,
      `fs.writeFileSync(${JSON.stringify(donePath)}, String(Date.now()));`,
    ].join("\n"));
    const { spawn } = await import("node:child_process");
    child = spawn(process.execPath, [racerPath], { stdio: "ignore" });
    const readyDeadline = Date.now() + 10_000;
    while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(fs.existsSync(readyPath)).toBe(true);

    broker = new VaultBroker({
      _testSecrets: {},
      _testConfig: makeVaultBackedAclConfig(vaultPath, [KEY]),
      _testVaultPath: vaultPath,
      _testAgentName: "myagent",
      _testAuditLogger: createAuditLogger({ path: path.join(tmpDir, "audit.log") }),
    });
    await broker.start(socketPath, undefined, undefined);

    // Release the racer, then immediately burn the KDF window.
    fs.writeFileSync(goPath, "");
    const startedAt = Date.now();
    broker.unlockFromPassphrase(PASSPHRASE);
    const finishedAt = Date.now();

    // The race must actually have landed inside the window, or the test
    // proves nothing.
    expect(fs.existsSync(donePath)).toBe(true);
    const racedAt = Number(fs.readFileSync(donePath, "utf-8"));
    expect(racedAt).toBeGreaterThanOrEqual(startedAt);
    expect(racedAt).toBeLessThanOrEqual(finishedAt);

    // Pre-fix: the post-decrypt stat recorded the RENAMED file, so the reload
    // saw no change and this returned OLD_TOKEN forever.
    const resp = await rpc(socketPath, { v: 1, op: "get", key: KEY });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp && resp.entry.kind === "string") {
      expect(resp.entry.value).toBe("NEW_TOKEN");
    }
  }, 30_000);
});
