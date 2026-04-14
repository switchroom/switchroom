#!/usr/bin/env bun
/**
 * Proof-of-concept: switchroom-channel MCP plugin (client side)
 *
 * Validates assumptions 1-3:
 *   1. Bun process can connect to a Unix socket as a client
 *   2. Multiple instances connect to the same daemon simultaneously
 *   3. Socket connection works alongside stdio (MCP transport uses stdin/stdout,
 *      socket uses a separate file descriptor — no conflict on the event loop)
 *
 * In production this would also:
 *   - Import StdioServerTransport from @modelcontextprotocol/sdk
 *   - Register MCP tools (reply, react, edit_message, download_attachment)
 *   - Forward inbound Telegram messages as MCP notifications to Claude
 *   - Forward outbound replies from Claude through the daemon to Telegram
 */

const SOCKET_PATH = process.env.SWITCHROOM_SOCKET ?? "/tmp/switchroom-telegram.sock";
const TOPIC_ID = Number(process.env.TELEGRAM_TOPIC_ID ?? "42");

type MessageEnvelope =
  | { type: "register"; topicId: number }
  | { type: "outbound"; topicId: number; chatId: string; text: string }
  | { type: "inbound"; topicId: number; chatId: string; messageId: number; user: string; text: string }
  | { type: "reply_result"; topicId: number; success: boolean; error?: string }
  | { type: "ack"; originalType: string; ok: boolean };

let daemonSocket: import("bun").Socket<{ buffer: string }> | null = null;

// --- JSONL buffer handling (same pattern as daemon) ---
function processBuffer(socket: import("bun").Socket<{ buffer: string }>) {
  const lines = socket.data.buffer.split("\n");
  socket.data.buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as MessageEnvelope;
      handleDaemonMessage(msg);
    } catch {
      console.error(`[plugin:${TOPIC_ID}] bad JSON from daemon: ${line}`);
    }
  }
}

function handleDaemonMessage(msg: MessageEnvelope) {
  switch (msg.type) {
    case "inbound": {
      console.log(`[plugin:${TOPIC_ID}] inbound from ${msg.user}: "${msg.text}"`);
      // In production: deliver as MCP notification to Claude via server.notification()
      // The MCP StdioServerTransport writes to stdout — completely independent of the socket
      break;
    }
    case "reply_result": {
      console.log(`[plugin:${TOPIC_ID}] reply result: success=${msg.success}`);
      // In production: resolve the pending promise from the MCP tool call
      break;
    }
    case "ack": {
      console.log(`[plugin:${TOPIC_ID}] ack for ${msg.originalType}: ok=${msg.ok}`);
      break;
    }
    default:
      console.error(`[plugin:${TOPIC_ID}] unknown message type: ${(msg as any).type}`);
  }
}

// --- Connect to daemon with retry ---
async function connectToDaemon(retries = 5, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      daemonSocket = await Bun.connect<{ buffer: string }>({
        unix: SOCKET_PATH,
        socket: {
          data(socket, data) {
            socket.data.buffer += data.toString();
            processBuffer(socket);
          },
          open(socket) {
            socket.data = { buffer: "" };
            console.log(`[plugin:${TOPIC_ID}] connected to daemon`);
            // Register for our topic
            socket.write(JSON.stringify({ type: "register", topicId: TOPIC_ID }) + "\n");
          },
          close(socket) {
            console.log(`[plugin:${TOPIC_ID}] disconnected from daemon`);
            daemonSocket = null;
            // In production: schedule reconnect
          },
          drain(socket) {},
          error(socket, err) {
            console.error(`[plugin:${TOPIC_ID}] socket error:`, err);
          },
        },
      });
      return; // success
    } catch (err) {
      console.error(`[plugin:${TOPIC_ID}] connect attempt ${attempt}/${retries} failed:`, err);
      if (attempt < retries) {
        await Bun.sleep(delayMs);
      }
    }
  }
  throw new Error(`[plugin:${TOPIC_ID}] failed to connect to daemon after ${retries} attempts`);
}

// --- Outbound: called when Claude invokes the "reply" MCP tool ---
function sendReply(chatId: string, text: string): boolean {
  if (!daemonSocket) {
    console.error(`[plugin:${TOPIC_ID}] not connected to daemon`);
    return false;
  }
  const envelope: MessageEnvelope = {
    type: "outbound",
    topicId: TOPIC_ID,
    chatId,
    text,
  };
  daemonSocket.write(JSON.stringify(envelope) + "\n");
  return true;
}

// --- Main ---
await connectToDaemon();

// In production, the MCP server would be running here too:
//   const mcpServer = new Server({ name: "switchroom-telegram", version: "1.0.0" }, { capabilities: { tools: {} } });
//   const transport = new StdioServerTransport();
//   await mcpServer.connect(transport);
//
// Both the MCP stdio transport and the daemon socket run on the same Bun event loop.
// stdin/stdout are fd 0/1, the socket is a separate fd — no conflict.

export { connectToDaemon, sendReply, daemonSocket };
