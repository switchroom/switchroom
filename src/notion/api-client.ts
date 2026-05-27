/**
 * Minimal Notion REST client — just the calls the PreToolUse hook
 * makes itself: getPage, getBlock (for resolver walks), and search
 * (for the post-filter to fetch result metadata).
 *
 * NOT a full Notion SDK; the MCP server is the agent-facing SDK.
 * This is the hook's private hatchet, used only when the PreToolUse
 * gate needs to peek at Notion to compute the allowlist verdict.
 *
 * RFC docs/rfcs/notion-integration.md PR 3.
 */

import type { NotionApiClient } from "./db-resolver.js";

export interface NotionFetchHttpOptions {
  /** Authorization bearer token. */
  token: string;
  /** Override the API base. Default `https://api.notion.com`. */
  base?: string;
  /** Notion-Version header value. Default `2022-06-28`. */
  notionVersion?: string;
  /** Injectable fetch — tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** Override request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

const DEFAULT_BASE = "https://api.notion.com";
const DEFAULT_VERSION = "2022-06-28";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Build the live API client. Returns the NotionApiClient interface
 * the resolver consumes, plus a `search` method the post-filter uses.
 */
export function createNotionApiClient(
  opts: NotionFetchHttpOptions,
): NotionApiClient & {
  search(query: string, pageSize?: number): Promise<NotionSearchResponse>;
} {
  const base = opts.base ?? DEFAULT_BASE;
  const version = opts.notionVersion ?? DEFAULT_VERSION;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${opts.token}`,
          "Notion-Version": version,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          // ignore
        }
        throw new Error(
          `Notion API ${method} ${path} failed: ${res.status} ${res.statusText}${
            detail ? ` — ${detail.slice(0, 200)}` : ""
          }`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getPage(pageId: string) {
      const data = await request<{
        parent: Awaited<ReturnType<NotionApiClient["getPage"]>>["parent"];
      }>("GET", `/v1/pages/${encodeURIComponent(pageId)}`);
      return { parent: data.parent };
    },
    async getBlock(blockId: string) {
      const data = await request<{
        parent: Awaited<ReturnType<NotionApiClient["getBlock"]>>["parent"];
      }>("GET", `/v1/blocks/${encodeURIComponent(blockId)}`);
      return { parent: data.parent };
    },
    async search(query: string, pageSize = 20) {
      return await request<NotionSearchResponse>("POST", "/v1/search", {
        query,
        page_size: pageSize,
      });
    },
  };
}

export interface NotionSearchResult {
  object: "page" | "database" | "block";
  id: string;
  parent?:
    | { type: "database_id"; database_id: string }
    | { type: "page_id"; page_id: string }
    | { type: "workspace"; workspace: true }
    | { type: "block_id"; block_id: string };
  /** Title is in `properties.title` (DB items) or `properties.<name>.title` (other DBs). Best-effort. */
  properties?: Record<string, unknown>;
  url?: string;
}

export interface NotionSearchResponse {
  results: NotionSearchResult[];
  next_cursor: string | null;
  has_more: boolean;
}
