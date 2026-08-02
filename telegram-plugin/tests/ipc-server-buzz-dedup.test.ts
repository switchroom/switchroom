import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createIpcServer, type IpcServer, type IpcClient } from "../gateway/ipc-server.js";
import { createInjectIpcClient, type InjectIpcClient } from "../../src/agent-scheduler/ipc-client.js";
import type { InjectInboundMessage, InboundMessage } from "../gateway/ipc-protocol.js";

/**
 * Hub-side Buzz dedup ring (fable MAJOR-2). The Buzz sidecar's durable journal
 * covers the normal case, but a crash AFTER the gateway injects but BEFORE the
 * sidecar records dedup would re-fire the turn on restart. The ipc-server keeps
 * a bounded in-memory ring keyed on the Buzz event id and drops a re-injected
 * duplicate at the hub — scoped strictly to meta.source==="buzz" so no existing
 * inject source (cron/reactions/etc.) changes behaviour.
 */

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipc-buzz-dedup-"));
  return join(dir, "test.sock");
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: "inbound",
    chatId: "555",
    messageId: 0,
    user: "buzz:deadbeef…abcd",
    userId: 0,
    ts: Date.now(),
    text: "<channel source=\"buzz\">hi</channel>",
    meta: { source: "buzz", buzz_event_id: "evt-1" },
    ...over,
  };
}

function injectMsg(inb: InboundMessage): InjectInboundMessage {
  return { type: "inject_inbound", agentName: "klanker", inbound: inb };
}

describe("ipc-server hub-side Buzz dedup ring (fable MAJOR-2)", () => {
  const servers: IpcServer[] = [];
  const clients: InjectIpcClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  async function setup() {
    const path = tmpSocket();
    const onInjectInbound = vi.fn();
    const server = createIpcServer({
      socketPath: path,
      onClientRegistered: vi.fn(),
      onClientDisconnected: vi.fn(),
      onToolCall: vi.fn(),
      onSessionEvent: vi.fn(),
      onPermissionRequest: vi.fn(),
      onHeartbeat: vi.fn(),
      onInjectInbound,
    });
    servers.push(server);
    const client = createInjectIpcClient({ socketPath: path });
    clients.push(client);
    await client.waitForConnect(2000);
    return { client, onInjectInbound };
  }

  it("drops a duplicate buzz inject (same buzz_event_id) at the hub", async () => {
    const { client, onInjectInbound } = await setup();

    client.sendInjectInbound(injectMsg(inbound({ meta: { source: "buzz", buzz_event_id: "evt-dup" } })));
    await wait(60);
    client.sendInjectInbound(injectMsg(inbound({ meta: { source: "buzz", buzz_event_id: "evt-dup" } })));
    await wait(60);

    // Only the FIRST inject with this id reaches the handler.
    expect(onInjectInbound).toHaveBeenCalledTimes(1);
  });

  it("passes a distinct-key buzz inject through (not spuriously deduped)", async () => {
    const { client, onInjectInbound } = await setup();

    client.sendInjectInbound(injectMsg(inbound({ meta: { source: "buzz", buzz_event_id: "evt-a" } })));
    await wait(40);
    client.sendInjectInbound(injectMsg(inbound({ meta: { source: "buzz", buzz_event_id: "evt-b" } })));
    await wait(60);

    expect(onInjectInbound).toHaveBeenCalledTimes(2);
  });

  it("never dedups a non-buzz inject, even with a repeated key", async () => {
    const { client, onInjectInbound } = await setup();

    // A cron inject carrying the SAME (non-buzz) shape twice must fire twice —
    // the ring is buzz-only and must not touch other sources.
    const cron = inbound({ meta: { source: "cron", buzz_event_id: "evt-a" } });
    client.sendInjectInbound(injectMsg(cron));
    await wait(40);
    client.sendInjectInbound(injectMsg(cron));
    await wait(60);

    expect(onInjectInbound).toHaveBeenCalledTimes(2);
  });

  it("a buzz inject WITHOUT a buzz_event_id is passed through (never dropped blind)", async () => {
    const { client, onInjectInbound } = await setup();

    const noId = inbound({ meta: { source: "buzz" } });
    client.sendInjectInbound(injectMsg(noId));
    await wait(40);
    client.sendInjectInbound(injectMsg(noId));
    await wait(60);

    expect(onInjectInbound).toHaveBeenCalledTimes(2);
  });
});
