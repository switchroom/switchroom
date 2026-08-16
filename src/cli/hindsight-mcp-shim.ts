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
 * ## The one place the shim is not a pure proxy (#directive-retirement)
 *
 * It also SYNTHESIZES tools that no backend version registers (see
 * {@link SYNTHESIZED_TOOL_TABLE}), answered locally over REST against the base
 * derived from `HINDSIGHT_MCP_URL`, with the bank pinned to
 * `HINDSIGHT_BANK_ID`, and never forwarded upstream:
 *
 *   - `deactivate_directive` / `reactivate_directive` — hindsight's MCP
 *     surface can create, list and delete a directive but cannot flip
 *     `is_active`; only the REST API can, so without this the only retirement
 *     path was hand-rolled curl. Backed by {@link DirectiveAdmin}.
 *   - `search_knowledge_pages` / `get_knowledge_page` / `get_knowledge_tree` —
 *     hindsight 0.9.0 serves a full Knowledge Base REST surface and registers
 *     no knowledge MCP tools at all, so an agent's own curated pages were
 *     unreachable from a tool call. Backed by {@link KnowledgeAdmin}, which is
 *     GET-only: page authorship and deletion stay off this surface entirely.
 *
 * That pin is a usability and provenance boundary, NOT a security one — the
 * REST API is unauthenticated and raw curl bypasses the shim entirely. See the
 * header of `src/memory/hindsight-directive-admin.ts` for the full statement.
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
 *   HINDSIGHT_BANK_ID         X-Bank-Id header value (agent's collection),
 *                             and the PINNED bank for the synthesized
 *                             directive tools
 *   HINDSIGHT_SHIM_CACHE_DIR  where the cached tools/list manifest lives
 *   HINDSIGHT_SHIM_RECALL_MAX_TOKENS / HINDSIGHT_SHIM_REFLECT_MAX_TOKENS
 *                             per-tool max_tokens injected when the caller
 *                             omits it (default 1024 each; explicit wins)
 *   HINDSIGHT_SHIM_RECALL_BUDGET / HINDSIGHT_SHIM_REFLECT_BUDGET
 *                             per-tool budget injected when the caller omits
 *                             it (default recall low, reflect mid; explicit
 *                             wins; garbage falls back to the default)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Command } from "commander";

