/**
 * Tests for broker PUT with operator-passphrase attestation (issue #969 P1a).
 *
 * The Telegram gateway forwards the operator's passphrase as a `passphrase`
 * field on the PUT request. When it matches `this.passphrase` (set on
 * unlock), the broker treats the call as operator-attested and bypasses
 * path-as-identity / ACL / unknown-key gates.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import { createVault, setStringSecret } from "../vault.js";
import type { AuditEntry } from "./audit-log.js";
import { migrateGrantsSchema } from "../grants.js";

function makeMinimalConfig() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {},
  } as any;
}

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
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
        try { resolve(decodeResponse(line)); } catch (e) { reject(e); }
      }
    });
    client.on("connect", () => client.write(encodeRequest(req)));
  });
}

describe("VaultBroker: PUT with operator-passphrase attestation (#969 P1a)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let vaultPath: string;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  const PASSPHRASE = "operator-attestation-test-pass";

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-passphrase-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    vaultPath = path.join(tmpDir, "vault.enc");

    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, "existing_key", "old-value");

    const grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
    const testAuditLogger = { write: (e: AuditEntry) => { auditEntries.push(e); return true; }, failOpenCount: () => 0 };

    broker = new VaultBroker({
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: testAuditLogger,
      _testVaultPath: vaultPath,
    });
    await broker.start(socketPath, undefined, vaultPath);
    broker.unlockFromPassphrase(PASSPHRASE);
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

  it("PUT with matching passphrase introduces a NEW key", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "first_time_key",
      entry: { kind: "string", value: "freshly-pasted" },
      passphrase: PASSPHRASE,
    });

    expect(resp.ok).toBe(true);
    const allowed = auditEntries.find(
      (e) => e.op === "put" && e.key === "first_time_key" && e.result === "allowed",
    );
    expect(allowed).toBeDefined();
    expect(allowed?.method).toBe("passphrase");
  });

  it("PUT with matching passphrase rotates an EXISTING key", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "rotated-by-operator" },
      passphrase: PASSPHRASE,
    });
    expect(resp.ok).toBe(true);
  });

  it("PUT with WRONG passphrase fails closed with DENIED (no fall-through)", async () => {
    // A wrong passphrase asserts operator identity the caller doesn't
    // have — broker must refuse and not silently fall back to
    // path-as-identity. Otherwise a typo would mask the wrong-attestation
    // signal.
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "wrong-attestation" },
      passphrase: "definitely-not-the-real-passphrase",
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg.toLowerCase()).toContain("passphrase");
    }
    // Audit entry tags the path explicitly.
    const denied = auditEntries.find(
      (e) => e.op === "put" && e.key === "existing_key" && e.result === "denied:passphrase-mismatch",
    );
    expect(denied).toBeDefined();
    expect(denied?.method).toBe("passphrase");
  });

  it("PUT without passphrase or token falls through to path-as-identity (test-mode → DENIED)", async () => {
    // Sanity check: the new field is optional and doesn't break legacy
    // behaviour. Without passphrase, token, or path-as-identity, the
    // broker rejects.
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "no-attestation" },
    });
    expect(resp.ok).toBe(false);
  });

  it("PUT with passphrase can change entry kind (operator action)", async () => {
    // Path-as-identity put rejects kind changes. Operator-attested put
    // permits them — the operator is the source of truth for storage
    // shape.
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "binary", value: "YmluYXJ5dmFs" }, // 'binaryval' base64
      passphrase: PASSPHRASE,
    });
    expect(resp.ok).toBe(true);
  });
});
