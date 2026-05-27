/**
 * PreToolUse hook for @notionhq/notion-mcp-server tool calls —
 * RFC docs/rfcs/notion-integration.md §8 PR 3.
 *
 * Bundled to `/opt/switchroom/hooks/notion-write-pretool.mjs` at build
 * time so it runs inside the agent container with zero relative
 * imports. Mirrors `drive-write-pretool.ts` shape but adds the
 * per-DB allowlist gate that's load-bearing for switchroom's
 * defence-in-depth posture over Notion's upstream-shared set.
 *
 * Claude Code PreToolUse contract:
 *   Input:  JSON on stdin — `{ session_id, tool_name, tool_input, ... }`
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON `{ decision: "block", reason: "..." }` → block.
 *
 * Flow:
 *   1. Parse stdin. Fail-open allow if tool isn't a Notion tool.
 *   2. If tool is `create_database` → BLOCK (RFC §6.2 rule 3).
 *   3. Dispatch tool args → either DB id in args (free) or walk-required.
 *   4. If walk-required → fetch parent via Notion API (using the
 *      integration token from the vault-broker), cache the result.
 *   5. Check the resolved DB against the agent's allowlist via
 *      `agentCanAccessNotionDB`. If denied → BLOCK with clear reason.
 *   6. If `search` → fall through; the MCP server's search response
 *      is post-filtered by the launcher's stdio bridge (search-filter.ts).
 *      The hook can't post-process the response, so for `search` the
 *      hook does a coarse "is allowlist non-empty" check and lets the
 *      call through; redaction happens at response time.
 *
 * Fail-closed defaults:
 *   - Stdin parse fails → BLOCK (Claude Code protocol error).
 *   - Resolver errors (network / 404) → BLOCK (don't allow what we
 *     can't gate).
 *   - SWITCHROOM_AGENT_NAME missing → BLOCK (don't know which
 *     allowlist to apply).
 *   - Config missing or notion_workspace missing → BLOCK.
 *
 * Fail-open allow:
 *   - Tool isn't a Notion tool (prefix doesn't match).
 *
 * v1 scope cuts:
 *   - **No approval card.** Writes pass through after the allowlist
 *     gate. A follow-up PR adds the operator-approval card on top.
 *     The allowlist gate IS the security primitive; the approval is
 *     UX gravy.
 *   - **No rate-bucket integration.** Hook makes API calls directly.
 *     Across the fleet's typical 2-3 Notion-enabled agents this is
 *     within Notion's 3-rps headroom for typical multi-step turns;
 *     if production logs show >5% 429s the broker rate-bucket
 *     (PR 2) gets wired in a follow-up.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config/loader.js";
import { agentCanAccessNotionDB } from "../config/notion-workspace-acl.js";
import { createNotionApiClient } from "../notion/api-client.js";
import {
  dispatchTool,
  resolveDbForNode,
  type NotionApiClient,
} from "../notion/db-resolver.js";
import { PageDbCache } from "../notion/page-db-cache.js";

const TOOL_PREFIX = "mcp__notion__";

/** Process-lifetime cache. The hook runs as a short-lived child of
 *  Claude Code per tool invocation, so this cache resets on each
 *  fire — modest hit-rate. The launcher-side cache (PR 4 wire-up)
 *  will be the long-lived one. */
const CACHE = new PageDbCache({ maxEntries: 256, ttlMs: 5 * 60 * 1000 });

export interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface HookDecision {
  decision: "allow" | "block";
  /** Operator-facing reason. Surfaced in Claude Code's hook output. */
  reason?: string;
}

/**
 * Pure dispatch — given parsed hook input + injected dependencies,
 * compute the decision. Exposed for unit tests.
 */