import {
  DirectiveAdmin,
  DirectivePairInconsistentError,
} from "../memory/hindsight-directive-admin.js";
import {
  KnowledgeAdmin,
  KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
  KNOWLEDGE_SEARCH_LIMIT_MAX,
  KNOWLEDGE_SEARCH_LIMIT_MIN,
  type KnowledgeNode,
} from "../memory/hindsight-knowledge-admin.js";
import { redact } from "../secret-detect/redact.js";
import { ShimContractPin } from "../memory/hindsight-shim-contract.js";
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
 * MUST mirror `tests/fixtures/hindsight-tools-list.snapshot.json` exactly:
 * `tests/memory.hindsight-contract.fixture.test.ts` asserts the tool names,
 * `required` sets and `props` sets are identical, so the two can never drift
 * silently.
 *
 * Schemas are deliberately permissive ({} per property) — the point is that
 * the tools EXIST at session start; the first successful live tools/list
 * replaces this with the backend's real schemas via the disk cache.
 *
 * WHY THE EQUALITY IS PINNED (2026-07-27, hindsight 0.8.4 audit): this table
 * was hand-copied from a 2026-06-07 capture and then never re-synced. By the
 * time the fleet ran 0.8.4 it was missing THREE whole tools —
 * `update_memory`, `invalidate_memory`, `clear_mental_model` — plus six
 * accepted props. Those are exactly the tools `switchroom memory demote` and
 * `switchroom vault-sweep` reach for, so on a first boot (or any boot where
 * hindsight is unreachable and the shim serves the fallback) the agent's
 * advertised memory surface silently omitted them. From inside the session a
 * stale fallback is indistinguishable from an upstream removal — which is the
 * exact failure mode this shim exists to prevent.
 *
 * OVER-REPORTING IS THE WORSE HALF, so this table must never run AHEAD of the
 * pinned image either. Advertising a prop the server does not accept is not a
 * harmless optimism: hindsight drops an unknown argument SILENTLY and answers
 * isError:false, so an agent that reads `list_memories.tags` off this manifest
 * and issues a tag-scoped query on 0.8.4 receives the UNFILTERED list and
 * believes it was filtered (verified live). The snapshot is therefore always a
 * capture of the PINNED image with no forward-patch, and re-capturing it is
 * part of an image bump, not a follow-up to one.
 *
 * The silent-drop hazard is not tools/LIST-only: on tools/CALL the engine
 * likewise declares `additionalProperties:false` but does NOT enforce it, so a
 * bogus arg (agents keep guessing recall `limit`) is dropped SILENTLY with
 * isError:false and the agent believes it capped results when it did not. This
 * table is now ALSO the ground truth for the tools/CALL guard: {@link
 * guardAndClampToolCall} validates every forwarded call's argument keys
 * against this union and rejects unknowns loudly, so drift here reds a test in
 * both directions AND flows straight into call-time validation — do not
 * hand-write a second accepted-prop list anywhere.
 *
 * This table now describes 0.9.0, which the image pins. The 0.8.6 → 0.9.0 bump
 * changed NOTHING here: both digests register the same 32 tools with identical
 * required/props (upstream's `mcp_tools.py`, `api/mcp.py` and
 * `extensions/mcp.py` are byte-identical between the two tags). The surface is
 * derived by dumping `create_mcp_server(...)`'s registration inside each pinned
 * digest, a method cross-validated at every bump by reproducing the committed
 * previous capture byte-for-byte before trusting the new one — done again for
 * 0.9.0. The 0.8.5 → 0.8.6 step before it added exactly one prop,
 * `reflect.apply_all_directives` (upstream #3013).
 * Advertising it is deliberate: it is a real accepted prop, and because this
 * table is also the tools/CALL allowlist, omitting it would make
 * {@link guardAndClampToolCall} REJECT a legitimate upstream argument. Byte-equality with
 * tests/fixtures/hindsight-tools-list.snapshot.json is asserted per tool in
 * tests/memory.hindsight-contract.fixture.test.ts, so this table cannot drift
 * in either direction without a red test.
 */
export const FALLBACK_TOOL_TABLE: Record<string, [string[], string[]]> = {
  cancel_operation: [["operation_id"], ["bank_id", "operation_id"]],
  clear_memories: [[], ["bank_id", "type"]],
  clear_mental_model: [["mental_model_id"], ["bank_id", "mental_model_id"]],
  create_bank: [["bank_id"], ["bank_id", "mission", "name"]],
  create_directive: [["content", "name"], ["bank_id", "content", "is_active", "name", "priority", "tags"]],
  create_mental_model: [["name", "source_query"], ["bank_id", "max_tokens", "mental_model_id", "name", "source_query", "tags", "tags_match", "trigger_refresh_after_consolidation"]],
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
  invalidate_memory: [["memory_id"], ["bank_id", "memory_id", "reason", "restore"]],
  list_banks: [[], []],
  list_directives: [[], ["active_only", "bank_id", "tags"]],
  list_documents: [[], ["bank_id", "limit", "q"]],
  list_memories: [[], ["bank_id", "limit", "offset", "q", "tags", "tags_match", "type"]],
  list_mental_models: [[], ["bank_id", "detail", "tags"]],
  list_operations: [[], ["bank_id", "limit", "status"]],
  list_tags: [[], ["bank_id", "limit", "q"]],
  recall: [["query"], ["bank_id", "budget", "max_tokens", "min_scores", "prefer_observations", "query", "query_timestamp", "tag_groups", "tags", "tags_match", "types"]],
  reflect: [["query"], ["apply_all_directives", "bank_id", "budget", "context", "include_based_on", "include_trace", "max_tokens", "query", "response_schema", "tags", "tags_match"]],
  refresh_mental_model: [["mental_model_id"], ["bank_id", "mental_model_id"]],
  retain: [["content"], ["bank_id", "content", "context", "document_id", "metadata", "strategy", "tags", "timestamp", "update_mode"]],
  sync_retain: [["content"], ["bank_id", "content", "context", "document_id", "metadata", "strategy", "tags", "timestamp"]],
  update_bank: [[], ["bank_id", "config_updates", "mission", "name"]],
  update_memory: [["memory_id"], ["bank_id", "context", "entities", "fact_type", "memory_id", "occurred_end", "occurred_start", "text"]],
  update_mental_model: [["mental_model_id"], ["bank_id", "max_tokens", "mental_model_id", "name", "source_query", "tags", "trigger_refresh_after_consolidation"]],
};

// ─── Shim-synthesized tools (the documented carve-out) ────────────────────

/**
 * Tools the SHIM implements itself and never forwards upstream.
 *
 * ## Why this does not violate "OVER-REPORTING IS THE WORSE HALF"
 *
 * Read that rule above before adding anything here. It exists because
 * hindsight drops an unknown ARGUMENT silently and answers `isError:false`, so
 * advertising a prop the server does not accept makes an agent believe a
 * filter applied when it did not. The harm is entirely a property of tools
 * whose calls are FORWARDED to the backend.
 *
 * These are not. `toolsCall()` intercepts them by name before any upstream
 * request exists and answers them locally over REST, so there is no server to
 * mis-describe and no argument that can be silently dropped: an unknown
 * argument here is rejected loudly by {@link HindsightShim.synthesizedCall}.
 * Advertising them is therefore accurate, not optimistic — the shim really
 * does provide them, backend up or down.
 *
 * What the rule DOES still bind: `FALLBACK_TOOL_TABLE` must continue to
 * describe the pinned image byte-for-byte. That is why these live in a
 * separate table rather than being added to it, and why
 * `tests/memory.hindsight-contract.fixture.test.ts` still asserts
 * `FALLBACK_TOOL_TABLE` ≡ the snapshot, plus a new assertion that these names
 * do NOT appear in the snapshot — so if a future image bump registers real
 * `deactivate_directive` / `search_knowledge_pages` / … tools, the test reds
 * and the synthesis gets retired rather than silently shadowing them.
 *
 * The knowledge tools additionally carry `type: "integer"` props. See
 * {@link coerceSynthesizedArg}: an integer prop is range-checked against its
 * own `minimum`/`maximum` here rather than forwarded, because the upstream
 * endpoint answers a 422 the calling model cannot act on.
 *
 * NOTE the deliberate absence of a `bank_id` property. The bank is pinned from
 * `HINDSIGHT_BANK_ID`; a caller cannot name one. That is a usability and
 * provenance boundary, not a security one — see
 * `src/memory/hindsight-directive-admin.ts`.
 */
export const SYNTHESIZED_TOOL_TABLE: Record<
  string,
  { description: string; required: string[]; props: Record<string, unknown> }
> = {
  deactivate_directive: {
    description:
      "Retire one of YOUR OWN standing directives by setting is_active=false, " +
      "so it stops being injected as a hard rule. Reversible with " +
      "reactivate_directive; the directive and its text are preserved. Pass " +
      "superseded_by when another directive replaces this one — both get " +
      "provenance tags recording the supersession. Operates only on your own " +
      "memory bank and changes nothing but the active flag and those tags.",
    required: ["name"],
    props: {
      name: {
        type: "string",
        description: "Exact name of the directive to deactivate.",
      },
      superseded_by: {
        type: "string",
        description:
          "Optional exact name of the directive that replaces this one. " +
          "Records 'superseded-by:<winner>' on this directive and " +
          "'supersedes:<this>' on the winner.",
      },
    },
  },
  reactivate_directive: {
    description:
      "Restore one of YOUR OWN previously deactivated directives by setting " +
      "is_active=true, so it is injected as a hard rule again. Operates only " +
      "on your own memory bank and changes nothing but the active flag.",
    required: ["name"],
    props: {
      name: {
        type: "string",
        description: "Exact name of the directive to reactivate.",
      },
    },
  },
  search_knowledge_pages: {
    description:
      "Search YOUR OWN knowledge pages — the curated, continuously-refreshed " +
      "summaries of what this bank knows — with hybrid full-text + semantic " +
      "search. Reach for this before re-deriving a standing answer from raw " +
      "recall: a page is already synthesized, where recall returns fragments. " +
      "Returns ranked hits with a relevance snippet and a page id; read the " +
      "whole page with get_knowledge_page. Read-only, and only ever your own " +
      "memory bank. An empty knowledge base returns no results, not an error.",
    required: ["query"],
    props: {
      query: {
        type: "string",
        description: "What to look for, in natural language.",
      },
      limit: {
        type: "integer",
        minimum: KNOWLEDGE_SEARCH_LIMIT_MIN,
        maximum: KNOWLEDGE_SEARCH_LIMIT_MAX,
        description:
          `Maximum hits to return (${KNOWLEDGE_SEARCH_LIMIT_MIN}-` +
          `${KNOWLEDGE_SEARCH_LIMIT_MAX}, default ${KNOWLEDGE_SEARCH_LIMIT_DEFAULT}).`,
      },
    },
  },
  get_knowledge_page: {
    description:
      "Read one of YOUR OWN knowledge pages in full, by the page id returned " +
      "by search_knowledge_pages or get_knowledge_tree. Returns the complete " +
      "markdown document (YAML frontmatter + synthesized body). Prefer this " +
      "over rebuilding the same understanding from scratch. Read-only: it " +
      "returns the page as it currently stands and never triggers a refresh.",
    required: ["page_id"],
    props: {
      page_id: {
        type: "string",
        description:
          "Id of the page to read, from search_knowledge_pages or " +
          "get_knowledge_tree.",
      },
    },
  },
  get_knowledge_tree: {
    description:
      "List YOUR OWN knowledge base as a folder/page tree — every page's id, " +
      "name, source query, tags and staleness flag. Call this to see what " +
      "this bank already knows before reading anything else; is_stale=true " +
      "means the page MAY be behind newer memories, not that it is wrong. " +
      "Read-only, and only ever your own memory bank.",
    required: [],
    props: {},
  },
};

/** Names of the shim-synthesized tools (never forwarded upstream). */
export const SYNTHESIZED_TOOL_NAMES = Object.keys(SYNTHESIZED_TOOL_TABLE);

/**
 * The ONLY string spelling of an integer `coerceSynthesizedArg` accepts.
 *
 * Deliberately narrower than `/^-?\d+$/` over a trimmed value, which took
 * `"01"`, `" 5 "` and `"50\n"`. Those are not what an MCP client's number
 * stringification produces; accepting them means accepting a value the caller
 * did not mean to send in that form, and `"01"` in particular is the shape a
 * truncated or hand-mangled argument arrives in. No surrounding whitespace, no
 * leading zeros, `0` itself allowed.
 */
const INTEGER_STRING_PATTERN = /^-?(?:0|[1-9]\d*)$/;

/**
 * Validate + coerce ONE synthesized-tool argument against its declared schema.
 *
 * Per-property, deliberately. The original rule was "every argument must be a
 * non-empty string", which was true while every declared prop was a string and
 * became a latent bug the moment one was not: a well-formed `limit: 5` would
 * have been rejected with "'limit' must be a non-empty string", and the model
 * would have had no way to satisfy the schema it was shown.
 *
 * The strictness is preserved, not relaxed:
 *   • a string prop still rejects a non-string and an empty string — silently
 *     treating `superseded_by: ""` as "no supersession" would drop provenance
 *     the caller asked for without saying so;
 *   • an integer prop rejects anything that is not an integer (or the exact
 *     decimal string of one — MCP clients routinely stringify numbers) and
 *     rejects out-of-range rather than clamping, because the bound is in the
 *     schema the model was shown and a silently-clamped `limit: 500` reads as
 *     "you got 500 hits" when it got 50.
 *
 * Exported for direct test coverage of the table's contract.
 */
export function coerceSynthesizedArg(
  toolName: string,
  key: string,
  propSchema: unknown,
  value: unknown,
): { ok: true; value: string | number } | { ok: false; text: string } {
  const schema = (propSchema ?? {}) as {
    type?: string;
    minimum?: number;
    maximum?: number;
  };
  if (schema.type !== "integer") {
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        text: `${toolName}: '${key}' must be a non-empty string.`,
      };
    }
    return { ok: true, value };
  }
  const min = schema.minimum;
  const max = schema.maximum;
  const range =
    min !== undefined && max !== undefined ? ` between ${min} and ${max}` : "";
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && INTEGER_STRING_PATTERN.test(value)) {
    n = Number(value);
  } else {
    return {
      ok: false,
      text: `${toolName}: '${key}' must be an integer${range}.`,
    };
  }
  if (!Number.isSafeInteger(n)) {
    return {
      ok: false,
      text: `${toolName}: '${key}' must be an integer${range}.`,
    };
  }
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    return {
      ok: false,
      text:
        `${toolName}: '${key}' must be an integer${range} — got ${n}. ` +
        `Re-issue the call with a value in range.`,
    };
  }
  return { ok: true, value: n };
}

