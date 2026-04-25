import { renameSync, unlinkSync } from "fs";
import type {
  ClientToGateway,
  GatewayToClient,
  HeartbeatMessage,
  OperatorEventForward,
  PermissionRequestForward,
  RegisterMessage,
  ScheduleRestartMessage,
  SessionEventForward,
  ToolCallMessage,
  ToolCallResult,
} from "./ipc-protocol.js";

export interface IpcServerOptions {
  socketPath: string;
  onClientRegistered: (client: IpcClient) => void;
  onClientDisconnected: (client: IpcClient) => void;
  onToolCall: (client: IpcClient, msg: ToolCallMessage) => Promise<ToolCallResult>;
  onSessionEvent: (client: IpcClient, msg: SessionEventForward) => void;
  onPermissionRequest: (client: IpcClient, msg: PermissionRequestForward) => void;
  onHeartbeat: (client: IpcClient, msg: HeartbeatMessage) => void;
  onScheduleRestart: (client: IpcClient, msg: ScheduleRestartMessage) => void;
  onOperatorEvent?: (client: IpcClient, msg: OperatorEventForward) => void;
  log?: (msg: string) => void;
  /**
   * How long (in ms) to wait without a heartbeat before force-closing the
   * client connection. The bridge sends heartbeats every 5s by default, so
   * a safe threshold is 3–5× that (15–30s). Set to 0 to disable the watchdog.
   * Defaults to 30 000 ms (30 s).
   *
   * Issue #71: without this, a bridge that crashes or hangs silently stays in
   * the agentIndex and new inbound Telegram messages are never delivered to the
   * new claude process that reconnects after a restart.
   */
  heartbeatTimeoutMs?: number;
}

export interface IpcClient {
  id: string;
  agentName: string | null;
  topicId: number | null;
  send(msg: GatewayToClient): void;
  close(): void;
  isAlive(): boolean;
  lastHeartbeat: number;
}

export interface IpcServer {
  sendToAgent(agentName: string, msg: GatewayToClient): boolean;
  sendToTopic(topicId: number, msg: GatewayToClient): boolean;
  broadcast(msg: GatewayToClient): void;
  getClient(agentName: string): IpcClient | undefined;
  clientCount(): number;
  close(): Promise<void>;
}

type SocketData = { clientId: string; buffer: string };

/** Max buffer size per client (1MB). Protects against a client flooding
 *  data without newline delimiters, which would cause unbounded memory growth. */
const MAX_BUFFER_SIZE = 1024 * 1024;

/** Validate that a parsed JSON object looks like a legitimate ClientToGateway
 *  message. Returns false for malformed or unexpected shapes. This prevents
 *  a rogue process on the same Unix socket from injecting arbitrary payloads.
 *
 *  Exported so tests can exercise every field-level rejection independently
 *  without spinning up a real Unix-socket server. */
export function validateClientMessage(msg: unknown): msg is ClientToGateway {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "register":
      return typeof m.agentName === "string"
        && m.agentName.length > 0
        && m.agentName.length <= 128
        && (m.topicId === undefined
          || (typeof m.topicId === "number"
            && Number.isInteger(m.topicId)
            && Number.isFinite(m.topicId)));
    case "tool_call":
      return typeof m.id === "string" && m.id.length > 0
        && typeof m.tool === "string" && m.tool.length > 0
        && typeof m.args === "object" && m.args !== null;
    case "session_event":
      return typeof m.event === "object" && m.event !== null
        && typeof m.chatId === "string";
    case "permission_request":
      return typeof m.requestId === "string" && m.requestId.length > 0
        && typeof m.toolName === "string"
        && typeof m.description === "string"
        && typeof m.inputPreview === "string";
    case "heartbeat":
      return typeof m.agentName === "string" && m.agentName.length > 0;
    case "schedule_restart":
      return typeof m.agentName === "string" && m.agentName.length > 0;
    case "operator_event":
      return typeof m.kind === "string" && m.kind.length > 0
        && typeof m.agent === "string" && m.agent.length > 0
        && typeof m.detail === "string"
        && typeof m.chatId === "string";
    default:
      return false;
  }
}

