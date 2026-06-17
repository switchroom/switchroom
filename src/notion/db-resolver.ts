/**
 * Per-tool DB resolution for Notion's PreToolUse hook.
 *
 * RFC reference/rfcs/notion-integration.md §8.2.
 *
 * For each Notion MCP write tool, the PreToolUse hook needs to know
 * the parent database UUID of the target page/block so the allowlist
 * gate can decide whether to allow the call.
 *
 * Notion tool shapes (verified against @notionhq/notion-mcp-server
 * v1.8.x at design time):
 *
 *   - `create_page` with `parent.database_id` → free (in args)
 *   - `create_page` with `parent.page_id` → 1 call (page → DB)
 *   - `update_page` (page_id in args) → 1 call
 *   - `update_block` / `delete_block` / `append_block_children`
 *     (block_id in args) → 1–4 calls (block → page → DB walk, bounded)
 *   - `create_comment` with `parent.page_id` → 1 call
 *   - `query_database` / `update_database` (DB id in args) → free
 *   - `get_page` / `get_block_children` (page/block id in args) → 1+ calls
 *
 * Three return outcomes:
 *   - "db" — resolved to a database UUID; pass to allowlist check.
 *   - "no-db" — the target is a standalone page or workspace page with
 *     no DB ancestor. §6.2 rule 2: hard-deny in v1.
 *   - "error" — the API walk failed (network, 404, etc.). Caller
 *     should fail-closed (deny the tool call).
 *
 * The resolver is dependency-injected — the caller passes a Notion
 * REST client and a cache. Both are testable in isolation.
 */

import type { PageDbCache } from "./page-db-cache.js";

/**
 * Max walk depth before we give up and call it "no-db".
 *
 * Raised from 4 → 6 in v0.13.55 follow-up: Notion blocks can nest
 * deeper than the original budget (column → callout → toggle →
 * sub-block → page → DB is 5 hops). 4 was an over-aggressive cap
 * that surfaced as fail-closed denials on legitimately nested
 * pages. 6 gives margin without unbounding the walk.
 *
 * IMPORTANT: when the depth cap is hit, we do NOT cache the result
 * as `null` (no-db) — caching would poison subsequent lookups for
 * the same node. Instead we return `no-db` for the current call but
 * leave the cache untouched so the next lookup re-walks (and may
 * succeed if the API was transiently slow on the prior call). See
 * `resolveDbForNode` end-of-walk handling.
 */
export const MAX_WALK_DEPTH = 6;

export type ResolutionResult =
  | { kind: "db"; dbId: string; apiCalls: number }
  | { kind: "no-db"; apiCalls: number }
  | { kind: "error"; reason: string; apiCalls: number };

/**
 * Minimal Notion REST client surface — implement-as-mocked-in-tests.
 * Production wiring lives in `src/notion/api-client.ts`.
 */
export interface NotionApiClient {
  /** Returns the page object — at minimum `parent`. */
  getPage(pageId: string): Promise<{
    parent:
      | { type: "database_id"; database_id: string }
      | { type: "page_id"; page_id: string }
      | { type: "workspace"; workspace: true }
      | { type: "block_id"; block_id: string };
  }>;
  /** Returns the block object — at minimum `parent`. */
  getBlock(blockId: string): Promise<{
    parent:
      | { type: "page_id"; page_id: string }
      | { type: "block_id"; block_id: string }
      | { type: "database_id"; database_id: string }
      | { type: "workspace"; workspace: true };
  }>;
}

/**
 * Resolve the parent DB UUID for a given starting node (page or block).
 *
 * Walks up Notion's parent chain (block → page → DB / workspace) using
 * the cache to short-circuit known nodes. Bounded by MAX_WALK_DEPTH —
 * deeper chains short-circuit to "no-db" (the deep ancestor is almost
 * always the workspace root, which we hard-deny).
 */
export async function resolveDbForNode(
  startId: string,
  startKind: "page" | "block",
  client: NotionApiClient,
  cache: PageDbCache,
): Promise<ResolutionResult> {
  let apiCalls = 0;
  const visited = new Set<string>();
  let currentId = startId;
  let currentKind: "page" | "block" = startKind;

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (visited.has(currentId)) {
      // Cycle (shouldn't happen but defensive).
      return {
        kind: "error",
        reason: `parent cycle at ${currentId}`,
        apiCalls,
      };
    }
    visited.add(currentId);

    // Cache check — if a freshly-known answer exists for this node,
    // short-circuit.
    const cached = cache.get(currentId);
    if (cached.kind === "hit" || cached.kind === "stale") {
      if (cached.dbId === null) {
        return { kind: "no-db", apiCalls };
      }
      return { kind: "db", dbId: cached.dbId, apiCalls };
    }

    // API fetch.
    let parent: Awaited<ReturnType<NotionApiClient["getPage"]>>["parent"];
    try {
      if (currentKind === "page") {
        parent = (await client.getPage(currentId)).parent;
      } else {
        parent = (await client.getBlock(currentId)).parent;
      }
      apiCalls += 1;
    } catch (err) {
      return {
        kind: "error",
        reason: (err as Error).message,
        apiCalls,
      };
    }

    if (parent.type === "database_id") {
      cache.set(startId, parent.database_id);
      // Don't write the intermediate nodes — only the START id maps
      // to the eventual DB. Intermediates can have ambiguous status
      // (a "page" parent of one tool call might be the same as a
      // "block" parent in another, but block→page resolution loses
      // that distinction).
      return { kind: "db", dbId: parent.database_id, apiCalls };
    }
    if (parent.type === "workspace") {
      cache.set(startId, null);
      return { kind: "no-db", apiCalls };
    }
    if (parent.type === "page_id") {
      currentId = parent.page_id;
      currentKind = "page";
      continue;
    }
    if (parent.type === "block_id") {
      currentId = parent.block_id;
      currentKind = "block";
      continue;
    }
    return {
      kind: "error",
      reason: `unknown parent.type at ${currentId}`,
      apiCalls,
    };
  }

  // Hit walk-depth cap. Deny THIS call (fail-closed), but DO NOT
  // poison the cache with `null`. If we cached `null`, every future
  // lookup of the same node would short-circuit to no-db forever
  // — even if the real chain is only one hop deeper than the cap.
  // Returning `no-db` without writing to cache lets the next call
  // re-walk fresh (and possibly succeed if MAX_WALK_DEPTH gets
  // raised, or if the deeper page gets moved closer to its DB).
  return { kind: "no-db", apiCalls };
}

