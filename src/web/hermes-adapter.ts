/**
 * Hermes-Desktop adapter for the operator console.
 *
 * Exposes the JSON-RPC 2.0 / REST contract that Hermes Desktop remote-gateway
 * mode expects, backed by Switchroom's own artifacts and IPC.
 *
 * Design: reference/rfcs/fleet-dashboard.md
 * Session model: session_id = agent name (one live claude session per agent).
 *
 * Not implemented (panels degrade gracefully in Hermes Desktop):
 *   approval.*, sudo.*, secret.*, pet.*, billing.*, voice.*
 *
 * Operator-console invariants (invariants.md §telegram-only admin-console scope):
 *   1. Operator-only audience — token-gated, same auth as the dashboard.
 *   2. prompt.submit mirrors into the agent's Telegram thread via inject_inbound.
 *   3. Same inject_inbound path as cron (synthesized turn, not a new channel).
 *   4. Approvals are not implemented — the Telegram tap stays the sole surface.
 */

import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveChannelTarget } from "../agent-scheduler/channel-target.js";
import {
  handleGetAgents,
  handleGetTurns,
  agentBridgeAlive,
  type AgentInfo,
} from "./api.js";

// ─── JSON-RPC 2.0 types ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Hermes event notification (server → client, no id). */
interface HermesEvent {
  jsonrpc: "2.0";
  method: "event";
  params: {
    type: string;
    session_id: string | null;
    payload: unknown;
  };
}

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function hermesEvent(type: string, sessionId: string | null, payload: unknown): HermesEvent {
  return { jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } };
}

// ─── Session (agent) status helpers ──────────────────────────────────────────

type AgentLiveness = "active" | "idle" | "offline";

function agentLiveness(config: SwitchroomConfig, agentName: string): AgentLiveness {
  const agentsDir = resolveAgentsDir(config);
  if (agentBridgeAlive(agentsDir, agentName)) return "active";
  const alive = join(agentsDir, agentName, "telegram", ".bridge-alive");
  if (existsSync(alive)) return "idle";
  return "offline";
}

function toHermesSession(agent: AgentInfo, liveness: AgentLiveness) {
  return {
    id: agent.name,
    name: agent.name,
    status: liveness,
    model: "claude",
    created_at: null,
    updated_at: null,
    quota: agent.primaryAccount
      ? { used_pct: null, slot: agent.primaryAccount }
      : null,
  };
}

// ─── prompt.submit → inject_inbound ──────────────────────────────────────────

interface InjectResult {
  ok: boolean;
  error?: string;
}

/** Resolve the chatId + threadId for injecting an inbound for this agent. */
function resolveAgentChat(
  config: SwitchroomConfig,
  agentName: string,
  agentsDir: string,
): { chatId: string; threadId?: number } | null {
  // Try cascade-resolved config (supergroup-owned or fleet-mode).
  const channel = resolveChannelTarget(config as Parameters<typeof resolveChannelTarget>[0], agentName);
  if (channel) return { chatId: channel.chatId, threadId: channel.threadId };

  // DM agent: no forum_chat_id configured. Read access.json for the
  // primary allowed chat (the operator's own Telegram user_id).
  const accessPath = resolve(agentsDir, agentName, "telegram", "access.json");
  if (!existsSync(accessPath)) return null;
  try {
    const raw = readFileSync(accessPath, "utf-8");
    const access = JSON.parse(raw) as { allowFrom?: string[] };
    const chatId = access.allowFrom?.[0];
    if (!chatId) return null;
    return { chatId };
  } catch {
    return null;
  }
}

