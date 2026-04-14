#!/usr/bin/env bun
/**
 * Proof-of-concept: switchroom-telegram-daemon
 *
 * Validates assumptions 1-3:
 *   1. Bun process can listen on a Unix socket
 *   2. Multiple clients can connect simultaneously
 *   3. JSON newline-delimited protocol works for bidirectional async messaging
 *
 * This daemon:
 *   - Listens on /tmp/switchroom-telegram.sock
 *   - Accepts multiple plugin connections
 *   - Maintains a routing table: topic_id -> socket
 *   - Routes inbound "Telegram messages" to the correct plugin by topic_id
 *   - Receives outbound replies from plugins and would forward to Telegram
 */

import { unlinkSync } from "fs";

const SOCKET_PATH = process.env.SWITCHROOM_SOCKET ?? "/tmp/switchroom-telegram.sock";

// Clean up stale socket file
try { unlinkSync(SOCKET_PATH); } catch {}

// --- Types ---
type MessageEnvelope =
  | { type: "register"; topicId: number }
  | { type: "unregister"; topicId: number }
  | { type: "outbound"; topicId: number; chatId: string; text: string; replyTo?: number }
  | { type: "inbound"; topicId: number; chatId: string; messageId: number; user: string; text: string }
  | { type: "reply_result"; topicId: number; success: boolean; error?: string }
  | { type: "ack"; originalType: string; ok: boolean };

// --- Routing table: topicId -> socket ---
type SocketWithData = {
  socket: import("bun").Socket<{ topicIds: Set<number>; buffer: string }>;
};

const routingTable = new Map<number, import("bun").Socket<{ topicIds: Set<number>; buffer: string }>>();
const allClients = new Set<import("bun").Socket<{ topicIds: Set<number>; buffer: string }>>();

// --- Process JSONL: handle partial reads and multiple messages in one chunk ---
function processBuffer(socket: import("bun").Socket<{ topicIds: Set<number>; buffer: string }>) {
  const lines = socket.data.buffer.split("\n");
  // Last element is either empty (complete message) or a partial — keep it in buffer
  socket.data.buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as MessageEnvelope;
      handleMessage(socket, msg);
    } catch (err) {
      console.error(`[daemon] bad JSON from client: ${line}`);
    }
  }
}

function handleMessage(
  socket: import("bun").Socket<{ topicIds: Set<number>; buffer: string }>,
  msg: MessageEnvelope,
) {
  switch (msg.type) {
    case "register": {
      socket.data.topicIds.add(msg.topicId);
      routingTable.set(msg.topicId, socket);
      console.log(`[daemon] registered topic ${msg.topicId}, total routes: ${routingTable.size}`);
      socket.write(JSON.stringify({ type: "ack", originalType: "register", ok: true }) + "\n");
      break;
    }
    case "unregister": {
      socket.data.topicIds.delete(msg.topicId);
      routingTable.delete(msg.topicId);
      console.log(`[daemon] unregistered topic ${msg.topicId}`);
      socket.write(JSON.stringify({ type: "ack", originalType: "unregister", ok: true }) + "\n");
      break;
    }
    case "outbound": {
      // In real code: call Telegram Bot API here via Grammy
      console.log(`[daemon] outbound to Telegram: chat=${msg.chatId} topic=${msg.topicId} text="${msg.text}"`);
      // Simulate success
      socket.write(
        JSON.stringify({ type: "reply_result", topicId: msg.topicId, success: true }) + "\n",
      );
      break;
    }
    default:
      console.error(`[daemon] unknown message type: ${(msg as any).type}`);
  }
}

// --- Simulate inbound Telegram message (would come from Grammy polling) ---
function simulateInbound(topicId: number, text: string) {
  const target = routingTable.get(topicId);
  if (!target) {
    console.log(`[daemon] no plugin registered for topic ${topicId}, message dropped`);
    return;
  }
  const envelope: MessageEnvelope = {
    type: "inbound",
    topicId,
    chatId: "-1001234567890",
    messageId: Date.now(),
    user: "testuser",
    text,
  };
  target.write(JSON.stringify(envelope) + "\n");
  console.log(`[daemon] routed inbound to topic ${topicId}`);
}

// --- Start server ---
const server = Bun.listen<{ topicIds: Set<number>; buffer: string }>({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      socket.data.buffer += data.toString();
      processBuffer(socket);
    },
    open(socket) {
      socket.data = { topicIds: new Set(), buffer: "" };
      allClients.add(socket);
      console.log(`[daemon] client connected (total: ${allClients.size})`);
    },
    close(socket) {
      // Clean up routing table for all topics this client owned
      for (const topicId of socket.data.topicIds) {
        routingTable.delete(topicId);
        console.log(`[daemon] removed route for topic ${topicId} (client disconnected)`);
      }
      allClients.delete(socket);
      console.log(`[daemon] client disconnected (total: ${allClients.size})`);
    },
    drain(socket) {},
    error(socket, err) {
      console.error(`[daemon] socket error:`, err);
    },
  },
});

console.log(`[daemon] listening on ${SOCKET_PATH}`);
console.log(`[daemon] pid: ${process.pid}`);

// Export for testing — in production this would receive from Grammy
export { simulateInbound, server, routingTable, allClients };