/** Materialize the synthesized tools in MCP tools/list shape. */
export function buildSynthesizedToolsList(): ToolDef[] {
  return Object.entries(SYNTHESIZED_TOOL_TABLE).map(
    ([name, { description, required, props }]) => ({
      name,
      description,
      inputSchema: {
        type: "object" as const,
        properties: props,
        required,
      },
    }),
  );
}

/**
 * Append the synthesized tools to a manifest, dropping any same-named backend
 * tool first.
 *
 * The drop is the retirement seam: if hindsight ever registers a real
 * `deactivate_directive`, the shim's bank-pinned version keeps winning at
 * runtime (so behaviour never silently widens to accept a `bank_id`) while the
 * contract test reds and forces a deliberate decision.
 */
export function withSynthesizedTools(result: { tools: ToolDef[] }): {
  tools: ToolDef[];
} {
  const synthesized = new Set(SYNTHESIZED_TOOL_NAMES);
  return {
    ...result,
    tools: [
      ...result.tools.filter((t) => !synthesized.has(t.name)),
      ...buildSynthesizedToolsList(),
    ],
  };
}

// ─── Write-path secret redaction ──────────────────────────────────────

/**
 * Tools whose arguments are a QUERY, not content to be persisted. Their
 * arguments are forwarded verbatim: masking a search string would change
 * which memories come back, for no security gain (nothing is stored).
 *
 * Everything NOT on this list is treated as a write and redacted. That
 * default is the point — when hindsight registers a new tool that
 * persists text, it is covered on the day it appears, with no change
 * here. Adding a name to this list is the deliberate, reviewable act.
 */
export const READ_ONLY_TOOL_NAMES = new Set([
  "recall",
  "reflect",
  "search",
  "list_memories",
  "list_directives",
  "list_mental_models",
  "get_mental_model",
  "get_memory",
  "get_bank",
]);

/**
 * Substring of upstream's `ReflectToolCallError` message (hindsight v0.8.6,
 * `engine/reflect/agent.py` — class at the top of the module, raised from the
 * `if not saw_tool_call` guard in the agent loop). Matched as a substring
 * because the message interpolates the provider/model and an arbitrary
 * response snippet around it.
 */
export const REFLECT_NO_TOOL_CALL_SIGNATURE = "produced no usable tool call";

/**
 * How many times the shim re-issues a `reflect` that failed with
 * `ReflectToolCallError`.
 *
 * WHY THIS IS SAFE TO RETRY POST-DELIVERY, when `Upstream.request` deliberately
 * never does (see its DOUBLE-EXECUTION GUARD): that guard exists because a
 * re-sent *write* (retain, create_directive, ...) would be applied twice. This
 * retry is scoped to `reflect` alone — a read-only synthesis with no persisted
 * side effect — and only to the one failure mode where upstream provably did
 * NOT produce an answer. Re-running it is a fresh sampling of the same query.
 *
 * WHY IT WORKS: the failure is stochastic, not deterministic. Upstream raises
 * only when the model emitted zero parseable tool calls across the WHOLE
 * trajectory; our local gpt-oss-20b ignores forced `tool_choice` and does this
 * on a minority of runs (~8% measured over the v0.8.5 baseline, n=12), so an
 * independent re-roll clears it with high probability. If the backend model
 * genuinely cannot tool-call at all, every attempt fails and the agent still
 * sees upstream's real, diagnostic error — the retry costs latency, never
 * correctness.
 *
 * Deliberately NOT applied to `refresh_mental_model` / mental-model writes,
 * which also drive the reflect agent but persist their result.
 */
export const REFLECT_TOOL_CALL_RETRIES = 2;

/**
 * True when `res` is upstream's "reflect could not tool-call" failure for a
 * `reflect` call. Handles both shapes the backend can answer with: a
 * JSON-RPC protocol error, and a tool result flagged `isError`.
 */
export function isReflectToolCallFailure(
  toolName: string | undefined,
  res: { error?: { message?: string }; result?: unknown },
): boolean {
  if (toolName !== "reflect") return false;
  const texts: string[] = [];
  if (typeof res.error?.message === "string") texts.push(res.error.message);
  const result = res.result as
    | { isError?: boolean; content?: Array<{ text?: unknown }> }
    | undefined;
  if (result?.isError && Array.isArray(result.content)) {
    for (const c of result.content) {
      if (typeof c?.text === "string") texts.push(c.text);
    }
  }
  return texts.some((t) => t.includes(REFLECT_NO_TOOL_CALL_SIGNATURE));
}

// ─── Reflect cardinality guard (RFC P9) ────────────────────────────────────

/**
 * The explicit "no relevant memories" answer the shim substitutes for a
 * `reflect` synthesis when the engine's returned evidence set is genuinely
 * empty.
 *
 * WHY A SUBSTITUTION AND NOT A PASS-THROUGH: hindsight's reflect agent always
 * emits SOME prose. On an empty retrieval that prose is a fluent-but-sourceless
 * answer — the model narrating around nothing — which reads to the calling
 * agent as a real recalled fact and is exactly the false-positive that defeats
 * an abstention signal (RFC J2/J7). Replacing it with a flat, machine-legible
 * absence is the whole point: downstream can branch on "the bank had nothing"
 * instead of parsing confidence out of prose.
 *
 * `isError` is deliberately false on the substituted result — an empty bank is
 * a valid answer, not a tool failure, and flagging it isError would make the
 * agent retry a query that will keep returning empty.
 */
