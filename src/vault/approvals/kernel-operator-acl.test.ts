/**
 * Operator-socket ACL — the security contract for the host operator
 * listener (RFC: dashboard read-only kernel access).
 *
 * The kernel's mutating ops (approval_request/consume/revoke/record)
 * are gated by the listener-identity ACL (#1399 — see
 * kernel-listener-acl.test.ts). That ACL keys off the bound agent name,
 * so it cannot be satisfied on the operator socket (no agent identity).
 * Independently, the operator socket MUST be deny-by-default: only
 * `approval_list` is permitted. These tests pin that inversion over a
 * real bound socket so a refactor that reorders the op chain or widens
 * the allowlist fails loudly.
 *
 * bun test (openKernelDb → bun:sqlite); excluded from vitest.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  KERNEL_OPERATOR_NAME,
  type KernelServerHandle,
} from "./kernel-server.js";
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

describe("kernel operator socket — deny-by-default ACL", () => {
  let dir: string;
  let handle: KernelServerHandle;
  let opSock: string;
  let agentSock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kernel-op-"));
    // operatorUid = our own uid: the try/catch chown is a no-op, the
    // socket binds connectable as the test user either way.
    handle = await bootstrap({
      socketParent: dir,
      agents: ["alice"],
      dbPath: ":memory:",
      operatorUid: process.getuid?.() ?? 0,
    });
    opSock = join(dir, KERNEL_OPERATOR_NAME, "sock");
    agentSock = join(dir, "alice", "sock");
  });

  afterEach(() => {
    try {
      handle.stop();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows approval_list on the operator socket", async () => {
    const resp = await rpc(opSock, {
      v: 1,
      op: "approval_list",
      agent_unit: "alice",
    });
    expect(resp.ok).toBe(true);
    expect(Array.isArray(resp.decisions)).toBe(true);
  });

  // Every mutating op (and the per-agent-scoped reads) must be refused
  // on the operator socket with the read-only DENIED error — BEFORE any
  // op handler runs.
  const forbidden: Array<[string, Record<string, unknown>]> = [
    [
      "approval_request",
      {
        v: 1,
        op: "approval_request",
        agent_unit: "alice",
        scope: "doc:gdrive:write",
        action: "docs:edit",
        approver_set: ["u1"],
      },
    ],
    [
      "approval_lookup",
      {
        v: 1,
        op: "approval_lookup",
        agent_unit: "alice",
        scope: "doc:gdrive:write",
        action: "docs:edit",
        current_approver_set: ["u1"],
      },
    ],
    [
      "approval_consume",
      { v: 1, op: "approval_consume", request_id: "0badf00d0badf00d0badf00d0badf00d" },
    ],
    [
      "approval_revoke",
      { v: 1, op: "approval_revoke", decision_id: "d1", actor: "attacker" },
    ],
    [
      "approval_record",
      {
        v: 1,
        op: "approval_record",
        request_id: "0badf00d0badf00d0badf00d0badf00d",
        decision: "allow_always",
        approver_set: ["u1"],
        granted_by_user_id: 1,
      },
    ],
    [
      // PR-6 R1: the atomic consume+record op BURNS a nonce AND records
      // a decision — it must never be reachable on the operator socket.
      // Pinned so a future OPERATOR_ALLOWED_OPS edit can't silently
      // expose it.
      "approval_consume_record",
      {
        v: 1,
        op: "approval_consume_record",
        request_id: "0badf00d0badf00d0badf00d0badf00d",
        decision: "allow_always",
        approver_set: ["u1"],
        granted_by_user_id: 1,
      },
    ],
  ];

  for (const [op, req] of forbidden) {
    it(`refuses ${op} on the operator socket (read-only DENIED)`, async () => {
      const resp = await rpc(opSock, req);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe("DENIED");
      expect(String(resp.msg)).toMatch(/read-only/i);
      // Crucially the message names the op restriction, proving the
      // top-of-handler gate fired — not an incidental downstream error.
      expect(String(resp.msg)).toContain("not permitted");
    });
  }

  it("does NOT apply the operator restriction to per-agent sockets", async () => {
    // approval_record on alice's own socket must not hit the operator
    // gate. It may fail for an unrelated reason (no such request_id),
    // but it must NOT be the operator read-only DENIED message.
    const resp = await rpc(agentSock, {
      v: 1,
      op: "approval_record",
      request_id: "0badf00d0badf00d0badf00d0badf00d",
      decision: "allow_always",
      approver_set: ["u1"],
      granted_by_user_id: 1,
    });
    const msg = String(resp.msg ?? "");
    expect(msg).not.toMatch(/operator socket is read-only/i);
  });

  it("never binds the operator dir as a per-agent listener", () => {
    const names = handle.listeners.map((l) => l.agent).sort();
    expect(names).toContain("alice");
    expect(names).toContain(KERNEL_OPERATOR_NAME);
    // Exactly one operator listener — the reserved name wasn't also
    // enumerated as an agent.
    expect(names.filter((n) => n === KERNEL_OPERATOR_NAME)).toHaveLength(1);
  });
});
