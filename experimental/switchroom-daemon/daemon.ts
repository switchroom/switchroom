#!/usr/bin/env bun
/**
 * switchroom-telegram-daemon — single-process Telegram router for multi-agent topic routing.
 *
 * Polls Telegram via Grammy, listens on a Unix socket, and routes messages
 * between Telegram forum topics and connected switchroom-channel MCP plugins.
 *
 * Architecture:
 *   [Grammy long-poll] → daemon → Unix socket → switchroom-channel plugin → Claude Code agent
 *   [Grammy bot API]   ← daemon ← Unix socket ← switchroom-channel plugin ← Claude Code agent
 */

import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  statSync,
  chmodSync,
} from "fs";
import { homedir } from "os";
import { join, extname } from "path";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOME = homedir();
const SWITCHROOM_DIR = join(HOME, ".switchroom");

// Load daemon.env if present
const DAEMON_ENV_PATH = process.env.SWITCHROOM_DAEMON_ENV ?? join(SWITCHROOM_DIR, "daemon.env");
try {
  for (const line of readFileSync(DAEMON_ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  process.stderr.write(
    `switchroom-daemon: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${DAEMON_ENV_PATH} or as env var\n`,
  );
  process.exit(1);
}

const SOCKET_PATH = process.env.SWITCHROOM_SOCKET_PATH ?? "/tmp/switchroom-telegram.sock";
const ACCESS_PATH = process.env.SWITCHROOM_ACCESS_PATH ?? join(SWITCHROOM_DIR, "daemon-access.json");
const INBOX_PATH = process.env.SWITCHROOM_INBOX_PATH ?? join(SWITCHROOM_DIR, "inbox");
const OFFSET_PATH = join(SWITCHROOM_DIR, "telegram-offset.json");

// Ensure directories exist
mkdirSync(SWITCHROOM_DIR, { recursive: true });
mkdirSync(INBOX_PATH, { recursive: true });

// ---------------------------------------------------------------------------
// Types — JSONL protocol messages
// ---------------------------------------------------------------------------

/** Messages from client (plugin) to daemon */
export type ClientMessage =
  | { type: "register"; topicId: number; agentName: string }
  | { type: "outbound"; requestId: string; action: "reply"; chatId: string; text: string; replyTo?: number; messageThreadId?: number; files?: string[]; format?: string }
  | { type: "outbound"; requestId: string; action: "react"; chatId: string; messageId: number; emoji: string }
  | { type: "outbound"; requestId: string; action: "edit"; chatId: string; messageId: number; text: string; format?: string }
  | { type: "outbound"; requestId: string; action: "typing"; chatId: string }
  | { type: "outbound"; requestId: string; action: "pin"; chatId: string; messageId: number }
  | { type: "outbound"; requestId: string; action: "forward"; chatId: string; fromChatId: string; messageId: number; messageThreadId?: number }
  | { type: "outbound"; requestId: string; action: "download"; fileId: string }
  | { type: "permission_request"; requestId: string; toolName: string; description: string; inputPreview: string };

/** Messages from daemon to client (plugin) */
export type DaemonMessage =
  | { type: "ack"; originalType: string; ok: boolean }
  | { type: "inbound"; topicId: number; chatId: string; messageId: number; userId: string; username: string; text: string; ts: string; imagePath?: string; attachmentFileId?: string; attachmentKind?: string; attachmentMime?: string; attachmentName?: string; attachmentSize?: number }
  | { type: "result"; requestId: string; success: boolean; data?: unknown; error?: string }
  | { type: "permission_response"; requestId: string; behavior: string };

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

type GroupPolicy = {
  requireMention: boolean;
  allowFrom?: string[];
};

type DaemonAccess = {
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
};

function defaultAccess(): DaemonAccess {
  return { allowFrom: [], groups: {} };
}

export function loadAccess(): DaemonAccess {
  try {
    const raw = readFileSync(ACCESS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonAccess>;
    return {
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
    };
  } catch {
    return defaultAccess();
  }
}

function isAllowedSender(senderId: string, chatId: string, chatType: string): boolean {
  const access = loadAccess();
  if (chatType === "private") {
    return access.allowFrom.includes(senderId);
  }
  if (chatType === "group" || chatType === "supergroup") {
    const policy = access.groups[chatId];
    if (!policy) return false;
    const groupAllowFrom = policy.allowFrom ?? [];
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return false;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Routing table and client management
// ---------------------------------------------------------------------------

type SocketData = { topicIds: Set<number>; agentName: string; buffer: string };
type ClientSocket = import("bun").Socket<SocketData>;

/** topicId -> socket for topic-specific routing */
export const routingTable = new Map<number, ClientSocket>();
/** All connected clients */
export const allClients = new Set<ClientSocket>();

function sendToClient(socket: ClientSocket, msg: DaemonMessage): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function sendToAllClients(msg: DaemonMessage): void {
  for (const client of allClients) {
    sendToClient(client, msg);
  }
}

function routeToTopic(topicId: number, msg: DaemonMessage): boolean {
  const client = routingTable.get(topicId);
  if (!client) return false;
  sendToClient(client, msg);
  return true;
}

// ---------------------------------------------------------------------------
// JSONL buffer processing
// ---------------------------------------------------------------------------

export function processBuffer(socket: ClientSocket): void {
  const lines = socket.data.buffer.split("\n");
  socket.data.buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as ClientMessage;
      handleClientMessage(socket, msg);
    } catch (err) {
      process.stderr.write(`[daemon] bad JSON from client: ${line}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Handle messages from clients
// ---------------------------------------------------------------------------

async function handleClientMessage(socket: ClientSocket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case "register": {
      socket.data.topicIds.add(msg.topicId);
      socket.data.agentName = msg.agentName;
      routingTable.set(msg.topicId, socket);
      process.stderr.write(
        `[daemon] registered agent "${msg.agentName}" for topic ${msg.topicId} (total routes: ${routingTable.size})\n`,
      );
      sendToClient(socket, { type: "ack", originalType: "register", ok: true });
      break;
    }
    case "outbound": {
      await handleOutbound(socket, msg);
      break;
    }
    case "permission_request": {
      await handlePermissionRequest(msg);
      break;
    }
    default:
      process.stderr.write(`[daemon] unknown message type: ${(msg as { type: string }).type}\n`);
  }
}

// ---------------------------------------------------------------------------
// Outbound: agent -> Telegram
// ---------------------------------------------------------------------------

const MAX_CHUNK_LIMIT = 4096;
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut =
      para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

function escapeMarkdownV2(text: string): string {
  const specialChars = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
  const parts: string[] = [];
  let last = 0;
  const codeRe = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(text.slice(last, m.index).replace(specialChars, "\\$&"));
    }
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(text.slice(last).replace(specialChars, "\\$&"));
  }
  return parts.join("");
}

async function handleOutbound(
  socket: ClientSocket,
  msg: ClientMessage & { type: "outbound" },
): Promise<void> {
  const { requestId, action } = msg;

  try {
    switch (action) {
      case "reply": {
        const { chatId, text, replyTo, messageThreadId, files, format } = msg as ClientMessage & {
          type: "outbound"; action: "reply"; chatId: string; text: string;
          replyTo?: number; messageThreadId?: number; files?: string[]; format?: string;
        };
        const parseMode = format === "markdownv2" ? ("MarkdownV2" as const) : undefined;
        const effectiveText = parseMode ? escapeMarkdownV2(text) : text;
        const chunks = chunk(effectiveText, MAX_CHUNK_LIMIT);
        const sentIds: number[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = replyTo != null && i === 0;
          const sent = await bot.api.sendMessage(chatId, chunks[i], {
            ...(shouldReplyTo ? { reply_parameters: { message_id: replyTo } } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
            ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
          });
          sentIds.push(sent.message_id);
        }

        // Send files as separate messages
        for (const f of files ?? []) {
          const st = statSync(f);
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
          }
          const ext = extname(f).toLowerCase();
          const input = new InputFile(f);
          const baseOpts = {
            ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
            ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
          };
          if (PHOTO_EXTS.has(ext)) {
            const sent = await bot.api.sendPhoto(chatId, input, baseOpts);
            sentIds.push(sent.message_id);
          } else {
            const sent = await bot.api.sendDocument(chatId, input, baseOpts);
            sentIds.push(sent.message_id);
          }
        }

        sendToClient(socket, {
          type: "result",
          requestId,
          success: true,
          data: { sentIds },
        });
        break;
      }
      case "react": {
        const { chatId, messageId, emoji } = msg as ClientMessage & {
          type: "outbound"; action: "react"; chatId: string; messageId: number; emoji: string;
        };
        await bot.api.setMessageReaction(chatId, messageId, [
          { type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] },
        ]);
        sendToClient(socket, { type: "result", requestId, success: true });
        break;
      }
      case "edit": {
        const { chatId, messageId, text, format } = msg as ClientMessage & {
          type: "outbound"; action: "edit"; chatId: string; messageId: number; text: string; format?: string;
        };
        const editParseMode = format === "markdownv2" ? ("MarkdownV2" as const) : undefined;
        const editText = editParseMode ? escapeMarkdownV2(text) : text;
        const edited = await bot.api.editMessageText(chatId, messageId, editText, {
          ...(editParseMode ? { parse_mode: editParseMode } : {}),
        });
        const id = typeof edited === "object" ? edited.message_id : messageId;
        sendToClient(socket, { type: "result", requestId, success: true, data: { messageId: id } });
        break;
      }
      case "typing": {
        const { chatId } = msg as ClientMessage & { type: "outbound"; action: "typing"; chatId: string };
        await bot.api.sendChatAction(chatId, "typing");
        sendToClient(socket, { type: "result", requestId, success: true });
        break;
      }
      case "pin": {
        const { chatId, messageId } = msg as ClientMessage & {
          type: "outbound"; action: "pin"; chatId: string; messageId: number;
        };
        await bot.api.pinChatMessage(chatId, messageId);
        sendToClient(socket, { type: "result", requestId, success: true });
        break;
      }
      case "forward": {
        const { chatId, fromChatId, messageId, messageThreadId } = msg as ClientMessage & {
          type: "outbound"; action: "forward"; chatId: string; fromChatId: string;
          messageId: number; messageThreadId?: number;
        };
        const fwd = await bot.api.forwardMessage(chatId, fromChatId, messageId, {
          ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
        });
        sendToClient(socket, { type: "result", requestId, success: true, data: { messageId: fwd.message_id } });
        break;
      }
      case "download": {
        const { fileId } = msg as ClientMessage & { type: "outbound"; action: "download"; fileId: string };
        const file = await bot.api.getFile(fileId);
        if (!file.file_path) throw new Error("Telegram returned no file_path");
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const rawExt = file.file_path.includes(".") ? file.file_path.split(".").pop()! : "bin";
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
        const uniqueId = (file.file_unique_id ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || "dl";
        const path = join(INBOX_PATH, `${Date.now()}-${uniqueId}.${ext}`);
        writeFileSync(path, buf);
        sendToClient(socket, { type: "result", requestId, success: true, data: { path } });
        break;
      }
      default:
        sendToClient(socket, {
          type: "result",
          requestId,
          success: false,
          error: `unknown action: ${action}`,
        });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[daemon] outbound error (${action}): ${errorMsg}\n`);
    sendToClient(socket, { type: "result", requestId, success: false, error: errorMsg });
  }
}

// ---------------------------------------------------------------------------
// Permission relay
// ---------------------------------------------------------------------------

/** Pending permission details for "See more" expansion, keyed by requestId */
const pendingPermissions = new Map<string, { toolName: string; description: string; inputPreview: string }>();

async function handlePermissionRequest(msg: ClientMessage & { type: "permission_request" }): Promise<void> {
  const { requestId, toolName, description, inputPreview } = msg;
  pendingPermissions.set(requestId, { toolName, description, inputPreview });
  const access = loadAccess();
  const text = `Permission: ${toolName}`;
  const keyboard = new InlineKeyboard()
    .text("See more", `perm:more:${requestId}`)
    .text("Allow", `perm:allow:${requestId}`)
    .text("Deny", `perm:deny:${requestId}`);
  for (const chatId of access.allowFrom) {
    void bot.api.sendMessage(chatId, text, { reply_markup: keyboard }).catch((e) => {
      process.stderr.write(`[daemon] permission_request send to ${chatId} failed: ${e}\n`);
    });
  }
}

// ---------------------------------------------------------------------------
// Grammy bot setup
// ---------------------------------------------------------------------------

const bot = new Bot(TOKEN);
let botUsername = "";

// Permission reply regex (from original plugin)
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// Handle inline button callbacks for permissions
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const m = /^perm:(allow|deny|more):(.+)$/.exec(data);
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const access = loadAccess();
  const senderId = String(ctx.from.id);
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
    return;
  }
  const [, behavior, requestId] = m;

  if (behavior === "more") {
    const details = pendingPermissions.get(requestId);
    if (!details) {
      await ctx.answerCallbackQuery({ text: "Details no longer available." }).catch(() => {});
      return;
    }
    const { toolName, description, inputPreview } = details;
    let prettyInput: string;
    try {
      prettyInput = JSON.stringify(JSON.parse(inputPreview), null, 2);
    } catch {
      prettyInput = inputPreview;
    }
    const expanded =
      `Permission: ${toolName}\n\n` +
      `tool_name: ${toolName}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`;
    const keyboard = new InlineKeyboard()
      .text("Allow", `perm:allow:${requestId}`)
      .text("Deny", `perm:deny:${requestId}`);
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  // Forward permission response to all connected clients
  pendingPermissions.delete(requestId);
  const label = behavior === "allow" ? "Allowed" : "Denied";
  await ctx.answerCallbackQuery({ text: label }).catch(() => {});
  const cbMsg = ctx.callbackQuery.message;
  if (cbMsg && "text" in cbMsg && cbMsg.text) {
    await ctx.editMessageText(`${cbMsg.text}\n\n${label}`).catch(() => {});
  }

  // Send permission response to all clients (the one that asked will match on requestId)
  sendToAllClients({
    type: "permission_response",
    requestId,
    behavior: behavior === "allow" ? "allow" : "deny",
  });
});

// ---------------------------------------------------------------------------
// Inbound message handling: Telegram -> agent
// ---------------------------------------------------------------------------

type AttachmentMeta = {
  kind: string;
  file_id: string;
  size?: number;
  mime?: string;
  name?: string;
};

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, "_");
}