export async function decide(
  input: HookInput,
  deps: {
    agentName: string;
    configLoader: () => ReturnType<typeof loadConfig>;
    apiClient: NotionApiClient;
    cache?: PageDbCache;
  },
): Promise<HookDecision> {
  const toolName = input.tool_name ?? "";
  if (!toolName.startsWith(TOOL_PREFIX)) {
    return { decision: "allow" };
  }

  const config = deps.configLoader();
  if (!config.notion_workspace) {
    return {
      decision: "block",
      reason:
        "notion_workspace is not configured globally — refusing to allow Notion tool calls.",
    };
  }

  const bare = toolName.slice(TOOL_PREFIX.length);

  // `search` is special-cased BEFORE the regular dispatch — the
  // dispatcher returns args-malformed for search (it's handled at
  // response time by the post-filter), but the hook still needs to
  // gate at call time on whether the agent has notion_workspace at
  // all. The actual result-filtering happens elsewhere (search-
  // filter.ts) once the response comes back.
  if (bare === "search") {
    if (!agentHasNotionWorkspace(deps.agentName, config)) {
      return {
        decision: "block",
        reason: `Agent ${deps.agentName} has no notion_workspace config; Notion tool calls are not permitted.`,
      };
    }
    return { decision: "allow" };
  }

  const dispatch = dispatchTool(bare, input.tool_input);

  if (dispatch.kind === "banned-tool") {
    return {
      decision: "block",
      reason:
        `Notion tool \`${bare}\` is disabled in switchroom v1. ` +
        `Create databases via Notion's UI instead; switchroom can read + write existing DBs.`,
    };
  }

  if (dispatch.kind === "args-malformed") {
    return {
      decision: "block",
      reason: `Notion tool \`${bare}\` rejected: ${dispatch.reason}.`,
    };
  }

  let dbId: string;
  if (dispatch.kind === "args-resolved") {
    if (dispatch.dbId === null) {
      // No-DB target (workspace page) — hard deny per RFC §6.2 rule 2.
      return {
        decision: "block",
        reason:
          `Notion tool \`${bare}\` targets a page without a database parent — ` +
          `switchroom v1 only allows access to pages inside an allowlisted database.`,
      };
    }
    dbId = dispatch.dbId;
  } else {
    // walk-required
    const cache = deps.cache ?? CACHE;
    const r = await resolveDbForNode(
      dispatch.startId,
      dispatch.startKind,
      deps.apiClient,
      cache,
    );
    if (r.kind === "no-db") {
      return {
        decision: "block",
        reason:
          `Notion tool \`${bare}\` targets a standalone page (no database parent). ` +
          `switchroom v1 only allows access to pages inside an allowlisted database.`,
      };
    }
    if (r.kind === "error") {
      return {
        decision: "block",
        reason: `Notion tool \`${bare}\` could not resolve parent database: ${r.reason}.`,
      };
    }
    dbId = r.dbId;
  }

  // Allowlist gate.
  if (!agentCanAccessNotionDB(config, deps.agentName, dbId)) {
    return {
      decision: "block",
      reason:
        `Notion tool \`${bare}\` targets database \`${dbId}\` which is not in ` +
        `${deps.agentName}'s allowlist (notion_workspace.databases). ` +
        `If this is intentional, add the database friendly name to ` +
        `agents.${deps.agentName}.notion_workspace.databases in switchroom.yaml.`,
    };
  }

  return { decision: "allow" };
}

function agentHasNotionWorkspace(
  agentName: string,
  config: ReturnType<typeof loadConfig>,
): boolean {
  return config.agents?.[agentName]?.notion_workspace !== undefined;
}

/**
 * Stdin parse helper. Returns null if input is malformed.
 */
export function parseHookInput(stdin: string): HookInput | null {
  if (!stdin.trim()) return null;
  try {
    const obj = JSON.parse(stdin) as HookInput;
    if (typeof obj !== "object" || obj === null) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Read stdin synchronously. Claude Code spawns the hook with a JSON
 * payload piped on stdin; this is the canonical pattern (see
 * `ms-365-write-pretool.ts`).
 */
function readAllStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Live entrypoint. Wires production deps and exits with the
 * appropriate code + stdout for Claude Code's hook protocol.
 */
export async function runHook(): Promise<void> {
  const stdin = readAllStdin();
  const input = parseHookInput(stdin);

  if (!input) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: "notion-write-pretool: malformed stdin payload.",
      }),
    );
    return;
  }

  const toolName = input.tool_name ?? "";
  if (!toolName.startsWith(TOOL_PREFIX)) {
    // fast-path allow: nothing to do.
    return;
  }

  const agentName = process.env.SWITCHROOM_AGENT_NAME;
  if (!agentName) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          "notion-write-pretool: SWITCHROOM_AGENT_NAME env var missing — cannot apply per-agent allowlist.",
      }),
    );
    return;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    const cfgPath = process.env.SWITCHROOM_CONFIG;
    config = cfgPath ? loadConfig(cfgPath) : loadConfig();
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          `notion-write-pretool: failed to load switchroom.yaml: ${
            (err as Error).message
          }`,
      }),
    );
    return;
  }

  // Fetch the integration token from the vault-broker so the resolver
  // can call Notion's REST API. We do this lazily — only when the
  // dispatch result indicates a walk is required.
  const vaultKey =
    config.notion_workspace?.vault_key ?? "notion/integration-token";
  let cachedToken: string | null = null;
  const apiClient: NotionApiClient = {
    async getPage(pageId: string) {
      cachedToken = cachedToken ?? (await fetchTokenFromBroker(vaultKey));
      return await createNotionApiClient({ token: cachedToken }).getPage(pageId);
    },
    async getBlock(blockId: string) {
      cachedToken = cachedToken ?? (await fetchTokenFromBroker(vaultKey));
      return await createNotionApiClient({ token: cachedToken }).getBlock(blockId);
    },
  };

  let decision: HookDecision;
  try {
    decision = await decide(input, {
      agentName,
      configLoader: () => config,
      apiClient,
      cache: CACHE,
    });
  } catch (err) {
    decision = {
      decision: "block",
      reason: `notion-write-pretool: internal error: ${(err as Error).message}`,
    };
  }

  if (decision.decision === "block") {
    process.stdout.write(JSON.stringify(decision));
  }
  // allow: empty stdout per Claude Code's protocol.
}

async function fetchTokenFromBroker(vaultKey: string): Promise<string> {
  const { getViaBrokerStructured } = await import("../vault/broker/client.js");
  const result = await getViaBrokerStructured(vaultKey);
  if (result.kind === "ok" && result.entry.kind === "string") {
    return result.entry.value;
  }
  throw new Error(
    `vault-broker did not return a string entry for ${vaultKey}: kind=${result.kind}`,
  );
}
