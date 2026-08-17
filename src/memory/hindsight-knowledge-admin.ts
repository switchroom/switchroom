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
 * ## The bank selector is a USABILITY AND PROVENANCE boundary, NOT A SECURITY ONE
 *
 * `bankId` pins the agent's OWN bank (from `HINDSIGHT_BANK_ID`) and remains the
 * default for every read. `extraBanks` is the operator-granted set of ADDITIONAL
 * banks this agent may read — rendered per agent at apply time from the same
 * `memory.recall.additional_banks` config that already fans the recall hook out
 * to those banks (design-v2 §10, W-2). A read may name a bank via the tool's
 * optional `bank_id` selector, and {@link KnowledgeAdmin.resolveBank} validates
 * it against `{own} ∪ extraBanks`:
 *
 *   - omitted / own bank        → own bank (unchanged default);
 *   - a bank in `extraBanks`    → that bank (the granted cross-bank read);
 *   - anything else             → LOUD rejection ({@link KnowledgeBankNotGrantedError}),
 *                                 never silently coerced to the agent's own bank.
 *
 * The invariant this preserves is narrow and the one that matters: a caller may
 * SELECT among operator-granted banks; it can never MINT reach. `extraBanks`
 * comes only from constructor options (operator config); there is no parameter
 * path from a tool call to that set. Rev-11/E-95: this is a shim-layer
 * relaxation of OUR own designed pin, not a platform capability — the engine's
 * knowledge-base REST routes are already bank-parameterised.
 *
 * That is the entire extent of the guarantee — the REST transport is
 * unauthenticated, so raw curl from an agent's Bash bypasses this module
 * entirely. The full statement is in the header of
 * `src/memory/hindsight-directive-admin.ts`; nothing here changes it, and these
 * being READS makes the residual exposure strictly smaller than the directive
 * path's. WRITES stay fully pinned — this module has no write, and directive
 * writes elsewhere keep their own-bank pin (W-2 pt 2).
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
   * The agent's OWN bank and the default target of every read. A read reaches
   * a DIFFERENT bank only when a caller-supplied `bank_id` names one in
   * {@link KnowledgeAdminOptions.extraBanks}; anything else is loud-rejected.
   */
  bankId: string;
  /**
   * Operator-granted ADDITIONAL banks this agent may read (design-v2 §10, W-2).
   * The ONLY source of cross-bank reach: it comes from operator config
   * (rendered into `HINDSIGHT_KNOWLEDGE_EXTRA_BANKS` at apply from
   * `memory.recall.additional_banks`), never from a tool call. Empty/undefined
   * ⇒ own-bank-only, i.e. the pre-W-2 behaviour exactly.
   */
  extraBanks?: readonly string[];
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/**
 * Thrown when a caller-supplied `bank_id` is neither the agent's own bank nor
 * one of the operator-granted {@link KnowledgeAdminOptions.extraBanks}.
 *
 * A distinct type so the shim can render it as a clean, loud VALIDATION
 * rejection (the ungranted bank is named, the grant set is named) rather than
 * as a generic "tool failed" — the anti-silent-drop property W-2 pt 1 requires:
 * an ungranted bank is rejected loudly, never coerced to the caller's own.
 */
export class KnowledgeBankNotGrantedError extends Error {
  constructor(
    readonly requested: string,
    readonly ownBankId: string,
    readonly grantedBanks: readonly string[],
  ) {
    super(
      grantedBanks.length > 0
        ? `bank_id '${requested}' is not a bank you can read. You may read your ` +
            `own bank ('${ownBankId}') or an operator-granted bank ` +
            `(${grantedBanks.map((b) => `'${b}'`).join(", ")}); '${requested}' ` +
            `is none of these. Omit bank_id to read your own memory bank.`
        : `bank_id '${requested}' is not your own bank ('${ownBankId}'), and ` +
            `this agent has not been granted any other bank to read. Omit ` +
            `bank_id to read your own memory bank.`,
    );
    this.name = "KnowledgeBankNotGrantedError";
  }
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
   * Resolve the bank a read targets, validating a caller-supplied selector
   * against `{own} ∪ extraBanks`. The single authority for cross-bank reach:
   *
   *   - `undefined` / `""` / the own bank → own bank (unchanged default);
   *   - a bank in `extraBanks`            → that bank (operator-granted read);
   *   - anything else                     → throws {@link KnowledgeBankNotGrantedError}.
   *
   * `extraBanks` is read from constructor options only, so no tool call can
   * widen the set — a caller SELECTS among grants, it never MINTS reach.
   */
  private resolveBank(requested?: string): string {
    const own = this.opts.bankId;
    if (requested === undefined || requested === "" || requested === own) {
      return own;
    }
    if ((this.opts.extraBanks ?? []).includes(requested)) return requested;
    throw new KnowledgeBankNotGrantedError(requested, own, [
      ...(this.opts.extraBanks ?? []),
    ]);
  }

