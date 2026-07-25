/**
 * Self-approval bypass — the security regression test.
 *
 * THE ATTACK (pre-fix, over the agent's own legitimate kernel socket):
 *
 *   1. approval_request { agent_unit: <self>, scope, action }  → request_id
 *   2. approval_consume_record { request_id, decision: "allow_always", … }
 *   3. approval_lookup → state === "granted"  → the gated write hook
 *      called allow(). No card was posted. No human tapped.
 *
 * Both ops pass `checkApprovalAclByAgent` (acl.ts:39) because it only
 * enforces `claim === listener` — cross-agent forgery is blocked, SELF
 * forgery is not. So `state` can never be the whole gate; the gate needs
 * provenance.
 *
 * These tests run the attack for real against a bound kernel socket and
 * assert (a) the kernel stamps the forged row `origin='agent'` and
 * reports it on the lookup, and (b) the shared gated-write predicate
 * REFUSES it while still accepting an operator-origin decision. A test
 * that only asserted `state === "granted"` would not have caught the
 * original bypass — which is the point.
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
import { requestApproval, consumeNonce, recordDecision } from "./kernel.js";
import { isGatedWriteApproved } from "./gated-write-policy.js";

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

const AGENT = "alice";
const DOC = "1AbCdEfGhIjK";
const SCOPE = `doc:gdrive:write:${DOC}`;
const APPROVER = ["4242"];

describe("self-approval bypass — agent-recorded decisions are not operator taps", () => {
  let dir: string;
  let handle: KernelServerHandle;
  let agentSock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kernel-selfapp-"));
    handle = await bootstrap({
      socketParent: dir,
      agents: [AGENT],
      dbPath: ":memory:",
    });
    agentSock = join(dir, AGENT, "sock");
  });

  afterEach(() => {
    try {
      handle.stop();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the full self-approval attack; returns the lookup response. */
  async function selfApproveThenLookup(): Promise<any> {
    const reqResp = await rpc(agentSock, {
      v: 1,
      op: "approval_request",
      agent_unit: AGENT,
      scope: SCOPE,
      action: "write",
      approver_set: APPROVER,
    });
    expect(reqResp.ok).toBe(true);
    expect(reqResp.state).toBe("pending");

    const rec = await rpc(agentSock, {
      v: 1,
      op: "approval_consume_record",
      request_id: reqResp.request_id,
      decision: "allow_always",
      approver_set: APPROVER,
      granted_by_user_id: 4242,
    });
    // The attack still SUCCEEDS at writing a row — the ACL cannot stop a
    // caller acting as itself. That is exactly why provenance matters.
    expect(rec.ok).toBe(true);
    expect(rec.consumed).toBe(true);

    return rpc(agentSock, {
      v: 1,
      op: "approval_lookup",
      agent_unit: AGENT,
      scope: SCOPE,
      action: "write",
      current_approver_set: APPROVER,
    });
  }

  it("stamps a self-recorded decision origin='agent' and reports it on approval_lookup", async () => {
    const lookup = await selfApproveThenLookup();
    expect(lookup.ok).toBe(true);
    // Pre-fix, `state` was the entire gate — and it says "granted" here.
    expect(lookup.state).toBe("granted");
    // Post-fix, the lookup carries the provenance that exposes the forgery.
    expect(lookup.decision).not.toBeNull();
    expect(lookup.decision.origin).toBe("agent");
  });

  it("SECURITY: a self-recorded decision does NOT satisfy the gated write path", async () => {
    const lookup = await selfApproveThenLookup();
    const verdict = isGatedWriteApproved(
      { state: lookup.state, origin: lookup.decision?.origin },
      true, // SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE=1
    );
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toContain("origin='agent'");
  });

  it("a genuine operator-verified decision DOES satisfy the gated write path", async () => {
    // Simulate the host-side verifier: a decision recorded on a channel
    // the agent cannot reach ⇒ origin='operator'. Written directly to the
    // kernel db the bound listener serves, then read back over the SAME
    // socket the hook uses.
    const r = requestApproval(handle.db, {
      agent_unit: AGENT,
      scope: SCOPE,
      action: "write",
      approver_set: APPROVER,
    });
    const nonce = consumeNonce(handle.db, r.request_id);
    expect(nonce).not.toBeNull();
    recordDecision(handle.db, {
      nonce: nonce!,
      decision: "allow_always",
      approver_set: APPROVER,
      granted_by_user_id: 4242,
      origin: "operator",
    });

    const lookup = await rpc(agentSock, {
      v: 1,
      op: "approval_lookup",
      agent_unit: AGENT,
      scope: SCOPE,
      action: "write",
      current_approver_set: APPROVER,
    });
    expect(lookup.ok).toBe(true);
    expect(lookup.state).toBe("granted");
    expect(lookup.decision.origin).toBe("operator");
    expect(
      isGatedWriteApproved(
        { state: lookup.state, origin: lookup.decision.origin },
        true,
      ).allow,
    ).toBe(true);
  });

  it("approval_lookup_by_request also carries origin", async () => {
    const reqResp = await rpc(agentSock, {
      v: 1,
      op: "approval_request",
      agent_unit: AGENT,
      scope: SCOPE,
      action: "write",
      approver_set: APPROVER,
    });
    await rpc(agentSock, {
      v: 1,
      op: "approval_consume_record",
      request_id: reqResp.request_id,
      decision: "allow_always",
      approver_set: APPROVER,
      granted_by_user_id: 4242,
    });
    const lookup = await rpc(agentSock, {
      v: 1,
      op: "approval_lookup_by_request",
      agent_unit: AGENT,
      request_id: reqResp.request_id,
      current_approver_set: APPROVER,
    });
    expect(lookup.ok).toBe(true);
    expect(lookup.state).toBe("granted");
    expect(lookup.decision.origin).toBe("agent");
  });
});
