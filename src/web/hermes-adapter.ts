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
 * Operator-console invariants (invariants.md §telegram-and-buzz-only admin-console scope):
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
import type { Turn } from "../../telegram-plugin/registry/turns-schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveChannelTarget } from "../agent-scheduler/channel-target.js";
import {
  handleGetAgents,
  handleGetTurns,
  handleGetSchedule,
  handleListThreadIds,
  parseHermesSessionId,
  agentBridgeAlive,
  type AgentInfo,
} from "./api.js";
import {
  injectSlashCommand,
  INJECT_ALLOWLIST,
  INJECT_BLOCKLIST,
} from "../agents/inject.js";

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

/**
 * Human-readable title for a Hermes session ID (may be composite "agent~threadId").
 * Resolves forum thread IDs to names via channels.telegram.topic_aliases when available.
 */
function sessionTitle(config: SwitchroomConfig, sessionId: string): string {
  const { agentName, threadId } = parseHermesSessionId(sessionId)
  if (threadId === undefined) return agentName           // DM agent — no topic suffix
  // Build an inverted alias map: thread_id (as string) → alias name
  const aliases = config.agents?.[agentName]?.channels?.telegram?.topic_aliases ?? {}
  const byId = Object.fromEntries(
    Object.entries(aliases).map(([name, id]) => [String(id), name])
  )
  if (threadId === null) {
    // null thread = messages not in any topic (pre-topic or Telegram General)
    return `${agentName} · ${byId["1"] ?? "General"}`
  }
  const name = byId[threadId]
  return name ? `${agentName} · ${name}` : `${agentName} · ${threadId}`
}

/**
 * Returns true if sessionId refers to a known agent (possibly a composite
 * "agentName~threadId" for supergroup topics).
 */
function isKnownSession(config: SwitchroomConfig, sessionId: string): boolean {
  const { agentName } = parseHermesSessionId(sessionId)
  return !!config.agents?.[agentName]
}

function toHermesSession(sessionId: string, agent: AgentInfo, liveness: AgentLiveness, config: SwitchroomConfig) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: sessionId,
    name: sessionId,
    title: sessionTitle(config, sessionId),
    status: liveness,
    model: "claude",
    // Required SessionInfo fields — zero-value stubs (no token metering in switchroom)
    is_active: liveness === "active",
    started_at: nowSec,
    last_active: nowSec,
    ended_at: null,
    input_tokens: 0,
    output_tokens: 0,
    message_count: 0,
    tool_call_count: 0,
    preview: null,
    source: "switchroom",
    created_at: null,
    updated_at: null,
    quota: agent.primaryAccount
      ? { used_pct: null, slot: agent.primaryAccount }
      : null,
  };
}

/**
 * Build the full Hermes session list. For supergroup agents (those with a
 * primary channel chat_id), enumerate distinct forum thread_ids from the
 * turns DB and emit one session per topic. DM agents emit a single session.
 */
async function buildAllSessions(
  config: SwitchroomConfig,
): Promise<ReturnType<typeof toHermesSession>[]> {
  const agents = await handleGetAgents(config)
  const sessions: ReturnType<typeof toHermesSession>[] = []
  for (const agent of agents) {
    const liveness = agentLiveness(config, agent.name)
    const chatId = config.agents?.[agent.name]?.channels?.telegram?.chat_id
    if (chatId) {
      // Supergroup agent — one session per forum topic found in the turns DB.
      // Falls back to a single unlabelled session if the DB has no turns yet.
      const threadIds = handleListThreadIds(config, agent.name)
      if (threadIds.length === 0) {
        sessions.push(toHermesSession(agent.name, agent, liveness, config))
      } else {
        for (const threadId of threadIds) {
          const sessionId = threadId === null ? agent.name : `${agent.name}~${threadId}`
          sessions.push(toHermesSession(sessionId, agent, liveness, config))
        }
      }
    } else {
      sessions.push(toHermesSession(agent.name, agent, liveness, config))
    }
  }
  return sessions
}

/**
 * Source scoping for the session-list endpoints.
 *
 * Upstream's `list_sessions_rich` takes `source` (keep only this source) and
 * `exclude_sources` (drop these), and the desktop leans on both: the sidebar's
 * cron slice asks for `source=cron`, its recents slice excludes the cron and
 * messaging taxonomies, and its messaging slice excludes the local ones
 * (`apps/desktop/src/app/session/hooks/use-session-list-actions.ts:47-50`,
 * `hermes.ts:436-441` at 9da6d45). Ignoring them makes every slice return the
 * identical unfiltered fleet — the starvation the upstream comment at
 * `hermes.ts:418-422` describes.
 *
 * Every switchroom session reports `source: "switchroom"` (see
 * {@link toHermesSession}), which is in none of the desktop's exclude
 * taxonomies and is not `cron` — so `source=cron` correctly yields nothing.
 */
function filterSessionsBySource<T extends { source: string }>(
  sessions: T[],
  opts: { source?: string | null; excludeSources?: string[] },
): T[] {
  const exclude = new Set(opts.excludeSources ?? []);
  return sessions.filter(
    (s) => (!opts.source || s.source === opts.source) && !exclude.has(s.source),
  );
}

