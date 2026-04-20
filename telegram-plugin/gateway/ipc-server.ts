import { unlinkSync } from "fs";
import type {
  ClientToGateway,
  GatewayToClient,
  HeartbeatMessage,
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
  log?: (msg: string) => void;
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
    log = () => {},
  } = options;

  try { unlinkSync(socketPath); } catch {}

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
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      agentIndex.clear();
      topicIndex.clear();
      clientBySocketId.clear();
      server.stop(true);
      try { unlinkSync(socketPath); } catch {}
    },
  };

  return ipcServer;
}