export const REFLECT_EMPTY_EVIDENCE_TEXT =
  "No relevant memories: reflect retrieved ZERO evidence from your memory " +
  "bank for this query — no memories, mental models, or directives matched. " +
  "This is not an error and not a synthesized answer: the bank has nothing " +
  "recorded on this topic. Treat it as an explicit absence, not a fact, and " +
  "do not present the (suppressed) synthesized prose as if it were recalled.";

/**
 * Total cardinality of a reflect `based_on` evidence map.
 *
 * Tolerant of every shape the field takes: the MCP tool result buckets by
 * fact_type (`world`/`experience`/`opinion`/`observation`, plus `mental-models`
 * / `directives` when present); the REST model buckets as
 * `memories`/`mental_models`/`directives`. Both are just an object whose values
 * are arrays, so summing array lengths over ALL values counts every piece of
 * evidence regardless of which spelling the pinned engine uses. If ANY bucket
 * value is not an array the shape is unrecognised, so we return `null` rather
 * than sum a partial count — a 0 there would be a FALSE abstention. Returns
 * `null` when `based_on` is absent, is not an object, or has any non-array
 * bucket — the caller reads that as "could not determine" and never abstains,
 * which is the false-abstention-safe direction. Abstention (a 0) can only ever
 * fire on a genuinely-empty, fully-array-shaped evidence set.
 */
export function reflectEvidenceCardinality(basedOn: unknown): number | null {
  if (!basedOn || typeof basedOn !== "object" || Array.isArray(basedOn)) {
    return null;
  }
  let total = 0;
  for (const v of Object.values(basedOn as Record<string, unknown>)) {
    if (!Array.isArray(v)) return null; // any non-array bucket → shape unseen, never abstain
    total += v.length;
  }
  return total;
}

/**
 * Post-process a forwarded `reflect` tool result: abstain explicitly when the
 * engine's returned evidence set is genuinely empty, and strip the evidence set
 * back out when the shim injected `include_based_on` the caller did not ask for.
 *
 * The gate keys off the REAL returned evidence cardinality (`based_on`), NEVER a
 * heuristic over the synthesized prose. So it fires ONLY when retrieval was
 * genuinely empty and can never false-abstain on a query the engine actually
 * had evidence for — the one risk RFC P9 calls out. Whenever the evidence set
 * cannot be seen (no `based_on`, content not the expected JSON, unexpected
 * shape), the result is returned UNCHANGED: the safe direction is always "keep
 * the synthesized answer", never "abstain on a doubt".
 *
 * `callerWantedBasedOn` records whether the original tool call asked for the
 * evidence. The shim forces `include_based_on: true` on the forwarded request so
 * this gate always has ground truth to read; when the caller did not ask for it
 * and retrieval was non-empty, the injected `based_on` is removed so the
 * caller-visible payload is byte-for-byte what it would have been without the
 * guard. The ONLY observable behaviour change is the empty-retrieval abstention.
 */
export function applyReflectCardinalityGuard(
  result: unknown,
  callerWantedBasedOn: boolean,
): unknown {
  const abstain = {
    content: [{ type: "text", text: REFLECT_EMPTY_EVIDENCE_TEXT }],
    isError: false,
  };
  if (!result || typeof result !== "object") return result;
  const res = result as {
    content?: Array<{ type?: unknown; text?: unknown }>;
    isError?: unknown;
  };
  if (res.isError) return result; // an error result carries no evidence set
  const content = res.content;
  if (!Array.isArray(content) || content.length === 0) return result;
  const first = content[0];
  if (!first || typeof first.text !== "string") return result;
  let payload: unknown;
  try {
    payload = JSON.parse(first.text);
  } catch {
    return result; // not the JSON envelope — leave it exactly as-is
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return result;
  }
  const obj = payload as Record<string, unknown>;
  if (!("based_on" in obj)) return result; // evidence not visible → never abstain
  const cardinality = reflectEvidenceCardinality(obj.based_on);
  if (cardinality === null) return result;
  if (cardinality === 0) return abstain;
  if (callerWantedBasedOn) return result; // caller asked for it — keep it
  // Non-empty, but the caller never requested the evidence set; the shim only
  // injected include_based_on to run this gate. Strip it back out so the
  // caller-visible payload matches the pre-guard behaviour, preserving every
  // other field and content entry. 2-space indent mirrors the engine's own
  // rendering of this envelope.
  delete obj.based_on;
  return {
    ...res,
    content: [
      { ...first, text: JSON.stringify(obj, null, 2) },
      ...content.slice(1),
    ],
  };
}

/**
 * Mask secrets in the string leaves of a tool-call argument object.
 *
 * `mcp__hindsight__retain` is an agent-driven write into a memory bank
 * that never passes through the Python plugin, so `lib/client.py`'s
 * chokepoint cannot see it. This is the equivalent chokepoint for the MCP
 * surface: every forwarded non-read tool call is rewritten here, before
 * the upstream request is built.
 *
 * Keys are left alone (they are structural) and non-string leaves pass
 * through unchanged.
 */
export function redactToolArguments(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactToolArguments);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactToolArguments(v);
    }
    return out;
  }
  return value;
}

/** Apply {@link redactToolArguments} to a `tools/call` params object. */
export function redactToolCallParams(params: unknown): unknown {
  const called = params as
    | { name?: string; arguments?: unknown }
    | undefined
    | null;
  if (!called || typeof called !== "object") return params;
  if (called.arguments === undefined || called.arguments === null) return params;
  if (typeof called.name === "string" && READ_ONLY_TOOL_NAMES.has(called.name)) {
    return params;
  }
  return { ...called, arguments: redactToolArguments(called.arguments) };
}

// ─── Recall/reflect budget clamp + loud unknown-arg rejection ──────────────

/**
 * Injected token budget for a bare `recall` / `reflect` when the caller
 * names none. The engine's MCP defaults are budget:"high" + max_tokens:4096,
 * which returns ~53 facts / ~80KB of JSON — over Claude Code's MCP output
 * token cap, so the payload silently NEVER lands in the agent's context.
 * 1024 matches the auto-recall hook (`vendor/.../lib/client.py` uses
 * max_tokens=1024). Explicit caller values always win — see
 * {@link guardAndClampToolCall}. Tunable via
 * `HINDSIGHT_SHIM_RECALL_MAX_TOKENS` / `HINDSIGHT_SHIM_REFLECT_MAX_TOKENS`.
 *
 * The companion `budget` default lives in {@link DEFAULT_RECALL_BUDGET} /
 * {@link DEFAULT_REFLECT_BUDGET}, tunable via
 * `HINDSIGHT_SHIM_RECALL_BUDGET` / `HINDSIGHT_SHIM_REFLECT_BUDGET`.
 */
export const DEFAULT_RECALL_MAX_TOKENS = 1024;
export const DEFAULT_REFLECT_MAX_TOKENS = 1024;

/**
 * Injected `budget` for a bare `recall` / `reflect` when the caller names
 * none. Recall stays "low" (fast, shallow — it fires on every inbound turn).
 * Reflect ships "mid": budget:"low" bounded reflect depth but made
 * slightly-off queries return empty; the original overflow hazard was driven
 * by max_tokens (still clamped to 1024, see above), so "mid" cannot resurrect
 * it — the only cost of "mid" is added reflect latency / backend compute.
 * Explicit caller values always win. Tunable via
 * `HINDSIGHT_SHIM_RECALL_BUDGET` / `HINDSIGHT_SHIM_REFLECT_BUDGET`.
 */