/** Read a comma-separated query param (`exclude_sources`, `recents_exclude`, …). */
function csvParam(params: URLSearchParams, key: string): string[] {
  return (params.get(key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Clamp a numeric query param the way upstream's sidebar route does. */
function intParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : fallback;
}

// ─── prompt.submit → inject_inbound ──────────────────────────────────────────

interface InjectResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolve the chatId + threadId for injecting an inbound.
 * sessionId may be a composite "agentName~threadId" — extract both parts.
 */
function resolveAgentChat(
  config: SwitchroomConfig,
  sessionId: string,
  agentsDir: string,
): { chatId: string; threadId?: number } | null {
  const { agentName, threadId: topicId } = parseHermesSessionId(sessionId)
  // Try cascade-resolved config (supergroup-owned or fleet-mode).
  const channel = resolveChannelTarget(config as Parameters<typeof resolveChannelTarget>[0], agentName);
  if (channel) {
    // If the session ID encodes a specific topic, use that thread; otherwise use config default.
    const threadId = topicId !== undefined
      ? (topicId === null ? undefined : (parseInt(topicId, 10) || undefined))
      : channel.threadId
    return { chatId: channel.chatId, threadId }
  }

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

/**
 * Read the most recent `limit` messages from history.db for an agent.
 * Returns an array of {role, content, timestamp} in chronological order,
 * or null if history.db is unavailable.
 */
function readHistoryDb(
  agentsDir: string,
  agentName: string,
  limit: number,
): Array<{ role: string; content: string; timestamp: number }> | null {
  const dbPath = resolve(agentsDir, agentName, "telegram", "history.db");
  if (!existsSync(dbPath)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let SqliteDatabase: any;
    const meta = import.meta as { require?: (id: string) => unknown };
    if (!meta.require) return null;
    const mod = meta.require("bun:sqlite") as { Database?: unknown };
    SqliteDatabase = mod.Database;
    if (!SqliteDatabase) return null;

    const db = new SqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          // role <> 'system' excludes the card lane (#4571): activity cards /
          // status pins / approval cards are ephemeral UI, not transcript.
          `SELECT role, text, ts FROM messages
           WHERE role <> 'system'
           ORDER BY ts DESC, rowid DESC LIMIT ?`,
        )
        .all(limit) as Array<{ role: string; text: string; ts: number }>;
      return rows.reverse().map((r) => ({
        role: r.role,
        content: r.text,
        timestamp: r.ts,
      }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Start a 2-second background poll on history.db for a given agent.
 * Emits `message.complete` to the WS client for every new assistant
 * message — covering both Telegram-originated and Hermes-injected replies.
 *
 * The cursor is the SQLite rowid so ties / timestamp collisions can't
 * cause missed or duplicate messages. Only assistant messages are emitted;
 * user messages are already rendered locally by Hermes or injected via us.
 *
 * Returns a stop function. Call it on session change or WS close.
 */
function startHistoryPoll(
  ctx: HermesWsContext,
  agentsDir: string,
  agentName: string,
  sessionId: string,
  pollIntervalMs = 2_000,
): () => void {
  const dbPath = resolve(agentsDir, agentName, "telegram", "history.db");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SqliteDatabase: any = null;
  try {
    const meta = import.meta as { require?: (id: string) => unknown };
    if (meta.require) {
      const mod = meta.require("bun:sqlite") as { Database?: unknown };
      SqliteDatabase = mod.Database ?? null;
    }
  } catch { /* not Bun — skip */ }

  // Initialise cursor to current max rowid so we only emit NEW messages.
  let cursor = 0;
  if (SqliteDatabase && existsSync(dbPath)) {
    try {
      const db = new SqliteDatabase(dbPath, { readonly: true });
      try {
        const row = db.prepare("SELECT MAX(rowid) AS r FROM messages").get() as { r: number | null } | null;
        cursor = row?.r ?? 0;
      } finally { db.close(); }
    } catch { /* best-effort */ }
  }

  const timer = setInterval(() => {
    if (!SqliteDatabase || !existsSync(dbPath)) return;
    try {
      const db = new SqliteDatabase(dbPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT rowid, role, text FROM messages
             WHERE rowid > ? AND role = 'assistant'
             ORDER BY rowid ASC`,
          )
          .all(cursor) as Array<{ rowid: number; role: string; text: string }>;

        for (const row of rows) {
          cursor = row.rowid;
          // Claim the pending prompt.submit key FOR THIS SESSION if present, else
          // synthesise a fresh start+complete pair for a Telegram-originated reply.
          const { promptKey, needsStart } = claimPromptKey(ctx, sessionId, row.rowid);
          if (needsStart) {
            sendEvent(ctx, "message.start", sessionId, { prompt_key: promptKey });
          }
          sendEvent(ctx, "message.complete", sessionId, {
            text: row.text,
            prompt_key: promptKey,
          });
        }
      } finally { db.close(); }
    } catch { /* DB locked / temporarily unreadable — retry next tick */ }
  }, pollIntervalMs);

  return () => clearInterval(timer);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

import type { ScheduleDashboard } from "./api.js";
import type { DispatchResult } from "../scheduler/dispatch.js";

/** Compose a stable CronJob id from agent name + schedule index. */
function cronJobId(agent: string, index: number): string {
  return `${agent}~${index}`;
}

/** Map a ScheduleDashboard to CronJob[] for the Hermes cron panel. */
function scheduleToCronJobs(schedule: ScheduleDashboard): Record<string, unknown>[] {
  return schedule.entries.map((entry) => {
    const id = cronJobId(entry.agent, entry.scheduleIndex);
    // Find the most recent fire for this entry to populate last_run_at / last_error
    const fires: DispatchResult[] = schedule.recentByAgent[entry.agent] ?? [];
    const entryFires = fires.filter((f) => f.scheduleIndex === entry.scheduleIndex);
    const lastFire = entryFires[entryFires.length - 1];
    return {
      id,
      enabled: true,
      name: entry.name ?? null,
      prompt: entry.prompt ?? null,
      schedule: { expr: entry.cron, display: entry.cron, kind: entry.kind ?? "prompt" },
      schedule_display: entry.cron,
      last_run_at: lastFire ? new Date(lastFire.finishedAt).toISOString() : null,
      last_error: lastFire?.exitCode !== 0 ? (lastFire?.outputSummary ?? null) : null,
      state: lastFire ? (lastFire.exitCode === 0 ? "success" : "error") : null,
    };
  });
}

/** Get run history for a single job id ("<agent>/<index>"). */
function cronJobRuns(schedule: ScheduleDashboard, jobId: string): object[] {
  const tilde = jobId.lastIndexOf("~");
  if (tilde === -1) return [];
  const agent = jobId.slice(0, tilde);
  const index = parseInt(jobId.slice(tilde + 1), 10);
  const fires: DispatchResult[] = schedule.recentByAgent[agent] ?? [];
  return fires
    .filter((f) => f.scheduleIndex === index)
    .map((f) => {
      const d = new Date(f.startedAt);
      const name = d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return {
        id: `${jobId}/${f.startedAt}`,
        job_id: jobId,
        name,
        started_at: new Date(f.startedAt).toISOString(),
        finished_at: new Date(f.finishedAt).toISOString(),
        exit_code: f.exitCode,
        output: f.outputSummary,
        status: f.exitCode === 0 ? "success" : "error",
      };
    });
}

/** Map switchroom Turn records to SessionMessage[] for Hermes Desktop history. */
function turnsToMessages(turns: Turn[]): object[] {
  const messages: object[] = [];
  for (const t of turns) {
    if (t.user_prompt_preview) {
      messages.push({
        role: "user",
        content: t.user_prompt_preview,
        timestamp: Math.floor(t.started_at / 1000),
      });
    }
    if (t.assistant_reply_preview) {
      messages.push({
        role: "assistant",
        content: t.assistant_reply_preview,
        timestamp: t.ended_at != null ? Math.floor(t.ended_at / 1000) : Math.floor(t.started_at / 1000),
      });
    }
  }
  return messages;
}

/** Claude models available via the switchroom subscription.
 *
 * These are the family ALIASES the claude CLI resolves itself, not pinned
 * concrete ids. Pinned ids rot: `claude-fable-5` was retired server-side and
 * 4xx'd the fleet on 2026-06-13 (see telegram-plugin/gateway/model-command.ts
 * MODEL_ALIASES), while the `fable` alias keeps resolving to the current
 * flagship. The picker's selection is injected as `/model <value>` (see the
 * config.set handler), so aliases are the durable selector.
 */
export const SWITCHROOM_MODELS = ["fable", "opus", "sonnet", "haiku"];

/** Report the model for an agent session. There is no live per-session model
 * source in the adapter (a `/model` switch happens inside the claude session
 * and is not observable here), so the most honest answer is the agent's
 * configured model from switchroom.yaml (per-agent `model:` over
 * `defaults.model`), falling back to the `sonnet` family alias (the CLI's
 * default tier) when nothing is configured. */
export function configuredModel(config: SwitchroomConfig, agentName?: string): string {
  const agentModel = agentName ? config.agents?.[agentName]?.model : undefined;
  return agentModel ?? config.defaults?.model ?? "sonnet";
}

/** Build a ModelOptionsResponse for the Hermes Desktop model picker. */
function switchroomModelOptions(config: SwitchroomConfig, agentName?: string) {
  return {
    model: configuredModel(config, agentName),
    provider: "switchroom",
    providers: [
      {
        slug: "switchroom",
        name: "Switchroom (Claude)",
        is_current: true,
        authenticated: true,
        models: SWITCHROOM_MODELS,
        total_models: SWITCHROOM_MODELS.length,
      },
    ],
  };
}

/** Switchroom slash commands surfaced in the Hermes Desktop slash palette.
 *
 * Hermes filters this list through filterDesktopCommandsCatalog — only
 * "extension" commands (anything not in its own built-in table) and exec-surface
 * commands appear in the popover. Switchroom commands like /memory, /vault,
 * /schedule, /effort, /whoami, /doctor, /logs, /auth are all extensions and will
 * show. Commands that overlap with Hermes built-ins (/new, /status, /restart,
 * /compact, /clear) stay in the catalog for exec dispatch but are filtered from
 * the popover by Hermes.
 */
function switchroomCommandsCatalog() {
  return {
    categories: [
      {
        name: "Session",
        pairs: [
          // /new and /restart are intentionally absent — Hermes handles them
          // natively via its own built-in command table; and injectInbound
          // cannot correctly dispatch them (they need the grammy bot.command
          // handler path, which only fires on real Telegram messages).
          ["/compact", "Compact context (summarize, keep the thread)"],
          ["/clear", "Clear context (fresh slate; memory in Hindsight)"],
          ["/model", "Show or switch the Claude model"],
          ["/status", "Agent, model, auth status"],
        ] as [string, string][],
      },
      {
        name: "Memory & knowledge",
        pairs: [
          ["/memory", "List, search, or clear Hindsight memory"],
        ] as [string, string][],
      },
      {
        name: "Vault & auth",
        pairs: [
          ["/vault", "Manage vault secrets + capability grants"],
          ["/auth", "Auth dashboard — accounts, quota, reauth, switch primary"],
          ["/whoami", "This agent's sandbox: tools, MCP, vault key-names"],
        ] as [string, string][],
      },
      {
        name: "Diagnostics",
        pairs: [
          ["/doctor", "Health check (deps, services, MCP)"],
          ["/logs", "Show recent agent logs"],
          ["/usage", "Pro/Max plan quota (5h + 7d windows)"],
          ["/version", "Show version + running agent health"],
          ["/commands", "Full command list"],
        ] as [string, string][],
      },
    ],
  };
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
  search = "",
): Promise<HermesRestResult | null> {
  // GET /api/sessions or /api/profiles/sessions — fleet session list
  // Hermes Desktop calls /api/profiles/sessions for the cross-profile sidebar.
  if (
    method === "GET" &&
    (pathname === "/api/sessions" || pathname === "/api/profiles/sessions")
  ) {
    const query = new URLSearchParams(search);
    const sessions = filterSessionsBySource(await buildAllSessions(config), {
      source: query.get("source"),
      excludeSources: csvParam(query, "exclude_sources"),
    });
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

  // GET /api/profiles/sessions/sidebar — the batched three-slice sidebar payload
  // (SidebarSessionsResponse, apps/desktop/src/hermes.ts:486-491 at 9da6d45).
  //
  // MUST be served or 404'd honestly, never answered with a bare 200: the
  // desktop's `isEndpointMissingError` (hermes.ts:520-536) only recognises
  // 404-shaped failures, so a 200 with the wrong body never trips the
  // `listSidebarSessionsLegacy` fallback — the sidebar just renders three
  // permanently-empty slices. Serving it for real is strictly better than
  // 404-ing, because the data is the same `buildAllSessions` list the
  // per-slice route already answers from.
  //
  // Slice semantics mirror hermes_cli/web_routers/profiles.py:232-383: all
  // three windows are recency-ordered and source-scoped, cron is an implicit
  // `source=cron`, and recents/messaging honour the caller's CSV exclude lists.
  //
  // Consequence worth knowing: `source: "switchroom"` is in neither the
  // recents nor the messaging exclude list, so a switchroom session appears in
  // both slices. That is what the taxonomy says — every switchroom session is
  // a Telegram thread AND a recent chat — and the alternative (retagging
  // sessions as `source: "telegram"`) would move the whole fleet OUT of
  // recents, since the desktop excludes every messaging source from it
  // (use-session-list-actions.ts:47). Deliberate, not an oversight.
  if (method === "GET" && pathname === "/api/profiles/sessions/sidebar") {
    const query = new URLSearchParams(search);
    const all = await buildAllSessions(config);
    const recentsCap = intParam(query, "recents_limit", 20);
    const cronCap = intParam(query, "cron_limit", 50);
    const messagingCap = intParam(query, "messaging_limit", 100);
    const recents = filterSessionsBySource(all, {
      excludeSources: csvParam(query, "recents_exclude"),
    }).slice(0, recentsCap);
    const cron = filterSessionsBySource(all, { source: "cron" }).slice(0, cronCap);
    const messaging = filterSessionsBySource(all, {
      excludeSources: csvParam(query, "messaging_exclude"),
    }).slice(0, messagingCap);
    return {
      status: 200,
      body: {
        // `profiles_usage` is deliberately omitted rather than zero-filled:
        // switchroom does no token/spend metering, and upstream declares the
        // key optional (hermes.ts:465-467), so absent is the honest answer.
        recents: {
          sessions: recents,
          profiles_truncated: { default: recents.length >= recentsCap },
        },
        cron: { sessions: cron },
        messaging: { sessions: messaging, total: messaging.length },
        errors: [],
      },
    };
  }

  // GET /api/sessions/:id — single session status
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    if (!isKnownSession(config, id)) return { status: 404, body: { error: "Unknown session" } };
    const { agentName } = parseHermesSessionId(id);
    const agents = await handleGetAgents(config);
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) return { status: 404, body: { error: "Unknown session" } };
    return { status: 200, body: { session: toHermesSession(id, agent, agentLiveness(config, agentName), config) } };
  }

  // GET /api/sessions/:id/messages — conversation history (SessionMessagesResponse shape)
  const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (method === "GET" && messagesMatch) {
    const id = decodeURIComponent(messagesMatch[1]);
    if (!isKnownSession(config, id)) return { status: 404, body: { error: "Unknown session" } };
    const result = handleGetTurns(config, id, 100);
    // Degrade gracefully on DB errors — return empty messages.
    const messages = turnsToMessages(result.turns ?? []);
    return { status: 200, body: { session_id: id, messages } };
  }

  // GET /api/status — StatusResponse shape Hermes Desktop expects
  if (method === "GET" && pathname === "/api/status") {
    return {
      status: 200,
      body: {
        version: "switchroom",
        gateway_running: true,
        gateway_platforms: {},
        gateway_state: "ready",
        config_version: 0,
        latest_config_version: 0,
        hermes_home: "switchroom",
        release_date: null,
        active_sessions: 0,
        config_path: null,
        env_path: null,
        gateway_exit_reason: null,
        gateway_health_url: null,
        gateway_pid: null,
        gateway_updated_at: null,
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
        // No session context on this endpoint — report the fleet-default
        // configured model rather than a hardcoded constant.
        model: configuredModel(config),
        provider: "switchroom",
        capabilities: {},
      },
    };
  }

  // GET /api/logs — return empty log
  if (method === "GET" && pathname.startsWith("/api/logs")) {
    return { status: 200, body: { file: "gateway.log", lines: [] } };
  }

  // Cron panel — reads from handleGetSchedule (same data as the web dashboard's
  // Schedule tab). Job IDs are "<agent>/<index>" composites; Hermes treats them
  // as opaque strings. Read-only: create/update/pause/resume/delete are no-ops
  // since schedules are owned by the YAML config (operator edits the file, not
  // the UI — the same constraint as the Telegram /schedule command).
  if (pathname.startsWith("/api/cron")) {
    if (method === "GET" && pathname === "/api/cron/jobs") {
      const schedule = await handleGetSchedule(config);
      const jobs = scheduleToCronJobs(schedule);
      return { status: 200, body: jobs };
    }

    const jobRunsMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)\/runs$/);
    if (method === "GET" && jobRunsMatch) {
      const jobId = decodeURIComponent(jobRunsMatch[1]);
      const schedule = await handleGetSchedule(config);
      const runs = cronJobRuns(schedule, jobId);
      const limitParam = new URLSearchParams(search).get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 20;
      return { status: 200, body: { runs: runs.slice(0, limit) } };
    }

    const jobMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)$/);
    if (method === "GET" && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const schedule = await handleGetSchedule(config);
      const job = scheduleToCronJobs(schedule).find((j) => j.id === jobId);
      if (!job) return { status: 404, body: { error: "Not found" } };
      return { status: 200, body: job };
    }

    // GET /api/cron/delivery-targets — the platforms a cron job may deliver to.
    // Upstream (hermes_cli/web_routers/cron.py:72-95) always prepends the
    // implicit `local` option and derives the rest from the configured gateway
    // platforms. Switchroom's only delivery platform is Telegram, and a cron
    // fire lands in the agent's own thread — so `home_target_set` is true iff
    // at least one agent actually resolves a channel target.
    if (method === "GET" && pathname === "/api/cron/delivery-targets") {
      const telegramConfigured = Object.keys(config.agents ?? {}).some(
        (name) =>
          resolveChannelTarget(config as Parameters<typeof resolveChannelTarget>[0], name) !== null,
      );
      return {
        status: 200,
        body: {
          targets: [
            { id: "local", name: "Local (save only)", home_target_set: true, home_env_var: null },
            {
              id: "telegram",
              name: "Telegram",
              home_target_set: telegramConfigured,
              home_env_var: null,
            },
          ],
        },
      };
    }

    // GET /api/cron/blueprints — the automation-blueprint gallery
    // (`{ blueprints }`, read at apps/desktop/src/hermes.ts:1480-1486).
    // Switchroom has no blueprint catalog, and instantiating one would be a
    // schedule write, which the 422 below refuses anyway — so the honest
    // answer is an empty catalog, not a bare 200 that leaves `blueprints`
    // undefined at the call site.
    if (method === "GET" && pathname === "/api/cron/blueprints") {
      return { status: 200, body: { blueprints: [] } };
    }

    // Create/update/pause/resume/delete: schedules are config-owned, not
    // UI-mutable. PUT is in this list because `updateCronJob`
    // (apps/desktop/src/hermes.ts:1428-1434) uses it — without it the edit fell
    // through to a 200 and the desktop reported a save that never happened.
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      return { status: 422, body: { error: "Schedules are managed via switchroom YAML config — edit the agent config file and apply." } };
    }

    // No blanket 200 for unrecognised /api/cron reads: a fabricated empty
    // success is indistinguishable from a served route at the call site, so an
    // unknown path 404s (via the caller's null handling) and the desktop can
    // tell that the route is missing.
    return null;
  }

  if (method === "GET" && pathname === "/api/messaging/platforms") {
    return { status: 200, body: { platforms: [] } };
  }

  if (method === "GET" && pathname.startsWith("/api/profiles")) {
    // /api/profiles — ProfilesResponse: { profiles: ProfileInfo[] }
    if (pathname === "/api/profiles") {
      return { status: 200, body: { profiles: [] } };
    }
    // /api/profiles/:name/soul — { content: string; exists: boolean }
    if (pathname.endsWith("/soul")) {
      return { status: 200, body: { content: "", exists: false } };
    }
    // /api/profiles/:name/setup-command — { command: string }. Switchroom has
    // no shell-launchable profiles, so the command is empty; the key must
    // still be present and a string (upstream returns a bare `string`,
    // hermes_cli/web_routers/profiles.py:779-781).
    if (pathname.endsWith("/setup-command")) {
      return { status: 200, body: { command: "" } };
    }
    // Everything else under /api/profiles is unimplemented — 404 rather than a
    // fabricated 200 the client cannot distinguish from a real answer.
    return null;
  }

  // GET /api/fs/default-cwd — remote mode cwd seeding (caught by caller)
  if (method === "GET" && pathname === "/api/fs/default-cwd") {
    return { status: 200, body: { cwd: null, branch: null } };
  }

  // GET /api/env — API keys / env-var panel; no agent env vars to surface
  if (method === "GET" && pathname === "/api/env") {
    return { status: 200, body: {} };
  }

  // POST /api/providers/validate — credential check; switchroom has no API keys
  if (method === "POST" && pathname === "/api/providers/validate") {
    return { status: 200, body: { ok: true, model: null } };
  }

  // GET /api/auth/providers — the login-bootstrap provider list
  // (hermes_cli/dashboard_auth/routes.py:152). NOT dead weight: Hermes
  // Desktop's *main* process probes it — `gatewayAuthProviders`
  // (apps/desktop/electron/main.ts:4954) and `probeRemoteAuthMode`
  // (:7590) — to label the sign-in button and to tell a password provider
  // from an OAuth one. Both read `body.providers` and both treat a failure as
  // "keep the strict guard", so switchroom's token-auth gateway answering an
  // empty list is the correct signal.
  if (method === "GET" && pathname === "/api/auth/providers") {
    return { status: 200, body: { providers: [] } };
  }

  // GET /api/model/options — model picker list (ModelOptionsResponse)
  if (method === "GET" && pathname.startsWith("/api/model/options")) {
    return { status: 200, body: switchroomModelOptions(config) };
  }

  // POST /api/model/set — model selection (accept silently; agent model is set per-session via config.set RPC)
  if (method === "POST" && pathname === "/api/model/set") {
    return { status: 200, body: { ok: true } };
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
  /** Stop function for the history.db background poller — called on session change or close. */
  stopHistoryPoll?: () => void;
  /**
   * Pending prompt_keys, keyed by session_id. Each entry is the prompt_key from
   * the most recent prompt.submit for that session that hasn't yet been resolved
   * by a message.complete. The per-session history poller claims only its own
   * session's key for the first new assistant message, so a submit to a
   * non-activated session — or two rapid submits to different sessions — can't
   * cross-claim each other's spinner in Hermes. Lazily initialised.
   */
  pendingPromptKeys?: Map<string, string>;
}

/** Get-or-create the per-session pending-prompt-key map on a WS context. */
export function pendingPromptKeys(ctx: HermesWsContext): Map<string, string> {
  return (ctx.pendingPromptKeys ??= new Map<string, string>());
}

/**
 * Resolve the prompt_key for a freshly-observed assistant reply on `sessionId`.
 * If that session has a pending prompt.submit, claim (and consume) its key so
 * Hermes resolves the correct spinner; the caller must NOT emit a message.start
 * in that case (Hermes already showed one at submit time). Otherwise synthesise
 * a fresh `tg-<rowid>` key for a Telegram-originated reply and signal that a
 * message.start is needed.
 *
 * Keying by sessionId is the isolation guarantee: a pending submit on session B
 * never gets claimed by session A's reply, and two rapid submits to different
 * sessions can't cross-claim. Exported for unit testing.
 */
export function claimPromptKey(
  ctx: HermesWsContext,
  sessionId: string,
  rowid: number,
): { promptKey: string; needsStart: boolean } {
  const keys = pendingPromptKeys(ctx);
  const pending = keys.get(sessionId);
  if (pending !== undefined) {
    keys.delete(sessionId);
    return { promptKey: pending, needsStart: false };
  }
  return { promptKey: `tg-${rowid}`, needsStart: true };
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

/** Called on WS close — clears all poll timers. */
export function onHermesClose(ctx: HermesWsContext) {
  if (ctx.pollInterval) {
    clearInterval(ctx.pollInterval);
    ctx.pollInterval = undefined;
  }
  ctx.stopHistoryPoll?.();
  ctx.stopHistoryPoll = undefined;
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
      const sessions = await buildAllSessions(config);
      sendResponse(ctx, rpcOk(id, { sessions }));
      break;
    }

    case "session.most_recent": {
      // Upstream returns the bare id — `{"session_id": <id|null>}`, with null
      // meaning "no eligible session right now"
      // (tui_gateway/methods_session.py:214-235). Returning `{session}` here
      // meant no caller ever found the id it destructures.
      const sessions = await buildAllSessions(config);
      sendResponse(ctx, rpcOk(id, { session_id: sessions[0]?.id ?? null }));
      break;
    }

    case "session.status": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      const { agentName } = parseHermesSessionId(sessionId);
      const agents = await handleGetAgents(config);
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      sendResponse(ctx, rpcOk(id, { session: toHermesSession(sessionId, agent, agentLiveness(config, agentName), config) }));
      break;
    }

    case "session.create":
    case "session.resume":
    case "session.activate": {
      // Map to an existing agent — Switchroom agents are always live.
      // session.create from Hermes v0.17+ may omit session_id (profile-based new-chat
      // flow); fall back to the active session on this WS connection, then the most
      // recently active agent.
      let sessionId = String(params.session_id ?? params.name ?? "");
      if (!sessionId && ctx.activeSessionId) sessionId = ctx.activeSessionId;
      if (!sessionId) {
        const all = await handleGetAgents(config);
        const latest = all.sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0))[0];
        if (latest) sessionId = latest.name;
      }
      if (!isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      ctx.activeSessionId = sessionId;
      const { agentName } = parseHermesSessionId(sessionId);
      const agents = await handleGetAgents(config);
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      const session = toHermesSession(sessionId, agent, agentLiveness(config, agentName), config);
      // Hermes reads `v.session_id` (and optionally `v.stored_session_id`) directly from
      // the response — NOT `v.session.id`. Return the flat shape; the full session object
      // arrives via the session.info event below.
      sendResponse(ctx, rpcOk(id, { session_id: sessionId, stored_session_id: sessionId }));
      sendEvent(ctx, "session.info", sessionId, session);
      // Start background poll so Telegram replies appear in Hermes in real time.
      ctx.stopHistoryPoll?.();
      ctx.stopHistoryPoll = startHistoryPoll(ctx, resolveAgentsDir(config), agentName, sessionId);
      break;
    }

    case "session.close": {
      ctx.stopHistoryPoll?.();
      ctx.stopHistoryPoll = undefined;
      ctx.activeSessionId = undefined;
      sendResponse(ctx, rpcOk(id, { ok: true }));
      break;
    }

    case "session.history": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const { agentName: histAgent } = parseHermesSessionId(sessionId);
      const agentsDir = resolveAgentsDir(config);
      const histMessages = readHistoryDb(agentsDir, histAgent, limit);
      // `count` is part of the upstream result — `{"count", "messages"}`,
      // tui_gateway/methods_session.py:2456-2462.
      if (histMessages !== null) {
        sendResponse(
          ctx,
          rpcOk(id, { session_id: sessionId, count: histMessages.length, messages: histMessages }),
        );
      } else {
        // Fall back to turns preview if history.db is unavailable
        const result = handleGetTurns(config, sessionId, Math.min(limit, 200));
        const messages = turnsToMessages(result.turns ?? []);
        sendResponse(ctx, rpcOk(id, { session_id: sessionId, count: messages.length, messages }));
      }
      break;
    }

    case "session.usage": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      // Metadata only — no token values egress.
      const { agentName: usageAgentName } = parseHermesSessionId(sessionId);
      const agents = await handleGetAgents(config);
      const agent = agents.find((a) => a.name === usageAgentName);
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

      if (!sessionId || !isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      if (!content) {
        sendResponse(ctx, rpcErr(id, -32602, "content is required"));
        break;
      }

      const { agentName: submitAgent } = parseHermesSessionId(sessionId);
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
      // Record so the history poller uses this key when the agent's reply lands.
      // Keyed by sessionId so a submit to another session can't cross-claim it.
      pendingPromptKeys(ctx).set(sessionId, promptKey);

      const result = await injectInbound(agentsDir, submitAgent, chat.chatId, chat.threadId, content, promptKey);
      if (!result.ok) {
        pendingPromptKeys(ctx).delete(sessionId);
        sendEvent(ctx, "error", sessionId, { message: result.error, prompt_key: promptKey });
        sendResponse(ctx, rpcErr(id, -32603, result.error ?? "inject failed"));
        break;
      }

      // Prompt accepted. The history poller (started at session.activate) will emit
      // message.complete with this prompt_key when the agent's reply appears in history.db.
      sendResponse(ctx, rpcOk(id, { ok: true, prompt_key: promptKey }));
      break;
    }

    case "session.interrupt": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      if (!sessionId || !isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      // Interrupt is implemented by injecting the operator's `/interrupt`
      // command through the same synthesized-inbound path. The gateway
      // handles the `!interrupt` / `/interrupt` verb.
      const { agentName: intAgent } = parseHermesSessionId(sessionId);
      const agentsDir = resolveAgentsDir(config);
      const chat = resolveAgentChat(config, sessionId, agentsDir);
      if (!chat) {
        sendResponse(ctx, rpcErr(id, -32603, `Cannot resolve chat for ${sessionId}`));
        break;
      }
      const promptKey = `interrupt-${Date.now()}`;
      const intResult = await injectInbound(agentsDir, intAgent, chat.chatId, chat.threadId, "! ", promptKey);
      if (!intResult.ok) {
        sendResponse(ctx, rpcErr(id, -32603, intResult.error ?? "interrupt inject failed"));
        break;
      }
      sendResponse(ctx, rpcOk(id, { ok: true }));
      break;
    }

    case "pet.info":
    case "pet.info.meta":
    case "pet.gallery": {
      // Hermes "pet" companion feature — not supported by Switchroom; signal disabled
      // so Hermes stops retrying instead of looping on -32601.
      sendResponse(ctx, rpcOk(id, { enabled: false }));
      break;
    }

    case "setup.status": {
      // Switchroom always has a provider configured (subscription-funded claude CLI).
      sendResponse(ctx, rpcOk(id, { provider_configured: true }));
      break;
    }

    case "setup.runtime_check": {
      // The runtime is always ready — claude runs inside each agent container.
      sendResponse(ctx, rpcOk(id, { ok: true }));
      break;
    }

    case "model.options": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      const agentName = sessionId ? parseHermesSessionId(sessionId).agentName : undefined;
      sendResponse(ctx, rpcOk(id, switchroomModelOptions(config, agentName)));
      break;
    }

    case "model.info": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      const agentName = sessionId ? parseHermesSessionId(sessionId).agentName : undefined;
      sendResponse(ctx, rpcOk(id, { model: configuredModel(config, agentName), provider: "switchroom" }));
      break;
    }

    // config.set — model switch from the composer model picker:
    // value is "model --provider provider". Inject /model <model> into the agent.
    case "config.set": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      const key = String(params.key ?? "");
      const value = String(params.value ?? "");

      if (key === "model" && sessionId && isKnownSession(config, sessionId)) {
        // Extract model name from "claude-sonnet-5 --provider switchroom"
        const modelName = value.replace(/\s+--provider\s+\S+$/, "").trim();
        if (modelName) {
          const agentsDir = resolveAgentsDir(config);
          const chat = resolveAgentChat(config, sessionId, agentsDir);
          if (chat) {
            const promptKey = `model-switch-${Date.now()}`;
            const { agentName: modelAgent } = parseHermesSessionId(sessionId);
            void injectInbound(agentsDir, modelAgent, chat.chatId, chat.threadId, `/model ${modelName}`, promptKey);
          }
        }
      }
      sendResponse(ctx, rpcOk(id, { ok: true }));
      break;
    }

    // commands.catalog — slash palette autocomplete list
    case "commands.catalog": {
      sendResponse(ctx, rpcOk(id, switchroomCommandsCatalog()));
      break;
    }

    // slash.exec — run a slash command against the agent.
    //
    // Two-path routing based on the inject allowlist:
    //
    //   REPL commands (INJECT_ALLOWLIST: /memory, /status, /usage, /clear,
    //   /compact, /model, /hooks, /cost) — go through injectSlashCommand
    //   (tmux send-keys). These are Claude Code REPL commands; injectInbound
    //   would deliver them as conversation text, not execute them.
    //
    //   Non-REPL commands (/vault, /auth, /doctor, /whoami, /logs, /version,
    //   /commands, etc.) — go through injectInbound as a synthesized user turn.
    //   Claude receives the string as conversation text (not a bot.command
    //   dispatch) and handles it via MCP tools and training knowledge.
    //   NOTE: /restart and /new must NOT be placed in the catalog — they need
    //   the grammy bot.command handler path (hostd + restart-marker protocol)
    //   which only fires on real Telegram messages.
    //
    // Explicitly blocked REPL commands (/effort, /login, /logout, /exit, /quit)
    // are refused with a clear error.
    case "slash.exec": {
      const sessionId = String(params.session_id ?? ctx.activeSessionId ?? "");
      const bare = String(params.command ?? "").replace(/^\/+/, "");
      const arg = params.arg != null ? String(params.arg) : "";

      if (!sessionId || !isKnownSession(config, sessionId)) {
        sendResponse(ctx, rpcErr(id, -32602, `Unknown session: ${sessionId}`));
        break;
      }
      if (!bare) {
        sendResponse(ctx, rpcErr(id, -32602, "command is required"));
        break;
      }

      const { agentName: slashAgent } = parseHermesSessionId(sessionId);
      const fullCommand = arg ? `/${bare} ${arg}` : `/${bare}`;
      const verb = `/${bare}` as `/${string}`;

      if (INJECT_BLOCKLIST.has(verb)) {
        sendResponse(ctx, rpcErr(id, -32602, `/${bare} cannot be executed remotely`));
        break;
      }

      if (INJECT_ALLOWLIST.has(verb)) {
        // REPL command — tmux send-keys path captures real output
        let injectResult;
        try {
          injectResult = await injectSlashCommand(slashAgent, fullCommand);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendResponse(ctx, rpcErr(id, -32603, msg));
          break;
        }
        // #3116: `skipped` means an opt-in write-time precondition aborted the
        // send — no keys were sent, so do NOT claim it was "sent". No hermes
        // caller opts in today (unreachable), but report honestly if one does.
        const output =
          injectResult.outcome === "ok"
            ? injectResult.output ?? ""
            : injectResult.outcome === "skipped"
              ? `*(${fullCommand} skipped — precondition not met)*`
              : `*(${fullCommand} sent)*`;
        sendResponse(ctx, rpcOk(id, { ok: true, output }));
        break;
      }

      // Non-REPL command — deliver via injectInbound as a synthesized user turn.
      // Claude receives the command string as conversation text (not a bot.command
      // dispatch). For commands like /vault, /auth, /doctor, /whoami Claude can
      // handle them via its MCP tools and knowledge, producing a contextual
      // response that arrives as a Telegram message. The response is async and
      // not captured here. Commands that require grammy bot.command handlers
      // (notably /restart and /new) must not be placed in the catalog.
      const agentsDir = resolveAgentsDir(config);
      const chat = resolveAgentChat(config, sessionId, agentsDir);
      if (!chat) {
        sendResponse(ctx, rpcErr(id, -32603, `Cannot resolve chat for ${sessionId}`));
        break;
      }

      const promptKey = `slash-${bare}-${Date.now()}`;
      const result = await injectInbound(agentsDir, slashAgent, chat.chatId, chat.threadId, fullCommand, promptKey);
      if (!result.ok) {
        sendResponse(ctx, rpcErr(id, -32603, result.error ?? "inject failed"));
        break;
      }
      sendResponse(ctx, rpcOk(id, { ok: true, output: `*(${fullCommand} sent to ${sessionId})*` }));
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