function isMentioned(ctx: import("grammy").Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? [];
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";
  for (const e of entities) {
    if (e.type === "mention") {
      const mentioned = text.slice(e.offset, e.offset + e.length);
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true;
    }
    if (e.type === "text_mention" && e.user?.is_bot && e.user.username === botUsername) {
      return true;
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true;
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, "i").test(text)) return true;
    } catch {}
  }
  return false;
}

async function handleInbound(
  ctx: import("grammy").Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const messageThreadId = ctx.message?.message_thread_id;
  const chatType = ctx.chat?.type ?? "private";
  const chatId = String(ctx.chat!.id);
  const from = ctx.from;
  if (!from) return;
  const senderId = String(from.id);

  // Access control
  if (!isAllowedSender(senderId, chatId, chatType)) return;

  // For group messages, check mention requirement
  if (chatType === "group" || chatType === "supergroup") {
    const access = loadAccess();
    const policy = access.groups[chatId];
    if (policy?.requireMention && !isMentioned(ctx)) return;
  }

  // Permission reply intercept: check if this is a "yes/no XXXXX" permission reply
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    sendToAllClients({
      type: "permission_response",
      requestId: permMatch[2]!.toLowerCase(),
      behavior: permMatch[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
    });
    const msgId = ctx.message?.message_id;
    if (msgId != null) {
      const emoji = permMatch[1]!.toLowerCase().startsWith("y") ? "thumbs_up" : "thumbs_down";
      void bot.api.setMessageReaction(chatId, msgId, [
        { type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] },
      ]).catch(() => {});
    }
    return;
  }

  // Download photo if applicable
  const imagePath = downloadImage ? await downloadImage() : undefined;

  const msgId = ctx.message?.message_id;
  const ts = new Date((ctx.message?.date ?? 0) * 1000).toISOString();

  const inboundMsg: DaemonMessage & { type: "inbound" } = {
    type: "inbound",
    topicId: messageThreadId ?? 0,
    chatId,
    messageId: msgId ?? 0,
    userId: senderId,
    username: from.username ?? senderId,
    text,
    ts,
    ...(imagePath ? { imagePath } : {}),
    ...(attachment ? {
      attachmentFileId: attachment.file_id,
      attachmentKind: attachment.kind,
      ...(attachment.mime ? { attachmentMime: attachment.mime } : {}),
      ...(attachment.name ? { attachmentName: attachment.name } : {}),
      ...(attachment.size != null ? { attachmentSize: attachment.size } : {}),
    } : {}),
  };

  // Route by topic_id
  if (messageThreadId != null) {
    const routed = routeToTopic(messageThreadId, inboundMsg);
    if (!routed) {
      // No client registered for this topic; silently drop
      process.stderr.write(
        `[daemon] no client for topic ${messageThreadId}, message dropped\n`,
      );
    }
  } else if (chatType === "private") {
    // DMs: route to ALL connected clients (for permission relay and general DM handling)
    sendToAllClients(inboundMsg);
  } else {
    // Group message without a topic thread — try routing by chat as fallback
    // Send to all clients
    sendToAllClients(inboundMsg);
  }

  // Typing indicator
  void bot.api.sendChatAction(chatId, "typing").catch(() => {});
}

