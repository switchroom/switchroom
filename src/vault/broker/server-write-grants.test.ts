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

// ─── sec #3084-F4 (write path): identity-bind cross-check on PUT ──────────────
//
// The `get` token path cross-checks a capability token's owning agent
// against the calling socket's bind-time identity and denies a mismatch
// (server.ts ~line 1297; covered by server-grants.test.ts F4). The write
// (`put`) token path historically discarded `v.grant.agent_slug`, so a
// write-grant token leaked to another agent's container could be replayed
// over that agent's OWN bound socket to overwrite/plant shared secrets,
// bypassing the path-as-identity ACL. This block asserts the OUTCOME of the
// mirrored guard:
//   (a) a write-grant whose agent_slug != the socket bind identity is DENIED
//       with grant-identity-mismatch (and NOT written);
//   (b) a matching-identity write still succeeds;
//   (c) the no-bind-identity (operator/legacy) write path is unchanged.
describe("VaultBroker: PUT write-grant identity bind (sec #3084-F4 write path)", () => {
  let socketPath: string;
  let tmpDir: string;
  let vaultPath: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  let agentsDir: string;
  let prevAgentsDirEnv: string | undefined;
  const PASSPHRASE = "test-pass-phrase-for-this-test-only";
  const brokers: VaultBroker[] = [];

  // Build a broker with a real on-disk vault (PUT calls saveVault) and an
  // optional bind identity. When `agentName` is passed, the handler defaults
  // its per-connection identity to it (server.ts _handleDataConnection), which
  // is exactly what socketPathToAgent would establish at bind time in prod.
  async function makeBroker(agentName?: string): Promise<string> {
    const sp = path.join(tmpDir, `${agentName ?? "nobind"}.sock`);
    const b = new VaultBroker({
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: {
        write: (e: AuditEntry) => { auditEntries.push(e); return true; },
        failOpenCount: () => 0,
      },
      _testVaultPath: vaultPath,
      ...(agentName !== undefined ? { _testAgentName: agentName } : {}),
    });
    await b.start(sp, undefined, vaultPath);
    b.unlockFromPassphrase(PASSPHRASE);
    brokers.push(b);
    return sp;
  }

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-write-idbind-test-"));
    vaultPath = path.join(tmpDir, "vault.enc");

    agentsDir = path.join(tmpDir, "agents");
    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;

    createVault(PASSPHRASE, vaultPath);
    for (const [k, entry] of Object.entries(TEST_SECRETS)) {
      if (entry.kind === "string") {
        setStringSecret(PASSPHRASE, vaultPath, k, entry.value);
      }
    }

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
  });

  afterEach(() => {
    for (const b of brokers.splice(0)) { try { b.stop(); } catch { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevAgentsDirEnv === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDirEnv;
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
  });

  it("(a) write-grant whose agent_slug != socket bind identity is DENIED (not written)", async () => {
    // Bind identity is "myagent"; the leaked write-grant belongs to "otheragent".
    const socketPath = await makeBroker("myagent");
    const { token } = await mintGrant(
      grantsDb, "otheragent", [], null, "leaked write grant", ["existing_key"],
    );

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "planted-by-attacker" },
      token,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("grant-identity-mismatch");
    }
    // Audited as an identity-mismatch denial on the put/grant method.
    const mismatch = auditEntries.find(
      (e) => e.op === "put" && String(e.result).includes("grant-identity-mismatch"),
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.method).toBe("grant");
    // The write must NOT have been served.
    const served = auditEntries.find((e) => e.op === "put" && e.result === "allowed");
    expect(served).toBeUndefined();
  });

  it("(b) write-grant whose agent_slug matches the bind identity still succeeds", async () => {
    const socketPath = await makeBroker("myagent");
    const { token } = await mintGrant(
      grantsDb, "myagent", [], null, undefined, ["existing_key"],
    );

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "rotated-by-owner" },
      token,
    });

    expect(resp.ok).toBe(true);
    const served = auditEntries.find(
      (e) => e.op === "put" && e.key === "existing_key" && e.result === "allowed",
    );
    expect(served).toBeDefined();
    expect(served?.method).toBe("grant");
  });

  it("(c) no-bind-identity (operator/legacy) write path is unchanged — any valid write-grant is served", async () => {
    // agentName === null: no identity to compare, token remains sole auth.
    const socketPath = await makeBroker();
    const { token } = await mintGrant(
      grantsDb, "otheragent", [], null, undefined, ["existing_key"],
    );

    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "existing_key",
      entry: { kind: "string", value: "rotated-no-bind" },
      token,
    });

    expect(resp.ok).toBe(true);
    // No identity-mismatch denial when there is no bind identity to compare.
    const mismatch = auditEntries.find(
      (e) => e.op === "put" && String(e.result).includes("grant-identity-mismatch"),
    );
    expect(mismatch).toBeUndefined();
  });
});

