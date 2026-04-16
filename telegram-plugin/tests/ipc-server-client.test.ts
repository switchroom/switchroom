import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createIpcServer, type IpcServer, type IpcClient } from "../gateway/ipc-server.js";
import { createIpcClient, type IpcClientHandle } from "../bridge/ipc-client.js";
import type {
  ToolCallMessage,
  ToolCallResult,
  SessionEventForward,
  HeartbeatMessage,
  InboundMessage,
  StatusEvent,
} from "../gateway/ipc-protocol.js";

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipc-test-"));
  return join(dir, "test.sock");
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("IPC Server + Client integration", () => {
  const servers: IpcServer[] = [];
  const clients: IpcClientHandle[] = [];

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  function makeServer(
    socketPath: string,
    overrides: Partial<Parameters<typeof createIpcServer>[0]> = {},
  ) {
    const registered = vi.fn();
    const disconnected = vi.fn();
    const toolCallHandler = vi.fn(async (_client: IpcClient, msg: ToolCallMessage): Promise<ToolCallResult> => ({
      type: "tool_call_result",
      id: msg.id,
      success: true,
      result: { echo: msg.tool },
    }));
    const sessionEventHandler = vi.fn();
    const permissionRequestHandler = vi.fn();
    const heartbeatHandler = vi.fn();

    const server = createIpcServer({
      socketPath,
      onClientRegistered: overrides.onClientRegistered ?? registered,
      onClientDisconnected: overrides.onClientDisconnected ?? disconnected,
      onToolCall: overrides.onToolCall ?? toolCallHandler,
      onSessionEvent: overrides.onSessionEvent ?? sessionEventHandler,
      onPermissionRequest: overrides.onPermissionRequest ?? permissionRequestHandler,
      onHeartbeat: overrides.onHeartbeat ?? heartbeatHandler,
    });
    servers.push(server);
    return { server, registered, disconnected, toolCallHandler, sessionEventHandler, permissionRequestHandler, heartbeatHandler };
  }

  async function makeClient(
    socketPath: string,
    agentName: string,
    overrides: Partial<Parameters<typeof createIpcClient>[0]> = {},
  ) {
    const onInbound = overrides.onInbound ?? vi.fn();
    const onPermission = overrides.onPermission ?? vi.fn();
    const onStatus = overrides.onStatus ?? vi.fn();
    const client = await createIpcClient({
      socketPath,
      agentName,
      topicId: overrides.topicId,
      onInbound,
      onPermission,
      onStatus,
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 60000, // long default to avoid noise
      reconnectDelayMs: overrides.reconnectDelayMs ?? 100,
      maxReconnectDelayMs: overrides.maxReconnectDelayMs ?? 500,
    });
    clients.push(client);
    return { client, onInbound, onPermission, onStatus };
  }

  it("server starts and listens on socket", () => {
    const path = tmpSocket();
    const { server } = makeServer(path);
    expect(server.clientCount()).toBe(0);
  });

  it("client connects and registers", async () => {
    const path = tmpSocket();
    const { server, registered } = makeServer(path);
    const { client } = await makeClient(path, "assistant");

    await wait(50);

    expect(client.isConnected()).toBe(true);
    expect(server.clientCount()).toBe(1);
    expect(registered).toHaveBeenCalledTimes(1);

    const registeredClient = registered.mock.calls[0][0] as IpcClient;
    expect(registeredClient.agentName).toBe("assistant");
  });

  it("client calls tool, server receives and responds", async () => {
    const path = tmpSocket();
    const { server, toolCallHandler } = makeServer(path);
    const { client } = await makeClient(path, "assistant");
    await wait(50);

    const result = await client.callTool("reply", { text: "hi" });

    expect(result.type).toBe("tool_call_result");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ echo: "reply" });
    expect(toolCallHandler).toHaveBeenCalledTimes(1);
    expect(toolCallHandler.mock.calls[0][1].tool).toBe("reply");
    expect(toolCallHandler.mock.calls[0][1].args).toEqual({ text: "hi" });
  });

  it("client disconnects, server cleans up routing", async () => {
    const path = tmpSocket();
    const { server, disconnected } = makeServer(path);
    const { client } = await makeClient(path, "worker");
    await wait(50);

    expect(server.clientCount()).toBe(1);
    expect(server.getClient("worker")).toBeDefined();

    client.close();
    await wait(100);

    expect(server.clientCount()).toBe(0);
    expect(server.getClient("worker")).toBeUndefined();
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("multiple clients can connect", async () => {
    const path = tmpSocket();
    const { server, registered } = makeServer(path);

    await makeClient(path, "assistant", { topicId: 10 });
    await makeClient(path, "worker", { topicId: 20 });
    await wait(50);

    expect(server.clientCount()).toBe(2);
    expect(registered).toHaveBeenCalledTimes(2);
    expect(server.getClient("assistant")).toBeDefined();
    expect(server.getClient("worker")).toBeDefined();
  });

  it("server broadcasts to all clients", async () => {
    const path = tmpSocket();
    const { server } = makeServer(path);

    const c1 = await makeClient(path, "agent-a");
    const c2 = await makeClient(path, "agent-b");
    await wait(50);

    const statusMsg: StatusEvent = { type: "status", status: "gateway_shutting_down" };
    server.broadcast(statusMsg);
    await wait(100);

    expect(c1.onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", status: "gateway_shutting_down" }),
    );
    expect(c2.onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", status: "gateway_shutting_down" }),
    );
  });

  it("server sendToAgent routes to correct client", async () => {
    const path = tmpSocket();
    const { server } = makeServer(path);

    const c1 = await makeClient(path, "agent-a");
    const c2 = await makeClient(path, "agent-b");
    await wait(50);

    const msg: InboundMessage = {
      type: "inbound",
      chatId: "123",
      messageId: 1,
      user: "alice",
      userId: 1,
      ts: Date.now(),
      text: "hello",
      meta: {},
    };

    const sent = server.sendToAgent("agent-a", msg);
    expect(sent).toBe(true);
    await wait(50);

    expect(c1.onInbound).toHaveBeenCalledTimes(1);
    expect(c2.onInbound).not.toHaveBeenCalled();
  });

  it("server sendToTopic routes to correct client", async () => {
    const path = tmpSocket();
    const { server } = makeServer(path);

    const c1 = await makeClient(path, "agent-a", { topicId: 100 });
    const c2 = await makeClient(path, "agent-b", { topicId: 200 });
    await wait(50);

    const msg: InboundMessage = {
      type: "inbound",
      chatId: "123",
      messageId: 1,
      user: "bob",
      userId: 2,
      ts: Date.now(),
      text: "world",
      meta: {},
    };

    const sent = server.sendToTopic(200, msg);
    expect(sent).toBe(true);
    await wait(50);

    expect(c2.onInbound).toHaveBeenCalledTimes(1);
    expect(c1.onInbound).not.toHaveBeenCalled();
  });

  it("client reconnects after server restart", async () => {
    const path = tmpSocket();
    const { server: server1, registered: registered1 } = makeServer(path);
    const { client } = await makeClient(path, "resilient", {
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 200,
    });
    await wait(50);

    expect(registered1).toHaveBeenCalledTimes(1);

    await server1.close();
    servers.length = 0;
    await wait(50);

    expect(client.isConnected()).toBe(false);

    const { server: server2, registered: registered2 } = makeServer(path);
    await wait(500);

    expect(client.isConnected()).toBe(true);
    expect(registered2).toHaveBeenCalledTimes(1);
    expect(registered2.mock.calls[0][0].agentName).toBe("resilient");
  });

  it("callTool timeout produces error", async () => {
    const path = tmpSocket();
    makeServer(path, {
      onToolCall: async (_client, msg) => {
        // Never respond — simulate a hung tool call
        await new Promise(() => {});
        return { type: "tool_call_result", id: msg.id, success: true };
      },
    });
    const { client } = await makeClient(path, "timeout-test");
    await wait(50);

    await expect(client.callTool("slow_tool", {}, 200)).rejects.toThrow(/timed out/);
  });

  it("callTool when disconnected rejects immediately", async () => {
    const path = tmpSocket();
    makeServer(path);
    const { client } = await makeClient(path, "disc-test");
    await wait(50);

    client.close();
    await expect(client.callTool("reply", {})).rejects.toThrow(/not connected/);
  });

  it("heartbeat keeps connection alive and is received by server", async () => {
    const path = tmpSocket();
    const { heartbeatHandler } = makeServer(path);
    await makeClient(path, "hb-agent", { heartbeatIntervalMs: 100 });
    await wait(350);

    expect(heartbeatHandler).toHaveBeenCalled();
    const lastCall = heartbeatHandler.mock.calls[heartbeatHandler.mock.calls.length - 1];
    expect(lastCall[1].agentName).toBe("hb-agent");
  });

  it("session events are forwarded to server", async () => {
    const path = tmpSocket();
    const { sessionEventHandler } = makeServer(path);
    const { client } = await makeClient(path, "session-agent");
    await wait(50);

    const event: SessionEventForward = {
      type: "session_event",
      event: { type: "assistant", message: "test" },
      chatId: "456",
      threadId: 7,
    };
    client.sendSessionEvent(event);
    await wait(50);

    expect(sessionEventHandler).toHaveBeenCalledTimes(1);
    expect(sessionEventHandler.mock.calls[0][1]).toEqual(event);
  });

  it("sendToAgent returns false for unknown agent", () => {
    const path = tmpSocket();
    const { server } = makeServer(path);
    const result = server.sendToAgent("nonexistent", { type: "status", status: "agent_down" });
    expect(result).toBe(false);
  });

  it("sendToTopic returns false for unknown topic", () => {
    const path = tmpSocket();
    const { server } = makeServer(path);
    const result = server.sendToTopic(9999, { type: "status", status: "agent_down" });
    expect(result).toBe(false);
  });
});
