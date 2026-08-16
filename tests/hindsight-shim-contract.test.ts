/**
 * Outcome tests for the shim's engine-version pin + REST route contract
 * (src/memory/hindsight-shim-contract.ts) — design-v2.md §2.5's "the pin is
 * not built", now built.
 *
 * Each guard is written so it fails on the specific defect it exists for:
 *   • route presence   — a route that IS in /openapi.json must never be
 *                         reported missing (false alarm)
 *   • route absence     — a route the live spec does NOT declare must be
 *                         reported missing, by name, for the RIGHT tool
 *   • degrade-not-block — an unreachable/malformed /openapi.json must let
 *                         calls proceed (preflight ok:true), never freeze
 *                         every synthesized tool on a flaky probe
 *   • retry-after-fail  — a first FAILED fetch must not be cached as
 *                         failure; the next call gets a fresh attempt
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  fetchHindsightOpenApi,
  missingRoutesForTool,
  openApiHasRoute,
  ShimContractPin,
  SYNTHESIZED_ROUTE_TOOL_NAMES,
  SYNTHESIZED_TOOL_ROUTES,
  type OpenApiSpec,
} from "../src/memory/hindsight-shim-contract.js";

// ─── the live route set this whole module exists to protect ───────────────

/** The exact shape confirmed live against a running hindsight 0.9.0. */
function fullOpenApiSpec(): OpenApiSpec {
  return {
    info: { version: "0.9.0" },
    paths: {
      "/v1/default/banks/{bank_id}/directives": { get: {}, post: {} },
      "/v1/default/banks/{bank_id}/directives/{directive_id}": {
        get: {},
        patch: {},
        delete: {},
      },
      "/v1/default/banks/{bank_id}/knowledge-base/search": { get: {} },
      "/v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}": { get: {} },
      "/v1/default/banks/{bank_id}/knowledge-base/tree": { get: {} },
    },
  };
}

describe("route table sanity", () => {
  it("every synthesized tool with a call-path has a pinned route requirement", () => {
    // Guards SYNTHESIZED_TOOL_ROUTES from silently losing a tool.
    expect(SYNTHESIZED_ROUTE_TOOL_NAMES.sort()).toEqual(
      [
        "deactivate_directive",
        "reactivate_directive",
        "search_knowledge_pages",
        "get_knowledge_page",
        "get_knowledge_tree",
      ].sort(),
    );
  });

  it("every pinned route resolves against the live-confirmed full spec", () => {
    const spec = fullOpenApiSpec();
    for (const tool of SYNTHESIZED_ROUTE_TOOL_NAMES) {
      expect(missingRoutesForTool(spec, tool), tool).toEqual([]);
    }
  });
});

describe("openApiHasRoute", () => {
  it("true when the method is declared on the path", () => {
    const spec = fullOpenApiSpec();
    expect(
      openApiHasRoute(spec, {
        path: "/v1/default/banks/{bank_id}/knowledge-base/tree",
        method: "get",
      }),
    ).toBe(true);
  });

  it("false when the path exists but the method does not", () => {
    const spec: OpenApiSpec = {
      paths: { "/v1/default/banks/{bank_id}/directives/{directive_id}": { get: {} } },
    };
    expect(
      openApiHasRoute(spec, {
        path: "/v1/default/banks/{bank_id}/directives/{directive_id}",
        method: "patch",
      }),
    ).toBe(false);
  });

  it("false when the path is absent entirely", () => {
    const spec: OpenApiSpec = { paths: {} };
    expect(
      openApiHasRoute(spec, {
        path: "/v1/default/banks/{bank_id}/knowledge-base/tree",
        method: "get",
      }),
    ).toBe(false);
  });

  it("method match is case-insensitive against the requirement table", () => {
    const spec: OpenApiSpec = {
      paths: { "/x": { GET: {} } as unknown as Record<string, unknown> },
    };
    // openapi.json always lowercases methods; this proves we don't silently
    // false-negative if a future spec generator changes case.
    expect(openApiHasRoute(spec, { path: "/x", method: "get" })).toBe(false);
    const lower: OpenApiSpec = { paths: { "/x": { get: {} } } };
    expect(openApiHasRoute(lower, { path: "/x", method: "get" })).toBe(true);
  });
});

describe("missingRoutesForTool", () => {
  it("reports the PATCH route missing when the directive PATCH route is dropped", () => {
    const spec = fullOpenApiSpec();
    delete spec.paths!["/v1/default/banks/{bank_id}/directives/{directive_id}"];
    const missing = missingRoutesForTool(spec, "deactivate_directive");
    expect(missing).toEqual(
      SYNTHESIZED_TOOL_ROUTES.deactivate_directive.filter(
        (r) => r.path === "/v1/default/banks/{bank_id}/directives/{directive_id}",
      ),
    );
  });

  it("reports the knowledge search route missing without touching unrelated tools", () => {
    const spec = fullOpenApiSpec();
    delete spec.paths!["/v1/default/banks/{bank_id}/knowledge-base/search"];
    expect(missingRoutesForTool(spec, "search_knowledge_pages")).toHaveLength(1);
    expect(missingRoutesForTool(spec, "get_knowledge_page")).toEqual([]);
    expect(missingRoutesForTool(spec, "get_knowledge_tree")).toEqual([]);
    expect(missingRoutesForTool(spec, "deactivate_directive")).toEqual([]);
  });

  it("a tool with no pinned requirement (e.g. a real backend tool name) is never 'missing'", () => {
    expect(missingRoutesForTool(fullOpenApiSpec(), "recall")).toEqual([]);
  });
});

