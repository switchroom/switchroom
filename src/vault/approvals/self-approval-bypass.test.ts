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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/**
 * Hook-level wiring (review finding F8). The suites above call
 * `isGatedWriteApproved` directly, so a refactor that dropped
 * `REQUIRE_OPERATOR_ORIGIN` from `src/cli/drive-write-pretool.ts` — i.e.
 * removed the enforcement from the only place it actually runs — would
 * still leave them green. These tests SPAWN the real hook against a real
 * kernel socket holding a real self-approved decision, and assert the
 * flag changes the hook's verdict.
 */
describe("drive-write-pretool — the gate is actually wired into the hook", () => {
  let dir: string;
  let handle: KernelServerHandle;
  let stateDir: string;
  const HOOK = resolve(import.meta.dir, "../../cli/drive-write-pretool.ts");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kernel-hookgate-"));
    handle = await bootstrap({
      socketParent: dir,
      agents: [AGENT],
      dbPath: ":memory:",
    });
    // access.json → allowFrom, else the hook fails closed on "no operator
    // paired" before it ever reaches the approval lookup.
    stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "access.json"),
      JSON.stringify({ allowFrom: APPROVER }),
    );

    // The self-approval attack, straight into the kernel db this socket
    // serves: origin='agent', state will read 'granted'.
    const r = requestApproval(handle.db, {
      agent_unit: AGENT,
      scope: SCOPE,
      action: "write",
      approver_set: APPROVER,
    });
    const nonce = consumeNonce(handle.db, r.request_id)!;
    recordDecision(handle.db, {
      nonce,
      decision: "allow_always",
      approver_set: APPROVER,
      granted_by_user_id: 4242,
      // origin omitted ⇒ 'agent', exactly what the kernel stamps for a
      // decision recorded on a per-agent socket.
    });
  });

  afterEach(() => {
    try {
      handle.stop();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the hook over a gated Drive write; returns exit code + stdout. */
  async function runHook(
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          tool_name: "mcp__google-workspace__modify_doc_text",
          tool_input: { document_id: DOC, content: "hi" },
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SWITCHROOM_AGENT_NAME: AGENT,
        SWITCHROOM_KERNEL_SOCKET: join(dir, AGENT, "sock"),
        TELEGRAM_STATE_DIR: stateDir,
        // Point the auth-broker at a dead path so the flag-ON case can
        // never accidentally proceed to a live Google call.
        SWITCHROOM_VAULT_BROKER_SOCK: join(dir, "no-such-broker.sock"),
        ...env,
      },
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout };
  }

  it("flag OFF: the self-approved decision satisfies the hook (documents the live exposure)", async () => {
    const { code, stdout } = await runHook({});
    // allow() = exit 0 with no decision payload on stdout.
    expect(code).toBe(0);
    expect(stdout).not.toContain('"block"');
  }, 20_000);

  it("SECURITY: flag ON: the same self-approved decision does NOT satisfy the hook", async () => {
    const { stdout } = await runHook({
      SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_WRITE: "1",
    });
    // The hook must NOT fall through to allow. It blocks — either on the
    // provenance check itself or, having refused the fast path, on the
    // downstream auth-broker. Either way the write is refused, which is
    // the security outcome; asserting only "not allowed" keeps the test
    // from pinning an unrelated downstream message.
    expect(stdout).toContain('"block"');
  }, 20_000);
});
