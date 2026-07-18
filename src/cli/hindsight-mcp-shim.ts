/**
 * `switchroom hindsight-mcp-shim` — lazy-connect stdio MCP proxy for the
 * Hindsight memory backend.
 *
 * ## Why this exists (#hindsight-startup-resilience)
 *
 * Hindsight exposes MCP over Streamable HTTP only (127.0.0.1:18888/mcp/),
 * and upstream explicitly leaves client resilience to clients. Claude Code
 * retries a failed MCP handshake ~3x at session start and then marks the
 * server FAILED for the entire session — a manual `/mcp` reconnect is the
 * only recovery. So if the hindsight container is down (or still booting)
 * at the moment an agent session starts, the agent loses its entire memory
 * tool surface for the whole session, even after the backend comes back.
 *
 * This shim converts that hard startup dependency into a soft per-call one:
 *
 *   - It is spawned as a stdio MCP server (`command` entry in .mcp.json),
 *     and it ALWAYS completes the stdio `initialize` handshake itself,
 *     immediately, without touching the backend. Registration can never
 *     fail at session start.
 *   - `tools/list` tries a live fetch from the backend (short timeout);
 *     on success the manifest is cached to disk, on failure the cached
 *     manifest is served (or a static built-in fallback on first boot).
 *   - `tools/call` lazily opens/reuses a Streamable HTTP session per call
 *     with a bounded timeout + one retry; when the backend is down it
 *     returns a proper `isError: true` tool result telling the agent that
 *     memory is temporarily unavailable — never a shim crash, never a
 *     session-wide failure. The next call after the backend recovers goes
 *     straight through.
 *   - Everything else (ping, prompts/*, resources/*, unknown methods) is
 *     forwarded transparently when the backend is up, and answered with a
 *     JSON-RPC error when it is down.
 *
 * Escape hatch: `memory.config.mcp_transport: "http"` in switchroom.yaml
 * reverts the scaffolded entry to the old direct `type: "http"` form (see
 * generateHindsightMcpConfig in src/memory/hindsight.ts).
 *
 * The shim is a hidden CLI verb, wired as the `hindsight` MCP `command`
 * inside agent containers (spawned by Claude Code, sanitized env — all
 * inputs are threaded via the entry's `env` block):
 *
 *   HINDSIGHT_MCP_URL         backend Streamable HTTP endpoint
 *   HINDSIGHT_BANK_ID         X-Bank-Id header value (agent's collection)
 *   HINDSIGHT_SHIM_CACHE_DIR  where the cached tools/list manifest lives
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Command } from "commander";

import { HINDSIGHT_DEFAULT_MCP_URL } from "../setup/hindsight.js";

// ─── Protocol constants ───────────────────────────────────────────────────

/**
 * Protocol versions the shim itself understands, newest first. On
 * `initialize` the shim echoes the client's requested version when it is
 * one of these, else answers with the newest — the standard MCP
 * version-negotiation rule. The backend's own negotiation happens
 * independently on the lazy upstream session; the shim only ever forwards
 * method payloads that are stable across these revisions (tools/list,
 * tools/call, ping), so the two negotiations never need to agree.
 */
export const SHIM_SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/** Timeout for the live tools/list fetch before falling back to cache. */
export const TOOLS_LIST_TIMEOUT_MS = 3_000;

/**
 * Per-attempt timeout for tools/call forwarding. Generous because reflect /
 * consolidation-adjacent tools do real LLM work upstream; bounded so a
 * wedged backend can never hang the agent's tool call forever.
 */
export const TOOLS_CALL_TIMEOUT_MS = 120_000;

/** Timeout for the upstream initialize/initialized handshake. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 3_000;

/** Cached-manifest filename inside the cache dir. */
export const TOOLS_CACHE_FILENAME = "hindsight-tools-list.json";

// ─── Static fallback manifest ─────────────────────────────────────────────