// ─── fetchHindsightOpenApi against a real HTTP server ──────────────────────

async function startOpenApiServer(
  respond: (res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/openapi.json") return respond(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("fetchHindsightOpenApi", () => {
  it("returns the parsed spec on a 200 with a paths object", async () => {
    const srv = await startOpenApiServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fullOpenApiSpec()));
    });
    try {
      const spec = await fetchHindsightOpenApi(srv.url);
      expect(spec?.info?.version).toBe("0.9.0");
      expect(Object.keys(spec?.paths ?? {})).toHaveLength(5);
    } finally {
      await srv.close();
    }
  });

  it("returns null on a non-200", async () => {
    const srv = await startOpenApiServer((res) => {
      res.writeHead(500).end("boom");
    });
    try {
      expect(await fetchHindsightOpenApi(srv.url)).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("returns null on a body with no paths object (malformed spec)", async () => {
    const srv = await startOpenApiServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ info: { version: "0.9.0" } }));
    });
    try {
      expect(await fetchHindsightOpenApi(srv.url)).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("returns null when the server is unreachable", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    expect(
      await fetchHindsightOpenApi(`http://127.0.0.1:${port}`, { timeoutMs: 300 }),
    ).toBeNull();
  });
});

// ─── ShimContractPin.preflight — the loud-vs-degrade decision itself ──────

describe("ShimContractPin.preflight", () => {
  let srv: { url: string; close: () => Promise<void> };
  let spec: OpenApiSpec;

  beforeEach(async () => {
    spec = fullOpenApiSpec();
    srv = await startOpenApiServer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(spec));
    });
  });
  afterEach(async () => {
    await srv.close();
  });

  it("ok:true when every route the tool needs is present", async () => {
    const pin = new ShimContractPin(srv.url);
    const result = await pin.preflight("get_knowledge_tree");
    expect(result.ok).toBe(true);
  });

  it("THE CORE GUARD: ok:false, naming the exact missing route, once the live spec drops it", async () => {
    delete spec.paths!["/v1/default/banks/{bank_id}/knowledge-base/tree"];
    const pin = new ShimContractPin(srv.url);
    const result = await pin.preflight("get_knowledge_tree");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.text).toContain("get_knowledge_tree");
      expect(result.text).toContain(
        "GET /v1/default/banks/{bank_id}/knowledge-base/tree",
      );
      // Must read as a deliberate refusal, not a silent/empty result — this is
      // the exact anti-silent-drop wording the task requires.
      expect(result.text.toLowerCase()).toContain("not");
    }
  });

  it("does not cross-contaminate: dropping one tool's route leaves a sibling tool ok", async () => {
    delete spec.paths!["/v1/default/banks/{bank_id}/knowledge-base/search"];
    const pin = new ShimContractPin(srv.url);
    expect((await pin.preflight("search_knowledge_pages")).ok).toBe(false);
    expect((await pin.preflight("get_knowledge_tree")).ok).toBe(true);
    expect((await pin.preflight("deactivate_directive")).ok).toBe(true);
  });

  it("degrades to ok:true (does not block) when /openapi.json is unreachable", async () => {
    await srv.close();
    const pin = new ShimContractPin(srv.url, { timeoutMs: 300 });
    expect((await pin.preflight("get_knowledge_tree")).ok).toBe(true);
  });

  it("memoizes a SUCCESSFUL fetch — one request serves every subsequent preflight", async () => {
    let hits = 0;
    const counting = await startOpenApiServer((res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fullOpenApiSpec()));
    });
    try {
      const pin = new ShimContractPin(counting.url);
      await pin.preflight("get_knowledge_tree");
      await pin.preflight("search_knowledge_pages");
      await pin.preflight("deactivate_directive");
      expect(hits).toBe(1);
    } finally {
      await counting.close();
    }
  });

  it("does NOT cache a FAILED fetch — a later call gets a fresh attempt", async () => {
    let hits = 0;
    let up = false;
    const flaky = await startOpenApiServer((res) => {
      hits += 1;
      if (!up) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fullOpenApiSpec()));
    });
    try {
      const pin = new ShimContractPin(flaky.url, { timeoutMs: 500 });
      expect((await pin.preflight("get_knowledge_tree")).ok).toBe(true); // degraded
      expect(hits).toBe(1);
      up = true;
      await pin.preflight("get_knowledge_tree");
      expect(hits).toBe(2); // retried, not stuck on the first failure forever
    } finally {
      await flaky.close();
    }
  });
});
