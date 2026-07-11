/**
 * #2975 Stage 2 — gateway-side IPC surface for `check_pre_approved`, the
 * read-only pre-approval query hostd sends before applying the
 * `config_propose_edit` rate limit.
 *
 * Exercises the REAL createIpcServer over a real (tmp) unix socket with a raw
 * `net.createConnection` client — the same hostd → gateway approval-gateway
 * transport. Pins:
 *   - wire-shape validation (validateClientMessage);
 *   - the wired handler is invoked and its `pre_approved_result` relayed;
 *   - FAIL CLOSED: no handler wired (old gateway / mixed-version) → the server
 *     itself replies `preApproved: false`.
 *
 * The message is hostd → gateway over the approval-gateway socket; it is NOT
 * reachable via any agent-facing hostd verb (there is no hostd op that emits
 * it), and the handler treats it as read-only.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createConnection } from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createIpcServer,
  validateClientMessage,
  type IpcServer,
  type IpcClient,
} from "../gateway/ipc-server.js";
import type { CheckPreApprovedMessage } from "../gateway/ipc-protocol.js";

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipc-cpa-test-"));
  return join(dir, "test.sock");
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function queryOnce(
  socketPath: string,
  agentName: string,
  correlationId: string,
  unifiedDiff: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buffer = "";
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({
          type: "check_pre_approved",
          agentName,
          correlationId,
          unifiedDiff,
        } as CheckPreApprovedMessage) + "\n",
      );
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        sock.end();
        resolve(JSON.parse(buffer.slice(0, idx)));
      }
    });
    sock.on("error", reject);
  });
}

describe("validateClientMessage — check_pre_approved (#2975 Stage 2)", () => {
  it("accepts a well-formed query", () => {
    expect(
      validateClientMessage({
        type: "check_pre_approved",
        agentName: "klanker",
        correlationId: "abc",
        unifiedDiff: "--- a\n+++ b\n",
      }),
    ).toBe(true);
  });

  it("rejects missing/malformed agentName", () => {
    expect(
      validateClientMessage({ type: "check_pre_approved", correlationId: "abc", unifiedDiff: "x" }),
    ).toBe(false);
    expect(
      validateClientMessage({ type: "check_pre_approved", agentName: "Bad Name", correlationId: "abc", unifiedDiff: "x" }),
    ).toBe(false);
  });

  it("rejects missing/oversized correlationId", () => {
    expect(
      validateClientMessage({ type: "check_pre_approved", agentName: "klanker", unifiedDiff: "x" }),
    ).toBe(false);
    expect(
      validateClientMessage({ type: "check_pre_approved", agentName: "klanker", correlationId: "", unifiedDiff: "x" }),
    ).toBe(false);
    expect(
      validateClientMessage({ type: "check_pre_approved", agentName: "klanker", correlationId: "x".repeat(65), unifiedDiff: "x" }),
    ).toBe(false);
  });

  it("rejects an empty/missing unifiedDiff", () => {
    expect(
      validateClientMessage({ type: "check_pre_approved", agentName: "klanker", correlationId: "abc" }),
    ).toBe(false);
    expect(
      validateClientMessage({ type: "check_pre_approved", agentName: "klanker", correlationId: "abc", unifiedDiff: "" }),
    ).toBe(false);
  });
});

describe("ipc-server — onCheckPreApproved handler (#2975 Stage 2)", () => {
  const servers: IpcServer[] = [];

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it("fails CLOSED (preApproved:false) when no handler is wired — mixed-version-safe default", async () => {
    const socketPath = tmpSocket();
    const server = createIpcServer({
      socketPath,
      onClientRegistered: () => {},
      onClientDisconnected: () => {},
      onToolCall: async () => ({ type: "tool_call_result", id: "x", success: true }),
      onSessionEvent: () => {},
      onPermissionRequest: () => {},
      onHeartbeat: () => {},
      onScheduleRestart: () => {},
      // onCheckPreApproved intentionally omitted.
    });
    servers.push(server);
    await wait(50);

    const reply = await queryOnce(socketPath, "klanker", "corr-1", "--- a\n+++ b\n");
    expect(reply).toEqual({ type: "pre_approved_result", correlationId: "corr-1", preApproved: false });
  });

  it("invokes the wired handler with the query, and relays its reply", async () => {
    const socketPath = tmpSocket();
    let received: CheckPreApprovedMessage | null = null;
    const server = createIpcServer({
      socketPath,
      onClientRegistered: () => {},
      onClientDisconnected: () => {},
      onToolCall: async () => ({ type: "tool_call_result", id: "x", success: true }),
      onSessionEvent: () => {},
      onPermissionRequest: () => {},
      onHeartbeat: () => {},
      onScheduleRestart: () => {},
      onCheckPreApproved: (client: IpcClient, msg: CheckPreApprovedMessage) => {
        received = msg;
        client.send({ type: "pre_approved_result", correlationId: msg.correlationId, preApproved: true });
      },
    });
    servers.push(server);
    await wait(50);

    const reply = await queryOnce(socketPath, "klanker", "corr-2", "--- a\n+++ b\n");
    expect(received).toEqual({
      type: "check_pre_approved",
      agentName: "klanker",
      correlationId: "corr-2",
      unifiedDiff: "--- a\n+++ b\n",
    });
    expect(reply).toEqual({ type: "pre_approved_result", correlationId: "corr-2", preApproved: true });
  });

  it("relays preApproved:false from a wired handler", async () => {
    const socketPath = tmpSocket();
    const server = createIpcServer({
      socketPath,
      onClientRegistered: () => {},
      onClientDisconnected: () => {},
      onToolCall: async () => ({ type: "tool_call_result", id: "x", success: true }),
      onSessionEvent: () => {},
      onPermissionRequest: () => {},
      onHeartbeat: () => {},
      onScheduleRestart: () => {},
      onCheckPreApproved: (client: IpcClient, msg: CheckPreApprovedMessage) => {
        client.send({ type: "pre_approved_result", correlationId: msg.correlationId, preApproved: false });
      },
    });
    servers.push(server);
    await wait(50);

    const reply = await queryOnce(socketPath, "klanker", "corr-3", "--- a\n+++ b\n");
    expect(reply).toEqual({ type: "pre_approved_result", correlationId: "corr-3", preApproved: false });
  });
});
