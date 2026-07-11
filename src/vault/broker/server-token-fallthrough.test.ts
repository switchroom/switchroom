/**
 * Tests for the READ-path unusable-token fall-through (the deterministic
 * fix to "stale .vault-token shadows the standing schedule.secrets ACL").
 *
 * Mirrors the proven `put` precedent in server-write-grants.test.ts:
 * `validateGrantForWrite` already falls through on grant-invalid /
 * grant-write-not-allowed and hard-denies grant-revoked/expired. This
 * brings `get`/`list` into line, with one deliberate divergence on the
 * READ path (owner decision): only `grant-revoked` hard-denies;
 * `grant-invalid`, `grant-key-not-allowed` AND `grant-expired` fall
 * through (an unusable token must never be MORE restrictive than
 * presenting no token when the agent has a standing ACL).
 *
 * Harness limitation (same as the put precedent): a per-agent socket
 * path must literally be /run/switchroom/broker/<agent>/sock, which a
 * /tmp test cannot bind, so `agentName` is null here and the no-token
 * fall-through lands on the path-as-identity DENIED in test mode. The
 * positive "fall-through → standing ACL → secret served" path is
 * proven by the live gymbro repro + the identical, in-production `put`
 * fall-through. What IS unit-asserted here and is the highest-risk
 * invariant (reviewer B1): on fall-through there is exactly ONE
 * terminal audit row and it is NOT method:"grant" — the token-branch
 * deny-audit must be gone, or the #1433 hash-chain double-rows.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import type { VaultEntry } from "../vault.js";
import type { AuditEntry } from "./audit-log.js";
import { migrateGrantsSchema, mintGrant } from "../grants.js";

const TEST_SECRETS: Record<string, VaultEntry> = {
  foo: { kind: "string", value: "bar-value" },
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
        client.destroy();
        try { resolve(decodeResponse(buffer.slice(0, idx))); } catch (e) { reject(e); }
      }
    });
    client.on("connect", () => client.write(encodeRequest(req)));
  });
}

describe("VaultBroker: read-path unusable-token fall-through", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-tokenft-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: { write: (e: AuditEntry) => { auditEntries.push(e); return true; }, failOpenCount: () => 0 },
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
  });

  const getAudits = () => auditEntries.filter((e) => e.op === "get");
  const listAudits = () => auditEntries.filter((e) => e.op === "list");

  // ── revoked: hard-deny preserved (the only deliberate kill-switch) ──
  it("get with REVOKED token → DENIED grant-revoked, audited method:grant (no fall-through)", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    grantsDb.run(`UPDATE vault_grants SET revoked_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000), id]);
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) { expect(resp.code).toBe("DENIED"); expect(resp.msg).toContain("grant-revoked"); }
    const a = getAudits();
    expect(a).toHaveLength(1);
    expect(a[0].result).toBe("denied:grant-revoked");
    expect(a[0].method).toBe("grant"); // hard-deny stays grant-attributed
  });

  // ── invalid: falls through (NOT hard-denied on the token). B1: exactly
  //    one terminal row, NOT method:"grant". ──
  it("get with INVALID/garbage token → falls through (reason ≠ grant-invalid), single non-grant audit row", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token: "vg_deadbe.0000000000000000000000000000000000000000000000000000000000000000" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      // Proof of fall-through: the denial is the path-as-identity/ACL
      // reason, NOT the token reason. If it said grant-invalid the
      // token branch hard-denied (bug).
      expect(resp.msg).not.toContain("grant-invalid");
    }
    const a = getAudits();
    expect(a).toHaveLength(1);                       // B1: not double
    expect(a[0].method).not.toBe("grant");           // B1: token-branch audit gone
    expect(a.some((e) => e.result === "denied:grant-invalid" && e.method === "grant")).toBe(false);
  });

  // ── expired: owner divergence from `put` — expired ALSO falls through
  //    on the read path. ──
  it("get with EXPIRED token → falls through (reason ≠ grant-expired), single non-grant audit row", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    grantsDb.run(`UPDATE vault_grants SET expires_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000) - 3600, id]);
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) { expect(resp.code).toBe("DENIED"); expect(resp.msg).not.toContain("grant-expired"); }
    const a = getAudits();
    expect(a).toHaveLength(1);
    expect(a[0].method).not.toBe("grant");
  });

  // ── valid token: success arm untouched (regression guard) ──
  it("get with VALID in-scope token → ok, secret returned, audited method:grant", async () => {
    const { token } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) expect((resp as any).entry.value).toBe("bar-value");
    const a = getAudits();
    expect(a).toHaveLength(1);
    expect(a[0].result).toBe("allowed");
    expect(a[0].method).toBe("grant");
  });

  // ── list parallels ──
  it("list with REVOKED token → DENIED grant-revoked (hard-deny)", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    grantsDb.run(`UPDATE vault_grants SET revoked_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000), id]);
    const resp = await rpc(socketPath, { v: 1, op: "list", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) { expect(resp.code).toBe("DENIED"); expect(resp.msg).toContain("grant-revoked"); }
    const a = listAudits();
    expect(a).toHaveLength(1);
    expect(a[0].method).toBe("grant");
  });

  it("list with INVALID token → falls through to no-token list (ACL-filtered, single non-grant audit row)", async () => {
    // Unlike `get` (which hard-denies when the ACL grants nothing),
    // `list` post-fall-through behaves exactly like a no-token list:
    // it returns ok:true with the ACL-visible key set (empty in this
    // harness since config.agents={}), NOT a DENIED. The point of the
    // fix: an unusable token must behave identically to NO token.
    const resp = await rpc(socketPath, { v: 1, op: "list", token: "vg_deadbe.0000000000000000000000000000000000000000000000000000000000000000" });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) expect(Array.isArray((resp as any).keys)).toBe(true);
    const a = listAudits();
    expect(a).toHaveLength(1);                              // B1: single terminal row
    expect(a[0].method).not.toBe("grant");                 // B1: token-branch audit gone
    expect(a.some((e) => e.result === "denied:grant-invalid" && e.method === "grant")).toBe(false);
  });

  it("list with VALID token → ok (returns covered+existing keys), audited method:grant", async () => {
    const { token } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    const resp = await rpc(socketPath, { v: 1, op: "list", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) expect((resp as any).keys).toContain("foo");
    const a = listAudits();
    expect(a).toHaveLength(1);
    expect(a[0].method).toBe("grant");
  });
});
