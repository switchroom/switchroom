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

const TEST_SECRETS: Record<string, VaultEntry> = {
  foo: { kind: "string", value: "bar-value" },
  baz: { kind: "binary", value: "aGVsbG8=" },
  filekey: {
    kind: "files",
    files: { "cert.pem": { encoding: "utf8", value: "---CERT---" } },
  },
};

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
      _testSecrets: { ...TEST_SECRETS },
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

  // ── list ───────────────────────────────────────────────────────────────

  it("list: returns all key names", async () => {
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
