/**
 * Tests for VaultBroker grant operations and token-based access.
 *
 * Covers (issue #225):
 *   - mint_grant: client mints, token file written, audit logged
 *   - get with valid token: bypasses peercred, returns secret
 *   - get with no token: falls through to peercred (regression guard)
 *   - get with expired token: returns denied:grant-expired
 *   - get with key-not-in-allowlist: returns denied:grant-key-not-allowed
 *   - revoke_grant: removes token file, future token use fails
 *   - list_grants: returns active grants (filtered by agent if requested)
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import {
  encodeRequest,
  decodeResponse,
  type BrokerResponse,
} from "./protocol.js";
import type { VaultEntry } from "../vault.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";
import { migrateGrantsSchema, mintGrant } from "../grants.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_SECRETS: Record<string, VaultEntry> = {
  foo: { kind: "string", value: "bar-value" },
  baz: { kind: "binary", value: "aGVsbG8=" },
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

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("VaultBroker: grant operations (mint_grant / list_grants / revoke_grant)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  // #1561: the broker resolves `~/.switchroom/agents/<agent>/.vault-token`
  // via `resolveAgentsDir()` when minting grants. Without overriding
  // SWITCHROOM_AGENTS_DIR the mint path writes into the operator's REAL
  // `~/.switchroom/agents/`, creating fixture-named dirs (myagent,
  // agent1, …) — and on this shared host that propagated into a
  // vault-rewrite that destroyed the live vault.enc (incident
  // 2026-05-20, see PR). Override SWITCHROOM_AGENTS_DIR for the duration
  // of the test — this is the reliable override honored by
  // resolveAgentsDir() (unlike mutating process.env.HOME, which
  // os.homedir() does not reread after process start). Restored in
  // afterEach.
  let agentsDir: string;
  let prevAgentsDirEnv: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-grants-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    // MUST come BEFORE broker.start() — the broker resolves the agents
    // dir when constructing token write paths during mint_grant.
    agentsDir = path.join(tmpDir, "agents");
    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];

    const testAuditLogger = { write: (e: AuditEntry) => { auditEntries.push(e); } };

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: testAuditLogger,
    });
    await broker.start(socketPath, undefined, undefined);
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

  // ── mint_grant ────────────────────────────────────────────────────────────

  it("mint_grant: returns token, id, and expires_at", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "myagent",
      keys: ["foo"],
      ttl_seconds: 3600,
      description: "test grant",
    });

    expect(resp.ok).toBe(true);
    if (resp.ok && "token" in resp) {
      expect(typeof resp.token).toBe("string");
      expect(resp.token).toMatch(/^vg_[0-9a-f]{6}\./);
      expect(typeof resp.id).toBe("string");
      expect(resp.id).toMatch(/^vg_/);
      expect(typeof resp.expires_at).toBe("number");
    }
  });

  it("mint_grant: writes token file at ~/.switchroom/agents/<agent>/.vault-token", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "myagent",
      keys: ["foo"],
      ttl_seconds: null,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok && "token" in resp) {
      const expectedPath = path.join(agentsDir, "myagent", ".vault-token");
      expect(fs.existsSync(expectedPath)).toBe(true);
      const fileContent = fs.readFileSync(expectedPath, "utf8");
      expect(fileContent).toBe(resp.token);
    }
  });

  it("mint_grant: audit logs with method:grant and grant_id (no token in log)", async () => {
    await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "myagent",
      keys: ["foo"],
      ttl_seconds: 3600,
    });

    const mintEntry = auditEntries.find((e) => e.op === "mint_grant");
    expect(mintEntry).toBeDefined();
    expect(mintEntry?.result).toBe("allowed");
    expect(mintEntry?.method).toBe("grant");
    expect(mintEntry?.grant_id).toMatch(/^vg_/);
    // Confirm the raw token secret is NOT in the audit log
    if (mintEntry?.grant_id) {
      expect(mintEntry.grant_id).not.toContain(".");
    }
  });

  // ── list_grants ───────────────────────────────────────────────────────────

  it("list_grants: returns all active grants", async () => {
    // Mint two grants first
    await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "agent1", keys: ["foo"], ttl_seconds: null,
    });
    await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "agent2", keys: ["baz"], ttl_seconds: null,
    });

    const resp = await rpc(socketPath, { v: 1, op: "list_grants" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "grants" in resp) {
      expect(resp.grants.length).toBe(2);
      // No secret_hash in the response
      for (const g of resp.grants) {
        expect("secret_hash" in g).toBe(false);
      }
    }
  });

  it("list_grants: filters by agent", async () => {
    await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "agent1", keys: ["foo"], ttl_seconds: null,
    });
    await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "agent2", keys: ["baz"], ttl_seconds: null,
    });

    const resp = await rpc(socketPath, { v: 1, op: "list_grants", agent: "agent1" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "grants" in resp) {
      expect(resp.grants.length).toBe(1);
      expect(resp.grants[0].agent_slug).toBe("agent1");
    }
  });

  // ── revoke_grant ──────────────────────────────────────────────────────────

  it("revoke_grant: returns revoked:true for existing grant", async () => {
    const mintResp = await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "myagent", keys: ["foo"], ttl_seconds: null,
    });
    expect(mintResp.ok).toBe(true);
    if (!mintResp.ok || !("id" in mintResp)) return;

    const revokeResp = await rpc(socketPath, {
      v: 1, op: "revoke_grant", id: mintResp.id,
    });
    expect(revokeResp.ok).toBe(true);
    if (revokeResp.ok && "revoked" in revokeResp) {
      expect(revokeResp.revoked).toBe(true);
    }
  });

  it("revoke_grant: removes the token file", async () => {
    const mintResp = await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "myagent", keys: ["foo"], ttl_seconds: null,
    });
    expect(mintResp.ok).toBe(true);
    if (!mintResp.ok || !("id" in mintResp)) return;

    const tokenPath = path.join(agentsDir, "myagent", ".vault-token");
    expect(fs.existsSync(tokenPath)).toBe(true);

    await rpc(socketPath, { v: 1, op: "revoke_grant", id: mintResp.id });

    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  it("revoke_grant: returns revoked:false for unknown id", async () => {
    const resp = await rpc(socketPath, {
      v: 1, op: "revoke_grant", id: "vg_000000",
    });
    expect(resp.ok).toBe(true);
    if (resp.ok && "revoked" in resp) {
      expect(resp.revoked).toBe(false);
    }
  });
});

// ─── Token-based get/list tests ───────────────────────────────────────────────

describe("VaultBroker: token-based get access (issue #225)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-token-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];

    const testAuditLogger = { write: (e: AuditEntry) => { auditEntries.push(e); } };

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: testAuditLogger,
      // No _testIdentify → peer will be null on Linux (peercred unavailable)
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

  it("get with valid token: returns secret (bypasses peercred — no peer needed)", async () => {
    // Mint a grant directly against the in-memory DB (no broker round-trip needed
    // for setup — simpler and faster).
    const { token } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }

    // Audit should record method:grant
    const getEntry = auditEntries.find((e) => e.op === "get" && e.result === "allowed");
    expect(getEntry).toBeDefined();
    expect(getEntry?.method).toBe("grant");
    expect(getEntry?.grant_id).toMatch(/^vg_/);
  });

  it("get with no token: falls through to peercred (regression guard)", async () => {
    // On Linux with no peer identity, the broker should deny (not crash or succeed
    // via grant path). On non-Linux it returns UNKNOWN_KEY or the value normally.
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo" });

    if (process.platform === "linux") {
      // Peercred path: no peer → denied
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("DENIED");
      }
    } else {
      // Non-Linux: no peercred, socket-mode 0600 is the gate — key should be returned
      expect(resp.ok).toBe(true);
    }

    // Confirm no grant audit entry was written (peercred path taken, not grant)
    const grantGet = auditEntries.find((e) => e.op === "get" && e.method === "grant");
    expect(grantGet).toBeUndefined();
  });

  // Behaviour change (read-path unusable-token fall-through): an EXPIRED
  // token is no longer hard-denied on `get`/`list` — like the in-prod
  // `put` precedent, it falls through to path-as-identity so an agent
  // with a standing schedule.secrets[] grant is still served. In this
  // harness no agent identity is parsed from the /tmp socket, so the
  // fall-through lands on the path-as-identity DENIED — but the denial
  // reason is NO LONGER "grant-expired" (proving fall-through, not a
  // token hard-deny).
  it("get with expired token: falls through to path-as-identity (not denied:grant-expired)", async () => {
    const { token, id } = await mintGrant(grantsDb, "myagent", ["foo"], 3600);
    const past = Math.floor(Date.now() / 1000) - 100;
    grantsDb.run("UPDATE vault_grants SET expires_at = ? WHERE id = ?", [past, id]);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).not.toContain("grant-expired"); // fell through
    }
  });

  it("get with key-not-in-allowlist: falls through to path-as-identity (not denied:grant-key-not-allowed)", async () => {
    // Grant only allows "baz", but we request "foo". The token is valid
    // but grants nothing for "foo" → unusable for this key → fall through
    // (an agent with schedule.secrets[] for "foo" should still be served).
    const { token } = await mintGrant(grantsDb, "myagent", ["baz"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).not.toContain("grant-key-not-allowed"); // fell through
    }
  });

  it("get with invalid token: returns denied:grant-invalid", async () => {
    const resp = await rpc(socketPath, {
      v: 1,
      op: "get",
      key: "foo",
      token: "vg_000000.totally-fake-secret",
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
    }
  });

  it("revoke_grant: future get with revoked token fails", async () => {
    const { token, id } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    // First, verify it works
    const firstResp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(firstResp.ok).toBe(true);

    // Revoke it
    const revokeResp = await rpc(socketPath, { v: 1, op: "revoke_grant", id });
    expect(revokeResp.ok).toBe(true);

    // Now it should fail
    const afterResp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(afterResp.ok).toBe(false);
    if (!afterResp.ok) {
      expect(afterResp.code).toBe("DENIED");
      expect(afterResp.msg).toContain("grant-revoked");
    }
  });
});
