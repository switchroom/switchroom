/**
 * Buzz sidecar — Phase 2b DUPLEX peer client.
 *
 * Unlike the send-only inject client (`agent-scheduler/ipc-client.ts`, which
 * discards all inbound bytes), this client BOTH sends and receives on the
 * gateway socket. It announces itself once per connection with `hello_buzz_peer`
 * — NEVER `register` — so the gateway parks it in the dedicated watchdog-exempt
 * peer slot and never confuses it for the agent's MCP bridge (S7, enforced hub-
 * side as a code check). It then receives `outbound_to_buzz` publish requests,
 * hands each to the injected `onOutbound` handler (which signs+publishes via
 * `publisher.ts`), and returns the handler's `buzz_publish_result`.
 *
 * `node:net` (works under node and bun). Reconnect/backoff mirrors the inject
 * client; `hello_buzz_peer` is re-sent on every (re)connect.
 */

import { createConnection, type Socket } from "node:net";
import type {
  HelloBuzzPeerMessage,
  OutboundToBuzzMessage,
  BuzzPublishResultMessage,
} from "../../telegram-plugin/gateway/ipc-protocol.js";

export interface BuzzPeerClientOptions {
  socketPath: string;
  /** The agent whose outbound this peer publishes (stamped on hello_buzz_peer). */
  agentName: string;
  /** Sign + publish one request, resolving with the result to send back. */
  onOutbound: (msg: OutboundToBuzzMessage) => Promise<BuzzPublishResultMessage>;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Test seam — replace `createConnection`. */
  _connect?: (socketPath: string) => Socket;
}

export interface BuzzPeerClient {
  isConnected(): boolean;
  close(): void;
}

const MAX_BUFFER_BYTES = 1024 * 1024;

export function createBuzzPeerClient(options: BuzzPeerClientOptions): BuzzPeerClient {
  const {
    socketPath,
    agentName,
    onOutbound,
    reconnectDelayMs = 1_000,
    maxReconnectDelayMs = 30_000,
    connectTimeoutMs = 5_000,
    log = () => {},
    _connect = (path) => createConnection(path),
  } = options;

  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let currentDelay = reconnectDelayMs;
  let buffer = "";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  function clearConnectTimeout(): void {
    if (connectTimeoutTimer !== null) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    log(`buzz peer ipc: reconnecting in ${currentDelay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) connect();
    }, currentDelay);
    currentDelay = Math.min(currentDelay * 2, maxReconnectDelayMs);
  }

  function onClose(): void {
    clearConnectTimeout();
    connected = false;
    socket = null;
    buffer = "";
    if (!closed) scheduleReconnect();
  }

  function write(msg: HelloBuzzPeerMessage | BuzzPublishResultMessage): boolean {
    if (!socket || !connected) return false;
    try {
      return socket.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      log(`buzz peer ipc: write failed: ${(err as Error).message}`);
      return false;
    }
  }

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log(`buzz peer ipc: bad JSON from gateway: ${line.slice(0, 120)}`);
      return;
    }
    const m = parsed as { type?: unknown };
    // The gateway only ever sends `outbound_to_buzz` to a peer; ignore anything
    // else defensively (mixed-version safety).
    if (m.type !== "outbound_to_buzz") return;
    const req = parsed as OutboundToBuzzMessage;
    // Fire-and-forget: publish, then send the result back. A handler rejection
    // is reported as a failed publish (never crashes the socket loop).
    onOutbound(req).then(
      (result) => { write(result); },
      (err) => {
        write({
          type: "buzz_publish_result",
          correlationId: req.correlationId,
          ok: false,
          error: `sidecar publisher error: ${(err as Error).message}`,
        });
      },
    );
  }

  function processData(chunk: string): void {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      log("buzz peer ipc: buffer overflow, dropping connection");
      try { socket?.destroy(); } catch { /* nothing to do */ }
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) handleLine(line);
    }
  }

  function connect(): void {
    if (closed) return;
    let s: Socket;
    try {
      s = _connect(socketPath);
    } catch (err) {
      log(`buzz peer ipc: connect threw: ${(err as Error).message}`);
      scheduleReconnect();
      return;
    }
    socket = s;

    connectTimeoutTimer = setTimeout(() => {
      connectTimeoutTimer = null;
      if (!connected) {
        log(`buzz peer ipc: connect timeout after ${connectTimeoutMs}ms`);
        try { s.destroy(); } catch { /* nothing to do */ }
      }
    }, connectTimeoutMs);

    s.on("connect", () => {
      clearConnectTimeout();
      connected = true;
      currentDelay = reconnectDelayMs;
      buffer = "";
      log(`buzz peer ipc: connected to ${socketPath}`);
      // Announce as the duplex publish peer — once per connection.
      write({ type: "hello_buzz_peer", agentName });
    });
    s.on("close", () => onClose());
    s.on("error", (err) => {
      log(`buzz peer ipc: socket error: ${err.message}`);
      // 'close' fires after 'error'; onClose handles reconnect.
    });
    s.on("data", (data: Buffer) => processData(data.toString()));
  }

  setImmediate(connect);

  return {
    isConnected(): boolean {
      return connected;
    },
    close(): void {
      closed = true;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearConnectTimeout();
      if (socket) {
        try { socket.end(); } catch { /* nothing to do */ }
        socket = null;
      }
      connected = false;
    },
  };
}