/**
 * First-boot fallback tool manifest: tool name -> [required, allProps].
 * Derived from tests/fixtures/hindsight-tools-list.snapshot.json (captured
 * live from hindsight on 2026-06-07; upstream's tool surface is stable).
 * Schemas are deliberately permissive ({} per property) — the point is
 * that the tools EXIST at session start; the first successful live
 * tools/list replaces this with the backend's real schemas via the disk
 * cache. tests/hindsight-mcp-shim.fallback.test.ts pins this table against
 * the snapshot fixture so the two can never drift silently.
 */
export const FALLBACK_TOOL_TABLE: Record<string, [string[], string[]]> = {
  cancel_operation: [["operation_id"], ["bank_id", "operation_id"]],
  clear_memories: [[], ["bank_id", "type"]],
  create_bank: [["bank_id"], ["bank_id", "mission", "name"]],
  create_directive: [["content", "name"], ["bank_id", "content", "is_active", "name", "priority", "tags"]],
  create_mental_model: [["name", "source_query"], ["bank_id", "max_tokens", "mental_model_id", "name", "source_query", "tags", "trigger_refresh_after_consolidation"]],
  delete_bank: [[], ["bank_id"]],
  delete_directive: [["directive_id"], ["bank_id", "directive_id"]],
  delete_document: [["document_id"], ["bank_id", "document_id"]],
  delete_mental_model: [["mental_model_id"], ["bank_id", "mental_model_id"]],
  get_bank: [[], ["bank_id"]],
  get_bank_stats: [[], ["bank_id"]],
  get_document: [["document_id"], ["bank_id", "document_id"]],
  get_memory: [["memory_id"], ["bank_id", "memory_id"]],
  get_mental_model: [["mental_model_id"], ["bank_id", "detail", "mental_model_id"]],
  get_operation: [["operation_id"], ["bank_id", "operation_id"]],
  list_banks: [[], []],
  list_directives: [[], ["active_only", "bank_id", "tags"]],
  list_documents: [[], ["bank_id", "limit", "q"]],
  list_memories: [[], ["bank_id", "limit", "offset", "q", "type"]],
  list_mental_models: [[], ["bank_id", "detail", "tags"]],
  list_operations: [[], ["bank_id", "limit", "status"]],
  list_tags: [[], ["bank_id", "limit", "q"]],
  recall: [["query"], ["bank_id", "budget", "max_tokens", "query", "query_timestamp", "tag_groups", "tags", "tags_match", "types"]],
  reflect: [["query"], ["bank_id", "budget", "context", "max_tokens", "query", "response_schema", "tags", "tags_match"]],
  refresh_mental_model: [["mental_model_id"], ["bank_id", "mental_model_id"]],
  retain: [["content"], ["bank_id", "content", "context", "document_id", "metadata", "strategy", "tags", "timestamp", "update_mode"]],
  sync_retain: [["content"], ["bank_id", "content", "context", "document_id", "metadata", "strategy", "tags", "timestamp"]],
  update_bank: [[], ["bank_id", "config_updates", "mission", "name"]],
  update_mental_model: [["mental_model_id"], ["bank_id", "max_tokens", "mental_model_id", "name", "source_query", "tags", "trigger_refresh_after_consolidation"]],
};