export const DEFAULT_RECALL_BUDGET = "low";
export const DEFAULT_REFLECT_BUDGET = "mid";

// ─── Synthesized knowledge-read response caps ─────────────────────────────

/**
 * Char ceiling on ONE synthesized knowledge response.
 *
 * The forwarded reads are token-budgeted ({@link DEFAULT_RECALL_MAX_TOKENS} =
 * 1024) precisely because an unbounded payload silently overruns the MCP
 * output cap and never lands in the agent's context. The knowledge reads had
 * no equivalent ceiling: a big tree or a long page went back verbatim.
 *
 * 16384 = 4096 tokens × ~4 chars/token, i.e. exactly the budget upstream
 * generates a page against (`KNOWLEDGE_PAGE_DEFAULT_MAX_TOKENS = 4096`,
 * hindsight 0.9.0 `engine/memory_engine.py:13347`), so a normally-sized page
 * is never touched and only a genuinely oversized payload is cut.
 */
export const KNOWLEDGE_RESPONSE_MAX_CHARS = 16_384;

/**
 * Chars held back from the tree's budget for the omission marker, so the
 * capped render (JSON + marker) still fits {@link KNOWLEDGE_RESPONSE_MAX_CHARS}
 * rather than overshooting it by the length of its own footnote.
 *
 * Deliberately NOT paired with a node-count constant. A minimal node
 * serializes to ~35 chars, so any node ceiling low enough to bind before the
 * char budget would have to be under ~460 — i.e. a second threshold that
 * either never fires (dead config, which is what a 500-node cap turned out to
 * be) or silently overrides the one that matters. One budget, in the unit the
 * MCP output cap is actually denominated in.
 */
const KNOWLEDGE_TREE_MARKER_RESERVE = 256;

/**
 * Cut an oversized synthesized payload, SAYING SO.
 *
 * The marker is the whole point: a silently-truncated page reads to the model
 * as a complete page that simply ends, and it will act on the missing half as
 * if it did not exist. An explicit tail makes the gap something the model can
 * see and route around.
 */
export function capKnowledgeResponse(text: string): string {
  if (text.length <= KNOWLEDGE_RESPONSE_MAX_CHARS) return text;
  const omitted = text.length - KNOWLEDGE_RESPONSE_MAX_CHARS;
  return (
    text.slice(0, KNOWLEDGE_RESPONSE_MAX_CHARS) +
    `\n\n…truncated at ${KNOWLEDGE_RESPONSE_MAX_CHARS} chars — ${omitted} ` +
    `chars omitted. This is a PARTIAL read; narrow it with ` +
    `search_knowledge_pages rather than treating the above as the whole.`
  );
}

/** Total nodes in a knowledge forest, children included. */
function countKnowledgeNodes(nodes: KnowledgeNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countKnowledgeNodes(node.children ?? []);
  return n;
}

/** Depth-first prefix of a forest holding at most `budget` nodes. */
function takeKnowledgeNodes(
  nodes: KnowledgeNode[],
  budget: { left: number },
): KnowledgeNode[] {
  const out: KnowledgeNode[] = [];
  for (const node of nodes) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    out.push(
      node.children === undefined
        ? node
        : { ...node, children: takeKnowledgeNodes(node.children, budget) },
    );
  }
  return out;
}

/**
 * Render the tree inside {@link KNOWLEDGE_RESPONSE_MAX_CHARS}.
 *
 * `capKnowledgeResponse` is deliberately NOT used here: a char-level cut of
 * JSON leaves an unparseable document, which is worse than no answer. The
 * NODE budget is shrunk proportionally until the serialized form fits
 * instead, so the JSON is well-formed at every size.
 *
 * Depth-first prune so the retained part is a valid subtree (a folder is never
 * emitted without its own record), compact JSON so the budget buys nodes
 * rather than indentation, and an explicit `N of M nodes omitted` tail
 * whenever anything was dropped.
 */
export function renderKnowledgeTree(roots: KnowledgeNode[]): string {
  const total = countKnowledgeNodes(roots);
  const whole = JSON.stringify(roots);
  if (whole.length <= KNOWLEDGE_RESPONSE_MAX_CHARS) return whole;
  const charBudget = KNOWLEDGE_RESPONSE_MAX_CHARS - KNOWLEDGE_TREE_MARKER_RESERVE;
  let allowed = total;
  let kept = takeKnowledgeNodes(roots, { left: allowed });
  let json = JSON.stringify(kept);
  // Proportional shrink, guaranteed to make progress (the -1 floor), so this
  // terminates even on pathologically large single nodes.
  while (json.length > charBudget && allowed > 0) {
    allowed = Math.max(
      0,
      Math.min(allowed - 1, Math.floor(allowed * (charBudget / json.length))),
    );
    kept = takeKnowledgeNodes(roots, { left: allowed });
    json = JSON.stringify(kept);
  }
  const shown = countKnowledgeNodes(kept);
  if (shown === total) return json;
  return (
    json +
    `\n…${total - shown} of ${total} nodes omitted — the knowledge tree was ` +
    `truncated to fit the response budget. This is a PARTIAL listing; use ` +
    `search_knowledge_pages to find a specific page.`
  );
}

const VALID_BUDGETS = new Set(["low", "mid", "high"]);