// Register message handlers
bot.on("message:text", async (ctx) => {
  await handleInbound(ctx, ctx.message.text, undefined);
});

bot.on("message:photo", async (ctx) => {
  const caption = ctx.message.caption ?? "(photo)";
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    try {
      const file = await ctx.api.getFile(best.file_id);
      if (!file.file_path) return undefined;
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = file.file_path.split(".").pop() ?? "jpg";
      const path = join(INBOX_PATH, `${Date.now()}-${best.file_unique_id}.${ext}`);
      writeFileSync(path, buf);
      return path;
    } catch (err) {
      process.stderr.write(`[daemon] photo download failed: ${err}\n`);
      return undefined;
    }
  });
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const name = safeName(doc.file_name);
  const text = ctx.message.caption ?? `(document: ${name ?? "file"})`;
  await handleInbound(ctx, text, undefined, {
    kind: "document",
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name,
  });
});

bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const text = ctx.message.caption ?? "(voice message)";
  await handleInbound(ctx, text, undefined, {
    kind: "voice",
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  });
});

bot.on("message:audio", async (ctx) => {
  const audio = ctx.message.audio;
  const name = safeName(audio.file_name);
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? "audio"})`;
  await handleInbound(ctx, text, undefined, {
    kind: "audio",
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name,
  });
});

bot.on("message:video", async (ctx) => {
  const video = ctx.message.video;
  const text = ctx.message.caption ?? "(video)";
  await handleInbound(ctx, text, undefined, {
    kind: "video",
    file_id: video.file_id,
    size: video.file_size,
    mime: video.mime_type,
    name: safeName(video.file_name),
  });
});

bot.on("message:video_note", async (ctx) => {
  const vn = ctx.message.video_note;
  await handleInbound(ctx, "(video note)", undefined, {
    kind: "video_note",
    file_id: vn.file_id,
    size: vn.file_size,
  });
});

bot.on("message:sticker", async (ctx) => {
  const sticker = ctx.message.sticker;
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : "";
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: "sticker",
    file_id: sticker.file_id,
    size: sticker.file_size,
  });
});

// Error handler — keep polling even on handler errors
bot.catch((err) => {
  process.stderr.write(`[daemon] handler error (polling continues): ${err.error}\n`);
});

// ---------------------------------------------------------------------------
// Offset persistence
// ---------------------------------------------------------------------------

function saveOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_PATH, JSON.stringify({ offset, savedAt: new Date().toISOString() }));
  } catch {}
}

function loadOffset(): number | undefined {
  try {
    const raw = readFileSync(OFFSET_PATH, "utf8");
    const data = JSON.parse(raw);
    return data.offset;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Unix socket server
// ---------------------------------------------------------------------------

// Clean up stale socket
try {
  unlinkSync(SOCKET_PATH);
} catch {}

const server = Bun.listen<SocketData>({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      socket.data.buffer += data.toString();
      processBuffer(socket);
    },
    open(socket) {
      socket.data = { topicIds: new Set(), agentName: "", buffer: "" };
      allClients.add(socket);
      process.stderr.write(`[daemon] client connected (total: ${allClients.size})\n`);
    },
    close(socket) {
      for (const topicId of socket.data.topicIds) {
        routingTable.delete(topicId);
        process.stderr.write(
          `[daemon] removed route for topic ${topicId} (agent "${socket.data.agentName}" disconnected)\n`,
        );
      }
      allClients.delete(socket);
      process.stderr.write(`[daemon] client disconnected (total: ${allClients.size})\n`);
    },
    drain(_socket) {},
    error(_socket, err) {
      process.stderr.write(`[daemon] socket error: ${err}\n`);
    },
  },
});

// Make socket accessible
try {
  chmodSync(SOCKET_PATH, 0o660);
} catch {}

process.stderr.write(`[daemon] listening on ${SOCKET_PATH}\n`);
process.stderr.write(`[daemon] pid: ${process.pid}\n`);

// ---------------------------------------------------------------------------
// Start Grammy polling
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (err) => {
  process.stderr.write(`[daemon] unhandled rejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[daemon] uncaught exception: ${err}\n`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("[daemon] shutting down\n");
  server.stop(true);
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}
  setTimeout(() => process.exit(0), 2000);
  void Promise.resolve(bot.stop()).finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

void (async () => {
  const savedOffset = loadOffset();
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        ...(savedOffset != null ? { offset: savedOffset } : {}),
        onStart: (info) => {
          botUsername = info.username;
          process.stderr.write(`[daemon] polling as @${info.username}\n`);
          process.stderr.write(`[daemon] routing table size: ${routingTable.size}\n`);
        },
      });
      return;
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000);
        process.stderr.write(
          `[daemon] 409 Conflict, retrying in ${delay / 1000}s\n`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        process.stderr.write(`[daemon] bot.start failed: ${err}\n`);
        process.exit(1);
      }
    }
  }
})();

export { server, bot, SOCKET_PATH, loadOffset, saveOffset };
