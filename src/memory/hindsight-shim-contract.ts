/**
 * Engine version pin + REST route contract for the hindsight-mcp-shim's
 * SYNTHESIZED tools (`deactivate_directive`, `reactivate_directive`,
 * `search_knowledge_pages`, `get_knowledge_page`, `get_knowledge_tree`) —
 * the piece design-v2.md §2.5 named as owed and never built ("a grep of the
 * shipped shim finds no `/openapi.json` reference, so the pin is not built").
 *
 * ## Why `/openapi.json` and not `/version`
 *
 * `/version` (already consumed by `doctor-memory.ts`'s
 * `classifyHindsightVersionSkew`) returns a single `api_version` scalar and
 * nothing about which REST routes exist. That check protects the MCP
 * `tools/list` contract (`classifyToolContract` / `EXPECTED_HINDSIGHT_TOOLS`)
 * — but the five tools this module cares about are NOT MCP tools at all.
 * They are hand-rolled REST calls (`DirectiveAdmin` PATCHing
 * `/directives/{id}`, `KnowledgeAdmin` GETing the `/knowledge-base/*`
 * surface) that exist only because the pinned image's MCP surface has no
 * directive-update or knowledge tool (see the header comments of
 * `hindsight-directive-admin.ts` / `hindsight-knowledge-admin.ts`). A
 * `tools/list` diff can never notice one of those REST routes moving,
 * because it never looks at REST at all. `/openapi.json` is the one live
 * document that actually enumerates REST paths + methods, so it is the only
 * honest ground truth for this contract (design-v2.md §2.5, "E-01's
 * method").
 *
 * ## Fail-loud, not fail-hard
 *
 * The shim's own rule (`hindsight-mcp-shim.ts`'s module header,
 * `synthesizedCall`) is that a synthesized tool must fail LOUDLY at call
 * time, never degrade quietly. `ShimContractPin.preflight` extends that rule
 * to route drift: when `/openapi.json` PROVES a synthesized tool's
 * underlying route is gone, the call is rejected before it ever reaches the
 * REST layer, naming the missing route(s) — instead of a bare 404 the model
 * has to interpret unaided.
 *
 * It deliberately does NOT crash the shim at startup, and does NOT block a
 * call just because the probe itself failed: `initialize` must always
 * succeed with the backend down or old — that is the entire reason the shim
 * exists (see `hindsight-mcp-shim.ts`'s header) — and an unreachable or
 * malformed `/openapi.json` degrades to "unknown, proceed" so the REST layer
 * remains the backstop (it already answers its own honest `isError` on a
 * down/wrong backend). Only a CONFIRMED-missing route is rejected pre-flight;
 * everything else is unchanged behaviour.
 */

/** The subset of an OpenAPI 3 document this module reads. */
export interface OpenApiSpec {
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown> | undefined>;
}

/** Timeout for the `/openapi.json` fetch. Short: never worth blocking a call on. */
export const OPENAPI_FETCH_TIMEOUT_MS = 3_000;

/** One REST route + method a synthesized tool's implementation depends on. */
export interface RouteRequirement {
  /** Path exactly as `/openapi.json` spells it (e.g. `{bank_id}` placeholders). */
  path: string;
  method: string;
}

/**
 * The REST route(s) each synthesized tool's implementation actually calls.
 * MUST mirror `DirectiveAdmin`'s and `KnowledgeAdmin`'s real request paths —
 * kept here, not derived from those classes, so drift between "what the code
 * calls" and "what this module checks" is a reviewable diff. The same
 * discipline `FALLBACK_TOOL_TABLE` documents for the MCP surface
 * (`hindsight-mcp-shim.ts`).
 *
 * `deactivate_directive`/`reactivate_directive` both need the LIST route too
 * (`DirectiveAdmin.list()`/`.resolve()` — every deactivate/reactivate reads
 * the full directive list first to resolve a name to an id) as well as the
 * PATCH route that actually flips `is_active`.
 */
export const SYNTHESIZED_TOOL_ROUTES: Record<string, RouteRequirement[]> = {
  deactivate_directive: [
    { path: "/v1/default/banks/{bank_id}/directives", method: "get" },
    {
      path: "/v1/default/banks/{bank_id}/directives/{directive_id}",
      method: "patch",
    },
  ],
  reactivate_directive: [
    { path: "/v1/default/banks/{bank_id}/directives", method: "get" },
    {
      path: "/v1/default/banks/{bank_id}/directives/{directive_id}",
      method: "patch",
    },
  ],
  search_knowledge_pages: [
    {
      path: "/v1/default/banks/{bank_id}/knowledge-base/search",
      method: "get",
    },
  ],
  get_knowledge_page: [
    {
      path: "/v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}",
      method: "get",
    },
  ],
  get_knowledge_tree: [
    {
      path: "/v1/default/banks/{bank_id}/knowledge-base/tree",
      method: "get",
    },
  ],
};

