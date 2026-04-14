#!/usr/bin/env bun
/**
 * switchroom-channel — MCP channel plugin that connects to the switchroom-telegram-daemon
 * via Unix socket instead of directly to Telegram.
 *
 * Each instance registers for a single forum topic and bridges messages between
 * the daemon and Claude Code via the MCP stdio transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.SWITCHROOM_SOCKET_PATH ?? "/tmp/switchroom-telegram.sock";
const TOPIC_ID = Number(process.env.TELEGRAM_TOPIC_ID ?? "0");
const AGENT_NAME = process.env.AGENT_NAME ?? "unknown";
const FORUM_CHAT_ID = process.env.TELEGRAM_FORUM_CHAT_ID ?? "";

if (!TOPIC_ID) {
  process.stderr.write(
    `switchroom-channel: TELEGRAM_TOPIC_ID required (set as env var)\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types — must match daemon protocol
// ---------------------------------------------------------------------------

type OutboundMessage = {
  type: "outbound";
  requestId: string;
  action: string;
  [key: string]: unknown;
};

type InboundMessage = {
  type: "inbound";
  topicId: number;
  chatId: string;
  messageId: number;
  userId: string;
  username: string;
  text: string;
  ts: string;
  imagePath?: string;
  attachmentFileId?: string;
  attachmentKind?: string;
  attachmentMime?: string;
  attachmentName?: string;
  attachmentSize?: number;
};

type ResultMessage = {
  type: "result";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PermissionResponse = {
  type: "permission_response";
  requestId: string;
  behavior: string;
};

type AckMessage = {
  type: "ack";
  originalType: string;
  ok: boolean;
};

type DaemonMessage = InboundMessage | ResultMessage | PermissionResponse | AckMessage;

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (msg: ResultMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingRequests = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 30000;

function createRequest(): { requestId: string; promise: Promise<ResultMessage> } {
  const requestId = randomUUID();
  const promise = new Promise<ResultMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("request timed out after 30s"));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, reject, timer });
  });
  return { requestId, promise };
}

function resolveRequest(msg: ResultMessage): void {
  const pending = pendingRequests.get(msg.requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(msg.requestId);
    pending.resolve(msg);
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "switchroom-telegram", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
    },
    instructions: [
      "The sender reads Telegram, not this session. Anything you want them to see must go through the reply tool.",
      "",
      'Messages from Telegram arrive as <channel source="switchroom-telegram" chat_id="..." message_id="..." user="..." ts="...">.',
      "If the tag has an image_path attribute, Read that file. If it has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.",
      "Reply with the reply tool -- pass chat_id back. Use reply_to only when replying to an earlier message.",
      "",
      "reply accepts file paths (files: [\"/abs/path.png\"]) for attachments. Use react to add emoji reactions, and edit_message for interim progress updates.",
      "Edits don't trigger push notifications -- when a long task completes, send a new reply so the user's device pings.",
      "Use send_typing to show a typing indicator during long operations. Use pin_message to pin important outputs.",
      "",
      "If a message includes message_thread_id, it came from a forum topic. The reply tool will automatically route replies back to the same topic.",
      "",
      "Telegram's Bot API exposes no history or search -- you only see messages as they arrive.",
    ].join("\n"),
  },
);

// ---------------------------------------------------------------------------
// Socket connection to daemon
// ---------------------------------------------------------------------------

let daemonSocket: import("bun").Socket<{ buffer: string }> | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 30000;

function processBuffer(socket: import("bun").Socket<{ buffer: string }>): void {
  const lines = socket.data.buffer.split("\n");
  socket.data.buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as DaemonMessage;
      handleDaemonMessage(msg);
    } catch {
      process.stderr.write(`[switchroom-channel:${AGENT_NAME}] bad JSON from daemon: ${line}\n`);
    }
  }
}

function handleDaemonMessage(msg: DaemonMessage): void {
  switch (msg.type) {
    case "inbound": {
      const m = msg as InboundMessage;
      // Emit MCP channel notification
      void mcp
        .notification({
          method: "notifications/claude/channel",
          params: {
            content: m.text,
            meta: {
              chat_id: m.chatId,
              ...(m.messageId ? { message_id: String(m.messageId) } : {}),
              user: m.username,
              user_id: m.userId,
              ts: m.ts,
              ...(m.topicId ? { message_thread_id: String(m.topicId) } : {}),
              ...(m.imagePath ? { image_path: m.imagePath } : {}),
              ...(m.attachmentFileId
                ? {
                    attachment_file_id: m.attachmentFileId,
                    ...(m.attachmentKind ? { attachment_kind: m.attachmentKind } : {}),
                    ...(m.attachmentMime ? { attachment_mime: m.attachmentMime } : {}),
                    ...(m.attachmentName ? { attachment_name: m.attachmentName } : {}),
                    ...(m.attachmentSize != null ? { attachment_size: String(m.attachmentSize) } : {}),
                  }
                : {}),
            },
          },
        })
        .catch((err) => {
          process.stderr.write(`[switchroom-channel:${AGENT_NAME}] failed to deliver inbound: ${err}\n`);
        });
      break;
    }
    case "result": {
      resolveRequest(msg as ResultMessage);
      break;
    }
    case "permission_response": {
      const pr = msg as PermissionResponse;
      void mcp
        .notification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: pr.requestId,
            behavior: pr.behavior,
          },
        })
        .catch((err) => {
          process.stderr.write(`[switchroom-channel:${AGENT_NAME}] failed to deliver permission response: ${err}\n`);
        });
      break;
    }
    case "ack": {
      const a = msg as AckMessage;
      process.stderr.write(`[switchroom-channel:${AGENT_NAME}] ack for ${a.originalType}: ok=${a.ok}\n`);
      break;
    }
    default:
      process.stderr.write(`[switchroom-channel:${AGENT_NAME}] unknown message type: ${(msg as { type: string }).type}\n`);
  }
}

function sendToDaemon(msg: Record<string, unknown>): boolean {
  if (!daemonSocket) {
    process.stderr.write(`[switchroom-channel:${AGENT_NAME}] not connected to daemon\n`);
    return false;
  }
  daemonSocket.write(JSON.stringify(msg) + "\n");
  return true;
}

async function connectToDaemon(): Promise<void> {
  const maxRetries = 60; // Keep trying for a while
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
            process.stderr.write(`[switchroom-channel:${AGENT_NAME}] connected to daemon\n`);
            reconnectAttempt = 0;
            // Register for our topic
            socket.write(
              JSON.stringify({
                type: "register",
                topicId: TOPIC_ID,
                agentName: AGENT_NAME,
              }) + "\n",
            );
          },
          close(_socket) {
            process.stderr.write(`[switchroom-channel:${AGENT_NAME}] disconnected from daemon\n`);
            daemonSocket = null;
            // Reject all pending requests
            for (const [id, pending] of pendingRequests) {
              clearTimeout(pending.timer);
              pending.reject(new Error("disconnected from daemon"));
            }
            pendingRequests.clear();
            // Schedule reconnect
            scheduleReconnect();
          },
          drain(_socket) {},
          error(_socket, err) {
            process.stderr.write(`[switchroom-channel:${AGENT_NAME}] socket error: ${err}\n`);
          },
        },
      });
      return; // success
    } catch (err) {
      const delay = Math.min(1000 * Math.pow(1.5, attempt - 1), MAX_RECONNECT_DELAY_MS);
      process.stderr.write(
        `[switchroom-channel:${AGENT_NAME}] connect attempt ${attempt}/${maxRetries} failed, retry in ${(delay / 1000).toFixed(1)}s\n`,
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  process.stderr.write(`[switchroom-channel:${AGENT_NAME}] failed to connect to daemon after ${maxRetries} attempts\n`);
  process.exit(1);
}

function scheduleReconnect(): void {
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
  process.stderr.write(
    `[switchroom-channel:${AGENT_NAME}] scheduling reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempt})\n`,
  );
  setTimeout(() => {
    void connectToDaemon().catch((err) => {
      process.stderr.write(`[switchroom-channel:${AGENT_NAME}] reconnect failed: ${err}\n`);
    });
  }, delay);
}

// ---------------------------------------------------------------------------
// Permission relay: receive from Claude Code, forward to daemon
// ---------------------------------------------------------------------------

mcp.setNotificationHandler(
  z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    sendToDaemon({
      type: "permission_request",
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    });
  },
);

// ---------------------------------------------------------------------------
// MCP Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to for threading and files (absolute paths) to attach.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          text: { type: "string" },
          reply_to: {
            type: "string",
            description: "Message ID to thread under.",
          },
          message_thread_id: {
            type: "string",
            description: "Forum topic thread ID. Auto-applied if not specified.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach. Images send as photos; other types as documents. Max 50MB each.",
          },
          format: {
            type: "string",
            enum: ["text", "markdownv2"],
            description: "Rendering mode. Default: 'text'.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a Telegram message.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "download_attachment",
      description: "Download a file attachment from a Telegram message. Returns the local file path.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "The attachment_file_id from inbound meta" },
        },
        required: ["file_id"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a message the bot previously sent. Edits don't trigger push notifications.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          text: { type: "string" },
          format: {
            type: "string",
            enum: ["text", "markdownv2"],
            description: "Rendering mode. Default: 'text'.",
          },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "send_typing",
      description: "Send a typing indicator to a chat. Auto-expires after ~5 seconds.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "pin_message",
      description: "Pin a message in a Telegram chat.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
        },
        required: ["chat_id", "message_id"],
      },
    },
    {
      name: "forward_message",
      description: "Forward an existing message to a chat.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Destination chat ID" },
          from_chat_id: { type: "string", description: "Source chat ID" },
          message_id: { type: "string", description: "ID of the message to forward" },
          message_thread_id: {
            type: "string",
            description: "Forum topic thread ID in the destination chat.",
          },
        },
        required: ["chat_id", "from_chat_id", "message_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (req.params.name) {
      case "reply": {
        const { requestId, promise } = createRequest();
        const threadId = args.message_thread_id != null ? Number(args.message_thread_id) : TOPIC_ID;
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "reply",
          chatId: args.chat_id as string,
          text: args.text as string,
          ...(args.reply_to != null ? { replyTo: Number(args.reply_to) } : {}),
          messageThreadId: threadId,
          ...(args.files ? { files: args.files } : {}),
          ...(args.format ? { format: args.format } : {}),
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "reply failed");
        const data = result.data as { sentIds?: number[] } | undefined;
        const sentIds = data?.sentIds ?? [];
        const text =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`;
        return { content: [{ type: "text", text }] };
      }
      case "react": {
        const { requestId, promise } = createRequest();
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "react",
          chatId: args.chat_id as string,
          messageId: Number(args.message_id),
          emoji: args.emoji as string,
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "react failed");
        return { content: [{ type: "text", text: "reacted" }] };
      }
      case "download_attachment": {
        const { requestId, promise } = createRequest();
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "download",
          fileId: args.file_id as string,
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "download failed");
        const data = result.data as { path?: string } | undefined;
        return { content: [{ type: "text", text: data?.path ?? "download complete" }] };
      }
      case "edit_message": {
        const { requestId, promise } = createRequest();
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "edit",
          chatId: args.chat_id as string,
          messageId: Number(args.message_id),
          text: args.text as string,
          ...(args.format ? { format: args.format } : {}),
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "edit failed");
        const data = result.data as { messageId?: number } | undefined;
        return { content: [{ type: "text", text: `edited (id: ${data?.messageId ?? args.message_id})` }] };
      }
      case "send_typing": {
        const { requestId, promise } = createRequest();
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "typing",
          chatId: args.chat_id as string,
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "typing failed");
        return { content: [{ type: "text", text: "typing indicator sent" }] };
      }
      case "pin_message": {
        const { requestId, promise } = createRequest();
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "pin",
          chatId: args.chat_id as string,
          messageId: Number(args.message_id),
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "pin failed");
        return { content: [{ type: "text", text: `pinned message ${args.message_id}` }] };
      }
      case "forward_message": {
        const { requestId, promise } = createRequest();
        const threadId = args.message_thread_id != null ? Number(args.message_thread_id) : TOPIC_ID;
        sendToDaemon({
          type: "outbound",
          requestId,
          action: "forward",
          chatId: args.chat_id as string,
          fromChatId: args.from_chat_id as string,
          messageId: Number(args.message_id),
          messageThreadId: threadId,
        });
        const result = await promise;
        if (!result.success) throw new Error(result.error ?? "forward failed");
        const data = result.data as { messageId?: number } | undefined;
        return { content: [{ type: "text", text: `forwarded (id: ${data?.messageId})` }] };
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Connect MCP stdio transport
await mcp.connect(new StdioServerTransport());

// Connect to daemon
await connectToDaemon();

// Shutdown handling
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[switchroom-channel:${AGENT_NAME}] shutting down\n`);
  if (daemonSocket) {
    daemonSocket.end();
    daemonSocket = null;
  }
  setTimeout(() => process.exit(0), 1000);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
