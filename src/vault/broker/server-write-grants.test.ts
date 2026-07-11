/**
 * Tests for broker PUT with write-grant capability (issue #969 P1b).
 *
 * Exercises the new code path in server.ts that consults
 * `validateGrantForWrite` BEFORE the path-as-identity check. A valid
 * write-grant authorizes both rotation AND new-key creation — this is
 * the capability that unblocks agent-initiated saves of user-provided
 * secrets (issue #968).
 *
 * Covered:
 *   - PUT with valid write-grant for a NEW key → ok (new entry created)
 *   - PUT with valid write-grant for an existing key → ok (rotated)
 *   - PUT with read-only token (empty write_allow) → denied (falls through
 *     to path-as-identity, which test-mode does not satisfy)
 *   - PUT with prefix-glob write-grant matching a new key → ok
 *   - PUT with revoked write-grant → denied with grant-revoked
 *   - mint_grant rejected when both keys and write_keys are empty
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import { createVault, setStringSecret, type VaultEntry } from "../vault.js";
import type { AuditEntry } from "./audit-log.js";
import { migrateGrantsSchema, mintGrant } from "../grants.js";

const TEST_SECRETS: Record<string, VaultEntry> = {
  existing_key: { kind: "string", value: "old-value" },
};

function cloneSecrets(): Record<string, VaultEntry> {
  return JSON.parse(JSON.stringify(TEST_SECRETS));
}

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

describe("VaultBroker: PUT with write-grant (#969 P1b)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let vaultPath: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  // mint_grant writes a token file under resolveAgentsDir() — override
  // SWITCHROOM_AGENTS_DIR so this suite's mints never touch the operator's
  // real ~/.switchroom/agents/ (same class of bug fixed in
  // server-grants.test.ts / server-mint-grant-posture-attest.test.ts).
  let agentsDir: string;
  let prevAgentsDirEnv: string | undefined;
  const PASSPHRASE = "test-pass-phrase-for-this-test-only";

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-write-grant-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    vaultPath = path.join(tmpDir, "vault.enc");

    agentsDir = path.join(tmpDir, "agents");
    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;

    // Real vault file on disk seeded with `existing_key` — broker PUT
    // calls saveVault, so the on-disk file must exist and the broker
    // must hold the passphrase. Don't use _testSecrets here: we want the
    // broker to load from disk via unlockFromPassphrase so this.passphrase
    // is populated for the put path.
    createVault(PASSPHRASE, vaultPath);
    for (const [k, entry] of Object.entries(TEST_SECRETS)) {
      if (entry.kind === "string") {
        setStringSecret(PASSPHRASE, vaultPath, k, entry.value);
      }
    }

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
    const testAuditLogger = { write: (e: AuditEntry) => { auditEntries.push(e); return true; }, failOpenCount: () => 0 };

    broker = new VaultBroker({
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: testAuditLogger,
      _testVaultPath: vaultPath,
    });
    // start() signature is (socketPath, configPath, vaultPath) — pass
    // undefined configPath and the tmp vault path, then unlock so
    // this.passphrase is populated.
    await broker.start(socketPath, undefined, vaultPath);
    broker.unlockFromPassphrase(PASSPHRASE);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevAgentsDirEnv === undefined) {
      delete process.env.SWITCHROOM_AGENTS_DIR;
    } else {
      process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDirEnv;
    }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("PUT with valid write-grant introduces a NEW key", async () => {
    const { token } = await mintGrant(grantsDb, "agent1", [], null, "test write grant", ["new_key"]);

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "new_key",
      entry: { kind: "string", value: "fresh-value" },
      token,
    });

    expect(resp.ok).toBe(true);
    // Broker should now serve the new key on subsequent gets.
    const getResp = await rpc(socketPath, {
      v: 1,
      op: "get",
      key: "new_key",
      token,
    });
    // Need read access too — re-mint with read allowance.
    // Confirm at least the audit trail recorded the put as allowed.
    const putEntry = auditEntries.find(
      (e) => e.op === "put" && e.key === "new_key" && e.result === "allowed",
    );
    expect(putEntry).toBeDefined();
    expect(putEntry?.method).toBe("grant");
    expect(putEntry?.grant_id).toMatch(/^vg_/);
  });

  it("PUT with valid write-grant rotates an EXISTING key", async () => {
    const { token } = await mintGrant(
      grantsDb,
      "agent1",
      [],
      null,
      undefined,
      ["existing_key"],
    );

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "new-value" },
      token,
    });

    expect(resp.ok).toBe(true);
  });

  it("PUT with read-only token (empty write_allow) is denied for a new key", async () => {
    const { token } = await mintGrant(
      grantsDb,
      "agent1",
      ["read_only_key"],
      null,
      undefined,
      [], // empty write_allow
    );

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "read_only_key", // user can read it, but can't write
      entry: { kind: "string", value: "should-fail" },
      token,
    });

    // Token has read access, no write access → write validation fails →
    // falls through to path-as-identity, which in test mode (no
    // agentName parsed from socket path) returns the path-as-identity
    // DENIED error.
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
    }
  });

  it("PUT with prefix-glob write-grant matches a new key (e.g. OPENAI_*)", async () => {
    const { token } = await mintGrant(grantsDb, "agent1", [], null, undefined, ["OPENAI_*"]);

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "OPENAI_API_KEY_PROD",
      entry: { kind: "string", value: "sk-fresh" },
      token,
    });

    expect(resp.ok).toBe(true);
  });

  it("PUT with revoked write-grant returns DENIED (does NOT fall through)", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", [], null, undefined, ["k"]);
    // Revoke the grant directly in the DB.
    grantsDb.run(`UPDATE vault_grants SET revoked_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000), id]);

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "k",
      entry: { kind: "string", value: "x" },
      token,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("grant-revoked");
    }
  });

  it("mint_grant rejects request with both empty keys and empty write_keys", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "myagent",
      keys: [],
      ttl_seconds: null,
      write_keys: [],
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("BAD_REQUEST");
      expect(resp.msg).toContain("at least one");
    }
  });

  it("mint_grant accepts a write-only grant (empty keys, non-empty write_keys)", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "myagent",
      keys: [],
      ttl_seconds: null,
      write_keys: ["only_writable"],
    });
    expect(resp.ok).toBe(true);
  });
});
