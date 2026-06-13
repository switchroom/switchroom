/**
 * Minimal IPC client used by the in-agent scheduler sibling
 * (Phase 2 cron-fold-in) to send `inject_inbound` messages to the
 * agent's gateway. Deliberately separate from the bridge's
 * `telegram-plugin/bridge/ipc-client.ts` — the scheduler does NOT
 * need heartbeats, tool-call RPC, permission-event handling, the
 * liveness file, or the inbound/permission/status receive loop.
 * It just needs to write NDJSON `inject_inbound` envelopes to the
 * gateway socket and reconnect when the socket goes away.
 *
 * Uses `node:net` (works under both node and bun) so the bundled
 * agent-scheduler runs identically inside the agent container
 * regardless of which runtime supervises it.
 *
 * Trust model: the gateway socket lives at a per-agent path inside
 * the agent container (default `${TELEGRAM_STATE_DIR}/gateway.sock`,
 * overridable via `SWITCHROOM_GATEWAY_SOCKET`). Only processes
 * inside this container's network namespace can connect — the
 * scheduler runs as a sibling of the gateway under the same agent
 * UID, so peer authentication is the container boundary itself.
 */

import { createConnection, type Socket } from "node:net";
import type { InjectInboundMessage, SendOutboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";

export interface InjectIpcClientOptions {
  socketPath: string;
  /** Initial reconnect delay in ms; doubles up to maxReconnectDelayMs. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /**
   * Connect attempt timeout in ms. Default 5_000. The gateway boots in
   * the same container's start.sh preamble; if it isn't up after 5s,
   * it's not coming up on its own — the supervisor wrapper around the
   * scheduler will respawn the whole process.
   */
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
  /**
   * Test seam — replace `createConnection`. Default uses node:net.
   * Tests pass a fake that returns a Socket-shaped object with
   * `.write`, `.end`, and the `connect` / `close` / `error` events.
   */
  _connect?: (socketPath: string) => Socket;
}

export interface InjectIpcClient {
  /**
   * Send an inject_inbound envelope. Returns true if the bytes were
   * accepted by the local socket (which is the strongest delivery
   * signal a fire-and-forget client gets); false when not connected
   * or the write fails.
   */
  sendInjectInbound(msg: InjectInboundMessage): boolean;
  /**
   * #2307 Tier-0 action tier — send a MODEL-FREE `send_outbound` envelope
   * (a `kind: action` telegram-message). Same fire-and-forget delivery
   * semantics as `sendInjectInbound`: true iff the bytes were accepted by
   * the local socket. The gateway fences the chat to the agent's own.
   */
  sendOutbound(msg: SendOutboundMessage): boolean;
  isConnected(): boolean;
  /**
   * Resolve to true once the client is connected, false on timeout.
   * Used by the boot-time replay path to avoid attempting
   * `sendInjectInbound` before the gateway socket is up — a misfire
   * there would be audited as "no agent client connected" and trigger
   * an unnecessary replay loop on next boot.
   */
  waitForConnect(timeoutMs: number): Promise<boolean>;
  close(): void;
}

export function createInjectIpcClient(
  options: InjectIpcClientOptions,
): InjectIpcClient {
  const {
    socketPath,
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
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  function clearConnectTimeout(): void {
    if (connectTimeoutTimer !== null) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    log(`scheduler ipc: reconnecting in ${currentDelay}ms`);
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
    if (!closed) scheduleReconnect();
  }

  function connect(): void {
    if (closed) return;
    let s: Socket;
    try {
      s = _connect(socketPath);
    } catch (err) {
      log(`scheduler ipc: connect threw: ${(err as Error).message}`);
      scheduleReconnect();
      return;
    }
    socket = s;

    connectTimeoutTimer = setTimeout(() => {
      connectTimeoutTimer = null;
      if (!connected) {
        log(`scheduler ipc: connect timeout after ${connectTimeoutMs}ms`);
        try { s.destroy(); } catch { /* nothing to do */ }
      }
    }, connectTimeoutMs);

    s.on("connect", () => {
      clearConnectTimeout();
      connected = true;
      currentDelay = reconnectDelayMs;
      log(`scheduler ipc: connected to ${socketPath}`);
    });
    s.on("close", () => onClose());
    s.on("error", (err) => {
      log(`scheduler ipc: socket error: ${err.message}`);
      // 'close' fires after 'error', so onClose handles reconnect.
    });
    // The scheduler doesn't process inbound bytes — drain any to keep
    // the kernel buffer from filling. The gateway never replies to
    // inject_inbound, so this is just defence in depth.
    s.on("data", () => { /* discard */ });
  }

  // Kick off the first connect attempt asynchronously so the caller
  // can install the cron handlers before the connection goes live.
  setImmediate(connect);

  return {
    sendInjectInbound(msg: InjectInboundMessage): boolean {
      if (!socket || !connected) return false;
      try {
        return socket.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        log(`scheduler ipc: write failed: ${(err as Error).message}`);
        return false;
      }
    },
    sendOutbound(msg: SendOutboundMessage): boolean {
      if (!socket || !connected) return false;
      try {
        return socket.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        log(`scheduler ipc: write failed: ${(err as Error).message}`);
        return false;
      }
    },
    isConnected(): boolean {
      return connected;
    },
    waitForConnect(timeoutMs: number): Promise<boolean> {
      if (connected) return Promise.resolve(true);
      if (closed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (connected) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (closed || Date.now() - start >= timeoutMs) {
            clearInterval(timer);
            resolve(connected);
          }
        }, 50);
        // Don't keep the event loop alive for this — the caller's
        // shutdown path will close() the client and unblock us.
        if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
          (timer as unknown as { unref: () => void }).unref();
        }
      });
    },
    close(): void {
      closed = true;
      clearReconnectTimer();
      clearConnectTimeout();
      if (socket) {
        try { socket.end(); } catch { /* nothing to do */ }
        socket = null;
      }
      connected = false;
    },
  };
}
