import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createBuzzPeerClient } from "./peer-client.js";
import type {
  OutboundToBuzzMessage,
  BuzzPublishResultMessage,
} from "../../telegram-plugin/gateway/ipc-protocol.js";

// A fake node:net Socket: an EventEmitter that records everything written and
// lets the test push inbound NDJSON lines. peer-client's `_connect` seam swaps
// createConnection for this, so no real UDS is needed.
class FakeSocket extends EventEmitter {
  writes: string[] = [];
  ended = false;
  destroyed = false;
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** Test helper: deliver a JSON message as one NDJSON frame from the gateway. */
  pushLine(obj: unknown): void {
    this.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  }
  /** Test helper: the peer dials via setImmediate(connect); fire 'connect'. */
  fireConnect(): void {
    this.emit("connect");
  }
  parsedWrites(): unknown[] {
    return this.writes.flatMap((w) =>
      w.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)),
    );
  }
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("createBuzzPeerClient — announces as a peer, never registers (S7)", () => {
  it("sends hello_buzz_peer (NOT register) once on connect", async () => {
    const fake = new FakeSocket();
    const onOutbound = vi.fn(async (): Promise<BuzzPublishResultMessage> => ({
      type: "buzz_publish_result",
      correlationId: "x",
      ok: true,
    }));
    createBuzzPeerClient({
      socketPath: "/tmp/unused.sock",
      agentName: "klanker",
      onOutbound,
      _connect: () => fake as unknown as Socket,
    });
    await tick(); // let setImmediate(connect) run
    fake.fireConnect();

    const msgs = fake.parsedWrites() as Array<{ type: string; agentName?: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("hello_buzz_peer");
    expect(msgs[0].agentName).toBe("klanker");
    // It must NEVER announce itself as an agent bridge.
    expect(msgs.some((m) => m.type === "register")).toBe(false);
  });

  it("routes an outbound_to_buzz through onOutbound and writes back the result", async () => {
    const fake = new FakeSocket();
    const result: BuzzPublishResultMessage = {
      type: "buzz_publish_result",
      correlationId: "corr-1",
      ok: true,
      eventId: "evt-abc",
    };
    const onOutbound = vi.fn(async (_m: OutboundToBuzzMessage) => result);
    createBuzzPeerClient({
      socketPath: "/tmp/unused.sock",
      agentName: "klanker",
      onOutbound,
      _connect: () => fake as unknown as Socket,
    });
    await tick();
    fake.fireConnect();
    fake.writes.length = 0; // drop the hello frame

    const req: OutboundToBuzzMessage = {
      type: "outbound_to_buzz",
      correlationId: "corr-1",
      agentName: "klanker",
      channelId: "chan",
      payload: { kind: "message", text: "hello" },
    };
    fake.pushLine(req);
    await tick();
    await tick();

    expect(onOutbound).toHaveBeenCalledTimes(1);
    expect(onOutbound.mock.calls[0][0].correlationId).toBe("corr-1");
    expect(fake.parsedWrites()).toEqual([result]);
  });

  it("reports a failed publish (never crashes the loop) when onOutbound rejects", async () => {
    const fake = new FakeSocket();
    const onOutbound = vi.fn(async (): Promise<BuzzPublishResultMessage> => {
      throw new Error("signer blew up");
    });
    createBuzzPeerClient({
      socketPath: "/tmp/unused.sock",
      agentName: "klanker",
      onOutbound,
      _connect: () => fake as unknown as Socket,
    });
    await tick();
    fake.fireConnect();
    fake.writes.length = 0;

    fake.pushLine({
      type: "outbound_to_buzz",
      correlationId: "corr-2",
      agentName: "klanker",
      channelId: "chan",
      payload: { kind: "message", text: "x" },
    });
    await tick();
    await tick();

    const out = fake.parsedWrites() as BuzzPublishResultMessage[];
    expect(out).toHaveLength(1);
    expect(out[0].correlationId).toBe("corr-2");
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toMatch(/signer blew up/);
  });

  it("ignores non-outbound_to_buzz frames defensively (mixed-version safety)", async () => {
    const fake = new FakeSocket();
    const onOutbound = vi.fn(async (): Promise<BuzzPublishResultMessage> => ({
      type: "buzz_publish_result",
      correlationId: "x",
      ok: true,
    }));
    createBuzzPeerClient({
      socketPath: "/tmp/unused.sock",
      agentName: "klanker",
      onOutbound,
      _connect: () => fake as unknown as Socket,
    });
    await tick();
    fake.fireConnect();
    fake.writes.length = 0;

    fake.pushLine({ type: "status", status: "gateway_shutting_down" });
    fake.pushLine({ type: "inbound", chatId: "1", text: "hi" });
    await tick();

    expect(onOutbound).not.toHaveBeenCalled();
    expect(fake.writes).toHaveLength(0);
  });
});