export function createIpcServer(options: IpcServerOptions): IpcServer {
  const {
    socketPath,
    onClientRegistered,
    onClientDisconnected,
    onToolCall,
    onSessionEvent,
    onPermissionRequest,
    onHeartbeat,
    onScheduleRestart,
    onOperatorEvent,
    log = () => {},
    heartbeatTimeoutMs = 30_000,
  } = options;

  // Race-safe cleanup: rename the live socket to a .bak sidecar rather than
  // unlinking it. If the old gateway's delayed shutdown-cleanup later tries to
  // rename again, it targets .bak (already-moved) not the freshly-bound file.
  // Previous unlinkSync-based cleanup had a race where an in-flight old-gateway
  // cleanup could delete the new gateway's just-bound socket inode, leaving the
  // server listening but the filesystem entry gone (orphaned socket).
  try { renameSync(socketPath, socketPath + ".bak"); } catch {}
  // Now that we're about to bind fresh, stale .bak from a prior generation
  // is safe to remove — no one is using it (we haven't bound yet).
  try { unlinkSync(socketPath + ".bak"); } catch {}

  const clients = new Set<IpcClient>();
  const agentIndex = new Map<string, IpcClient>();
  const topicIndex = new Map<number, IpcClient>();

  function removeClient(client: IpcClient & { _socket: ReturnType<typeof Bun.listen> extends infer S ? any : never }) {
    clients.delete(client);
    if (client.agentName) agentIndex.delete(client.agentName);
    if (client.topicId != null) topicIndex.delete(client.topicId);
    onClientDisconnected(client);
    log(`client disconnected: ${client.id} (agent=${client.agentName})`);
  }

  // Local alias of the exported validator — kept as a named reference so
  // the call site below reads the same as before.
  const validateMessage = validateClientMessage;

  function processBuffer(
    socket: import("bun").Socket<SocketData>,
  ) {
    const lines = socket.data.buffer.split("\n");
    socket.data.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!validateMessage(parsed)) {
          log(`invalid IPC message shape from client: ${line.slice(0, 200)}`);
          continue;
        }
        const client = clientBySocketId.get(socket.data.clientId);
        if (client) handleMessage(client, parsed);
      } catch {
        log(`bad JSON from client: ${line.slice(0, 200)}`);
      }
    }
  }

  function handleMessage(client: IpcClientImpl, msg: ClientToGateway) {
    switch (msg.type) {
      case "register":
        handleRegister(client, msg);
        break;
      case "tool_call":
        handleToolCall(client, msg);
        break;
      case "session_event":
        onSessionEvent(client, msg);
        break;
      case "permission_request":
        onPermissionRequest(client, msg);
        break;
      case "heartbeat":
        client.lastHeartbeat = Date.now();
        onHeartbeat(client, msg);
        break;
      case "schedule_restart":
        onScheduleRestart(client, msg);
        break;
      case "operator_event":
        if (onOperatorEvent) onOperatorEvent(client, msg as OperatorEventForward);
        break;
      default:
        log(`unknown IPC message type from client ${client.id}: ${(msg as any).type}`);
    }
  }

  function handleRegister(client: IpcClientImpl, msg: RegisterMessage) {
    if (client.agentName) agentIndex.delete(client.agentName);
    if (client.topicId != null) topicIndex.delete(client.topicId);

    client.agentName = msg.agentName;
    client.topicId = msg.topicId ?? null;

    agentIndex.set(msg.agentName, client);
    if (msg.topicId != null) topicIndex.set(msg.topicId, client);

    log(`registered agent=${msg.agentName} topicId=${msg.topicId ?? "none"}`);
    onClientRegistered(client);
  }

  function handleToolCall(client: IpcClientImpl, msg: ToolCallMessage) {
    onToolCall(client, msg).then(
      (result) => client.send(result),
      (err) => client.send({
        type: "tool_call_result",
        id: msg.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  class IpcClientImpl implements IpcClient {
    id: string;
    agentName: string | null = null;
    topicId: number | null = null;
    lastHeartbeat: number = Date.now();
    _socket: import("bun").Socket<SocketData>;
    private _closed = false;

    constructor(socket: import("bun").Socket<SocketData>) {
      this.id = socket.data.clientId;
      this._socket = socket;
    }

    send(msg: GatewayToClient): void {
      if (this._closed) return;
      this._socket.write(JSON.stringify(msg) + "\n");
    }

    close(): void {
      if (this._closed) return;
      this._closed = true;
      this._socket.end();
    }

    isAlive(): boolean {
      return !this._closed;
    }
  }

  const clientBySocketId = new Map<string, IpcClientImpl>();

  const server = Bun.listen<SocketData>({
    unix: socketPath,
    socket: {
      open(socket) {
        const clientId = crypto.randomUUID();
        socket.data = { clientId, buffer: "" };
        const client = new IpcClientImpl(socket);
        clients.add(client);
        clientBySocketId.set(clientId, client);
        log(`client connected: ${clientId}`);
      },
      data(socket, data) {
        socket.data.buffer += data.toString();
        if (socket.data.buffer.length > MAX_BUFFER_SIZE) {
          log(`client ${socket.data.clientId} exceeded max buffer size (${MAX_BUFFER_SIZE} bytes), dropping connection`);
          socket.end();
          return;
        }
        processBuffer(socket);
      },
      close(socket) {
        const client = clientBySocketId.get(socket.data.clientId);
        if (client) {
          clientBySocketId.delete(socket.data.clientId);
          removeClient(client);
        }
      },
      drain() {},
      error(socket, err) {
        log(`socket error: ${err.message}`);
      },
    },
  });

  log(`listening on ${socketPath}`);

  // ─── Heartbeat watchdog (issue #71) ─────────────────────────────────────
  // The IPC client sends a heartbeat every `heartbeatIntervalMs` (default 5s).
  // If a client's `lastHeartbeat` is older than `heartbeatTimeoutMs` (default
  // 30s), the TCP socket is likely wedged (process crashed but the socket fd
  // was never cleanly closed, or the OS hasn't yet delivered the FIN). Force-
  // close those connections so:
  //   1. The gateway clears the stale agentIndex entry immediately.
  //   2. Inbound Telegram messages are not silently dropped into a black hole.
  //   3. The real bridge process (which may already be reconnecting) gets its
  //      fresh register() handled rather than silently shadowed by the stale
  //      entry (handleRegister does replace-not-reject, so this is belt-and-
  //      suspenders — but eviction is cleaner).
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  if (heartbeatTimeoutMs > 0) {
    // Poll at half the timeout so we catch a wedged client within one interval.
    const watchdogInterval = Math.max(1000, Math.floor(heartbeatTimeoutMs / 2));
    watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const client of clients) {
        if (!client.isAlive()) continue;
        // Only evict clients that have registered (agentName set). Unregistered
        // connections that just opened are excluded — they haven't had a chance
        // to send their first heartbeat yet.
        if (client.agentName === null) continue;
        const age = now - client.lastHeartbeat;
        if (age > heartbeatTimeoutMs) {
          log(
            `heartbeat watchdog: evicting stale client agent=${client.agentName} id=${client.id} ` +
            `lastHeartbeat=${age}ms ago (threshold=${heartbeatTimeoutMs}ms)`,
          );
          client.close();
        }
      }
    }, watchdogInterval);
    // Unref so the watchdog doesn't prevent clean process exit.
    if (typeof (watchdogTimer as any)?.unref === "function") {
      (watchdogTimer as any).unref();
    }
  }

  const ipcServer: IpcServer = {
    sendToAgent(agentName: string, msg: GatewayToClient): boolean {
      const client = agentIndex.get(agentName);
      if (!client || !client.isAlive()) return false;
      client.send(msg);
      return true;
    },

    sendToTopic(topicId: number, msg: GatewayToClient): boolean {
      const client = topicIndex.get(topicId);
      if (!client || !client.isAlive()) return false;
      client.send(msg);
      return true;
    },

    broadcast(msg: GatewayToClient): void {
      for (const client of clients) {
        if (client.isAlive()) client.send(msg);
      }
    },

    getClient(agentName: string): IpcClient | undefined {
      return agentIndex.get(agentName);
    },

    clientCount(): number {
      return clients.size;
    },

    async close(): Promise<void> {
      // Stop the heartbeat watchdog before closing clients so it doesn't
      // log spurious evictions during planned shutdown.
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      agentIndex.clear();
      topicIndex.clear();
      clientBySocketId.clear();
      server.stop(true);
      // Rename (not unlink) so a subsequent new-gateway bind that has already
      // landed at socketPath is not accidentally clobbered by this late cleanup.
      // If this rename arrives after a new server is listening, it moves the
      // NEW server's live file to .bak — which is wrong but recoverable. See
      // the note on test 4 in ipc-server-race.test.ts: when both generations
      // target the same pathname, the rename-to-.bak discipline is not enough
      // by itself to prevent the new generation's file from being moved away
      // by the old generation's delayed cleanup. Startup-side cleanup unlinks
      // the stale .bak, so the self-healing property is the best we can do
      // without an inode-matching check.
      try { renameSync(socketPath, socketPath + ".bak"); } catch {}
    },
  };

  return ipcServer;
}
