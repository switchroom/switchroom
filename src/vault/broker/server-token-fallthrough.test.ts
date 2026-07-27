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
 * Two harnesses, deliberately (#3750):
 *
 *  1. UNIDENTIFIED caller (describe #1). A /tmp test cannot bind the
 *     literal /run/switchroom/broker/<agent>/sock, so `agentName` is
 *     null and the post-fall-through no-token path lands on the
 *     path-as-identity DENIED on Linux. That denial is CORRECT, not a
 *     bug: an unidentified caller has no standing ACL to fall through
 *     TO. So the invariant is asserted here as EQUIVALENCE — a request
 *     carrying an unusable token must produce a byte-identical result
 *     to the same request with NO token — never as a hard-coded
 *     `ok: true`, which the design does not promise for a caller it
 *     cannot identify. (#3750: the `list` case asserted exactly that
 *     un-promised `ok: true` and was red on `main`.) Plus the
 *     highest-risk invariant (reviewer B1): on fall-through there is
 *     exactly ONE terminal audit row and it is NOT method:"grant" —
 *     the token-branch deny-audit must be gone, or #1433's hash-chain
 *     double-rows.
 *
 *  2. IDENTIFIED agent (describe #2). `_testAgentName` makes every
 *     connection agent-bound regardless of bind path, so the POSITIVE
 *     "fall-through → standing agents.<name>.secrets[] ACL → secret
 *     served / keys listed" path IS unit-assertable. An earlier
 *     revision of this header claimed it was not; that was stale, and
 *     believing it is what produced the wrong `list` assertion. This
 *     is the arm that goes red if the read path ever hard-denies on
 *     grant-invalid / grant-expired / grant-key-not-allowed.
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

  it("list with INVALID token → result is identical to a no-token list, single non-grant audit row", async () => {
    // The invariant is EQUIVALENCE, not success: an unusable token must
    // behave exactly as if no token were presented. Asserting a bare
    // `ok: true` here was wrong (#3750) — this harness cannot resolve an
    // agentName, so the no-token path itself correctly DENIES on the
    // path-as-identity gate, and there is nothing for a fall-through to
    // land on. Comparing the two responses pins the real promise on
    // every platform, and still goes red if the token branch ever
    // hard-denies grant-invalid (the denial would read "grant-invalid"
    // instead of the identity reason). The positive
    // fall-through-to-ACL arm is asserted in the identified-agent
    // describe below.
    const resp = await rpc(socketPath, { v: 1, op: "list", token: "vg_deadbe.0000000000000000000000000000000000000000000000000000000000000000" });
    const withTokenAudits = listAudits().slice();
    auditEntries.length = 0;
    const noToken = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp).toEqual(noToken);
    // Proof of fall-through: whatever the outcome, it is NOT reported as
    // the token reason — the token branch did not terminate the request.
    if (!resp.ok) expect(resp.msg).not.toContain("grant-invalid");
    expect(withTokenAudits).toHaveLength(1);               // B1: single terminal row
    expect(withTokenAudits[0].method).not.toBe("grant");   // B1: token-branch audit gone
    expect(withTokenAudits.some((e) => e.result === "denied:grant-invalid" && e.method === "grant")).toBe(false);
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

// ── Harness #2: IDENTIFIED agent with a standing ACL (#3750) ───────────
// `_testAgentName` treats every connection as agent-bound regardless of
// bind path, so the path-as-identity gate resolves and the standing
// `agents.agent1.secrets: [foo]` ACL is reachable. This is the arm that
// actually pins the security-relevant promise: a token that grants
// nothing usable must never leave the agent WORSE off than presenting
// no token at all.
describe("VaultBroker: read-path unusable-token fall-through (identified agent)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;

  const BAD_TOKEN =
    "vg_deadbe.0000000000000000000000000000000000000000000000000000000000000000";

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-tokenft-agent-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
    const config = makeMinimalConfig();
    // Standing operator-set ACL — the thing an unusable token must not shadow.
    config.agents = { agent1: { secrets: ["foo"] } };
    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: config,
      _testGrantsDb: grantsDb,
      _testAgentName: "agent1",
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

  it("get with INVALID token → falls through to the standing ACL and SERVES the secret", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token: BAD_TOKEN });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) expect((resp as any).entry.value).toBe("bar-value");
    const a = getAudits();
    expect(a).toHaveLength(1);
    expect(a[0].result).toBe("allowed");
    expect(a[0].method).not.toBe("grant");
  });

  it("get with EXPIRED token → falls through to the standing ACL and SERVES the secret", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    grantsDb.run(`UPDATE vault_grants SET expires_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000) - 3600, id]);
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) expect((resp as any).entry.value).toBe("bar-value");
    expect(getAudits()).toHaveLength(1);
  });

  it("get with a token scoped to ANOTHER key → falls through, standing ACL still serves", async () => {
    // grant-key-not-allowed: the token is genuine but covers nothing for
    // this key. It must not shadow the standing ACL.
    const { token } = await mintGrant(grantsDb, "agent1", ["other-key"], null);
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(true);
    if (resp.ok && "entry" in resp) expect((resp as any).entry.value).toBe("bar-value");
  });

  it("get with REVOKED token → still hard-denies (kill-switch survives an identified agent)", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    grantsDb.run(`UPDATE vault_grants SET revoked_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000), id]);
    const resp = await rpc(socketPath, { v: 1, op: "get", key: "foo", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.msg).toContain("grant-revoked");
    const a = getAudits();
    expect(a).toHaveLength(1);
    expect(a[0].method).toBe("grant");
  });

  it("list with INVALID token → falls through and lists the ACL-visible keys (identical to no token)", async () => {
    const resp = await rpc(socketPath, { v: 1, op: "list", token: BAD_TOKEN });
    expect(resp.ok).toBe(true);
    if (resp.ok && "keys" in resp) expect((resp as any).keys).toEqual(["foo"]);
    const withTokenAudits = listAudits().slice();
    auditEntries.length = 0;
    const noToken = await rpc(socketPath, { v: 1, op: "list" });
    expect(resp).toEqual(noToken);
    expect(withTokenAudits).toHaveLength(1);
    expect(withTokenAudits[0].method).not.toBe("grant");
  });

  it("list with REVOKED token → still hard-denies (kill-switch survives an identified agent)", async () => {
    const { token, id } = await mintGrant(grantsDb, "agent1", ["foo"], null);
    grantsDb.run(`UPDATE vault_grants SET revoked_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000), id]);
    const resp = await rpc(socketPath, { v: 1, op: "list", token });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.msg).toContain("grant-revoked");
    const a = listAudits();
    expect(a).toHaveLength(1);
    expect(a[0].method).toBe("grant");
  });
});