/** Materialize the static fallback manifest in MCP tools/list shape. */
export function buildFallbackToolsList(): { tools: ToolDef[] } {
  const tools = Object.entries(FALLBACK_TOOL_TABLE).map(
    ([name, [required, props]]) => ({
      name,
      description:
        "Hindsight memory tool (served from the shim's static fallback " +
        "manifest because the backend has not been reachable yet; the " +
        "schema is permissive and will be replaced by the live one).",
      inputSchema: {
        type: "object" as const,
        properties: Object.fromEntries(props.map((p) => [p, {}])),
        required,
      },
    }),
  );
  return { tools };
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
  [k: string]: unknown;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ShimOptions {
  /** Backend Streamable HTTP endpoint (e.g. http://127.0.0.1:18888/mcp/). */
  url: string;
  /** X-Bank-Id header threaded onto every backend request (may be ""). */
  bankId: string;
  /** Directory for the persisted tools/list cache. Created on demand. */
  cacheDir: string;
  /** Test seams — timeouts in ms. */
  toolsListTimeoutMs?: number;
  toolsCallTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Where diagnostics go. Defaults to process.stderr. */
  logger?: (line: string) => void;
}

// ─── Upstream Streamable HTTP client ──────────────────────────────────────

/**
 * Minimal Streamable HTTP MCP client for the hindsight backend.
 *
 * Lazy: nothing is sent until the first request needs a session. On any
 * transport failure the session is dropped so the next call re-handshakes
 * — that's the whole recovery model (per-call reconnect).
 */
export class UpstreamClient {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;

  constructor(private readonly opts: ShimOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /** Drop the session so the next request re-initializes. */
  reset(): void {
    this.sessionId = null;
    this.protocolVersion = null;
  }

  get connected(): boolean {
    return this.sessionId !== null || this.protocolVersion !== null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.opts.bankId) h["X-Bank-Id"] = this.opts.bankId;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    return h;
  }

  private async post(
    body: JsonRpcMessage,
    timeoutMs: number,
  ): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse a Streamable HTTP response body into the JSON-RPC response for
   * `id`. Handles both `application/json` and `text/event-stream` bodies
   * (hindsight answers POSTs with SSE-framed single responses).
   */
  private async parseResponse(
    res: Response,
    id: number,
  ): Promise<JsonRpcMessage> {
    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ctype.includes("text/event-stream")) {
      // SSE frames: take each `data:` payload, find the response with our id.
      for (const chunk of text.split(/\n\n/)) {
        const data = chunk
          .split(/\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as JsonRpcMessage;
          if (msg.id === id) return msg;
        } catch {
          // non-JSON keepalive frame — skip
        }
      }
      throw new Error("no matching JSON-RPC response in SSE stream");
    }
    return JSON.parse(text) as JsonRpcMessage;
  }

  /** Ensure an initialized upstream session exists. Throws on failure. */
  private async ensureSession(): Promise<void> {
    if (this.protocolVersion) return;
    const timeoutMs = this.opts.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
    const id = this.nextId++;
    const res = await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: SHIM_SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: {},
          clientInfo: { name: "switchroom-hindsight-shim", version: "1.0.0" },
        },
      },
      timeoutMs,
    );
    if (!res.ok) {
      throw new Error(`upstream initialize failed: HTTP ${res.status}`);
    }
    this.sessionId = res.headers.get("mcp-session-id");
    const msg = await this.parseResponse(res, id);
    if (msg.error) {
      throw new Error(`upstream initialize error: ${msg.error.message}`);
    }
    const negotiated = (msg.result as { protocolVersion?: string } | undefined)
      ?.protocolVersion;
    this.protocolVersion = negotiated ?? SHIM_SUPPORTED_PROTOCOL_VERSIONS[0];
    // notifications/initialized completes the upstream handshake. 202 (or
    // any 2xx) expected; failure here is fatal for the session attempt.
    const notifRes = await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      timeoutMs,
    );
    if (!notifRes.ok && notifRes.status !== 405) {
      throw new Error(`upstream initialized notification failed: HTTP ${notifRes.status}`);
    }
    // Drain body so undici can reuse the socket.
    await notifRes.text().catch(() => undefined);
  }

  /**
   * Forward one request to the backend. Lazy-connects, and on transport
   * failure resets the session and (when `retry`) re-attempts exactly once
   * — covering both cold backends that just came up and expired upstream
   * sessions (hindsight answers those with 404).
   */
  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    retry = true,
  ): Promise<JsonRpcMessage> {
    try {
      await this.ensureSession();
      const id = this.nextId++;
      const res = await this.post(
        { jsonrpc: "2.0", id, method, params },
        timeoutMs,
      );
      if (res.status === 404) {
        // Session expired upstream — retry with a fresh one.
        throw new Error("upstream session expired (404)");
      }
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      return await this.parseResponse(res, id);
    } catch (err) {
      this.reset();
      if (retry) return this.request(method, params, timeoutMs, false);
      throw err;
    }
  }
}

