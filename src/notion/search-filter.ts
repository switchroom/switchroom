/**
 * Notion search post-filter — RFC §8.5 PR 3.
 *
 * **This is the load-bearing privacy invariant.** Notion's `search`
 * endpoint returns titles + snippets of any page the upstream
 * integration was shared with, ignoring switchroom's per-agent
 * allowlist. Without this filter, an agent with `databases: [essays]`
 * could see search hits from any other DB the integration touches —
 * a real privacy leak.
 *
 * **Mandatory + default-on.** Per the RFC, no operator opt-out. If
 * a future JTBD truly needs cross-DB search visibility, that's a
 * separate per-agent flag (`search_global: true`) added explicitly,
 * not a default.
 *
 * Approach:
 *   1. Call `search` against Notion's API.
 *   2. For each result, resolve the parent DB UUID (using the same
 *      resolver + cache as the write path — RFC §8.2/§8.3).
 *   3. Drop results whose parent DB isn't in the agent's allowlist.
 *   4. Cap at 20 walks per filter pass to bound rate-limit cost.
 *   5. Return the filtered list + a count of how many were dropped.
 *
 * Returns to the caller (the PreToolUse hook for `search` calls) a
 * shape the hook stamps into the tool response metadata so the
 * model knows results were redacted.
 */

import { resolveDbForNode, type NotionApiClient } from "./db-resolver.js";
import type { PageDbCache } from "./page-db-cache.js";
import type { NotionSearchResponse, NotionSearchResult } from "./api-client.js";

/** Maximum results we walk parent chains for per filter pass. */
export const MAX_FILTERED_RESULTS = 20;

export interface SearchFilterResult {
  /** Results whose parent DB the agent may access. */
  allowed: NotionSearchResult[];
  /** Total results from upstream search. */
  upstreamCount: number;
  /** Number of results we DROPPED (allowlist denied). */
  filteredOut: number;
  /** Number of results we DID NOT WALK (over the cap). */
  unwalked: number;
  /** Number of API calls made by the resolver during this filter. */
  apiCalls: number;
  /** Number of results we couldn't resolve (treated as denied). */
  errored: number;
}

/**
 * Filter a search response down to results the agent is allowed to
 * see. `isAllowedDb` is a closure over the agent's
 * `notion_workspace.databases` allowlist (built by the caller from
 * `agentCanAccessNotionDB`).
 */
export async function filterSearchResults(
  response: NotionSearchResponse,
  client: NotionApiClient,
  cache: PageDbCache,
  isAllowedDb: (dbId: string) => boolean,
): Promise<SearchFilterResult> {
  const out: SearchFilterResult = {
    allowed: [],
    upstreamCount: response.results.length,
    filteredOut: 0,
    unwalked: 0,
    apiCalls: 0,
    errored: 0,
  };

  let walks = 0;
  for (const result of response.results) {
    if (walks >= MAX_FILTERED_RESULTS) {
      out.unwalked += 1;
      continue;
    }

    // Fast path: parent in result.parent already.
    if (result.parent?.type === "database_id") {
      if (isAllowedDb(result.parent.database_id)) {
        out.allowed.push(result);
      } else {
        out.filteredOut += 1;
      }
      continue;
    }
    if (result.parent?.type === "workspace") {
      // Standalone page — §6.2 rule 2 says hard-deny.
      out.filteredOut += 1;
      continue;
    }

    // Walk-required path.
    walks += 1;
    let startId: string | null = null;
    let startKind: "page" | "block" = "page";
    if (result.parent?.type === "page_id") {
      startId = result.parent.page_id;
      startKind = "page";
    } else if (result.parent?.type === "block_id") {
      startId = result.parent.block_id;
      startKind = "block";
    } else if (result.object === "page") {
      startId = result.id;
      startKind = "page";
    } else if (result.object === "block") {
      startId = result.id;
      startKind = "block";
    } else if (result.object === "database") {
      // Database results are gated by DB id directly.
      if (isAllowedDb(result.id)) {
        out.allowed.push(result);
      } else {
        out.filteredOut += 1;
      }
      continue;
    }

    if (!startId) {
      out.errored += 1;
      continue;
    }

    const r = await resolveDbForNode(startId, startKind, client, cache);
    out.apiCalls += r.apiCalls;
    if (r.kind === "db" && isAllowedDb(r.dbId)) {
      out.allowed.push(result);
    } else if (r.kind === "no-db") {
      // Standalone — deny.
      out.filteredOut += 1;
    } else if (r.kind === "error") {
      // Fail-closed for unresolvable.
      out.errored += 1;
    } else {
      // db kind but not allowed
      out.filteredOut += 1;
    }
  }

  return out;
}