/** Write an inject_inbound NDJSON envelope to the agent's gateway socket. */
async function injectInbound(
  agentsDir: string,
  agentName: string,
  chatId: string,
  threadId: number | undefined,
  text: string,
  promptKey: string,
): Promise<InjectResult> {
  const socketPath = resolve(agentsDir, agentName, "telegram", "gateway.sock");
  if (!existsSync(socketPath)) {
    return { ok: false, error: `agent ${agentName} gateway socket not found — is it running?` };
  }

  const ts = Date.now();
  const envelope = JSON.stringify({
    type: "inject_inbound",
    agentName,
    inbound: {
      type: "inbound",
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
      messageId: ts,
      user: "operator",
      userId: 0,
      ts,
      text,
      meta: {
        source: "operator-console",
        prompt_key: promptKey,
      },
    },
  });

  return new Promise((res) => {
    const sock = createConnection(socketPath);
    let settled = false;
    const settle = (result: InjectResult) => {
      if (!settled) {
        settled = true;
        sock.destroy();
        res(result);
      }
    };

    const timeout = setTimeout(() => settle({ ok: false, error: "gateway socket timeout" }), 5000);
    sock.once("connect", () => {
      clearTimeout(timeout);
      sock.write(envelope + "\n", (err) => {
        settle(err ? { ok: false, error: err.message } : { ok: true });
      });
    });
    sock.once("error", (err) => {
      clearTimeout(timeout);
      settle({ ok: false, error: err.message });
    });
  });
}

// ─── REST handler ─────────────────────────────────────────────────────────────

export interface HermesRestResult {
  status: number;
  body: unknown;
}

/**
 * Handle a Hermes REST route. Returns null when the path is not a Hermes route
 * (caller should fall through to other routes).
 */
export async function handleHermesRest(
  method: string,
  pathname: string,
  config: SwitchroomConfig,
): Promise<HermesRestResult | null> {
  // GET /api/sessions or /api/profiles/sessions — fleet session list
  // Hermes Desktop calls /api/profiles/sessions for the cross-profile sidebar.
  if (
    method === "GET" &&
    (pathname === "/api/sessions" || pathname === "/api/profiles/sessions")
  ) {
    const agents = await handleGetAgents(config);
    const sessions = agents.map((a) => toHermesSession(a, agentLiveness(config, a.name)));
    return {
      status: 200,
      body: {
        sessions,
        total: sessions.length,
        limit: sessions.length,
        offset: 0,
        profile_totals: { default: sessions.length },
      },
    };
  }

  // GET /api/sessions/:id — single session status
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    if (!config.agents?.[id]) return { status: 404, body: { error: "Unknown session" } };
    const agents = await handleGetAgents(config);
    const agent = agents.find((a) => a.name === id);
    if (!agent) return { status: 404, body: { error: "Unknown session" } };
    return { status: 200, body: { session: toHermesSession(agent, agentLiveness(config, id)) } };
  }

  // GET /api/sessions/:id/history — conversation history
  const historyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (method === "GET" && historyMatch) {
    const id = decodeURIComponent(historyMatch[1]);
    if (!config.agents?.[id]) return { status: 404, body: { error: "Unknown session" } };
    const result = handleGetTurns(config, id, 50);
    if (!result.ok) return { status: 500, body: { error: result.error } };
    return { status: 200, body: { history: result.turns ?? [] } };
  }

  // GET /api/status — fleet overview
  if (method === "GET" && pathname === "/api/status") {
    const agents = await handleGetAgents(config);
    const fleet = agents.map((a) => ({
      name: a.name,
      status: agentLiveness(config, a.name),
    }));
    return {
      status: 200,
      body: {
        status: "ok",
        provider: "switchroom",
        agents: fleet,
      },
    };
  }

  // GET /api/config — Hermes expects a HermesConfig-shaped response
  if (method === "GET" && pathname === "/api/config") {
    return {
      status: 200,
      body: {
        provider: "switchroom",
        model: null,
        context_length: null,
        system_prompt: null,
      },
    };
  }

  // GET /api/config/defaults and /api/config/schema — stub empties
  if (method === "GET" && (pathname === "/api/config/defaults" || pathname === "/api/config/schema")) {
    return { status: 200, body: {} };
  }

  // GET /api/model/info — Hermes renders the active model in the header
  if (method === "GET" && pathname === "/api/model/info") {
    return {
      status: 200,
      body: {
        model: "claude",
        provider: "switchroom",
        capabilities: {},
      },
    };
  }

  // GET /api/logs — return empty log
  if (method === "GET" && pathname.startsWith("/api/logs")) {
    return { status: 200, body: { file: "gateway.log", lines: [] } };
  }

  // Stub empty responses for cron/messaging/profile endpoints Hermes calls at boot
  if (
    method === "GET" &&
    (pathname.startsWith("/api/cron") ||
      pathname.startsWith("/api/messaging") ||
      pathname.startsWith("/api/profiles") ||
      pathname === "/api/memory/providers")
  ) {
    // Return the most common empty-list shape Hermes expects
    if (pathname.includes("sessions")) {
      return { status: 200, body: { sessions: [], total: 0, limit: 0, offset: 0 } };
    }
    return { status: 200, body: {} };
  }

  return null;
}

