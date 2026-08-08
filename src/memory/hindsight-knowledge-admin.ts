/**
 * Knowledge-page READS over the Hindsight REST API — the implementation
 * behind the shim-synthesized `search_knowledge_pages` /
 * `get_knowledge_page` / `get_knowledge_tree` MCP tools.
 *
 * ## Why REST and not MCP
 *
 * Hindsight 0.9.0 ships a complete Knowledge Base REST surface
 * (`/v1/default/banks/{bank_id}/knowledge-base/...`) and registers ZERO
 * knowledge tools on its MCP surface — verified against the running image's
 * `hindsight_api/mcp_tools.py`, and pinned by
 * `tests/fixtures/hindsight-tools-list.snapshot.json`, which contains no
 * `*_knowledge_*` entry. So an agent's curated pages — the thing the bank is
 * for once memories have been consolidated — are simply not reachable from a
 * tool call. This module is the narrow, named alternative, exactly as
 * `hindsight-directive-admin.ts` is for directive retirement.
 *
 * Upstream's own answer is a SEPARATE npm MCP sidecar
 * (`hindsight-integrations/coding-agents`, `src/core/knowledge-tools.ts`).
 * Deliberately not adopted: it is a second MCP server per agent (a second
 * startup dependency the shim exists to remove), it resolves its own bank
 * rather than honouring `HINDSIGHT_BANK_ID`, it needs an npm dependency in
 * every container, and it drags ungated WRITE tools (`capture_initiative`,
 * `ingest_document`) along with the reads. We take the three reads only.
 *
 * ## Read-only is enforced by construction, not by convention
 *
 * The REST surface underneath also offers `POST .../pages`,
 * `POST .../folders`, `PATCH .../nodes/{id}` and `DELETE .../nodes/{id}` —
 * page authorship and deletion. None of them is reachable from here: this
 * class has exactly three methods, all of them reads, and its ONLY network
 * primitive ({@link KnowledgeAdmin.get}) hard-codes `method: "GET"` with no
 * parameter to override it. Adding a write would mean adding a method AND a
 * second primitive, both of which red
 * `tests/hindsight-knowledge-admin.test.ts`'s prototype inventory.
 *
 * That matters because page CRUD is destructive with no undo — `DELETE
 * .../nodes/{id}` removes a page and, upstream, its backing mental model.
 * Page authorship stays where it already is: the operator-approved
 * `mental_model_propose` card.
 *
 * ## The bank pin is a USABILITY AND PROVENANCE boundary, NOT A SECURITY ONE
 *
 * `bankId` is pinned here from the agent's own `HINDSIGHT_BANK_ID` and the
 * tool schemas expose no `bank_id` property, so a *tool call* physically
 * cannot read another agent's pages. That is the entire extent of the
 * guarantee — the REST transport is unauthenticated, so raw curl from an
 * agent's Bash bypasses this module entirely. The full statement is in the
 * header of `src/memory/hindsight-directive-admin.ts`; nothing here changes
 * it, and these being READS makes the residual exposure strictly smaller than
 * the directive path's.
 */

/** One hybrid-search hit (`KnowledgePageSearchResult` upstream). */
export interface KnowledgePageSearchResult {
  id: string;
  name: string;
  mental_model_id?: string | null;
  snippet: string;
  score: number;
  updated_at?: string | null;
}

/** `GET .../knowledge-base/search` response. */
export interface KnowledgePageSearchResponse {
  results: KnowledgePageSearchResult[];
  total: number;
}

/** `GET .../knowledge-base/pages/{id}` response (`KnowledgePageResponse`). */
export interface KnowledgePage {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  tags?: string[];
  timestamp?: string | null;
  body?: string | null;
  /** The full markdown document: YAML frontmatter + markdown body. */
  markdown: string;
}

/** One node of the knowledge tree (`KnowledgeNode` upstream). */
export interface KnowledgeNode {
  id: string;
  kind: "folder" | "page";
  name: string;
  parent_id?: string | null;
  mental_model_id?: string | null;
  managed?: boolean;
  description?: string | null;
  tags?: string[];
  timestamp?: string | null;
  /** Pages only, populated by the tree endpoint. */
  is_stale?: boolean | null;
  children?: KnowledgeNode[];
}

/** `GET .../knowledge-base/tree` response. */
export interface KnowledgeTree {
  roots: KnowledgeNode[];
}

/**
 * Search limit bounds, mirroring the upstream Query declaration
 * (`limit: int = Query(10, ge=1, le=50)`). Out-of-range is a 422 upstream, so
 * the value is clamped here rather than forwarded — a caller asking for 200
 * results gets the 50 the server can give, not a validation error it cannot
 * act on.
 */
export const KNOWLEDGE_SEARCH_LIMIT_MIN = 1;
export const KNOWLEDGE_SEARCH_LIMIT_MAX = 50;
export const KNOWLEDGE_SEARCH_LIMIT_DEFAULT = 10;