/** Parse a positive-int env override, falling back on absent/garbage input. */
function resolveClampMaxTokens(
  envVal: string | undefined,
  fallback: number,
): number {
  if (envVal === undefined || envVal === "") return fallback;
  const n = Number.parseInt(envVal, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a budget env override, falling back on absent/garbage input. */
function resolveClampBudget(
  envVal: string | undefined,
  fallback: string,
): string {
  if (envVal === undefined || envVal === "") return fallback;
  return VALID_BUDGETS.has(envVal) ? envVal : fallback;
}

/** The accepted-argument union (required ∪ optional) for a table tool. */
function acceptedArgs(name: string): Set<string> | undefined {
  const spec = FALLBACK_TOOL_TABLE[name];
  if (!spec) return undefined;
  return new Set<string>([...spec[0], ...spec[1]]);
}

function unknownArgMessage(
  name: string,
  unknownKeys: string[],
  allowed: Set<string>,
): string {
  const keys = unknownKeys.map((k) => `'${k}'`).join(", ");
  const plural = unknownKeys.length > 1 ? "parameters" : "parameter";
  const base =
    `${name} has no ${keys} ${plural}. ` +
    `Accepted arguments: ${[...allowed].sort().join(", ")}.`;
  if (name === "recall" || name === "reflect") {
    // The 0.6.2 changelog renamed max_results→max_tokens; agents keep
    // guessing `limit`. Recall is capped by TOKEN BUDGET, not count.
    return (
      `${base} There is no 'limit'/'top_k' — cap results with max_tokens ` +
      `(a token budget over each fact's text, in relevance order) or ` +
      `budget: low|mid|high.`
    );
  }
  return base;
}

/**
 * Guard + clamp a `tools/call` params object before it is forwarded upstream.
 *
 * Two jobs, both closing holes the engine leaves open (it declares
 * `additionalProperties:false` but does NOT enforce it — an unknown arg is
 * dropped SILENTLY with isError:false, so the agent believes a cap/filter
 * applied when it did not):
 *
 *  1. LOUD UNKNOWN-ARG REJECTION — validate argument keys against the
 *     required∪optional union derived from {@link FALLBACK_TOOL_TABLE} (the
 *     single pinned source; the contract fixture keeps it ≡ the image). An
 *     unknown key returns a loud, self-correcting error instead of a silent
 *     drop. Tools not in the table are passed through unvalidated (no ground
 *     truth to validate against).
 *  2. DEFAULT BUDGET CLAMP — for `recall`/`reflect` only, inject
 *     max_tokens (env-tunable) + budget (env-tunable; recall low, reflect
 *     mid) when the caller OMITS them. Explicit caller values ALWAYS win (a
 *     deliberate max_tokens:4096 passes untouched).
 *
 * Returns the (possibly rewritten) params to forward, or a loud error text.
 */
export function guardAndClampToolCall(
  params: unknown,
  env: NodeJS.ProcessEnv,
): { ok: true; params: unknown } | { ok: false; text: string } {
  const called = params as
    | { name?: string; arguments?: unknown }
    | undefined
    | null;
  const name = called?.name;
  if (typeof name !== "string") return { ok: true, params };
  const allowed = acceptedArgs(name);
  // No pinned ground truth for this tool → nothing to validate/clamp against.
  if (!allowed) return { ok: true, params };

  const rawArgs = called?.arguments;
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  const unknownKeys = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknownKeys.length > 0) {
    return { ok: false, text: unknownArgMessage(name, unknownKeys, allowed) };
  }

  if (name === "recall" || name === "reflect") {
    const injected: Record<string, unknown> = { ...args };
    if (injected.max_tokens === undefined) {
      injected.max_tokens =
        name === "recall"
          ? resolveClampMaxTokens(
              env.HINDSIGHT_SHIM_RECALL_MAX_TOKENS,
              DEFAULT_RECALL_MAX_TOKENS,
            )
          : resolveClampMaxTokens(
              env.HINDSIGHT_SHIM_REFLECT_MAX_TOKENS,
              DEFAULT_REFLECT_MAX_TOKENS,
            );
    }
    if (injected.budget === undefined) {
      injected.budget =
        name === "recall"
          ? resolveClampBudget(
              env.HINDSIGHT_SHIM_RECALL_BUDGET,
              DEFAULT_RECALL_BUDGET,
            )
          : resolveClampBudget(
              env.HINDSIGHT_SHIM_REFLECT_BUDGET,
              DEFAULT_REFLECT_BUDGET,
            );
    }
    // RFC P9: force the reflect evidence set on so the cardinality guard in
    // toolsCall() has GROUND TRUTH (the real returned evidence) to read rather
    // than a heuristic over the synthesized prose. Only when the caller omits
    // it — an explicit include_based_on (true OR false) is the caller's call
    // and wins, exactly like budget/max_tokens above. When the caller leaves
    // it false the guard simply cannot see the evidence and never abstains,
    // which is the false-abstention-safe direction. The injected field is
    // stripped back out post-response unless the caller asked for it, so this
    // never bloats the caller-visible payload (see applyReflectCardinalityGuard).
    if (name === "reflect" && injected.include_based_on === undefined) {
      injected.include_based_on = true;
    }
    return { ok: true, params: { ...called, arguments: injected } };
  }

  return { ok: true, params };
}

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
  return withSynthesizedTools({ tools });
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
  /**
   * REST base for the synthesized directive tools (no trailing slash).
   * Defaults to `url` with the trailing `/mcp/` stripped — the same
   * derivation `HINDSIGHT_DEFAULT_API_BASE_URL` uses, so the port lives in
   * exactly one place.
   */
  apiBaseUrl?: string;
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
   * Forward one request to the backend. Lazy-connects, and on PRE-DELIVERY
   * failure resets the session and (when `retry`) re-attempts exactly once
   * — covering both cold backends that just came up and expired upstream
   * sessions (hindsight answers those with 404, i.e. it refused the request
   * without executing it).
   *
   * DOUBLE-EXECUTION GUARD (#3313 review must-fix 1): the retry is scoped
   * to failures where the request provably never reached the backend —
   * `ensureSession()` failures, connect-level errors (refused/DNS), and a
   * 404 session rejection. Once the POST has been delivered (the fetch
   * resolved, or it failed with a timeout/abort/mid-response error that
   * cannot be distinguished from "backend is still executing"), the shim
   * NEVER re-sends: a slow-but-alive backend processing a non-idempotent
   * call (retain, create_directive, ...) must not receive it twice. The
   * legacy direct-HTTP entry never auto-retried; neither do we
   * post-delivery.
   */
  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    retry = true,
  ): Promise<JsonRpcMessage> {
    // Phase 1 — session handshake. Nothing about THIS request has been
    // sent yet, so any failure here is safely retryable.
    try {
      await this.ensureSession();
    } catch (err) {
      this.reset();
      if (retry) return this.request(method, params, timeoutMs, false);
      throw err;
    }
    const id = this.nextId++;
    // Phase 2 — the POST itself. Only connect-level failures (the request
    // never left) are retryable; an abort/timeout may have been delivered.
    let res: Response;
    try {
      res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    } catch (err) {
      this.reset();
      if (retry && isPreDeliveryError(err)) {
        return this.request(method, params, timeoutMs, false);
      }
      throw err;
    }
    if (res.status === 404) {
      // Session expired upstream: the server REJECTED the request without
      // executing it — safe to retry on a fresh session.
      this.reset();
      await res.text().catch(() => undefined);
      if (retry) return this.request(method, params, timeoutMs, false);
      throw new Error("upstream session expired (404)");
    }
    // Phase 3 — delivered. Failures from here on are never retried.
    try {
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      return await this.parseResponse(res, id);
    } catch (err) {
      this.reset();
      throw err;
    }
  }
}

/**
 * True when a fetch rejection proves the request was never accepted by the
 * backend (connection refused / DNS failure / connect-phase timeout). An
 * AbortError (our own bounded timeout) or a reset/parse failure mid-response
 * is NOT pre-delivery — the backend may be executing the call — so those are
 * deliberately absent. Walks the `cause` chain because undici wraps network
 * errors in TypeError("fetch failed").
 */
