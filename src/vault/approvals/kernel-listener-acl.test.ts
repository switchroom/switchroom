/**
 * Listener-identity ACL on the kernel's mutating ops (#1399).
 *
 * Regression for the approval-integrity bypass: `approval_consume`,
 * `approval_record`, and `approval_revoke` used to operate purely on the
 * wire-supplied `request_id` / `decision_id` with NO check that the
 * resolved nonce/decision belonged to the connecting per-agent listener.
 * A compromised agent on its own legitimate socket could therefore
 * self-consume + self-record an `allow_always` for a gated tool call no
 * operator approved, or burn/revoke a peer's grant.
 *
 * These tests pin, over real bound per-agent sockets, that:
 *   - agent B cannot consume / record / revoke agent A's nonce/decision
 *     (DENIED, and A's state is untouched);
 *   - the legitimate same-agent path still works (request → consume →
 *     record → revoke for the listener's own agent);
 *   - request_id carries 128-bit entropy (32 hex chars, not the old 8).
 *
 * bun test (openKernelDb → bun:sqlite); excluded from vitest.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type KernelServerHandle } from "./kernel-server.js";
import { encodeRequest } from "../broker/protocol.js";

/** One-shot NDJSON round-trip against a bound unix socket. */
function rpc(sockPath: string, req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("rpc timeout"));
    }, 4000);
    sock.on("connect", () => sock.write(encodeRequest(req as never)));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe("kernel listener-identity ACL on mutating ops (#1399)", () => {
  let dir: string;
  let handle: KernelServerHandle;
  let aliceSock: string;
  let bobSock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kernel-lacl-"));
    handle = await bootstrap({
      socketParent: dir,
      agents: ["alice", "bob"],
      dbPath: ":memory:",
      operatorUid: process.getuid?.() ?? 0,
    });
    aliceSock = join(dir, "alice", "sock");
    bobSock = join(dir, "bob", "sock");
  });

  afterEach(() => {
    try {
      handle.stop();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function aliceRequest(): Promise<string> {
    const resp = await rpc(aliceSock, {
      v: 1,
      op: "approval_request",
      agent_unit: "alice",
      scope: "secret:TEST_KEY",
      action: "read",
      approver_set: ["op1"],
      why: "regression",
    });
    expect(resp.ok).toBe(true);
    expect(resp.state).toBe("pending");
    return resp.request_id as string;
  }

  it("mints 128-bit (32-hex) request ids, not the old 32-bit (8-hex)", async () => {
    const rid = await aliceRequest();
    expect(rid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("denies cross-agent approval_consume and leaves the nonce intact", async () => {
    const rid = await aliceRequest();

    // bob, on his own legitimate socket, tries to burn alice's nonce.
    const denied = await rpc(bobSock, {
      v: 1,
      op: "approval_consume",
      request_id: rid,
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("DENIED");
    // The denial must not echo the owning agent name (no oracle).
    expect(String(denied.msg)).not.toContain("alice");

    // alice can still consume her own nonce — bob's attempt was a no-op.
    const ok = await rpc(aliceSock, {
      v: 1,
      op: "approval_consume",
      request_id: rid,
    });
    expect(ok.ok).toBe(true);
    expect(ok.consumed).toBe(true);
    expect(ok.agent_unit).toBe("alice");
  });

  it("denies cross-agent approval_record (the self-grant bypass)", async () => {
    const rid = await aliceRequest();
    // Consume on alice's own socket so the nonce is in the recordable state.
    const consumed = await rpc(aliceSock, {
      v: 1,
      op: "approval_consume",
      request_id: rid,
    });
    expect(consumed.consumed).toBe(true);

    // bob tries to forge an allow_always decision for alice's nonce.
    const denied = await rpc(bobSock, {
      v: 1,
      op: "approval_record",
      request_id: rid,
      decision: "allow_always",
      approver_set: ["op1"],
      granted_by_user_id: 12345,
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("DENIED");

    // The legitimate owner can still record (regression: same-agent works).
    const ok = await rpc(aliceSock, {
      v: 1,
      op: "approval_record",
      request_id: rid,
      decision: "allow_always",
      approver_set: ["op1"],
      granted_by_user_id: 12345,
    });
    expect(ok.ok).toBe(true);
    expect(typeof ok.decision_id).toBe("string");
  });

  it("denies cross-agent approval_revoke; owner can revoke its own", async () => {
    // Build a real decision owned by alice.
    const rid = await aliceRequest();
    await rpc(aliceSock, { v: 1, op: "approval_consume", request_id: rid });
    const rec = await rpc(aliceSock, {
      v: 1,
      op: "approval_record",
      request_id: rid,
      decision: "allow_always",
      approver_set: ["op1"],
      granted_by_user_id: 12345,
    });
    const decisionId = rec.decision_id as string;
    expect(decisionId).toBeTruthy();

    // bob tries to revoke alice's grant.
    const denied = await rpc(bobSock, {
      v: 1,
      op: "approval_revoke",
      decision_id: decisionId,
      actor: "attacker",
      reason: "grief",
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("DENIED");

    // alice revokes her own — still works.
    const ok = await rpc(aliceSock, {
      v: 1,
      op: "approval_revoke",
      decision_id: decisionId,
      actor: "alice",
      reason: "done",
    });
    expect(ok.ok).toBe(true);
    expect(ok.revoked).toBe(true);
  });

  // PR-6: the atomic approval_consume_record op must enforce the SAME
  // listener-identity ACL as approval_consume (it burns + records).
  it("denies cross-agent approval_consume_record, nonce intact, no decision, no oracle", async () => {
    const rid = await aliceRequest();

    // bob tries to atomically burn+record alice's nonce.
    const denied = await rpc(bobSock, {
      v: 1,
      op: "approval_consume_record",
      request_id: rid,
      decision: "allow_always",
      approver_set: ["op1"],
      granted_by_user_id: 1,
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("DENIED");
    expect(String(denied.msg)).not.toContain("alice"); // no owner oracle

    // bob's attempt was a no-op: alice can still atomically
    // consume+record her own nonce.
    const okay = await rpc(aliceSock, {
      v: 1,
      op: "approval_consume_record",
      request_id: rid,
      decision: "allow_once",
      approver_set: ["op1"],
      granted_by_user_id: 1,
    });
    expect(okay.ok).toBe(true);
    expect(okay.consumed).toBe(true);
    expect(okay.decision_id).toBeTruthy();
    expect(okay.agent_unit).toBe("alice");
  });

  it("second approval_consume_record is non-committal {consumed:false} (single-use)", async () => {
    const rid = await aliceRequest();
    const first = await rpc(aliceSock, {
      v: 1, op: "approval_consume_record", request_id: rid,
      decision: "allow_once", approver_set: ["op1"], granted_by_user_id: 1,
    });
    expect(first.ok).toBe(true);
    expect(first.consumed).toBe(true);
    const second = await rpc(aliceSock, {
      v: 1, op: "approval_consume_record", request_id: rid,
      decision: "allow_always", approver_set: ["op1"], granted_by_user_id: 1,
    });
    expect(second.ok).toBe(true);
    expect(second.consumed).toBe(false);
    expect(second.decision_id).toBeUndefined();
  });
});

/**
 * approval_list was the ONE kernel op with no listener-identity ACL: it
 * passed the wire-supplied `agent_unit` straight to listDecisions. Agent B
 * could therefore enumerate agent A's decisions on B's own legitimate
 * socket — scopes (which embed Google doc ids / M365 paths),
 * granted_by_user_id (the operator's Telegram user id), grant timestamps
 * and revoke reasons. `agent_unit` is optional on the wire, so omitting it
 * dumped the WHOLE fleet.
 */
describe("kernel listener-identity ACL on approval_list", () => {
  let dir: string;
  let handle: KernelServerHandle;
  let aliceSock: string;
  let bobSock: string;
  let opSock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kernel-list-acl-"));
    handle = await bootstrap({
      socketParent: dir,
      agents: ["alice", "bob"],
      dbPath: ":memory:",
      operatorUid: process.getuid?.() ?? 0,
    });
    aliceSock = join(dir, "alice", "sock");
    bobSock = join(dir, "bob", "sock");
    opSock = join(dir, "operator", "sock");
  });

  afterEach(() => {
    try {
      handle.stop();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Give `who` one real allow_always decision on a sensitive scope. */
  async function grantFor(sockPath: string, who: string, scope: string): Promise<void> {
    const req = await rpc(sockPath, {
      v: 1,
      op: "approval_request",
      agent_unit: who,
      scope,
      action: "write",
      approver_set: ["op1"],
      why: "list-acl fixture",
    });
    expect(req.ok).toBe(true);
    const rec = await rpc(sockPath, {
      v: 1,
      op: "approval_consume_record",
      request_id: req.request_id,
      decision: "allow_always",
      approver_set: ["op1"],
      granted_by_user_id: 424242,
    });
    expect(rec.ok).toBe(true);
    expect(rec.consumed).toBe(true);
  }

  it("denies an explicit cross-agent approval_list", async () => {
    await grantFor(aliceSock, "alice", "doc:gdrive:write:SECRET_DOC");

    const denied = await rpc(bobSock, {
      v: 1,
      op: "approval_list",
      agent_unit: "alice",
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("DENIED");
    expect(denied.decisions).toBeUndefined();
    // Nothing about alice's grant leaks in the payload.
    expect(JSON.stringify(denied)).not.toContain("SECRET_DOC");
    expect(JSON.stringify(denied)).not.toContain("424242");
  });

  it("an omitted agent_unit lists only the caller's own decisions, not the fleet", async () => {
    await grantFor(aliceSock, "alice", "doc:gdrive:write:SECRET_DOC");
    await grantFor(bobSock, "bob", "doc:gdrive:write:BOB_DOC");

    const resp = await rpc(bobSock, { v: 1, op: "approval_list" });
    expect(resp.ok).toBe(true);
    expect(resp.decisions.map((d: { agent_unit: string }) => d.agent_unit)).toEqual(["bob"]);
    expect(resp.decisions.map((d: { scope: string }) => d.scope)).toEqual([
      "doc:gdrive:write:BOB_DOC",
    ]);
    expect(JSON.stringify(resp)).not.toContain("SECRET_DOC");
  });

  it("same-agent approval_list still works and returns the full metadata", async () => {
    await grantFor(aliceSock, "alice", "doc:gdrive:write:SECRET_DOC");

    const resp = await rpc(aliceSock, {
      v: 1,
      op: "approval_list",
      agent_unit: "alice",
    });
    expect(resp.ok).toBe(true);
    expect(resp.decisions.length).toBe(1);
    expect(resp.decisions[0].agent_unit).toBe("alice");
    expect(resp.decisions[0].scope).toBe("doc:gdrive:write:SECRET_DOC");
    expect(resp.decisions[0].granted_by_user_id).toBe(424242);
  });

  // F4 — documented wire invariant. A `state: "granted"` allow_once response
  // carries revoked_at != null, because the burn is the same atomic step that
  // authorizes this very use. Pinned here so a future reader who finds the
  // shape "self-contradictory" and starts re-gating on revoked_at (which
  // would deny the one use the operator actually approved) trips a test
  // instead of shipping it.
  it("granted allow_once response carries the burn (revoked_at set, state still granted)", async () => {
    const req = await rpc(aliceSock, {
      v: 1,
      op: "approval_request",
      agent_unit: "alice",
      scope: "doc:gdrive:write:ONCE_DOC",
      action: "write",
      approver_set: ["op1"],
      why: "one-shot wire shape",
    });
    expect(req.ok).toBe(true);
    const rec = await rpc(aliceSock, {
      v: 1,
      op: "approval_consume_record",
      request_id: req.request_id,
      decision: "allow_once",
      approver_set: ["op1"],
      granted_by_user_id: 1,
    });
    expect(rec.consumed).toBe(true);

    const first = await rpc(aliceSock, {
      v: 1,
      op: "approval_lookup",
      agent_unit: "alice",
      scope: "doc:gdrive:write:ONCE_DOC",
      action: "write",
      current_approver_set: ["op1"],
    });
    expect(first.ok).toBe(true);
    expect(first.state).toBe("granted");
    // The invariant: granted AND already burned, in the same response.
    expect(first.decision.revoked_at).not.toBeNull();
    expect(first.decision.revoke_reason).toBe("allow_once_consumed");

    // And the next lookup gets nothing — the one use is spent.
    const second = await rpc(aliceSock, {
      v: 1,
      op: "approval_lookup",
      agent_unit: "alice",
      scope: "doc:gdrive:write:ONCE_DOC",
      action: "write",
      current_approver_set: ["op1"],
    });
    expect(second.ok).toBe(true);
    expect(second.state).toBe("no_decision");
  });

  it("the operator socket keeps its fleet-wide read (it is the dashboard)", async () => {
    await grantFor(aliceSock, "alice", "doc:gdrive:write:SECRET_DOC");
    await grantFor(bobSock, "bob", "doc:gdrive:write:BOB_DOC");

    const all = await rpc(opSock, { v: 1, op: "approval_list" });
    expect(all.ok).toBe(true);
    expect(
      all.decisions.map((d: { agent_unit: string }) => d.agent_unit).sort(),
    ).toEqual(["alice", "bob"]);

    const justAlice = await rpc(opSock, {
      v: 1,
      op: "approval_list",
      agent_unit: "alice",
    });
    expect(justAlice.ok).toBe(true);
    expect(justAlice.decisions.map((d: { agent_unit: string }) => d.agent_unit)).toEqual([
      "alice",
    ]);
  });
});