// ─── WebSocket / JSON-RPC handler ─────────────────────────────────────────────

export interface HermesWsContext {
  config: SwitchroomConfig;
  /** Send a raw string to the WebSocket client. */
  send: (msg: string) => void;
  /** Active status-poll interval handle — cleared on close. */
  pollInterval?: ReturnType<typeof setInterval>;
  /** Currently activated session (agent name), if any. */
  activeSessionId?: string;
}

function sendEvent(ctx: HermesWsContext, type: string, sessionId: string | null, payload: unknown) {
  try {
    ctx.send(JSON.stringify(hermesEvent(type, sessionId, payload)));
  } catch {
    // client gone
  }
}

function sendResponse(ctx: HermesWsContext, resp: JsonRpcResponse) {
  try {
    ctx.send(JSON.stringify(resp));
  } catch {
    // client gone
  }
}

/** Called on WS open — sends the gateway.ready notification and arms a poll. */
export function onHermesOpen(ctx: HermesWsContext) {
  sendEvent(ctx, "gateway.ready", null, {
    provider: "switchroom",
    version: "1.0",
  });

  // Emit a fleet status.update every 5 s so the desktop stays fresh
  // without the client needing to poll session.list.
  ctx.pollInterval = setInterval(async () => {
    const agents = await handleGetAgents(ctx.config);
    for (const agent of agents) {
      const liveness = agentLiveness(ctx.config, agent.name);
      sendEvent(ctx, "status.update", agent.name, { status: liveness });
    }
  }, 5000);
}

/** Called on WS close — clears the poll timer. */
export function onHermesClose(ctx: HermesWsContext) {
  if (ctx.pollInterval) {
    clearInterval(ctx.pollInterval);
    ctx.pollInterval = undefined;
  }
}