/**
 * Tool-shape dispatcher. Given a Notion tool name + its raw args,
 * decides which resolver call to make (or short-circuits if the DB id
 * is directly in args, or if the tool is `create_database` which is
 * v1-banned).
 *
 * Returns the resolution outcome directly. The PreToolUse hook calls
 * this once per tool invocation and feeds the result into the
 * allowlist predicate (`agentCanAccessNotionDB`).
 *
 * Tools NOT in this dispatch table fail-open to "no-db" (the
 * allowlist predicate rejects them, which is the right v1 behaviour:
 * unknown tools must not be allowed without an explicit allowlist
 * entry). A future PR adding a new Notion tool name must add a
 * dispatch entry here at the same time.
 */
export type ToolDispatchOutcome =
  | { kind: "banned-tool"; toolName: string }
  | { kind: "args-resolved"; dbId: string | null }
  | { kind: "walk-required"; startId: string; startKind: "page" | "block" }
  | { kind: "args-malformed"; reason: string };

export function dispatchTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
): ToolDispatchOutcome {
  // RFC §6.2 rule 3: create_database is v1-banned.
  if (toolName === "create_database" || toolName === "create-database") {
    return { kind: "banned-tool", toolName };
  }

  if (!args || typeof args !== "object") {
    return { kind: "args-malformed", reason: "missing or non-object args" };
  }

  switch (toolName) {
    case "query_database":
    case "query-database":
    case "update_database":
    case "update-database":
    case "retrieve_database":
    case "retrieve-database": {
      const id = readStringField(args, ["database_id"]);
      if (!id) {
        return {
          kind: "args-malformed",
          reason: `missing database_id in ${toolName}`,
        };
      }
      return { kind: "args-resolved", dbId: id };
    }

    case "create_page":
    case "create-page": {
      const parent = args.parent as
        | { database_id?: string; page_id?: string; type?: string }
        | undefined;
      if (parent && typeof parent === "object") {
        if (typeof parent.database_id === "string") {
          return { kind: "args-resolved", dbId: parent.database_id };
        }
        if (typeof parent.page_id === "string") {
          return {
            kind: "walk-required",
            startId: parent.page_id,
            startKind: "page",
          };
        }
      }
      return {
        kind: "args-malformed",
        reason: "create_page missing parent.database_id or parent.page_id",
      };
    }

    case "update_page":
    case "update-page":
    case "retrieve_page":
    case "retrieve-page":
    case "get_page":
    case "get-page": {
      const id = readStringField(args, ["page_id"]);
      if (!id) {
        return {
          kind: "args-malformed",
          reason: `missing page_id in ${toolName}`,
        };
      }
      return { kind: "walk-required", startId: id, startKind: "page" };
    }

    case "update_block":
    case "update-block":
    case "delete_block":
    case "delete-block":
    case "retrieve_block":
    case "retrieve-block":
    case "get_block":
    case "get-block":
    case "get_block_children":
    case "get-block-children":
    case "append_block_children":
    case "append-block-children": {
      const id = readStringField(args, ["block_id"]);
      if (!id) {
        return {
          kind: "args-malformed",
          reason: `missing block_id in ${toolName}`,
        };
      }
      return { kind: "walk-required", startId: id, startKind: "block" };
    }

    case "create_comment":
    case "create-comment": {
      const parent = args.parent as
        | { page_id?: string }
        | undefined;
      if (parent?.page_id && typeof parent.page_id === "string") {
        return {
          kind: "walk-required",
          startId: parent.page_id,
          startKind: "page",
        };
      }
      // create_comment can also target a discussion_id which lives
      // attached to a page; v1 path requires walking from the page.
      return {
        kind: "args-malformed",
        reason: "create_comment requires parent.page_id (discussion-id targets not supported v1)",
      };
    }

    case "retrieve_comment":
    case "retrieve-comment":
    case "get_comment":
    case "get-comment": {
      // Comments are addressed by block_id (the page the comment is on).
      const id = readStringField(args, ["block_id"]);
      if (!id) {
        return {
          kind: "args-malformed",
          reason: `missing block_id in ${toolName}`,
        };
      }
      return { kind: "walk-required", startId: id, startKind: "block" };
    }

    // search is handled by the post-filter (§8.5), not the dispatcher.
    case "search":
      return {
        kind: "args-malformed",
        reason: "search dispatch handled separately by post-filter",
      };
  }

  return {
    kind: "args-malformed",
    reason: `unknown notion tool ${toolName} — refusing by default`,
  };
}

function readStringField(
  obj: Record<string, unknown>,
  paths: string[],
): string | null {
  for (const p of paths) {
    const v = obj[p];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