/** Names of every synthesized tool with a pinned route requirement. */
export const SYNTHESIZED_ROUTE_TOOL_NAMES = Object.keys(SYNTHESIZED_TOOL_ROUTES);

/** Pure, no network: true when `spec` declares `route.method` on `route.path`. */
export function openApiHasRoute(spec: OpenApiSpec, route: RouteRequirement): boolean {
  const methods = spec.paths?.[route.path];
  if (!methods || typeof methods !== "object") return false;
  return Object.prototype.hasOwnProperty.call(methods, route.method.toLowerCase());
}

/**
 * Pure: which of `toolName`'s required routes are missing from `spec`.
 * Empty array = every route present (or `toolName` has no pinned
 * requirement at all, e.g. it isn't a synthesized tool).
 */
export function missingRoutesForTool(
  spec: OpenApiSpec,
  toolName: string,
): RouteRequirement[] {
  const required = SYNTHESIZED_TOOL_ROUTES[toolName];
  if (!required) return [];
  return required.filter((r) => !openApiHasRoute(spec, r));
}

/**
 * Best-effort: GET `<apiBaseUrl>/openapi.json`. Returns null on any failure
 * — unreachable, non-200, unparseable JSON, or a body with no `paths`
 * object. Callers decide what "unknown" means; every current caller
 * degrades rather than blocking (see the module header).
 */
export async function fetchHindsightOpenApi(
  apiBaseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenApiSpec | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = apiBaseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? OPENAPI_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await doFetch(`${base}/openapi.json`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as OpenApiSpec | null;
    if (!body || typeof body !== "object" || typeof body.paths !== "object") {
      return null;
    }
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loud pre-flight for one synthesized tool call, lazily fetching and
 * memoizing `/openapi.json` for the process lifetime of one shim instance.
 *
 * A FAILED fetch is deliberately NOT cached as failure: the next
 * synthesized call retries, so a backend that was briefly unreachable at
 * the first call does not wedge every later call into permanent "unknown"
 * for the rest of the session — the same per-call-retry philosophy
 * `UpstreamClient` applies to the upstream MCP session.
 */
export class ShimContractPin {
  private cached: OpenApiSpec | null = null;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  /** The cached/fetched spec, or null if `/openapi.json` has never been reachable. */
  async spec(): Promise<OpenApiSpec | null> {
    if (this.cached) return this.cached;
    const fetched = await fetchHindsightOpenApi(this.apiBaseUrl, this.opts);
    if (fetched) this.cached = fetched;
    return fetched;
  }

  /**
   * `ok: true` — the call may proceed — when the route is confirmed
   * present, OR when the contract could not be checked at all (spec
   * unreachable/malformed: the REST layer is still the backstop and answers
   * its own honest error, exactly as it did before this module existed).
   *
   * `ok: false`, with the missing routes named, ONLY when `/openapi.json`
   * was successfully read and PROVES the route is gone — the one case a bare
   * REST call cannot distinguish from a transient 404.
   */
  async preflight(
    toolName: string,
  ): Promise<{ ok: true } | { ok: false; text: string }> {
    const spec = await this.spec();
    if (!spec) return { ok: true };
    const missing = missingRoutesForTool(spec, toolName);
    if (missing.length === 0) return { ok: true };
    const engineVersion = spec.info?.version ?? "unknown";
    const routeList = missing
      .map((r) => `${r.method.toUpperCase()} ${r.path}`)
      .join(", ");
    return {
      ok: false,
      text:
        `${toolName} is unavailable: the live Hindsight engine (api_version ` +
        `${engineVersion}) no longer exposes the REST route(s) this tool is ` +
        `synthesized over: ${routeList}. This is not a silent empty result — ` +
        `the shim confirmed the route is gone and is refusing the call rather ` +
        `than guessing. If the engine renamed/moved the route, this tool's ` +
        `implementation needs updating; if the engine now ships this ` +
        `capability as a real MCP tool, the synthesis should be retired (see ` +
        `the retirement seam in withSynthesizedTools, hindsight-mcp-shim.ts). ` +
        `\`switchroom doctor\`'s hindsight shim contract rows carry the same ` +
        `finding fleet-wide.`,
    };
  }
}
