/**
 * Integration tests for the gateway/bridge IPC architecture.
 *
 * Uses bun:test (NOT vitest) because it exercises Bun.listen / Bun.connect
 * through the real createIpcServer and createIpcClient.
 *
 * Run with:
 *   cd <repo-root> && bun test telegram-plugin/tests/gateway-bridge.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createIpcServer, type IpcServer, type IpcClient } from "../gateway/ipc-server.js";
import { createIpcClient, type IpcClientHandle } from "../bridge/ipc-client.js";
import type {
  InboundMessage,
  PermissionEvent,
  PermissionRequestForward,
  StatusEvent,
  ToolCallMessage,
  ToolCallResult,
  SessionEventForward,
  HeartbeatMessage,
} from "../gateway/ipc-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-bridge-test-"));
  return join(dir, "test.sock");
}

function wait(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

/** Create a promise + external resolve/reject handles. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: "inbound",
    chatId: "123",
    messageId: 1,
    user: "alice",
    userId: 42,
    ts: Date.now(),
    text: "hello",
    meta: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("gateway-bridge integration", () => {
  // Track all servers and clients for cleanup
  const servers: IpcServer[] = [];
  const clients: IpcClientHandle[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { c.close(); } catch {}
    }
    clients.length = 0;
    for (const s of servers) {
      try { await s.close(); } catch {}
    }
    servers.length = 0;
    // Small settle time for sockets to fully close
    await wait(30);
  });

  // ----- Factory helpers ---------------------------------------------------

  type ServerCallbacks = {
    registered: Array<IpcClient>;
    disconnected: Array<IpcClient>;
    toolCalls: Array<{ client: IpcClient; msg: ToolCallMessage }>;
    sessionEvents: Array<{ client: IpcClient; msg: SessionEventForward }>;
    permissionRequests: Array<{ client: IpcClient; msg: PermissionRequestForward }>;
    heartbeats: Array<{ client: IpcClient; msg: HeartbeatMessage }>;
  };

  function makeServer(
    socketPath: string,
    overrides: Partial<{
      onClientRegistered: (client: IpcClient) => void;
      onClientDisconnected: (client: IpcClient) => void;
      onToolCall: (client: IpcClient, msg: ToolCallMessage) => Promise<ToolCallResult>;
      onSessionEvent: (client: IpcClient, msg: SessionEventForward) => void;
      onPermissionRequest: (client: IpcClient, msg: PermissionRequestForward) => void;
      onHeartbeat: (client: IpcClient, msg: HeartbeatMessage) => void;
    }> = {},
  ) {
    const cb: ServerCallbacks = {
      registered: [],
      disconnected: [],
      toolCalls: [],
      sessionEvents: [],
      permissionRequests: [],
      heartbeats: [],
    };

    const registeredWaiters: Array<(client: IpcClient) => void> = [];
    const disconnectedWaiters: Array<(client: IpcClient) => void> = [];

    const server = createIpcServer({
      socketPath,
      onClientRegistered:
        overrides.onClientRegistered ??
        ((client) => {
          cb.registered.push(client);
          for (const w of registeredWaiters.splice(0)) w(client);
        }),
      onClientDisconnected:
        overrides.onClientDisconnected ??
        ((client) => {
          cb.disconnected.push(client);
          for (const w of disconnectedWaiters.splice(0)) w(client);
        }),
      onToolCall:
        overrides.onToolCall ??
        (async (client, msg) => {
          cb.toolCalls.push({ client, msg });
          return {
            type: "tool_call_result" as const,
            id: msg.id,
            success: true,
            result: { echo: msg.tool },
          };
        }),
      onSessionEvent:
        overrides.onSessionEvent ??
        ((client, msg) => {
          cb.sessionEvents.push({ client, msg });
        }),
      onPermissionRequest:
        overrides.onPermissionRequest ??
        ((client, msg) => {
          cb.permissionRequests.push({ client, msg });
        }),
      onHeartbeat:
        overrides.onHeartbeat ??
        ((client, msg) => {
          cb.heartbeats.push({ client, msg });
        }),
    });
    servers.push(server);

    /** Returns a promise that resolves the next time a client registers. */
    function waitForRegistration(): Promise<IpcClient> {
      return new Promise((resolve) => registeredWaiters.push(resolve));
    }

    /** Returns a promise that resolves the next time a client disconnects. */
    function waitForDisconnect(): Promise<IpcClient> {
      return new Promise((resolve) => disconnectedWaiters.push(resolve));
    }

    return { server, cb, waitForRegistration, waitForDisconnect };
  }

  async function makeClient(
    socketPath: string,
    agentName: string,
    overrides: Partial<{
      topicId: number;
      onInbound: (msg: InboundMessage) => void;
      onPermission: (msg: PermissionEvent) => void;
      onStatus: (msg: StatusEvent) => void;
      heartbeatIntervalMs: number;
      reconnectDelayMs: number;
      maxReconnectDelayMs: number;
    }> = {},
  ) {
    const inboundMessages: InboundMessage[] = [];
    const permissionEvents: PermissionEvent[] = [];
    const statusEvents: StatusEvent[] = [];

    const inboundWaiters: Array<(msg: InboundMessage) => void> = [];
    const permissionWaiters: Array<(msg: PermissionEvent) => void> = [];
    const statusWaiters: Array<(msg: StatusEvent) => void> = [];

    const client = await createIpcClient({
      socketPath,
      agentName,
      topicId: overrides.topicId,
      onInbound:
        overrides.onInbound ??
        ((msg) => {
          inboundMessages.push(msg);
          for (const w of inboundWaiters.splice(0)) w(msg);
        }),
      onPermission:
        overrides.onPermission ??
        ((msg) => {
          permissionEvents.push(msg);
          for (const w of permissionWaiters.splice(0)) w(msg);
        }),
      onStatus:
        overrides.onStatus ??
        ((msg) => {
          statusEvents.push(msg);
          for (const w of statusWaiters.splice(0)) w(msg);
        }),
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 60_000, // long to avoid noise
      reconnectDelayMs: overrides.reconnectDelayMs ?? 100,
      maxReconnectDelayMs: overrides.maxReconnectDelayMs ?? 500,
    });
    clients.push(client);

    function waitForInbound(): Promise<InboundMessage> {
      return new Promise((resolve) => inboundWaiters.push(resolve));
    }
    function waitForPermission(): Promise<PermissionEvent> {
      return new Promise((resolve) => permissionWaiters.push(resolve));
    }
    function waitForStatus(): Promise<StatusEvent> {
      return new Promise((resolve) => statusWaiters.push(resolve));
    }

    return {
      client,
      inboundMessages,
      permissionEvents,
      statusEvents,
      waitForInbound,
      waitForPermission,
      waitForStatus,
    };
  }

  // =========================================================================
  // 1. Gateway startup
  // =========================================================================
  it("gateway creates socket file and listens successfully", () => {
    const path = tmpSocket();
    const { server } = makeServer(path);

    expect(existsSync(path)).toBe(true);
    expect(server.clientCount()).toBe(0);
  });

  // =========================================================================
  // 2. Bridge connects and registers
  // =========================================================================
  it("bridge connects, sends RegisterMessage, gateway acknowledges", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const regPromise = waitForRegistration();
    const { client } = await makeClient(path, "assistant");

    const registeredClient = await regPromise;

    expect(client.isConnected()).toBe(true);
    expect(server.clientCount()).toBe(1);
    expect(registeredClient.agentName).toBe("assistant");
  });

  // =========================================================================
  // 3. Inbound message routing
  // =========================================================================
  it("gateway routes inbound event to the correct bridge by agent name", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const regPromise = waitForRegistration();
    const c = await makeClient(path, "assistant");
    await regPromise;

    const inboundPromise = c.waitForInbound();
    const msg = makeInbound({ text: "route me" });
    const sent = server.sendToAgent("assistant", msg);

    expect(sent).toBe(true);
    const received = await inboundPromise;
    expect(received.text).toBe("route me");
    expect(received.type).toBe("inbound");
  });

  // =========================================================================
  // 4. Tool call round-trip
  // =========================================================================
  it("bridge sends ToolCallMessage, gateway responds with ToolCallResult", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration, cb } = makeServer(path);

    const regPromise = waitForRegistration();
    const { client } = await makeClient(path, "tool-agent");
    await regPromise;

    const result = await client.callTool("reply", { chat_id: "123", text: "hi" });

    expect(result.type).toBe("tool_call_result");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ echo: "reply" });

    expect(cb.toolCalls.length).toBe(1);
    expect(cb.toolCalls[0].msg.tool).toBe("reply");
    expect(cb.toolCalls[0].msg.args).toEqual({ chat_id: "123", text: "hi" });
  });

  // =========================================================================
  // 5. Multiple bridges — routing to correct one
  // =========================================================================
  it("two bridges register, inbound routes to the correct bridge", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const reg1 = waitForRegistration();
    const c1 = await makeClient(path, "agent-alpha");
    await reg1;

    const reg2 = waitForRegistration();
    const c2 = await makeClient(path, "agent-beta");
    await reg2;

    expect(server.clientCount()).toBe(2);

    // Send to agent-beta only
    const inboundPromise = c2.waitForInbound();
    server.sendToAgent("agent-beta", makeInbound({ text: "for beta" }));
    const received = await inboundPromise;

    expect(received.text).toBe("for beta");
    expect(c1.inboundMessages.length).toBe(0);
  });

  // =========================================================================
  // 6. Topic-based routing
  // =========================================================================
  it("bridge registers with topicId, gateway.sendToTopic routes correctly", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const reg1 = waitForRegistration();
    const c1 = await makeClient(path, "topic-a", { topicId: 100 });
    await reg1;

    const reg2 = waitForRegistration();
    const c2 = await makeClient(path, "topic-b", { topicId: 200 });
    await reg2;

    const inboundPromise = c1.waitForInbound();
    const sent = server.sendToTopic(100, makeInbound({ text: "topic 100" }));
    expect(sent).toBe(true);

    const received = await inboundPromise;
    expect(received.text).toBe("topic 100");
    expect(c2.inboundMessages.length).toBe(0);
  });

  // =========================================================================
  // 7. Bridge disconnect cleanup
  // =========================================================================
  it("bridge disconnects, gateway removes from routing table, sendToAgent returns false", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration, waitForDisconnect } = makeServer(path);

    const regPromise = waitForRegistration();
    const { client } = await makeClient(path, "ephemeral");
    await regPromise;

    expect(server.clientCount()).toBe(1);
    expect(server.getClient("ephemeral")).toBeDefined();

    const discPromise = waitForDisconnect();
    client.close();
    await discPromise;

    expect(server.clientCount()).toBe(0);
    expect(server.getClient("ephemeral")).toBeUndefined();
    expect(server.sendToAgent("ephemeral", makeInbound())).toBe(false);
  });

  // =========================================================================
  // 8. No bridge available
  // =========================================================================
  it("gateway tries to route inbound with no bridge connected, returns false", () => {
    const path = tmpSocket();
    const { server } = makeServer(path);

    const result = server.sendToAgent("nobody", makeInbound());
    expect(result).toBe(false);
  });

  it("sendToTopic returns false when no bridge for that topic", () => {
    const path = tmpSocket();
    const { server } = makeServer(path);

    const result = server.sendToTopic(9999, makeInbound());
    expect(result).toBe(false);
  });

  // =========================================================================
  // 9. Session event forwarding
  // =========================================================================
  it("bridge sends SessionEventForward, gateway receives it", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration, cb } = makeServer(path);

    const regPromise = waitForRegistration();
    const { client } = await makeClient(path, "session-agent");
    await regPromise;

    const event: SessionEventForward = {
      type: "session_event",
      event: { type: "assistant", message: "thinking..." },
      chatId: "456",
      threadId: 7,
    };
    client.sendSessionEvent(event);
    await wait(50);

    expect(cb.sessionEvents.length).toBe(1);
    expect(cb.sessionEvents[0].msg).toEqual(event);
    expect(cb.sessionEvents[0].client.agentName).toBe("session-agent");
  });

  // =========================================================================
  // 10. Heartbeat
  // =========================================================================
  it("bridge sends heartbeat, gateway updates lastHeartbeat timestamp", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration, cb } = makeServer(path);

    const regPromise = waitForRegistration();
    await makeClient(path, "hb-agent", { heartbeatIntervalMs: 80 });
    const registeredClient = await regPromise;

    const initialHb = registeredClient.lastHeartbeat;
    // Wait for at least 2 heartbeats
    await wait(250);

    expect(cb.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(cb.heartbeats[0].msg.agentName).toBe("hb-agent");
    // The server handler is called, confirming gateway processes the heartbeat
    // (lastHeartbeat is updated in the server's handleMessage before calling onHeartbeat)
    expect(registeredClient.lastHeartbeat).toBeGreaterThanOrEqual(initialHb);
  });

  // =========================================================================
  // 11. Tool call timeout
  // =========================================================================
  it("bridge calls tool, gateway never responds, callTool rejects after timeout", async () => {
    const path = tmpSocket();
    makeServer(path, {
      onToolCall: async (_client, msg) => {
        // Never resolve — simulate hung tool
        await new Promise<ToolCallResult>(() => {});
        return { type: "tool_call_result", id: msg.id, success: true };
      },
    });
    const { client } = await makeClient(path, "timeout-agent");
    await wait(50);

    const start = Date.now();
    let error: Error | null = null;
    try {
      await client.callTool("slow_tool", { data: "x" }, 200);
    } catch (e) {
      error = e as Error;
    }
    const elapsed = Date.now() - start;

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/timed out/);
    expect(elapsed).toBeGreaterThanOrEqual(180); // allow small timing variance
    expect(elapsed).toBeLessThan(500);
  });

  // =========================================================================
  // 12. Permission event forwarding
  // =========================================================================
  it("gateway sends PermissionEvent, bridge receives in onPermission callback", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const regPromise = waitForRegistration();
    const c = await makeClient(path, "perm-agent");
    await regPromise;

    const permPromise = c.waitForPermission();
    const permEvent: PermissionEvent = {
      type: "permission",
      requestId: "req-42",
      behavior: "allow",
    };
    server.sendToAgent("perm-agent", permEvent);

    const received = await permPromise;
    expect(received.type).toBe("permission");
    expect(received.requestId).toBe("req-42");
    expect(received.behavior).toBe("allow");
  });

  it("gateway sends PermissionEvent with deny behavior", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const regPromise = waitForRegistration();
    const c = await makeClient(path, "perm-deny-agent");
    await regPromise;

    const permPromise = c.waitForPermission();
    server.sendToAgent("perm-deny-agent", {
      type: "permission",
      requestId: "req-99",
      behavior: "deny",
    });

    const received = await permPromise;
    expect(received.behavior).toBe("deny");
  });

  // =========================================================================
  // 13. Status event broadcasting
  // =========================================================================
  it("gateway broadcasts StatusEvent to all connected bridges", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const reg1 = waitForRegistration();
    const c1 = await makeClient(path, "bc-1");
    await reg1;

    const reg2 = waitForRegistration();
    const c2 = await makeClient(path, "bc-2");
    await reg2;

    const reg3 = waitForRegistration();
    const c3 = await makeClient(path, "bc-3");
    await reg3;

    const p1 = c1.waitForStatus();
    const p2 = c2.waitForStatus();
    const p3 = c3.waitForStatus();

    server.broadcast({ type: "status", status: "gateway_shutting_down" });

    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(s1.status).toBe("gateway_shutting_down");
    expect(s2.status).toBe("gateway_shutting_down");
    expect(s3.status).toBe("gateway_shutting_down");
  });

  it("broadcast sends agent_connected status to all bridges", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const reg1 = waitForRegistration();
    const c1 = await makeClient(path, "st-a");
    await reg1;

    const reg2 = waitForRegistration();
    const c2 = await makeClient(path, "st-b");
    await reg2;

    const p1 = c1.waitForStatus();
    const p2 = c2.waitForStatus();

    server.broadcast({ type: "status", status: "agent_connected" });

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1.status).toBe("agent_connected");
    expect(s2.status).toBe("agent_connected");
  });

  // =========================================================================
  // 14. Reconnection
  // =========================================================================
  it("bridge reconnects after server restarts", async () => {
    const path = tmpSocket();
    const { server: server1, waitForRegistration: waitReg1 } = makeServer(path);

    const reg1 = waitReg1();
    const { client } = await makeClient(path, "resilient", {
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 200,
    });
    await reg1;

    expect(client.isConnected()).toBe(true);

    // Shut down server1 — client disconnects
    await server1.close();
    // Remove server1 from cleanup list since it's already closed
    const idx = servers.indexOf(server1);
    if (idx >= 0) servers.splice(idx, 1);

    await wait(50);
    expect(client.isConnected()).toBe(false);

    // Start a new server on the same path
    const { server: server2, waitForRegistration: waitReg2 } = makeServer(path);

    const regPromise = waitReg2();
    // Wait for the client to reconnect (retries at 100ms, then 200ms max)
    const reconnectedClient = await regPromise;

    expect(client.isConnected()).toBe(true);
    expect(reconnectedClient.agentName).toBe("resilient");
    expect(server2.clientCount()).toBe(1);
  });

  // =========================================================================
  // 15. Concurrent tool calls
  // =========================================================================
  it("bridge fires multiple callTool in parallel, each resolves independently", async () => {
    const path = tmpSocket();
    // Stagger responses to ensure they aren't just returned in send order
    makeServer(path, {
      onToolCall: async (_client, msg) => {
        const delayByTool: Record<string, number> = {
          fast: 10,
          medium: 50,
          slow: 100,
        };
        await wait(delayByTool[msg.tool] ?? 10);
        return {
          type: "tool_call_result",
          id: msg.id,
          success: true,
          result: { tool: msg.tool, processed: true },
        };
      },
    });
    const { client } = await makeClient(path, "parallel-agent");
    await wait(50);

    // Fire 3 calls concurrently
    const [r1, r2, r3] = await Promise.all([
      client.callTool("fast", { order: 1 }),
      client.callTool("medium", { order: 2 }),
      client.callTool("slow", { order: 3 }),
    ]);

    // All should succeed with their own result
    expect(r1.success).toBe(true);
    expect((r1.result as any).tool).toBe("fast");
    expect(r2.success).toBe(true);
    expect((r2.result as any).tool).toBe("medium");
    expect(r3.success).toBe(true);
    expect((r3.result as any).tool).toBe("slow");
  });

  it("concurrent tool calls with different IDs resolve to correct callers", async () => {
    const path = tmpSocket();
    let callCount = 0;
    makeServer(path, {
      onToolCall: async (_client, msg) => {
        callCount++;
        return {
          type: "tool_call_result",
          id: msg.id,
          success: true,
          result: { index: callCount, tool: msg.tool },
        };
      },
    });
    const { client } = await makeClient(path, "multi-caller");
    await wait(50);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        client.callTool(`tool_${i}`, { i }),
      ),
    );

    expect(results.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(results[i].success).toBe(true);
      expect((results[i].result as any).tool).toBe(`tool_${i}`);
    }
  });

  // =========================================================================
  // Additional edge-case scenarios
  // =========================================================================

  it("tool call that errors on the server side returns error result", async () => {
    const path = tmpSocket();
    makeServer(path, {
      onToolCall: async (_client, msg) => {
        throw new Error("handler exploded");
      },
    });
    const { client } = await makeClient(path, "error-agent");
    await wait(50);

    const result = await client.callTool("bad_tool", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("handler exploded");
  });

  it("callTool when disconnected rejects immediately with 'not connected'", async () => {
    const path = tmpSocket();
    makeServer(path);
    const { client } = await makeClient(path, "disc-agent");
    await wait(50);

    client.close();

    let error: Error | null = null;
    try {
      await client.callTool("reply", { text: "hi" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not connected/);
  });

  it("server.getClient returns the correct client by agent name", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const reg1 = waitForRegistration();
    await makeClient(path, "lookup-a", { topicId: 10 });
    await reg1;

    const reg2 = waitForRegistration();
    await makeClient(path, "lookup-b", { topicId: 20 });
    await reg2;

    const clientA = server.getClient("lookup-a");
    const clientB = server.getClient("lookup-b");
    const clientC = server.getClient("nonexistent");

    expect(clientA).toBeDefined();
    expect(clientA!.agentName).toBe("lookup-a");
    expect(clientA!.topicId).toBe(10);

    expect(clientB).toBeDefined();
    expect(clientB!.agentName).toBe("lookup-b");
    expect(clientB!.topicId).toBe(20);

    expect(clientC).toBeUndefined();
  });

  it("server.close disconnects all clients and cleans up", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const reg1 = waitForRegistration();
    const c1 = await makeClient(path, "close-a", { reconnectDelayMs: 60_000 });
    await reg1;

    const reg2 = waitForRegistration();
    const c2 = await makeClient(path, "close-b", { reconnectDelayMs: 60_000 });
    await reg2;

    expect(server.clientCount()).toBe(2);

    // Remove from cleanup list since we close manually
    const idx = servers.indexOf(server);
    if (idx >= 0) servers.splice(idx, 1);

    await server.close();
    await wait(100);

    expect(server.clientCount()).toBe(0);
    expect(c1.client.isConnected()).toBe(false);
    expect(c2.client.isConnected()).toBe(false);
  });

  it("inbound message with all optional fields preserved through routing", async () => {
    const path = tmpSocket();
    const { server, waitForRegistration } = makeServer(path);

    const regPromise = waitForRegistration();
    const c = await makeClient(path, "full-msg-agent");
    await regPromise;

    const inboundPromise = c.waitForInbound();
    const fullMsg: InboundMessage = {
      type: "inbound",
      chatId: "-1001234567890",
      threadId: 42,
      messageId: 999,
      user: "alice",
      userId: 12345,
      ts: 1700000000,
      text: "hello world",
      imagePath: "/tmp/photo.jpg",
      attachment: { fileId: "abc123", mimeType: "image/jpeg", fileName: "photo.jpg" },
      meta: { steering: "false", source: "telegram" },
    };

    server.sendToAgent("full-msg-agent", fullMsg);
    const received = await inboundPromise;

    expect(received).toEqual(fullMsg);
  });
});
