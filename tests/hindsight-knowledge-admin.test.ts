/**
 * Outcome tests for the knowledge-page READ path — `KnowledgeAdmin`
 * (src/memory/hindsight-knowledge-admin.ts) and the three shim-synthesized MCP
 * tools that wrap it (src/cli/hindsight-mcp-shim.ts).
 *
 * These drive the real modules against a stateful mock of the hindsight REST
 * knowledge-base API and assert the REQUESTS THAT ACTUALLY REACHED IT plus the
 * text the agent ends up seeing — not that a code path ran. Each guard fails
 * on the specific defect it exists for:
 *
 *   • GET-only        — add any write and either the prototype inventory or
 *                       the "no non-GET verb was ever sent" assertion reds
 *   • bank pinning    — remove the pin and the request lands on a peer bank
 *   • limit clamping  — forward an out-of-range limit and the server 422s
 *   • honest failure  — a 404/500 surfaces as an isError result naming the id
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KnowledgeAdmin,
  KNOWLEDGE_ADMIN_MEMBERS,
  KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
  KNOWLEDGE_SEARCH_LIMIT_MAX,
  clampKnowledgeSearchLimit,
  type KnowledgeNode,
  type KnowledgePage,
  type KnowledgePageSearchResult,
} from "../src/memory/hindsight-knowledge-admin.js";
import { HindsightShim } from "../src/cli/hindsight-mcp-shim.js";

// ─── stateful mock of the hindsight REST knowledge-base API ───────────────

interface SeenRequest {
  method: string;
  path: string;
}

interface BankKnowledge {
  pages: Record<string, KnowledgePage>;
  hits: KnowledgePageSearchResult[];
  roots: KnowledgeNode[];
}

interface MockApi {
  baseUrl: string;
  server: Server;
  banks: Record<string, BankKnowledge>;
  seen: SeenRequest[];
  /** Force the next N responses for a sub-path to this status. */
  failStatus: (subPath: string) => number | null;
  close: () => Promise<void>;
}

async function startMockApi(
  banks: Record<string, BankKnowledge>,
): Promise<MockApi> {
  const state: MockApi = {
    baseUrl: "",
    server: undefined as unknown as Server,
    banks,
    seen: [],
    failStatus: () => null,
    close: async () => undefined,
  };

  const server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      const path = req.url ?? "";
      state.seen.push({ method: req.method ?? "", path });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const [rawPath, rawQuery] = path.split("?");
      const query = new URLSearchParams(rawQuery ?? "");
      const m =
        /^\/v1\/default\/banks\/([^/]+)\/knowledge-base\/(tree|search|pages\/([^/]+))$/.exec(
          rawPath,
        );
      if (!m) return send(404, { detail: "not found" });
      const bank = decodeURIComponent(m[1]);
      const sub = m[2].startsWith("pages/") ? "pages" : m[2];
      const injected = state.failStatus(sub);
      if (injected !== null) return send(injected, { detail: "injected" });
      const kb = state.banks[bank];
      if (!kb) return send(404, { detail: "no such bank" });
      // The real API accepts GET on all three. Anything else is a 405 here so
      // an accidental write shows up as a failure, not as a silent success.
      if (req.method !== "GET") return send(405, { detail: "method not allowed" });

      if (sub === "tree") return send(200, { roots: kb.roots });
      if (sub === "search") {
        // Mirror the REAL upstream Query constraints — ge=1, le=50 — because
        // those are exactly what an unclamped forward would trip.
        const q = query.get("q") ?? "";
        if (q.length === 0) return send(422, { detail: "q too short" });
        const limit = Number(query.get("limit") ?? "10");
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          return send(422, { detail: "limit out of range" });
        }
        const results = kb.hits
          .filter((h) => h.name.includes(q) || h.snippet.includes(q))
          .slice(0, limit);
        return send(200, { results, total: results.length });
      }
      const pageId = decodeURIComponent(m[3]);
      const page = kb.pages[pageId];
      if (!page) return send(404, { detail: `Knowledge page '${pageId}' not found` });
      return send(200, page);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.server = server;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

