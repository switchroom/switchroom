/**
 * Issue #2971 — gateway-side handler for `query_pending_permission`, the
 * read-only wedge-watchdog probe that lets the permission-prompt branch
 * defer to a live Telegram approval card instead of racing it with Esc.
 *
 * Exercises the REAL createIpcServer over a real (tmp) unix socket with a
 * raw `net.createConnection` client — the same transport the sidecar's
 * `permission-pending-query.ts` module uses (no bridge/register handshake
 * required; this message can be sent by ANY process inside the container,
 * same trust model as `quota_wall_detected`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createConnection } from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIpcServer, type IpcServer, type IpcClient } from "../gateway/ipc-server.js";
import { validateClientMessage } from "../gateway/ipc-server.js";
import type { QueryPendingPermissionMessage } from "../gateway/ipc-protocol.js";

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipc-qpp-test-"));
  return join(dir, "test.sock");
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Send one query and collect every `pending_permission_status` reply line. */
function queryOnce(socketPath: string, agentName: string, correlationId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buffer = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "query_pending_permission", agentName, correlationId } as QueryPendingPermissionMessage) + "\n");
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        sock.end();
        resolve(JSON.parse(line));
      }
    });
    sock.on("error", reject);
  });
}

describe("validateClientMessage — query_pending_permission (#2971)", () => {
  it("accepts a well-formed query", () => {
    expect(
      validateClientMessage({ type: "query_pending_permission", agentName: "carrie", correlationId: "abc" }),
    ).toBe(true);
  });

  it("rejects missing/malformed agentName", () => {
    expect(validateClientMessage({ type: "query_pending_permission", correlationId: "abc" })).toBe(false);
    expect(validateClientMessage({ type: "query_pending_permission", agentName: "", correlationId: "abc" })).toBe(false);
    expect(validateClientMessage({ type: "query_pending_permission", agentName: "Bad Name", correlationId: "abc" })).toBe(false);
  });

  it("rejects missing/oversized correlationId", () => {
    expect(validateClientMessage({ type: "query_pending_permission", agentName: "carrie" })).toBe(false);
    expect(validateClientMessage({ type: "query_pending_permission", agentName: "carrie", correlationId: "" })).toBe(false);
    expect(
      validateClientMessage({ type: "query_pending_permission", agentName: "carrie", correlationId: "x".repeat(65) }),
    ).toBe(false);
  });
});

describe("ipc-server — onQueryPendingPermission handler (#2971)", () => {
  const servers: IpcServer[] = [];

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it("fails CLOSED (pending:false) when no handler is wired — mixed-version-safe default", async () => {
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
      // onQueryPendingPermission intentionally omitted.
    });
    servers.push(server);
    await wait(50);

    const reply = await queryOnce(socketPath, "carrie", "corr-1");
    expect(reply).toEqual({ type: "pending_permission_status", correlationId: "corr-1", pending: false });
  });

  it("invokes the wired handler with the query, and relays its reply", async () => {
    const socketPath = tmpSocket();
    let received: QueryPendingPermissionMessage | null = null;
    const server = createIpcServer({
      socketPath,
      onClientRegistered: () => {},
      onClientDisconnected: () => {},
      onToolCall: async () => ({ type: "tool_call_result", id: "x", success: true }),
      onSessionEvent: () => {},
      onPermissionRequest: () => {},
      onHeartbeat: () => {},
      onScheduleRestart: () => {},
      onQueryPendingPermission: (client: IpcClient, msg: QueryPendingPermissionMessage) => {
        received = msg;
        client.send({
          type: "pending_permission_status",
          correlationId: msg.correlationId,
          pending: true,
          requestId: "req-live-1",
        });
      },
    });
    servers.push(server);
    await wait(50);

    const reply = await queryOnce(socketPath, "carrie", "corr-2");
    expect(received).toEqual({ type: "query_pending_permission", agentName: "carrie", correlationId: "corr-2" });
    expect(reply).toEqual({
      type: "pending_permission_status",
      correlationId: "corr-2",
      pending: true,
      requestId: "req-live-1",
    });
  });

  it("relays pending:false from a wired handler when nothing is live", async () => {
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
      onQueryPendingPermission: (client: IpcClient, msg: QueryPendingPermissionMessage) => {
        client.send({ type: "pending_permission_status", correlationId: msg.correlationId, pending: false });
      },
    });
    servers.push(server);
    await wait(50);

    const reply = await queryOnce(socketPath, "carrie", "corr-3");
    expect(reply).toEqual({ type: "pending_permission_status", correlationId: "corr-3", pending: false });
  });
});