// ─── sec #3084-F2 (write path): entry-scope enforcement on write-grant ────────
//
// Companion to the F4 identity-bind block above (landed separately in #3129).
// The GET token path also enforces the per-entry `scope` keyed on the grant's
// owning agent (server.ts ~line 1339, #3084-F3). The write (`put`) token path
// historically skipped it, so an entry's `scope.deny:[agent]` was silently
// ineffective against an outstanding write-token — the denied agent could
// still rotate/overwrite the value. This block asserts the OUTCOMES:
//
//   F2 — a write-token whose owning agent is in the target entry's `scope.deny`
//        is REJECTED (`scope-deny`) even when the socket identity binds, and
//        the value is NOT mutated.
//
// Plus an F1 read-back control that goes beyond the audit-only assertions of
// the F4 block above: it reads the target key back over the owning agent's own
// socket and proves the byte value is still the original after a denied
// cross-identity replay (the F4 block asserts "no allowed audit entry"; this
// asserts the persisted value directly). Both FAIL against the pre-fix broker.
describe("VaultBroker: PUT write-grant entry scope (sec #3084-F2 write path)", () => {
  let tmpDir: string;
  let vaultPath: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  let agentsDir: string;
  let prevAgentsDirEnv: string | undefined;
  const brokers: VaultBroker[] = [];
  const PASSPHRASE = "test-pass-phrase-for-identity-and-scope";

  // Build a broker whose EVERY connection is treated as `agentName` (bind
  // identity), sharing the on-disk vault + grants DB. Unlock so this.passphrase
  // is populated for the put/saveVault path.
  async function makeBroker(agentName: string): Promise<string> {
    const sp = path.join(tmpDir, `${agentName}.sock`);
    const b = new VaultBroker({
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: {
        write: (e: AuditEntry) => { auditEntries.push(e); return true; },
        failOpenCount: () => 0,
      },
      _testVaultPath: vaultPath,
      _testAgentName: agentName,
    });
    await b.start(sp, undefined, vaultPath);
    b.unlockFromPassphrase(PASSPHRASE);
    brokers.push(b);
    return sp;
  }

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-3084-write-test-"));
    vaultPath = path.join(tmpDir, "vault.enc");

    agentsDir = path.join(tmpDir, "agents");
    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;

    // Seed disk vault: a key writable by agent A, and a scoped entry that
    // DENIES "denyagent" (read-restriction semantics we now also honour on
    // write).
    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, "a_key", "a-original");
    setStringSecret(
      PASSPHRASE,
      vaultPath,
      "denied_key",
      "deny-original",
      undefined,
      { deny: ["denyagent"] },
    );

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
  });

  afterEach(() => {
    for (const b of brokers.splice(0)) { try { b.stop(); } catch { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevAgentsDirEnv === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDirEnv;
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
  });

  it("F1 read-back: agent B replaying agent A's write-token over B's own socket is REJECTED and the persisted value is unchanged", async () => {
    // Write-grant belongs to agent A; presented over agent B's socket.
    const { token } = await mintGrant(grantsDb, "agentA", [], null, "A's write grant", ["a_key"]);
    const bSocket = await makeBroker("agentB");

    const resp = await rpc(bSocket, {
      v: 1,
      op: "put",
      key: "a_key",
      entry: { kind: "string", value: "poisoned-by-B" },
      token,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("grant-identity-mismatch");
    }
    // Audited as an identity-mismatch on the grant method; never committed.
    const mismatch = auditEntries.find(
      (e) => e.op === "put" && e.method === "grant" && String(e.result).includes("grant-identity-mismatch"),
    );
    expect(mismatch).toBeDefined();
    const committed = auditEntries.find((e) => e.op === "put" && e.result === "allowed");
    expect(committed).toBeUndefined();

    // OUTCOME: the value must still be the original. Read it back over agent
    // A's own socket with a read grant.
    const { token: aReadToken } = await mintGrant(grantsDb, "agentA", ["a_key"], null, "A read");
    const aSocket = await makeBroker("agentA");
    const getResp = await rpc(aSocket, { v: 1, op: "get", key: "a_key", token: aReadToken });
    expect(getResp.ok).toBe(true);
    if (getResp.ok && "entry" in getResp) {
      expect(getResp.entry).toEqual({ kind: "string", value: "a-original" });
    }
  });

  it("F2: a write-token whose owning agent is in the entry's scope.deny is REJECTED (scope-deny) and the value is unchanged", async () => {
    // Identity binds correctly (denyagent == denyagent) — isolates the scope
    // check from the identity check. The entry denies denyagent.
    const { token } = await mintGrant(grantsDb, "denyagent", [], null, "deny write grant", ["denied_key"]);
    const socket = await makeBroker("denyagent");

    const resp = await rpc(socket, {
      v: 1,
      op: "put",
      key: "denied_key",
      entry: { kind: "string", value: "overwritten-despite-deny" },
      token,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("scope-deny");
    }
    const denied = auditEntries.find(
      (e) => e.op === "put" && e.method === "grant" && String(e.result).includes("scope-deny"),
    );
    expect(denied).toBeDefined();
    const committed = auditEntries.find((e) => e.op === "put" && e.result === "allowed");
    expect(committed).toBeUndefined();

    // OUTCOME: value unchanged. Read back as a non-denied agent (scope only
    // denies "denyagent") to confirm the write never landed.
    const { token: readToken } = await mintGrant(grantsDb, "readeragent", ["denied_key"], null, "reader read");
    const readSocket = await makeBroker("readeragent");
    const getResp = await rpc(readSocket, { v: 1, op: "get", key: "denied_key", token: readToken });
    expect(getResp.ok).toBe(true);
    if (getResp.ok && "entry" in getResp) {
      // The broker strips the scope metadata from the served entry; the
      // value being the original proves the denied write never landed.
      expect(getResp.entry.kind).toBe("string");
      if (getResp.entry.kind === "string") {
        expect(getResp.entry.value).toBe("deny-original");
      }
    }
  });
});