const OWN_BANK = "agent-own-bank";
const PEER_BANK = "peer-bank";

function fixtureBanks(): Record<string, BankKnowledge> {
  return {
    [OWN_BANK]: {
      pages: {
        "pg-conventions": {
          id: "pg-conventions",
          name: "Conventions",
          type: "knowledge-page",
          description: "How this project writes code",
          tags: ["arch"],
          timestamp: "2026-08-01T00:00:00Z",
          body: "Use tabs.",
          markdown: "---\nname: Conventions\n---\n\nUse tabs.\n",
        },
      },
      hits: [
        {
          id: "pg-conventions",
          name: "Conventions",
          mental_model_id: "mm-1",
          snippet: "Use tabs.",
          score: 0.91,
          updated_at: "2026-08-01T00:00:00Z",
        },
      ],
      roots: [
        {
          id: "pg-conventions",
          kind: "page",
          name: "Conventions",
          is_stale: false,
          children: [],
        },
      ],
    },
    [PEER_BANK]: {
      pages: {
        "pg-secret": {
          id: "pg-secret",
          name: "Peer secrets",
          type: "knowledge-page",
          markdown: "PEER ONLY",
        },
      },
      hits: [
        { id: "pg-secret", name: "Peer secrets", snippet: "PEER ONLY", score: 1 },
      ],
      roots: [{ id: "pg-secret", kind: "page", name: "Peer secrets" }],
    },
    // An agent whose bank has never been consolidated into pages.
    "empty-bank": { pages: {}, hits: [], roots: [] },
  };
}

let api: MockApi;
beforeEach(async () => {
  api = await startMockApi(fixtureBanks());
});
afterEach(async () => {
  await api.close();
});

function admin(bankId = OWN_BANK): KnowledgeAdmin {
  return new KnowledgeAdmin({ apiBaseUrl: api.baseUrl, bankId, timeoutMs: 5_000 });
}

