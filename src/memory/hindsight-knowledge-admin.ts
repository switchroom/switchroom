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
 * (`limit: int = Query(10, ge=1, le=50)`).
 *
 * The clamp below is a LOWER-LAYER BACKSTOP, not the policy an agent sees.
 * Out-of-range is a 422 upstream, so a non-shim caller of this module (a
 * script, a future CLI subcommand) that asks for 200 gets the 50 the server
 * can give rather than a validation error it cannot act on. The MCP shim layer
 * does NOT rely on it: `coerceSynthesizedArg`
 * (`src/cli/hindsight-mcp-shim.ts`) REJECTS an out-of-range `limit` before the
 * call ever reaches here, because the bound is in the schema the model was
 * shown and a silently-clamped `limit: 500` reads to the model as "you got 500
 * hits" when it got 50. Two layers, two different right answers.
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
 * Accepted shape of a knowledge-node id.
 *
 * Matches what upstream actually mints: `create_knowledge_page` builds
 * `f"kp-{uuid.uuid4().hex}"` and `create_knowledge_folder` the `kf-` twin
 * (hindsight 0.9.0, `hindsight_api/engine/memory_engine.py:13477`), so
 * `[A-Za-z0-9_-]+` covers every real id with room for a future uuid spelling
 * that carries dashes.
 *
 * The reason it is enforced rather than merely documented is `.` and `..`:
 * `encodeURIComponent("..")` is `..` verbatim, and the URL parser then
 * collapses the segment, so `page_id: ".."` turns
 * `.../knowledge-base/pages/..` into a GET of `.../knowledge-base/` — a
 * different endpoint whose body would then be cast to `KnowledgePage` and
 * handed to the agent as if it were a page. Not a bank-escape (single level,
 * GET, own bank only), but an unintended endpoint is not something a page read
 * should be able to reach.
 */
export const KNOWLEDGE_PAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
    // `Array.isArray`, not `?? []`. A malformed `{"results": "stringy"}` has a
    // truthy `.length`, so a nullish-coalesce alone would sail past the
    // empty-result check and the shim would stringify a STRING as if it were
    // the hit list — an isError:false answer that is not hits.
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return {
      results,
      total: typeof parsed.total === "number" ? parsed.total : results.length,
    };
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
    if (!KNOWLEDGE_PAGE_ID_PATTERN.test(args.page_id)) {
      throw new Error(
        `'${args.page_id}' is not a knowledge page id. Ids look like ` +
          `'kp-<hex>' (letters, digits, '-' and '_' only) and come from ` +
          `search_knowledge_pages or get_knowledge_tree.`,
      );
    }
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
    const page = (await res.json()) as Partial<KnowledgePage>;
    // The ONLY field the caller actually renders. Unvalidated, a response that
    // omits it (field rename on an image bump, or an explicit `markdown: null`)
    // makes the shim emit `{"type":"text"}` with no `text` key — a content
    // block that fails MCP client schema validation while `isError` is false,
    // i.e. a read that silently failed. Fail loudly and name the page instead.
    if (typeof page.markdown !== "string") {
      throw new Error(
        `knowledge page '${args.page_id}' in bank '${this.opts.bankId}' came ` +
          `back with no markdown body — the response had no string 'markdown' ` +
          `field, so there is nothing to read.`,
      );
    }
    return page as KnowledgePage;
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
    // Same hole as `search()`: a non-array `roots` must read as "no tree", not
    // as a tree, or the shim renders a scalar as the agent's knowledge base.
    return { roots: Array.isArray(parsed.roots) ? parsed.roots : [] };
  }
}

/**
 * The COMPLETE inventory of `KnowledgeAdmin.prototype`'s own properties.
 *
 * Exported so the test can assert the member set directly rather than
 * inferring read-only-ness from behaviour — the same mechanism-not-comment
 * move as `buildDirectivePatchBody`'s key-set assertion.
 *
 * WHAT THIS COVERS, exactly: prototype members. TypeScript's `private` is
 * erased at runtime, so a `createPage()` declared as a normal (or `private`)
 * METHOD lands on the prototype, appears here, and reds
 * `tests/hindsight-knowledge-admin.test.ts`.
 *
 * WHAT IT DOES NOT COVER, and why the test pairs it with two more assertions:
 *   • a write installed as a class FIELD (`createPage = async () => …`) is an
 *     INSTANCE own-property, not a prototype one — the test therefore also
 *     asserts a constructed instance has no function-valued own key;
 *   • a `static` method, and a plain exported module-level function, are on
 *     neither — nothing here sees those. The backstop for both is the
 *     behavioural assertion that no non-GET request ever reaches the mock API,
 *     plus review of this file's diff.
 * Neither this list nor the instance check is a substitute for reading the
 * diff; they are the two cheap mechanical tripwires.
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