/** Dispatch a JSON-RPC message from the client. */
export async function onHermesMessage(ctx: HermesWsContext, raw: string) {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    sendResponse(ctx, rpcErr(null, -32700, "Parse error"));
    return;
  }

  if (!req.method || typeof req.method !== "string") {
    sendResponse(ctx, rpcErr(req.id ?? null, -32600, "Invalid request"));
    return;
  }

  const id = req.id ?? null;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const config = ctx.config;

  switch (req.method) {
    case "session.list": {
      const agents = await handleGetAgents(config);
      const sessions = agents.map((a) => toHermesSession(a, agentLiveness(config, a.name)));
      sendResponse(ctx, rpcOk(id, { sessions }));
      break;
    }

    case "session.most_recent": {
      const agents = await handleGetAgents(config);
      if (agents.length === 0) {
        sendResponse(ctx, rpcOk(id, { session: null }));
        break;
      }
      const a = agents[0];
      sendResponse(ctx, rpcOk(id, { session: toHermesSession(a, agentLiveness(config, a.name)) }));
      break;
    }

    case "session.status": {
      const sessionId = String(params.session_id ?? "");
      if (!config.agents?.[sessionId]) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      const agents = await handleGetAgents(config);
      const agent = agents.find((a) => a.name === sessionId);
      if (!agent) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      sendResponse(ctx, rpcOk(id, { session: toHermesSession(agent, agentLiveness(config, sessionId)) }));
      break;
    }

    case "session.create":
    case "session.resume":
    case "session.activate": {
      // Map to an existing agent — Switchroom agents are always live.
      const sessionId = String(params.session_id ?? params.name ?? "");
      if (!config.agents?.[sessionId]) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      ctx.activeSessionId = sessionId;
      const agents = await handleGetAgents(config);
      const agent = agents.find((a) => a.name === sessionId);
      if (!agent) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      const session = toHermesSession(agent, agentLiveness(config, sessionId));
      sendResponse(ctx, rpcOk(id, { session }));
      sendEvent(ctx, "session.info", sessionId, session);
      break;
    }

    case "session.close": {
      ctx.activeSessionId = undefined;
      sendResponse(ctx, rpcOk(id, { ok: true }));
      break;
    }

    case "session.history": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!config.agents?.[sessionId]) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const result = handleGetTurns(config, sessionId, Math.min(limit, 200));
      if (!result.ok) {
        sendResponse(ctx, rpcErr(id, -32603, result.error ?? "Failed to read history"));
        break;
      }
      sendResponse(ctx, rpcOk(id, { history: result.turns ?? [] }));
      break;
    }

    case "session.usage": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!config.agents?.[sessionId]) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      // Metadata only — no token values egress.
      const agents = await handleGetAgents(config);
      const agent = agents.find((a) => a.name === sessionId);
      sendResponse(ctx, rpcOk(id, {
        session_id: sessionId,
        quota: agent?.primaryAccount
          ? { slot: agent.primaryAccount, state: agent.auth.subscriptionType ?? null }
          : null,
      }));
      break;
    }

    case "prompt.submit":
    case "prompt.background": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      const content = String(params.content ?? params.text ?? "");

      if (!sessionId || !config.agents?.[sessionId]) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      if (!content) {
        sendResponse(ctx, rpcErr(id, -32602, "content is required"));
        break;
      }

      const agentsDir = resolveAgentsDir(config);
      const chat = resolveAgentChat(config, sessionId, agentsDir);
      if (!chat) {
        sendResponse(ctx, rpcErr(id, -32603,
          `Could not resolve chat for ${sessionId} — ensure the agent has telegram.forum_chat_id or channels.telegram.chat_id configured.`
        ));
        break;
      }

      const promptKey = createHash("sha256")
        .update(`${sessionId}:${Date.now()}:${content}`)
        .digest("hex")
        .slice(0, 12);

      sendEvent(ctx, "message.start", sessionId, { prompt_key: promptKey });

      const result = await injectInbound(agentsDir, sessionId, chat.chatId, chat.threadId, content, promptKey);
      if (!result.ok) {
        sendEvent(ctx, "error", sessionId, { message: result.error, prompt_key: promptKey });
        sendResponse(ctx, rpcErr(id, -32603, result.error ?? "inject failed"));
        break;
      }

      // Prompt accepted. The agent's reply arrives in Telegram (mirrored
      // per the admin-console conditions). We emit message.complete so
      // the desktop knows the submit was accepted; real delta streaming
      // is a follow-up (Phase B).
      sendEvent(ctx, "message.complete", sessionId, {
        prompt_key: promptKey,
        note: "reply delivered to Telegram thread",
      });
      sendResponse(ctx, rpcOk(id, { ok: true, prompt_key: promptKey }));
      break;
    }

    case "session.interrupt": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!sessionId || !config.agents?.[sessionId]) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      // Interrupt is implemented by injecting the operator's `/interrupt`
      // command through the same synthesized-inbound path. The gateway
      // handles the `!interrupt` / `/interrupt` verb.
      const agentsDir = resolveAgentsDir(config);
      const chat = resolveAgentChat(config, sessionId, agentsDir);
      if (!chat) {
        sendResponse(ctx, rpcErr(id, -32603, `Cannot resolve chat for ${sessionId}`));
        break;
      }
      const promptKey = `interrupt-${Date.now()}`;
      const intResult = await injectInbound(agentsDir, sessionId, chat.chatId, chat.threadId, "! ", promptKey);
      if (!intResult.ok) {
        sendResponse(ctx, rpcErr(id, -32603, intResult.error ?? "interrupt inject failed"));
        break;
      }
      sendResponse(ctx, rpcOk(id, { ok: true }));
      break;
    }

    // Methods whose panels degrade gracefully when unimplemented:
    case "approval.request":
    case "approval.respond":
    case "sudo.request":
    case "sudo.respond":
    case "secret.get":
    case "secret.set":
      sendResponse(ctx, rpcErr(id, -32601, `Method not implemented: ${req.method}`));
      break;

    default:
      sendResponse(ctx, rpcErr(id, -32601, `Unknown method: ${req.method}`));
  }
}
