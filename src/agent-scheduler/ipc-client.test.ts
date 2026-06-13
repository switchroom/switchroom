/**
 * Unit tests for the agent-scheduler IPC client. Uses an injectable
 * `_connect` to simulate the gateway socket without binding a real
 * Unix socket — that's covered separately by the integration suite.
 *
 * Properties exercised:
 *   - sendInjectInbound returns false before connect, true after
 *   - the wire format is one NDJSON line per message
 *   - close() prevents further reconnect attempts
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createInjectIpcClient } from "./ipc-client.js";
import type { InjectInboundMessage, SendOutboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";

class FakeSocket extends EventEmitter {
  public writes: string[] = [];
  public ended = false;
  public destroyed = false;
  write(data: string | Uint8Array): boolean {
    this.writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    return true;
  }
  end(): void {
    this.ended = true;
    setImmediate(() => this.emit("close"));
  }
  destroy(): void {
    this.destroyed = true;
    setImmediate(() => this.emit("close"));
  }
}

function sampleMsg(): InjectInboundMessage {
  return {
    type: "inject_inbound",
    agentName: "klanker",
    inbound: {
      type: "inbound",
      chatId: "-100",
      messageId: 1,
      user: "cron",
      userId: 0,
      ts: 1,
      text: "hi",
      meta: { source: "cron", schedule_index: "0", prompt_key: "abc" },
    },
  };
}

async function tick(): Promise<void> {
  // Two macrotask hops — setImmediate (used by the client to defer
  // the initial connect) + EventEmitter sync emit.
  await new Promise<void>((res) => setImmediate(res));
  await new Promise<void>((res) => setImmediate(res));
}

describe("createInjectIpcClient", () => {
  it("returns false before the connect event fires, true once connected", async () => {
    const fake = new FakeSocket();
    const client = createInjectIpcClient({
      socketPath: "/fake.sock",
      _connect: () => fake as unknown as Socket,
    });
    expect(client.isConnected()).toBe(false);
    expect(client.sendInjectInbound(sampleMsg())).toBe(false);

    await tick();
    fake.emit("connect");

    expect(client.isConnected()).toBe(true);
    expect(client.sendInjectInbound(sampleMsg())).toBe(true);
    expect(fake.writes).toHaveLength(1);
    const wire = fake.writes[0]!;
    expect(wire.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(wire.trim());
    expect(parsed.type).toBe("inject_inbound");
    expect(parsed.agentName).toBe("klanker");
    expect(parsed.inbound.meta.source).toBe("cron");

    client.close();
  });

  it("sendOutbound returns false before connect, true after, as one NDJSON line", async () => {
    const fake = new FakeSocket();
    const client = createInjectIpcClient({
      socketPath: "/fake.sock",
      _connect: () => fake as unknown as Socket,
    });
    const msg: SendOutboundMessage = {
      type: "send_outbound",
      agentName: "clerk",
      chatId: "12345",
      threadId: 7,
      text: "Daily heartbeat 2026-06-13",
      parseMode: "html",
    };
    expect(client.sendOutbound(msg)).toBe(false); // not connected yet

    await tick();
    fake.emit("connect");

    expect(client.sendOutbound(msg)).toBe(true);
    expect(fake.writes).toHaveLength(1);
    const parsed = JSON.parse(fake.writes[0]!.trim());
    expect(parsed.type).toBe("send_outbound");
    expect(parsed.chatId).toBe("12345");
    expect(parsed.text).toBe("Daily heartbeat 2026-06-13");
    client.close();
  });

  it("close() prevents further reconnect attempts", async () => {
    let connectCalls = 0;
    const factory = () => {
      connectCalls += 1;
      const s = new FakeSocket();
      // Never emit 'connect'; close immediately.
      setImmediate(() => s.emit("close"));
      return s as unknown as Socket;
    };
    const client = createInjectIpcClient({
      socketPath: "/fake.sock",
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      connectTimeoutMs: 10_000,
      _connect: factory,
    });
    await tick();
    // First attempt fired; close before reconnect timer runs.
    expect(connectCalls).toBe(1);
    client.close();
    await new Promise<void>((res) => setTimeout(res, 5));
    // close should have prevented the reconnect from firing.
    expect(connectCalls).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  it("after a connected socket closes, the client schedules a reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const factory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as Socket;
    };
    const client = createInjectIpcClient({
      socketPath: "/fake.sock",
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      _connect: factory,
    });
    await tick();
    sockets[0]!.emit("connect");
    expect(client.isConnected()).toBe(true);
    sockets[0]!.emit("close");
    expect(client.isConnected()).toBe(false);
    // Wait for reconnect timer.
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.close();
  });
});
