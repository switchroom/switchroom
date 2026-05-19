/**
 * Tests for VaultBroker approval-kernel ops (RFC B §4 — folded into the
 * broker rather than a parallel daemon).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import { migrateGrantsSchema } from "../grants.js";
import { migrateApprovalSchema } from "../approvals/schema.js";

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  migrateApprovalSchema(db);
  return db;
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
    client.on("connect", () => { client.write(encodeRequest(req)); });
  });
}

describe("VaultBroker: approval-kernel ops", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-apv-"));
    socketPath = path.join(tmpDir, "t.sock");
    grantsDb = makeInMemoryGrantsDb();
    broker = new VaultBroker({
      _testSecrets: { foo: { kind: "string", value: "bar" } },
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: { write: () => { /* swallow */ } },
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    if (prev === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prev;
  });

  it("approval_request → approval_consume → approval_lookup full grant flow", async () => {
    const r1 = await rpc(socketPath, {
      v: 1, op: "approval_request",
      agent_unit: "switchroom-klanker.service",
      scope: "secret:OPENAI", action: "read",
      approver_set: ["U1"], why: "OpenAI API call",
    });
    expect(r1.ok).toBe(true);
    if (!(r1.ok && "kind" in r1 && r1.kind === "approval_request")) throw new Error("bad shape");
    if (r1.state !== "pending") throw new Error(`unexpected state ${r1.state}`);
    const reqId = r1.request_id;
    expect(reqId).toMatch(/^[0-9a-f]{32}$/);

    const r2 = await rpc(socketPath, {
      v: 1, op: "approval_lookup",
      agent_unit: "switchroom-klanker.service",
      scope: "secret:OPENAI", action: "read",
      current_approver_set: ["U1"],
    });
    expect(r2.ok).toBe(true);
    // No `typeof` workaround needed — lookup uses `state`, not `status`.
    if (r2.ok && "state" in r2) expect(r2.state).toBe("no_decision");

    const r3 = await rpc(socketPath, {
      v: 1, op: "approval_consume", request_id: reqId,
    });
    expect(r3.ok).toBe(true);
    if (r3.ok && "consumed" in r3) {
      expect(r3.consumed).toBe(true);
      expect(r3.scope).toBe("secret:OPENAI");
    }

    const r3b = await rpc(socketPath, {
      v: 1, op: "approval_consume", request_id: reqId,
    });
    if (r3b.ok && "consumed" in r3b) expect(r3b.consumed).toBe(false);
  });

  it("approval_record + approval_revoke + approval_list (with new RFC columns)", async () => {
    const reqRes = await rpc(socketPath, {
      v: 1, op: "approval_request",
      agent_unit: "u", scope: "secret:X", action: "read",
      approver_set: ["U1"],
    });
    if (!(reqRes.ok && "kind" in reqRes && reqRes.kind === "approval_request")) throw new Error("bad");
    if (reqRes.state !== "pending") throw new Error("not pending");
    const reqId = reqRes.request_id;
    await rpc(socketPath, { v: 1, op: "approval_consume", request_id: reqId });
    const recRes = await rpc(socketPath, {
      v: 1, op: "approval_record",
      request_id: reqId, decision: "allow_always",
      approver_set: ["U1"], granted_by_user_id: 42,
    });
    if (!(recRes.ok && "decision_id" in recRes)) throw new Error("bad");
    // approval_record always returns a string decision_id. The response
    // union is a plain z.union and (since PR-6) two variants carry
    // `decision_id` — one optional — so the `in` narrowing yields
    // string|undefined. Assert it's a string: strengthens the test and
    // gives the later approval_revoke a `string` decision_id.
    const id = recRes.decision_id;
    if (typeof id !== "string") throw new Error("expected a string decision_id");

    const list = await rpc(socketPath, { v: 1, op: "approval_list" });
    expect(list.ok).toBe(true);
    if (list.ok && "decisions" in list) {
      expect(list.decisions.length).toBe(1);
      const d = list.decisions[0]!;
      expect(d.id).toBe(id);
      expect(d.decision).toBe("allow_always");
      expect(d.granted_by_user_id).toBe(42);
      expect(d.agent_unit).toBe("u");
    }

    const rev = await rpc(socketPath, {
      v: 1, op: "approval_revoke",
      decision_id: id, actor: "U1", reason: "no longer needed",
    });
    if (rev.ok && "revoked" in rev) expect(rev.revoked).toBe(true);

    const list2 = await rpc(socketPath, { v: 1, op: "approval_list" });
    if (list2.ok && "decisions" in list2) expect(list2.decisions.length).toBe(0);
  });

  // ── RFC §10: rate caps ────────────────────────────────────────────────────

  it("per-agent cap of 2 → third concurrent request returns rate_limited", async () => {
    const a = "switchroom-klanker.service";
    const r1 = await rpc(socketPath, {
      v: 1, op: "approval_request", agent_unit: a, scope: "s1", action: "read", approver_set: ["1"],
    });
    const r2 = await rpc(socketPath, {
      v: 1, op: "approval_request", agent_unit: a, scope: "s2", action: "read", approver_set: ["1"],
    });
    const r3 = await rpc(socketPath, {
      v: 1, op: "approval_request", agent_unit: a, scope: "s3", action: "read", approver_set: ["1"],
    });
    const k = (r: BrokerResponse) =>
      r.ok && "kind" in r && r.kind === "approval_request" ? r : null;
    const k1 = k(r1), k2 = k(r2), k3 = k(r3);
    if (!k1 || !k2 || !k3) throw new Error("bad shape");
    expect(k1.state).toBe("pending");
    expect(k2.state).toBe("pending");
    expect(k3.state).toBe("rate_limited");
    if (k3.state === "rate_limited") {
      expect(k3.retry_after_ms).toBeGreaterThan(0);
    }
  });

  it("global cap of 32 → 33rd request across many agents returns rate_limited", async () => {
    // Issue 32 from distinct agents so per-agent cap never trips.
    for (let i = 0; i < 32; i++) {
      const r = await rpc(socketPath, {
        v: 1, op: "approval_request",
        agent_unit: `a${i}`, scope: `s${i}`, action: "read", approver_set: ["1"],
      });
      if (!(r.ok && "kind" in r && r.kind === "approval_request") || r.state !== "pending") {
        throw new Error(`request ${i} unexpected: ${JSON.stringify(r)}`);
      }
    }
    const r33 = await rpc(socketPath, {
      v: 1, op: "approval_request",
      agent_unit: "a32", scope: "s32", action: "read", approver_set: ["1"],
    });
    if (!(r33.ok && "kind" in r33 && r33.kind === "approval_request")) throw new Error("bad shape");
    expect(r33.state).toBe("rate_limited");
  });
});
