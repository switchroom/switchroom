import type {
  ClientToGateway,
  GatewayToClient,
  InboundMessage,
  PermissionEvent,
  PermissionRequestForward,
  SessionEventForward,
  StatusEvent,
  ToolCallResult,
} from "../gateway/ipc-protocol.js";

export interface IpcClientOptions {
  socketPath: string;
  agentName: string;
  topicId?: number;
  onInbound: (msg: InboundMessage) => void;
  onPermission: (msg: PermissionEvent) => void;
  onStatus: (msg: StatusEvent) => void;
  log?: (msg: string) => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
}

export interface IpcClientHandle {
  callTool(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallResult>;
  sendSessionEvent(event: SessionEventForward): void;
  sendPermissionRequest(msg: PermissionRequestForward): void;
  isConnected(): boolean;
  close(): void;
}

interface PendingCall {
  resolve: (result: ToolCallResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createIpcClient(options: IpcClientOptions): Promise<IpcClientHandle> {
  const {
    socketPath,
    agentName,
    topicId,
    onInbound,
    onPermission,
    onStatus,
    log = () => {},
    reconnectDelayMs = 2000,
    maxReconnectDelayMs = 30000,
    heartbeatIntervalMs = 5000,
  } = options;

  /** Max buffer size (1MB). Protects against the gateway flooding data
   *  without newline delimiters, which would cause unbounded memory growth. */
  const MAX_BUFFER_SIZE = 1024 * 1024;

  const pendingCalls = new Map<string, PendingCall>();
  let socket: import("bun").Socket<{ buffer: string }> | null = null;
  let connected = false;
  let closed = false;
  let currentDelay = reconnectDelayMs;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function sendRaw(msg: ClientToGateway): void {
    if (!socket || !connected) return;
    socket.write(JSON.stringify(msg) + "\n");
  }

  function sendRegister(): void {
    const msg: ClientToGateway = { type: "register", agentName, topicId };
    sendRaw(msg);
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendRaw({ type: "heartbeat", agentName });
    }, heartbeatIntervalMs);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function rejectAllPending(reason: string): void {
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingCalls.clear();
  }

  function handleMessage(msg: GatewayToClient): void {
    switch (msg.type) {
      case "inbound":
        onInbound(msg);
        break;
      case "permission":
        onPermission(msg);
        break;
      case "status":
        onStatus(msg);
        break;
      case "tool_call_result": {
        const pending = pendingCalls.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCalls.delete(msg.id);
          pending.resolve(msg);
        }
        break;
      }
    }
  }

  /** Validate that a parsed JSON object looks like a legitimate GatewayToClient message. */
  function validateMessage(msg: unknown): msg is GatewayToClient {
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "inbound":
        return typeof m.chatId === "string" && typeof m.text === "string";
      case "permission":
        return typeof m.requestId === "string"
          && (m.behavior === "allow" || m.behavior === "deny");
      case "status":
        return typeof m.status === "string";
      case "tool_call_result":
        return typeof m.id === "string" && typeof m.success === "boolean";
      default:
        return false;
    }
  }

  function processBuffer(sock: import("bun").Socket<{ buffer: string }>): void {
    const lines = sock.data.buffer.split("\n");
    sock.data.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!validateMessage(parsed)) {
          log(`invalid IPC message shape from gateway: ${line.slice(0, 200)}`);
          continue;
        }
        handleMessage(parsed);
      } catch {
        log(`bad JSON from gateway: ${line.slice(0, 200)}`);
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    log(`reconnecting in ${currentDelay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) doConnect();
    }, currentDelay);
    currentDelay = Math.min(currentDelay * 2, maxReconnectDelayMs);
  }

  function onDisconnect(): void {
    connected = false;
    socket = null;
    stopHeartbeat();
    rejectAllPending("disconnected from gateway");
    scheduleReconnect();
  }

  function doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (closed) { reject(new Error("client closed")); return; }

      Bun.connect<{ buffer: string }>({
        unix: socketPath,
        socket: {
          open(sock) {
            sock.data = { buffer: "" };
            socket = sock;
            connected = true;
            currentDelay = reconnectDelayMs;
            sendRegister();
            startHeartbeat();
            log(`connected to ${socketPath}`);
            resolve();
          },
          data(sock, data) {
            sock.data.buffer += data.toString();
            if (sock.data.buffer.length > MAX_BUFFER_SIZE) {
              log(`gateway buffer exceeded ${MAX_BUFFER_SIZE} bytes, disconnecting`);
              sock.end();
              return;
            }
            processBuffer(sock);
          },
          close() {
            log("disconnected");
            onDisconnect();
          },
          drain() {},
          error(sock, err) {
            log(`socket error: ${err.message}`);
          },
        },
        data: { buffer: "" },
      }).catch((err) => {
        log(`connect failed: ${err.message}`);
        scheduleReconnect();
        reject(err);
      });
    });
  }

  const handle: IpcClientHandle = {
    callTool(tool: string, args: Record<string, unknown>, timeoutMs = 15000): Promise<ToolCallResult> {
      return new Promise((resolve, reject) => {
        if (!connected) {
          reject(new Error("not connected"));
          return;
        }
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingCalls.delete(id);
          reject(new Error(`tool call "${tool}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingCalls.set(id, { resolve, reject, timer });
        sendRaw({ type: "tool_call", id, tool, args });
      });
    },

    sendSessionEvent(event: SessionEventForward): void {
      sendRaw(event);
    },

    sendPermissionRequest(msg: PermissionRequestForward): void {
      sendRaw(msg);
    },

    isConnected(): boolean {
      return connected;
    },

    close(): void {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectAllPending("client closed");
      if (socket) {
        try { socket.end(); } catch {}
        socket = null;
      }
      connected = false;
    },
  };

  // Attempt initial connection. If it fails, schedule reconnect and return
  // the handle anyway — the client will keep retrying in the background.
  // This prevents the caller from crashing if the gateway isn't up yet.
  return doConnect()
    .then(() => handle)
    .catch(() => {
      // scheduleReconnect() was already called in the doConnect catch handler
      return handle;
    });
}