// ─── The shim server ──────────────────────────────────────────────────────

export class HindsightShim {
  readonly upstream: UpstreamClient;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ShimOptions) {
    this.upstream = new UpstreamClient(opts);
    this.log = opts.logger ?? ((l) => process.stderr.write(l + "\n"));
  }

  private get cachePath(): string {
    return join(this.opts.cacheDir, TOOLS_CACHE_FILENAME);
  }

  /** Persist a successful tools/list result (atomic tmp+rename). */
  private writeCache(result: unknown): void {
    try {
      mkdirSync(this.opts.cacheDir, { recursive: true });
      const tmp = join(
        this.opts.cacheDir,
        `.${TOOLS_CACHE_FILENAME}.${process.pid}.tmp`,
      );
      writeFileSync(tmp, JSON.stringify(result, null, 2) + "\n");
      renameSync(tmp, this.cachePath);
    } catch (err) {
      this.log(`[hindsight-shim] cache write failed: ${String(err)}`);
    }
  }

  private readCache(): { tools: ToolDef[] } | null {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf-8")) as {
        tools?: ToolDef[];
      };
      if (Array.isArray(parsed.tools)) return parsed as { tools: ToolDef[] };
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Handle one client JSON-RPC message; returns the response to write, or
   * null for notifications (which never get responses).
   */
  async handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const { id, method } = msg;
    if (method === undefined) return null; // response from client — ignore

    // Notifications: initialized is consumed; others are forwarded
    // best-effort only when a session already exists (a notification must
    // never trigger a connect attempt, and failures are swallowed).
    if (id === undefined || id === null) {
      if (method !== "notifications/initialized" && this.upstream.connected) {
        this.upstream
          .request(method, msg.params, this.opts.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS, false)
          .catch(() => undefined);
      }
      return null;
    }

    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: this.initializeResult(msg.params) };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: await this.toolsList(msg.params) };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await this.toolsCall(msg.params) };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return this.forward(msg);
    }
  }

  /**
   * Answer `initialize` locally — NEVER touches the backend, so the stdio
   * handshake always succeeds regardless of backend state. Capabilities
   * advertise the backend's known surface (tools, with listChanged so a
   * client could re-list after recovery).
   */
  private initializeResult(params: unknown): unknown {
    const requested = (params as { protocolVersion?: string } | undefined)
      ?.protocolVersion;
    const version =
      requested && SHIM_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SHIM_SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "switchroom-hindsight-shim", version: "1.0.0" },
    };
  }

  /** tools/list: live fetch -> refresh cache; else cache; else fallback. */
  private async toolsList(params: unknown): Promise<unknown> {
    try {
      const res = await this.upstream.request(
        "tools/list",
        params ?? {},
        this.opts.toolsListTimeoutMs ?? TOOLS_LIST_TIMEOUT_MS,
      );
      if (res.error) throw new Error(res.error.message);
      const result = res.result as { tools?: ToolDef[] };
      if (Array.isArray(result?.tools)) {
        this.writeCache(result);
        return result;
      }
      throw new Error("upstream tools/list returned no tools array");
    } catch (err) {
      this.log(
        `[hindsight-shim] live tools/list failed (${String(err)}); serving ` +
          "cached/fallback manifest",
      );
      return this.readCache() ?? buildFallbackToolsList();
    }
  }

  /** tools/call: lazy connect + bounded timeout + one retry; isError on down. */
  private async toolsCall(params: unknown): Promise<unknown> {
    try {
      const res = await this.upstream.request(
        "tools/call",
        params,
        this.opts.toolsCallTimeoutMs ?? TOOLS_CALL_TIMEOUT_MS,
      );
      if (res.error) {
        // Upstream answered with a protocol-level error while up (e.g.
        // unknown tool). Surface it as a tool error result rather than
        // crashing the shim or hiding the message.
        return {
          content: [
            { type: "text", text: `Hindsight returned an error: ${res.error.message}` },
          ],
          isError: true,
        };
      }
      return res.result;
    } catch (err) {
      const name =
        (params as { name?: string } | undefined)?.name ?? "unknown";
      this.log(
        `[hindsight-shim] tools/call ${name} failed after retry: ${String(err)}`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              "Hindsight memory is temporarily unavailable (backend at " +
              `${this.opts.url} is not reachable: ${String(err)}). ` +
              "This is transient - the shim reconnects automatically, so " +
              "simply retry this tool call shortly. Do not treat memory " +
              "as permanently lost.",
          },
        ],
        isError: true,
      };
    }
  }

  /** Transparent forwarding for every other request method. */
  private async forward(msg: JsonRpcMessage): Promise<JsonRpcMessage> {
    try {
      const res = await this.upstream.request(
        msg.method as string,
        msg.params,
        this.opts.toolsListTimeoutMs ?? TOOLS_LIST_TIMEOUT_MS,
      );
      return { jsonrpc: "2.0", id: msg.id, result: res.result, ...(res.error ? { error: res.error } : {}) };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32001,
          message: `hindsight backend unavailable: ${String(err)}`,
        },
      };
    }
  }

  /**
   * Wire the shim to stdio: newline-delimited JSON-RPC, serialized writes.
   * Resolves after the input stream ends AND every in-flight handler has
   * flushed its response — callers must not exit before then (caught live:
   * exiting on raw stdin "end" raced the async tools/list handler and
   * dropped its response).
   */
  async run(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let chain: Promise<void> = Promise.resolve();
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        this.log(`[hindsight-shim] dropping non-JSON stdin line`);
        return;
      }
      // Serialize responses so concurrent handling can never interleave
      // partial writes on stdout.
      chain = chain.then(async () => {
        try {
          const res = await this.handle(msg);
          if (res) output.write(JSON.stringify(res) + "\n");
        } catch (err) {
          // Absolute last-resort guard: the shim must never crash.
          this.log(`[hindsight-shim] handler threw: ${String(err)}`);
          if (msg.id !== undefined && msg.id !== null) {
            output.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32603, message: `shim internal error: ${String(err)}` },
              }) + "\n",
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => rl.on("close", resolve));
    await chain;
  }
}

// ─── CLI wiring ───────────────────────────────────────────────────────────

/** Resolve shim options from the sanitized MCP-spawn env. */
export function resolveShimOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): ShimOptions {
  const home = env.HOME && env.HOME !== "/" ? env.HOME : tmpdir();
  return {
    url: env.HINDSIGHT_MCP_URL || HINDSIGHT_DEFAULT_MCP_URL,
    bankId: env.HINDSIGHT_BANK_ID || "",
    cacheDir:
      env.HINDSIGHT_SHIM_CACHE_DIR || join(home, ".hindsight-shim"),
  };
}

export function registerHindsightMcpShimCommand(program: Command): void {
  program
    .command("hindsight-mcp-shim", { hidden: true })
    .description(
      "Internal: lazy-connect stdio MCP proxy for the Hindsight memory " +
        "backend. Spawned as the `hindsight` MCP command inside agents.",
    )
    .action(async () => {
      const shim = new HindsightShim(resolveShimOptionsFromEnv(process.env));
      // Resolves when Claude Code closes stdin (session teardown) and all
      // in-flight responses have been written.
      await shim.run(process.stdin, process.stdout);
      process.exit(0);
    });
}
