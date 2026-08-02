import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createConnection, type Socket } from "net";
import { createIpcServer, type IpcServer, type IpcClient } from "../gateway/ipc-server.js";
import type { OutboundToBuzzMessage } from "../gateway/ipc-protocol.js";

/**
 * Buzz co-channel Phase 2b — S7 role-disjointness, enforced as a GATEWAY CODE
 * mechanism (not sidecar self-discipline). These are real-Unix-socket tests: a
 * raw net client sends hand-crafted frames so we can exercise the adversarial
 * orderings a well-behaved sidecar would never emit.
 *
 * The invariants (ipc-server.ts handleHelloBuzzPeer / handleRegister):
 *   - a hello_buzz_peer parks the connection as the single Buzz peer, NEVER in
 *     agentIndex (getClient stays undefined; the peer's agentName is null);
 *   - register on a peer connection is refused (close+drop);
 *   - hello on an already-registered connection is refused (close+drop);
 *   - the peer rides the watchdog's agentName===null exemption (never evicted);
 *   - the peer slot is released on disconnect (identity-checked).
 */

function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipc-buzz-peer-"));
  return join(dir, "test.sock");
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
const OUTBOUND: OutboundToBuzzMessage = {
  type: "outbound_to_buzz",
  correlationId: "c1",
  agentName: "klanker",
  channelId: "chan",
  payload: { kind: "message", text: "x" },
};

describe("ipc-server — Buzz peer role-disjointness (S7)", () => {
  const servers: IpcServer[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
    sockets.length = 0;
    for (const srv of servers) await srv.close();
    servers.length = 0;
  });

  function makeServer(overrides: Partial<Parameters<typeof createIpcServer>[0]> = {}) {
    const registered: IpcClient[] = [];
    const server = createIpcServer({
      socketPath: overrides.socketPath ?? tmpSocket(),
      onClientRegistered: (c) => registered.push(c),
      onClientDisconnected: () => {},
      onToolCall: async (_c, m) => ({ type: "tool_call_result", id: m.id, success: true }),
      onSessionEvent: () => {},
      onPermissionRequest: () => {},
      onHeartbeat: () => {},
      onScheduleRestart: () => {},
      ...overrides,
    });
    servers.push(server);
    return { server, registered };
  }

  /** Open a raw client, resolve once connected. Detects server-side close. */
  function rawClient(socketPath: string) {
    const sock = createConnection(socketPath);
    sockets.push(sock);
    let closedByServer = false;
    sock.on("close", () => { closedByServer = true; });
    sock.on("error", () => { /* server may reset on refuse */ });
    const send = (obj: unknown) => sock.write(JSON.stringify(obj) + "\n");
    const ready = new Promise<void>((res) => sock.on("connect", () => res()));
    return { sock, send, ready, wasClosed: () => closedByServer };
  }

  it("parks a hello_buzz_peer as the Buzz peer, NOT in agentIndex", async () => {
    const path = tmpSocket();
    const { server } = makeServer({ socketPath: path });
    const c = rawClient(path);
    await c.ready;
    c.send({ type: "hello_buzz_peer", agentName: "klanker" });
    await wait(60);

    // Addressable as the peer, but never as an agent bridge.
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(true);
    expect(server.getClient("klanker")).toBeUndefined();
  });

  it("REFUSES a register after hello_buzz_peer (peer must never claim a slot)", async () => {
    const path = tmpSocket();
    const { server } = makeServer({ socketPath: path });
    const c = rawClient(path);
    await c.ready;
    c.send({ type: "hello_buzz_peer", agentName: "klanker" });
    await wait(40);
    c.send({ type: "register", agentName: "klanker" });
    await wait(80);

    // The offending connection was closed+dropped; no agent slot was created.
    expect(c.wasClosed()).toBe(true);
    expect(server.getClient("klanker")).toBeUndefined();
  });

  it("REFUSES a hello_buzz_peer after register (bridge must never become the peer)", async () => {
    const path = tmpSocket();
    const { server } = makeServer({ socketPath: path });
    const c = rawClient(path);
    await c.ready;
    c.send({ type: "register", agentName: "klanker" });
    await wait(40);
    expect(server.getClient("klanker")).toBeDefined(); // registered as a bridge
    c.send({ type: "hello_buzz_peer", agentName: "klanker" });
    await wait(80);

    // The connection is closed+dropped; no Buzz peer was installed.
    expect(c.wasClosed()).toBe(true);
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(false);
  });

  it("EXEMPTS the peer from the heartbeat watchdog (agentName===null)", async () => {
    const path = tmpSocket();
    // Aggressive watchdog: 200ms timeout, no heartbeats from the peer.
    const { server } = makeServer({ socketPath: path, heartbeatTimeoutMs: 200 });
    const c = rawClient(path);
    await c.ready;
    c.send({ type: "hello_buzz_peer", agentName: "klanker" });
    await wait(60);
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(true);

    // Well past the timeout with no heartbeat — a registered bridge would be
    // evicted, but the peer (agentName===null) is exempt and survives.
    await wait(500);
    expect(c.wasClosed()).toBe(false);
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(true);
  });

  it("releases the peer slot on disconnect (sendToBuzzPeer → false)", async () => {
    const path = tmpSocket();
    const { server } = makeServer({ socketPath: path });
    const c = rawClient(path);
    await c.ready;
    c.send({ type: "hello_buzz_peer", agentName: "klanker" });
    await wait(60);
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(true);

    c.sock.destroy();
    await wait(100);
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(false);
  });

  it("forwards outbound_to_buzz to the peer and delivers buzz_publish_result to the handler", async () => {
    const path = tmpSocket();
    const onBuzzPublishResult = vi.fn();
    const { server } = makeServer({ socketPath: path, onBuzzPublishResult });
    const c = rawClient(path);
    const received: unknown[] = [];
    c.sock.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) received.push(JSON.parse(line));
      }
    });
    await c.ready;
    c.send({ type: "hello_buzz_peer", agentName: "klanker" });
    await wait(60);

    // Hub → peer.
    expect(server.sendToBuzzPeer(OUTBOUND)).toBe(true);
    await wait(40);
    expect(received).toContainEqual(expect.objectContaining({ type: "outbound_to_buzz", correlationId: "c1" }));

    // Peer → hub.
    c.send({ type: "buzz_publish_result", correlationId: "c1", ok: true, eventId: "evt-x" });
    await wait(60);
    expect(onBuzzPublishResult).toHaveBeenCalledTimes(1);
    expect(onBuzzPublishResult.mock.calls[0][1]).toMatchObject({ correlationId: "c1", ok: true, eventId: "evt-x" });
  });
});
