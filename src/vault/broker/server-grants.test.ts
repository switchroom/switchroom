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
import { listGrants, migrateGrantsSchema, mintGrant } from "../grants.js";

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

    const testAuditLogger = { write: (e: AuditEntry) => { auditEntries.push(e); return true; }, failOpenCount: () => 0 };

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

  // ── mint_grant: token-file publish semantics (#3751) ──────────────────────

  it("mint_grant: rewrites an existing token file IN PLACE, preserving the inode", async () => {
    // `apply` pre-creates the mount source; on the live fleet that file is
    // bind-mounted into the broker container as a BARE FILE, i.e. a
    // mountpoint. rename(2) over it is EBUSY, so the publish must never
    // replace the inode. Pin that here: same inode, new bytes.
    const tokenPath = path.join(agentsDir, "myagent", ".vault-token");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "vg_oldold.0000", { mode: 0o600 });
    const before = fs.statSync(tokenPath);

    const resp = await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "myagent", keys: ["foo"], ttl_seconds: null,
    });

    expect(resp.ok).toBe(true);
    if (!resp.ok || !("token" in resp)) return;
    const after = fs.statSync(tokenPath);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(resp.token);
    // A tmp+rename publish would leave a `.tmp.<pid>` sibling behind when
    // the rename half fails.
    expect(fs.readdirSync(path.dirname(tokenPath))).toEqual([".vault-token"]);
  });

  it("mint_grant: FAILS the RPC when the token file cannot be written", async () => {
    // A directory at the token path is a real, un-mocked write failure of
    // the same class as the EBUSY the live broker hits over the bind mount.
    // Pre-fix the broker logged it and still answered ok:true with a live
    // grant row — the inconsistency behind #3751.
    const tokenPath = path.join(agentsDir, "myagent", ".vault-token");
    fs.mkdirSync(tokenPath, { recursive: true });

    const resp = await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "myagent", keys: ["foo"], ttl_seconds: null,
    });

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.code).toBe("INTERNAL");
    expect(resp.msg).toContain("Failed to write token file");
    expect("token" in resp).toBe(false);
  });

  it("mint_grant: rolls the grant back (revoked) when the token write fails", async () => {
    const tokenPath = path.join(agentsDir, "myagent", ".vault-token");
    fs.mkdirSync(tokenPath, { recursive: true });

    await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "myagent", keys: ["foo"], ttl_seconds: null,
    });

    // No live capability may outlive a failed publish: the row stays for
    // forensics but must be revoked, so listGrants (active only) is empty.
    expect(listGrants(grantsDb)).toEqual([]);
    const rows = grantsDb
      .query<{ id: string; revoked_at: number | null }, []>(
        "SELECT id, revoked_at FROM vault_grants",
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("mint_grant: audit-logs the token-write failure as an error, not 'allowed'", async () => {
    const tokenPath = path.join(agentsDir, "myagent", ".vault-token");
    fs.mkdirSync(tokenPath, { recursive: true });

    await rpc(socketPath, {
      v: 1, op: "mint_grant", agent: "myagent", keys: ["foo"], ttl_seconds: null,
    });

    const mintEntries = auditEntries.filter((e) => e.op === "mint_grant");
    expect(mintEntries.length).toBe(1);
    expect(mintEntries[0].result).toContain("error:token-write-failed");
    expect(mintEntries[0].grant_id).toMatch(/^vg_/);
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

    const testAuditLogger = { write: (e: AuditEntry) => { auditEntries.push(e); return true; }, failOpenCount: () => 0 };

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

// ─── sec #3084: entry-scope + identity-bind on the token get path ─────────────
//
// F3: the capability-token `get` path historically skipped `checkEntryScope`,
//     so an entry's `scope.deny:[agent]` was silently ineffective against an
//     outstanding token. OUTCOME: a token whose owning agent is denied by the
//     entry scope is now refused on the token path (was served before).
// F4: tokens are bearer capabilities. When the connection ALSO carries a
//     bind-time socket identity, the broker now cross-checks it against the
//     grant's `agent_slug` and rejects a mismatch. OUTCOME: a token replayed
//     over a DIFFERENT agent's bound socket is denied; the matching identity
//     and the legitimate no-bind-identity flow are unchanged.
describe("VaultBroker: token get — entry scope + identity bind (sec #3084)", () => {
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  const brokers: VaultBroker[] = [];

  // Secret with a scope that DENIES "myagent" — used to exercise F3.
  const scopedSecrets = (): Record<string, VaultEntry> => ({
    foo: { kind: "string", value: "bar-value" },
    denied: {
      kind: "string",
      value: "top-secret",
      scope: { deny: ["myagent"] },
    } as VaultEntry,
  });

  async function makeBroker(agentName?: string): Promise<string> {
    const sp = path.join(tmpDir, `${agentName ?? "nobind"}.sock`);
    const b = new VaultBroker({
      _testSecrets: scopedSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: {
        write: (e: AuditEntry) => { auditEntries.push(e); return true; },
        failOpenCount: () => 0,
      },
      ...(agentName !== undefined ? { _testAgentName: agentName } : {}),
    });
    await b.start(sp, undefined, undefined);
    brokers.push(b);
    return sp;
  }

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-3084-test-"));
    socketPath = ""; // set per-test by makeBroker
    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
  });

  afterEach(() => {
    for (const b of brokers.splice(0)) { try { b.stop(); } catch { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
  });

  // ── F3: entry scope enforced on the token path ─────────────────────────────

  it("F3: token for an entry that denies the grant's agent is refused (scope-deny)", async () => {
    socketPath = await makeBroker(); // no bind identity
    const { token } = await mintGrant(grantsDb, "myagent", ["denied"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "denied", token });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("scope-deny");
    }
    // Audited as a scope denial on the grant method, NOT served.
    const denyEntry = auditEntries.find(
      (e) => e.op === "get" && e.method === "grant" && String(e.result).includes("scope-deny"),
    );
    expect(denyEntry).toBeDefined();
    const served = auditEntries.find((e) => e.op === "get" && e.result === "allowed");
    expect(served).toBeUndefined();
  });

  it("F3: token for an entry with no adverse scope is still served (control)", async () => {
    socketPath = await makeBroker();
    const { token } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }
  });

  // ── F4: identity bind cross-check ──────────────────────────────────────────

  it("F4: token presented on a socket whose bind identity != grant.agent_slug is rejected", async () => {
    // Bind identity is "myagent"; grant belongs to "otheragent".
    socketPath = await makeBroker("myagent");
    const { token } = await mintGrant(grantsDb, "otheragent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("grant-identity-mismatch");
    }
    const mismatch = auditEntries.find(
      (e) => e.op === "get" && String(e.result).includes("grant-identity-mismatch"),
    );
    expect(mismatch).toBeDefined();
  });

  it("F4: token whose grant.agent_slug matches the bind identity is served", async () => {
    socketPath = await makeBroker("myagent");
    const { token } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }
  });

  it("F4: no-bind-identity connection serves any valid token as before (unchanged flow)", async () => {
    socketPath = await makeBroker(); // agentName === null
    const { token } = await mintGrant(grantsDb, "otheragent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }
    // No identity-mismatch denial when there is no bind identity to compare.
    const mismatch = auditEntries.find(
      (e) => e.op === "get" && String(e.result).includes("grant-identity-mismatch"),
    );
    expect(mismatch).toBeUndefined();
  });
});

// ─── sec WS10-F3 / #1420: audit fail-closed mode ──────────────────────────────
//
// OUTCOME assertions: when the audit append for a secret release FAILS, the
// broker must (a) still release the secret in the default fail-OPEN mode, and
// (b) DENY the release with AUDIT_UNAVAILABLE when fail-CLOSED is enabled — so a
// blinded audit trail can't be used to exfiltrate a secret silently.
describe("VaultBroker: audit fail-closed release gate (sec WS10-F3 / #1420)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let prevNonLinuxFlag: string | undefined;
  let prevFailClosedEnv: string | undefined;

  // A logger whose append ALWAYS fails (write → false), simulating a broken /
  // read-only / full audit volume. Bumps a local counter so the test can assert
  // the release path actually consulted the return value.
  let failedWrites: number;
  const failingLogger = {
    write: (_e: AuditEntry) => {
      failedWrites += 1;
      return false;
    },
    failOpenCount: () => failedWrites,
  };

  async function startBroker(failClosed: boolean): Promise<void> {
    if (failClosed) {
      process.env.SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED = "1";
    } else {
      delete process.env.SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED;
    }
    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: failingLogger,
    });
    await broker.start(socketPath, undefined, undefined);
  }

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    prevFailClosedEnv = process.env.SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-failclosed-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    grantsDb = makeInMemoryGrantsDb();
    failedWrites = 0;
  });

  afterEach(() => {
    try { broker.stop(); } catch { /* not started */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    if (prevFailClosedEnv === undefined) delete process.env.SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED;
    else process.env.SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED = prevFailClosedEnv;
  });

  it("fail-OPEN (default): failed audit append still releases the secret", async () => {
    await startBroker(false);
    const { token } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });

    // The audit write failed…
    expect(failedWrites).toBeGreaterThan(0);
    // …but the secret was released anyway (historical fail-open behaviour).
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) {
      expect(resp.entry).toEqual({ kind: "string", value: "bar-value" });
    }
  });

  it("fail-CLOSED: failed audit append DENIES the release with AUDIT_UNAVAILABLE", async () => {
    await startBroker(true);
    const { token } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });

    // The audit write failed AND the secret was withheld.
    expect(failedWrites).toBeGreaterThan(0);
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("AUDIT_UNAVAILABLE");
      // The response must NOT leak the secret value.
      expect(JSON.stringify(resp)).not.toContain("bar-value");
    }
  });
});