async function withShim<T>(
  bankId: string,
  fn: (shim: HindsightShim) => Promise<T>,
): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), "shim-knowledge-test-"));
  try {
    return await fn(
      new HindsightShim({
        // /mcp/ on the mock answers 404 — proving a synthesized call never
        // touches the MCP transport, only the REST endpoints.
        url: `${api.baseUrl}/mcp/`,
        bankId,
        cacheDir,
        toolsListTimeoutMs: 500,
        logger: () => undefined,
      }),
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

async function callTool(
  shim: HindsightShim,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = (await shim.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { isError: boolean; content: { text: string }[] } };
  return { isError: res.result.isError, text: res.result.content[0].text };
}

// ─── 1. read-only by construction ─────────────────────────────────────────

describe("GET-only — no write verb is reachable", () => {
  it("KnowledgeAdmin's prototype has exactly the read members, no more", () => {
    // Asserted as a key set rather than inferred from behaviour, the same way
    // buildDirectivePatchBody's whitelist is. TypeScript `private` is erased
    // at runtime, so a `createPage` added anywhere in the class body appears
    // here — exported or not.
    expect(Object.getOwnPropertyNames(KnowledgeAdmin.prototype).sort()).toEqual(
      [...KNOWLEDGE_ADMIN_MEMBERS].sort(),
    );
    for (const write of ["createPage", "createFolder", "patch", "delete", "send"]) {
      expect(
        Object.getOwnPropertyNames(KnowledgeAdmin.prototype),
        `${write} would make page authorship/deletion reachable from a tool call`,
      ).not.toContain(write);
    }
  });

  it("every public method issues GET and nothing else", async () => {
    await admin().search({ query: "Use" });
    await admin().getPage({ page_id: "pg-conventions" });
    await admin().tree();
    expect(api.seen.length).toBe(3);
    expect(api.seen.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("the whole synthesized knowledge surface sends no mutating request", async () => {
    await withShim(OWN_BANK, async (shim) => {
      await callTool(shim, "search_knowledge_pages", { query: "Use" });
      await callTool(shim, "get_knowledge_page", { page_id: "pg-conventions" });
      await callTool(shim, "get_knowledge_tree", {});
    });
    expect(api.seen.length).toBeGreaterThan(0);
    for (const r of api.seen) {
      expect(
        r.method,
        `a knowledge tool sent ${r.method} ${r.path} — this surface is reads only`,
      ).toBe("GET");
    }
    // ...and none of it went through the MCP transport.
    expect(api.seen.some((r) => r.path.startsWith("/mcp"))).toBe(false);
  });
});

// ─── 2. the bank pin ──────────────────────────────────────────────────────

describe("bank pinning — every path embeds the agent's own bank", () => {
  it("builds all three URLs under the pinned bank", async () => {
    await admin().search({ query: "Use" });
    await admin().getPage({ page_id: "pg-conventions" });
    await admin().tree();
    expect(api.seen.map((r) => r.path.split("?")[0])).toEqual([
      `/v1/default/banks/${OWN_BANK}/knowledge-base/search`,
      `/v1/default/banks/${OWN_BANK}/knowledge-base/pages/pg-conventions`,
      `/v1/default/banks/${OWN_BANK}/knowledge-base/tree`,
    ]);
  });

  it("a page_id cannot path-traverse into a peer bank", async () => {
    // encodeURIComponent means the traversal survives only as an inert,
    // percent-encoded LEAF segment under our own bank — the separators never
    // reach the router, so it 404s here instead of resolving the peer's page.
    await expect(
      admin().getPage({ page_id: `../../${PEER_BANK}/knowledge-base/pages/pg-secret` }),
    ).rejects.toThrow(/no knowledge page/);
    expect(api.seen).toHaveLength(1);
    const [prefix, id] = [
      api.seen[0].path.slice(0, api.seen[0].path.lastIndexOf("/")),
      api.seen[0].path.slice(api.seen[0].path.lastIndexOf("/") + 1),
    ];
    // The routed part of the URL is entirely ours.
    expect(prefix).toBe(`/v1/default/banks/${OWN_BANK}/knowledge-base/pages`);
    expect(prefix).not.toContain(PEER_BANK);
    // ...and the peer's name only ever appears escaped inside the id.
    expect(id).not.toContain("/");
    expect(id).toContain(encodeURIComponent(`../../${PEER_BANK}/`));
  });

  it("the tool schemas expose no bank_id, and a bank_id argument is REJECTED", async () => {
    await withShim(OWN_BANK, async (shim) => {
      const list = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result: { tools: { name: string; inputSchema: unknown }[] } };
      for (const name of [
        "search_knowledge_pages",
        "get_knowledge_page",
        "get_knowledge_tree",
      ]) {
        const tool = list.result.tools.find((t) => t.name === name)!;
        expect(tool, `${name} is not advertised`).toBeDefined();
        expect(
          Object.keys(
            (tool.inputSchema as { properties: Record<string, unknown> })
              .properties,
          ),
        ).not.toContain("bank_id");
      }

      const mark = api.seen.length;
      const res = await callTool(shim, "search_knowledge_pages", {
        query: "Peer",
        bank_id: PEER_BANK,
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("bank_id");
      expect(res.text).toContain("your own memory bank");
      // Nothing was read from anywhere.
      expect(api.seen.slice(mark)).toEqual([]);
    });
  });

  it("refuses to act when the agent has no pinned bank", async () => {
    await withShim("", async (shim) => {
      const res = await callTool(shim, "get_knowledge_tree", {});
      expect(res.isError).toBe(true);
      expect(res.text).toContain("HINDSIGHT_BANK_ID");
    });
  });
});

// ─── 3. limit handling ────────────────────────────────────────────────────

describe("search limit", () => {
  it("clamps to the server's accepted range instead of 422ing", () => {
    expect(clampKnowledgeSearchLimit(undefined)).toBe(
      KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
    );
    expect(clampKnowledgeSearchLimit(0)).toBe(1);
    expect(clampKnowledgeSearchLimit(-5)).toBe(1);
    expect(clampKnowledgeSearchLimit(999)).toBe(KNOWLEDGE_SEARCH_LIMIT_MAX);
    expect(clampKnowledgeSearchLimit(7)).toBe(7);
    expect(clampKnowledgeSearchLimit(7.9)).toBe(7);
    expect(clampKnowledgeSearchLimit(Number.NaN)).toBe(
      KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
    );
  });

  it("an out-of-range limit reaches the server clamped, and still returns hits", async () => {
    // The mock 422s on a limit outside 1..50 exactly as upstream does, so an
    // unclamped forward fails this test rather than merely looking untidy.
    const res = await admin().search({ query: "Use", limit: 5_000 });
    expect(res.results).toHaveLength(1);
    expect(api.seen[0].path).toContain(`limit=${KNOWLEDGE_SEARCH_LIMIT_MAX}`);
  });

  it("omitting limit sends the documented default", async () => {
    await admin().search({ query: "Use" });
    expect(api.seen[0].path).toContain(
      `limit=${KNOWLEDGE_SEARCH_LIMIT_DEFAULT}`,
    );
  });
});

// ─── 4. results, empties and failures ─────────────────────────────────────

describe("results and failure text", () => {
  it("returns the hit fields the agent needs to follow up", async () => {
    const res = await admin().search({ query: "Use" });
    expect(res.total).toBe(1);
    expect(res.results[0].id).toBe("pg-conventions");
    expect(res.results[0].score).toBeCloseTo(0.91);
  });

  it("a page read returns the full markdown document", async () => {
    const page = await admin().getPage({ page_id: "pg-conventions" });
    expect(page.markdown).toContain("Use tabs.");
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_page", {
        page_id: "pg-conventions",
      });
      expect(res.isError).toBe(false);
      // The page IS a markdown document — returned verbatim, not re-wrapped.
      expect(res.text).toBe(page.markdown);
    });
  });

  it("an EMPTY knowledge base is an empty result, never an error", async () => {
    const search = await admin("empty-bank").search({ query: "anything" });
    expect(search.results).toEqual([]);
    expect(search.total).toBe(0);
    expect((await admin("empty-bank").tree()).roots).toEqual([]);

    await withShim("empty-bank", async (shim) => {
      const s = await callTool(shim, "search_knowledge_pages", { query: "x" });
      expect(s.isError).toBe(false);
      expect(s.text).toMatch(/no knowledge pages/i);
      const t = await callTool(shim, "get_knowledge_tree", {});
      expect(t.isError).toBe(false);
      expect(t.text).toMatch(/no pages yet/i);
    });
  });

  it("a 404 page names the id and where ids come from", async () => {
    await expect(admin().getPage({ page_id: "pg-nope" })).rejects.toThrow(
      /no knowledge page 'pg-nope'/,
    );
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_page", {
        page_id: "pg-nope",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("pg-nope");
      expect(res.text).toContain("get_knowledge_tree");
    });
  });

  it("a 500 surfaces as an isError result naming the status, not a crash", async () => {
    api.failStatus = (sub) => (sub === "search" ? 500 : null);
    await expect(admin().search({ query: "Use" })).rejects.toThrow(/HTTP 500/);
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "search_knowledge_pages", { query: "Use" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("HTTP 500");
    });

    api.failStatus = (sub) => (sub === "tree" ? 500 : null);
    await expect(admin().tree()).rejects.toThrow(/HTTP 500/);
    api.failStatus = (sub) => (sub === "pages" ? 503 : null);
    await expect(admin().getPage({ page_id: "pg-conventions" })).rejects.toThrow(
      /HTTP 503/,
    );
  });
});