export function isPreDeliveryError(err: unknown): boolean {
  const PRE_DELIVERY_CODES = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && PRE_DELIVERY_CODES.has(code)) return true;
    // AggregateError (e.g. Happy Eyeballs dual-stack connect): pre-delivery
    // iff every underlying error is.
    const errors = (cur as { errors?: unknown[] }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.every((e) => isPreDeliveryError(e));
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
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
   * handshake always succeeds regardless of backend state.
   *
   * Capabilities are deliberately **tools-only** even though the live
   * backend also advertises prompts/resources (review #3313 finding 5):
   * switchroom's hindsight integration consumes only the tool surface
   * (`mcp__hindsight__*`), and advertising prompts/resources here would
   * promise a surface the shim cannot guarantee offline (there is no
   * cached/fallback manifest for them — an early prompts/list against a
   * down backend would just error). `forward()` still proxies those
   * methods transparently if a client sends them anyway. `listChanged` is
   * honest: see notifyIfRecovered().
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

  /**
   * True after we served a cached/fallback manifest — i.e. the client's
   * view of the tool schemas may be stale relative to the live backend.
   * Cleared (with a `notifications/tools/list_changed` emission) once the
   * backend is reachable again, honoring the advertised `listChanged`.
   */
  private staleManifestServed = false;

  /**
   * Sink for server-initiated notifications, wired to stdout by run().
   * No-op default so direct handle() callers (tests) work without wiring.
   */
  notificationSink: (msg: JsonRpcMessage) => void = () => undefined;

  /**
   * Review #3313 finding 3: `listChanged: true` must be honest. When a
   * stale (cached/fallback) manifest has been served and a later upstream
   * request succeeds — proof the backend is reachable again — emit
   * `notifications/tools/list_changed` so the client re-lists and picks up
   * the live schemas. (The shim has no listen stream to RELAY backend-side
   * change notifications; this recovery emission is the one change event
   * it can genuinely detect.)
   */
  private notifyIfRecovered(): void {
    if (!this.staleManifestServed) return;
    this.staleManifestServed = false;
    this.notificationSink({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
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
        // Cache the BACKEND's manifest verbatim — the cache is a record of
        // upstream truth, so the synthesized tools are layered on at serve
        // time (below and in the catch) rather than baked into the file.
        this.writeCache(result);
        // The client is receiving the LIVE manifest right now — its view
        // is fresh, no recovery notification needed.
        this.staleManifestServed = false;
        return withSynthesizedTools(result as { tools: ToolDef[] });
      }
      throw new Error("upstream tools/list returned no tools array");
    } catch (err) {
      this.log(
        `[hindsight-shim] live tools/list failed (${String(err)}); serving ` +
          "cached/fallback manifest",
      );
      this.staleManifestServed = true;
      const cached = this.readCache();
      // The synthesized tools — the two directive-retirement tools AND the
      // three knowledge-page reads — do not depend on the backend's MCP
      // surface at all, so they are advertised identically on every path:
      // cold boot, cached, or live. An agent must never lose the retirement
      // path, or sight of its own knowledge pages, just because the MCP
      // session is briefly down. (Their REST calls can still fail; that
      // surfaces as an honest isError at call time, not as a missing tool.)
      return cached ? withSynthesizedTools(cached) : buildFallbackToolsList();
    }
  }

  /** Lazily built REST client for the synthesized directive tools. */
  private directiveAdminCache: DirectiveAdmin | null = null;

  private get directiveAdmin(): DirectiveAdmin {
    if (!this.directiveAdminCache) {
      this.directiveAdminCache = new DirectiveAdmin({
        apiBaseUrl:
          this.opts.apiBaseUrl ?? this.opts.url.replace(/\/mcp\/?$/, ""),
        // PINNED. There is no parameter path from a tool call to this value.
        bankId: this.opts.bankId,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    }
    return this.directiveAdminCache;
  }

  /** Lazily built REST client for the synthesized knowledge-page reads. */
  private knowledgeAdminCache: KnowledgeAdmin | null = null;

  private get knowledgeAdmin(): KnowledgeAdmin {
    if (!this.knowledgeAdminCache) {
      this.knowledgeAdminCache = new KnowledgeAdmin({
        apiBaseUrl:
          this.opts.apiBaseUrl ?? this.opts.url.replace(/\/mcp\/?$/, ""),
        // PINNED. There is no parameter path from a tool call to this value.
        bankId: this.opts.bankId,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    }
    return this.knowledgeAdminCache;
  }

  /**
   * Lazily built, per-instance memoized probe of the live engine's
   * `/openapi.json` — the engine version pin design-v2.md §2.5 named as
   * owed (see `../memory/hindsight-shim-contract.ts`'s module header for the
   * full rationale). Built the same way as {@link directiveAdmin} /
   * {@link knowledgeAdmin} — same `apiBaseUrl` derivation, same injected
   * `fetchImpl` — so a test that stubs one stubs all three consistently.
   *
   * Never fetched from `initializeResult()` or any other startup path: the
   * shim's foundational rule is that `initialize` always succeeds regardless
   * of backend state, and this probe is best-effort exactly like
   * `directiveAdmin`/`knowledgeAdmin` are — it only ever runs lazily, on the
   * first synthesized call.
   *
   * `negativeCacheMs`/`positiveCacheMs` (adversarial review on #4739):
   * without a negative TTL, an engine with no `/openapi.json` made EVERY
   * synthesized call re-pay up to `OPENAPI_FETCH_TIMEOUT_MS` (3s) on the
   * tool-call latency path, forever. 30s bounds that tax to at most one
   * timeout per 30s of wall-clock regardless of call volume, while still
   * clearing within a session once the engine comes back — no restart
   * needed. 5 minutes on the positive side means a route restored by a
   * mid-session engine upgrade (rare, but the alternative is a stuck
   * rejection lying about "the shim confirmed the route is gone" until the
   * shim restarts) is re-checked well inside a typical session rather than
   * requiring one.
   */
  private contractPinCache: ShimContractPin | null = null;

  private get contractPin(): ShimContractPin {
    if (!this.contractPinCache) {
      this.contractPinCache = new ShimContractPin(
        this.opts.apiBaseUrl ?? this.opts.url.replace(/\/mcp\/?$/, ""),
        {
          ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
          negativeCacheMs: 30_000,
          positiveCacheMs: 5 * 60_000,
        },
      );
    }
    return this.contractPinCache;
  }

  /**
   * Answer a shim-synthesized tool locally. Never touches the upstream MCP
   * session.
   *
   * Argument handling is deliberately strict: an argument the tool does not
   * declare is REJECTED rather than ignored. Silently ignoring `bank_id`
   * would leave a caller believing it had targeted another bank when it had
   * in fact edited its own — exactly the silent-drop failure mode the
   * fallback-manifest rules above exist to prevent.
   */
  private async synthesizedCall(
    name: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    const fail = (text: string) => ({
      content: [{ type: "text", text }],
      isError: true,
    });
    const spec = SYNTHESIZED_TOOL_TABLE[name];
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const allowed = new Set(Object.keys(spec.props));
    const unknown = Object.keys(args).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      return fail(
        `${name} does not accept ${unknown.map((u) => `'${u}'`).join(", ")}. ` +
          `Accepted arguments: ${[...allowed].join(", ")}. ` +
          (unknown.includes("bank_id")
            ? "This tool always operates on your own memory bank; there is no " +
              "way to target another agent's bank through it."
            : ""),
      );
    }
    // Each declared arg is validated against ITS OWN schema entry — see
    // coerceSynthesizedArg for why this is per-property rather than the flat
    // "must be a non-empty string" rule it replaced.
    const clean: Record<string, string | number> = {};
    for (const key of Object.keys(args)) {
      const coerced = coerceSynthesizedArg(name, key, spec.props[key], args[key]);
      if (!coerced.ok) return fail(coerced.text);
      clean[key] = coerced.value;
    }
    for (const req of spec.required) {
      if (clean[req] === undefined) {
        return fail(`${name} requires '${req}'.`);
      }
    }
    if (!this.opts.bankId) {
      return fail(
        `${name} is unavailable: this agent has no HINDSIGHT_BANK_ID, so ` +
          "there is no bank to pin it to.",
      );
    }
    // Route-contract preflight (engine version pin, design-v2.md §2.5): a
    // CONFIRMED-missing route fails loudly here, before the doomed REST call
    // is even attempted. An unreachable/malformed /openapi.json is treated
    // as "unknown" and falls through unchanged — see ShimContractPin's
    // header for why that direction is the safe one.
    const preflight = await this.contractPin.preflight(name);
    if (!preflight.ok) return fail(preflight.text);
    try {
      const text = await this.runSynthesized(name, clean);
      return { content: [{ type: "text", text }], isError: false };
    } catch (err) {
      if (err instanceof DirectivePairInconsistentError) {
        this.log(`[hindsight-shim] ${err.message}`);
      }
      return fail(`${name} failed: ${String(err)}`);
    }
  }

  /**
   * Dispatch one validated synthesized call to its REST backing and render
   * the agent-facing text.
   *
   * A name switch rather than a ternary chain: the directive pair was
   * expressible as `name === "deactivate_directive" ? … : …` only while there
   * were exactly two, and that shape silently routes any unrecognised name to
   * the else branch. The `default` throw makes a table entry added without a
   * dispatch arm a loud failure instead of a wrong tool running.
   *
   * Rendering differs by tool on purpose: a page IS a markdown document, so it
   * is returned verbatim; search hits and the tree are structured data with no
   * canonical prose form, so they are JSON.
   */
  private async runSynthesized(
    name: string,
    args: Record<string, string | number>,
  ): Promise<string> {
    switch (name) {
      case "deactivate_directive":
        return this.directiveAdmin.deactivate({
          name: args.name as string,
          ...(typeof args.superseded_by === "string"
            ? { supersededBy: args.superseded_by }
            : {}),
        });
      case "reactivate_directive":
        return this.directiveAdmin.reactivate({ name: args.name as string });
      case "search_knowledge_pages": {
        const res = await this.knowledgeAdmin.search({
          query: args.query as string,
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
        if (res.results.length === 0) {
          // An empty bank is a normal answer, not a failure — say so in words
          // so the model does not read `[]` as a broken tool and retry.
          return (
            "No knowledge pages matched that query in your memory bank. " +
            "The bank may have no pages yet — get_knowledge_tree lists what " +
            "exists."
          );
        }
        // `total` rides along deliberately: with `results` alone the model
        // cannot tell a complete set from one the `limit` cut short, and would
        // read 10 of 200 hits as "there are 10".
        return capKnowledgeResponse(
          JSON.stringify({ total: res.total, results: res.results }, null, 2),
        );
      }
      case "get_knowledge_page": {
        const page = await this.knowledgeAdmin.getPage({
          page_id: args.page_id as string,
        });
        return capKnowledgeResponse(page.markdown);
      }
      case "get_knowledge_tree": {
        const tree = await this.knowledgeAdmin.tree();
        if (tree.roots.length === 0) {
          return (
            "Your knowledge base has no pages yet. Pages are synthesized from " +
            "mental models — propose one to start it."
          );
        }
        return renderKnowledgeTree(tree.roots);
      }
      default:
        throw new Error(
          `${name} is advertised as a synthesized tool but has no dispatch arm`,
        );
    }
  }

  /** tools/call: lazy connect + bounded timeout + one retry; isError on down. */
  private async toolsCall(params: unknown): Promise<unknown> {
    const called = (params as { name?: string; arguments?: unknown } | undefined);
    // Synthesized tools are answered here and NEVER forwarded — the upstream
    // MCP surface has no directive-update or knowledge tool to forward them to.
    if (called?.name && SYNTHESIZED_TOOL_NAMES.includes(called.name)) {
      return this.synthesizedCall(called.name, called.arguments);
    }
    // Guard + clamp BEFORE forwarding: turn the engine's silent unknown-arg
    // drop into a loud, self-correcting error, and inject the recall/reflect
    // budget defaults the engine otherwise leaves fat (see
    // guardAndClampToolCall). Runs before redaction so the injected budget is
    // covered by the same forward path.
    const guarded = guardAndClampToolCall(params, process.env);
    if (!guarded.ok) {
      return { content: [{ type: "text", text: guarded.text }], isError: true };
    }
    // Secret redaction chokepoint for the MCP write path. Every
    // `mcp__hindsight__*` call an agent makes is forwarded from HERE, so
    // masking the arguments here covers retain / update_memory /
    // create_directive / mental-model writes with one seam, and covers any
    // tool the backend adds later without a code change (see
    // READ_ONLY_TOOL_NAMES — the allowlist is the reads, not the writes).
    const forwarded = redactToolCallParams(guarded.params);
    const toolName = (guarded.params as { name?: string } | undefined)?.name;
    // Whether the ORIGINAL call asked for the evidence set — read from the
    // caller's params, before guardAndClampToolCall forced include_based_on on
    // (RFC P9). Drives whether the injected evidence is stripped back out of a
    // non-empty result.
    const callerWantedBasedOn =
      toolName === "reflect" &&
      Boolean(
        (called?.arguments as { include_based_on?: unknown } | undefined)
          ?.include_based_on,
      );
    const timeoutMs = this.opts.toolsCallTimeoutMs ?? TOOLS_CALL_TIMEOUT_MS;
    try {
      let res = await this.upstream.request("tools/call", forwarded, timeoutMs);
      // Reflect-only re-roll of upstream's ReflectToolCallError (hindsight
      // v0.8.6). Read-only and non-deterministic, so re-issuing is safe and
      // usually succeeds — see REFLECT_TOOL_CALL_RETRIES for the full rationale.
      for (
        let attempt = 1;
        attempt <= REFLECT_TOOL_CALL_RETRIES &&
        isReflectToolCallFailure(toolName, res);
        attempt++
      ) {
        this.log(
          `[hindsight-shim] reflect produced no usable tool call; ` +
            `re-issuing (attempt ${attempt}/${REFLECT_TOOL_CALL_RETRIES})`,
        );
        res = await this.upstream.request("tools/call", forwarded, timeoutMs);
      }
      // Any answer at all proves the backend is reachable again.
      this.notifyIfRecovered();
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
      // RFC P9 reflect cardinality guard: substitute an explicit "no relevant
      // memories" answer when the engine's returned evidence set is genuinely
      // empty, and strip the shim-injected evidence back out otherwise. A
      // no-op for every non-reflect tool and for reflect results whose evidence
      // set cannot be read.
      if (toolName === "reflect") {
        return applyReflectCardinalityGuard(res.result, callerWantedBasedOn);
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
   * Wire the shim to stdio: newline-delimited JSON-RPC.
   *
   * Messages are handled **concurrently** (review #3313 must-fix 2): with
   * serialized handling, one tools/call against a hung-but-listening
   * backend would head-of-line-block ping / tools/list / parallel tool
   * calls for up to the full call timeout — the very "whole memory server
   * unresponsive" failure mode this shim exists to prevent — and a
   * notifications/cancelled would queue behind the call it cancels. Only
   * the stdout WRITES need serializing, which each handler gets for free:
   * every response is emitted as exactly one synchronous `output.write()`
   * of a complete line, and Node stream writes never interleave within a
   * single chunk.
   *
   * Resolves after the input stream ends AND every in-flight handler has
   * flushed its response — callers must not exit before then (caught live:
   * exiting on raw stdin "end" raced the async tools/list handler and
   * dropped its response).
   */
  async run(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ): Promise<void> {
    // Server-initiated notifications share the same atomic-line discipline.
    this.notificationSink = (msg) => output.write(JSON.stringify(msg) + "\n");
    const rl = createInterface({ input, crlfDelay: Infinity });
    const inflight = new Set<Promise<void>>();
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
      const task = (async () => {
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
      })();
      inflight.add(task);
      void task.finally(() => inflight.delete(task));
    });
    await new Promise<void>((resolve) => rl.on("close", resolve));
    // Drain: new tasks can no longer arrive (input closed); settle all.
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
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