/** Clamp to the server's accepted range. Exported so a test can pin it. */
export function clampKnowledgeSearchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return KNOWLEDGE_SEARCH_LIMIT_DEFAULT;
  }
  return Math.min(
    KNOWLEDGE_SEARCH_LIMIT_MAX,
    Math.max(KNOWLEDGE_SEARCH_LIMIT_MIN, Math.trunc(limit)),
  );
}

export interface KnowledgeAdminOptions {
  /** REST base, e.g. `http://127.0.0.1:18888` (no trailing slash). */
  apiBaseUrl: string;
  /**
   * The agent's OWN bank. Pinned: every request path this module builds
   * embeds this value, and no caller-supplied input can reach it.
   */
  bankId: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export const KNOWLEDGE_ADMIN_TIMEOUT_MS = 15_000;

/**
 * Read-only client for one bank's knowledge base.
 *
 * Three methods, all GET. See the header for why that is a construction-time
 * property rather than a convention.
 */
export class KnowledgeAdmin {
  constructor(private readonly opts: KnowledgeAdminOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /**
   * Base path for THIS agent's knowledge base. The bank segment comes from
   * `opts.bankId` only — there is no parameter, so no caller can redirect it.
   */
  private knowledgeBasePath(): string {
    const base = this.opts.apiBaseUrl.replace(/\/+$/, "");
    return `${base}/v1/default/banks/${encodeURIComponent(this.opts.bankId)}/knowledge-base`;
  }

  /**
   * The ONLY network primitive in this class, and it takes no method
   * parameter. A write would need a second primitive alongside it, which is
   * the reviewable act.
   */
  private async get(url: string): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(),
      this.opts.timeoutMs ?? KNOWLEDGE_ADMIN_TIMEOUT_MS,
    );
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          // Advisory only — the REST layer ignores it. Sent for parity with
          // the shim's MCP path and so request logs carry the intent.
          ...(this.opts.bankId ? { "X-Bank-Id": this.opts.bankId } : {}),
        },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hybrid (BM25 + vector) search over the pinned bank's knowledge pages.
   *
   * An empty bank answers `{results: [], total: 0}` with HTTP 200 — an empty
   * result, never an error, so a fresh agent asking about its own knowledge
   * gets "nothing yet" rather than a failure it has to interpret.
   */
  async search(args: {
    query: string;
    limit?: number;
  }): Promise<KnowledgePageSearchResponse> {
    const params = new URLSearchParams({
      q: args.query,
      limit: String(clampKnowledgeSearchLimit(args.limit)),
    });
    const res = await this.get(`${this.knowledgeBasePath()}/search?${params}`);
    if (!res.ok) {
      throw new Error(
        `searching knowledge pages in bank '${this.opts.bankId}' failed: HTTP ${res.status}`,
      );
    }
    const parsed = (await res.json()) as Partial<KnowledgePageSearchResponse>;
    const results = parsed.results ?? [];
    return { results, total: parsed.total ?? results.length };
  }

  /**
   * One page as a markdown document (YAML frontmatter + body).
   *
   * A pure read: upstream's handler resolves the page and renders it, with no
   * lazy-refresh side effect, so reading a stale page never triggers a
   * consolidation run. Staleness is reported by {@link KnowledgeAdmin.tree}
   * instead.
   */
  async getPage(args: { page_id: string }): Promise<KnowledgePage> {
    const res = await this.get(
      `${this.knowledgeBasePath()}/pages/${encodeURIComponent(args.page_id)}`,
    );
    if (res.status === 404) {
      throw new Error(
        `no knowledge page '${args.page_id}' in bank '${this.opts.bankId}'. ` +
          `Page ids come from search_knowledge_pages or get_knowledge_tree.`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `reading knowledge page '${args.page_id}' in bank ` +
          `'${this.opts.bankId}' failed: HTTP ${res.status}`,
      );
    }
    return (await res.json()) as KnowledgePage;
  }

  /** The pinned bank's folder/page tree, including per-page `is_stale`. */
  async tree(): Promise<KnowledgeTree> {
    const res = await this.get(`${this.knowledgeBasePath()}/tree`);
    if (!res.ok) {
      throw new Error(
        `listing the knowledge tree in bank '${this.opts.bankId}' failed: HTTP ${res.status}`,
      );
    }
    const parsed = (await res.json()) as Partial<KnowledgeTree>;
    return { roots: parsed.roots ?? [] };
  }
}

/**
 * The COMPLETE inventory of `KnowledgeAdmin.prototype`'s own properties.
 *
 * Exported so the test can assert the member set directly rather than
 * inferring read-only-ness from behaviour — the same mechanism-not-comment
 * move as `buildDirectivePatchBody`'s key-set assertion. TypeScript's
 * `private` is erased at runtime, so a `createPage` added anywhere in the
 * class body appears here and reds the test, whether or not it is exported
 * API.
 */
export const KNOWLEDGE_ADMIN_MEMBERS = [
  "constructor",
  "fetchImpl",
  "get",
  "getPage",
  "knowledgeBasePath",
  "search",
  "tree",
];