  /**
   * Base path for a knowledge base. The bank segment is the ALREADY-RESOLVED
   * bank ({@link KnowledgeAdmin.resolveBank}), so no un-validated caller input
   * can reach it.
   */
  private knowledgeBasePath(bankId: string): string {
    const base = this.opts.apiBaseUrl.replace(/\/+$/, "");
    return `${base}/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base`;
  }

  /**
   * The ONLY network primitive in this class, and it takes no method
   * parameter. A write would need a second primitive alongside it, which is
   * the reviewable act. `bankId` is the resolved target, echoed into the
   * advisory header.
   */
  private async get(url: string, bankId: string): Promise<Response> {
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
          // the shim's MCP path and so request logs carry the intent. Reflects
          // the RESOLVED target bank, not necessarily the agent's own.
          ...(bankId ? { "X-Bank-Id": bankId } : {}),
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
    bankId?: string;
  }): Promise<KnowledgePageSearchResponse> {
    const bank = this.resolveBank(args.bankId);
    const params = new URLSearchParams({
      q: args.query,
      limit: String(clampKnowledgeSearchLimit(args.limit)),
    });
    const res = await this.get(
      `${this.knowledgeBasePath(bank)}/search?${params}`,
      bank,
    );
    if (!res.ok) {
      throw new Error(
        `searching knowledge pages in bank '${bank}' failed: HTTP ${res.status}`,
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
  async getPage(args: { page_id: string; bankId?: string }): Promise<KnowledgePage> {
    if (!KNOWLEDGE_PAGE_ID_PATTERN.test(args.page_id)) {
      throw new Error(
        `'${args.page_id}' is not a knowledge page id. Ids look like ` +
          `'kp-<hex>' (letters, digits, '-' and '_' only) and come from ` +
          `search_knowledge_pages or get_knowledge_tree.`,
      );
    }
    const bank = this.resolveBank(args.bankId);
    const res = await this.get(
      `${this.knowledgeBasePath(bank)}/pages/${encodeURIComponent(args.page_id)}`,
      bank,
    );
    if (res.status === 404) {
      throw new Error(
        `no knowledge page '${args.page_id}' in bank '${bank}'. ` +
          `Page ids come from search_knowledge_pages or get_knowledge_tree.`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `reading knowledge page '${args.page_id}' in bank ` +
          `'${bank}' failed: HTTP ${res.status}`,
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
        `knowledge page '${args.page_id}' in bank '${bank}' came ` +
          `back with no markdown body — the response had no string 'markdown' ` +
          `field, so there is nothing to read.`,
      );
    }
    return page as KnowledgePage;
  }

  /**
   * A bank's folder/page tree, including per-page `is_stale`. Defaults to the
   * agent's own bank; `bankId` may name an operator-granted bank.
   */
  async tree(args: { bankId?: string } = {}): Promise<KnowledgeTree> {
    const bank = this.resolveBank(args.bankId);
    const res = await this.get(`${this.knowledgeBasePath(bank)}/tree`, bank);
    if (!res.ok) {
      throw new Error(
        `listing the knowledge tree in bank '${bank}' failed: HTTP ${res.status}`,
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
  // Bank-selector validation (W-2). A pure read helper — issues no request, so
  // the GET-only behavioural assertion stays green.
  "resolveBank",
  "search",
  "tree",
];
