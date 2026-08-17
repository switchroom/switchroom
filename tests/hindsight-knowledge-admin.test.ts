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
import {
  HindsightShim,
  KNOWLEDGE_RESPONSE_MAX_CHARS,
} from "../src/cli/hindsight-mcp-shim.js";

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
  /**
   * Replace the 200 body for a sub-path with an arbitrary payload.
   *
   * Exists to reproduce a MALFORMED-but-successful response — the field a
   * future image bump renames, the `null` where a string was promised. Those
   * are the responses a client that only checks `res.ok` mis-handles.
   */
  bodyOverride: (subPath: string) => unknown | undefined;
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
    bodyOverride: () => undefined,
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
      const overridden = state.bodyOverride(sub);
      if (overridden !== undefined) return send(200, overridden);
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

function admin(
  bankId = OWN_BANK,
  extraBanks?: readonly string[],
): KnowledgeAdmin {
  return new KnowledgeAdmin({
    apiBaseUrl: api.baseUrl,
    bankId,
    ...(extraBanks ? { extraBanks } : {}),
    timeoutMs: 5_000,
  });
}

async function withShim<T>(
  bankId: string,
  fn: (shim: HindsightShim) => Promise<T>,
  extraBanks?: readonly string[],
): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), "shim-knowledge-test-"));
  try {
    return await fn(
      new HindsightShim({
        // /mcp/ on the mock answers 404 — proving a synthesized call never
        // touches the MCP transport, only the REST endpoints.
        url: `${api.baseUrl}/mcp/`,
        bankId,
        ...(extraBanks ? { extraBanks } : {}),
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
    // at runtime, so a `createPage` declared as a METHOD (private or not)
    // lands on the prototype and shows up here.
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

  /**
   * The prototype inventory alone is NOT the whole guard, and the header
   * comment used to claim it was. A write installed as a class FIELD —
   * `createPage = async () => fetch(url, {method: "POST"})` — is an INSTANCE
   * own-property, so `KnowledgeAdmin.prototype` never sees it and the test
   * above stays green while page authorship is fully reachable. This closes
   * that half; `static` methods and module-level functions are covered by
   * neither and are left to the no-mutating-request assertion plus review, as
   * the corrected header now says.
   */
  it("a constructed KnowledgeAdmin carries no function-valued own property", () => {
    const instance = new KnowledgeAdmin({
      apiBaseUrl: api.baseUrl,
      bankId: OWN_BANK,
    }) as unknown as Record<string, unknown>;
    const callable = Object.getOwnPropertyNames(instance).filter(
      (k) => typeof instance[k] === "function",
    );
    expect(
      callable,
      `${callable.join(", ")} is a class FIELD holding a function — a write ` +
        `installed this way is invisible to the prototype inventory`,
    ).toEqual([]);
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

// ─── 2. the bank selector: own by default, granted banks on request ───────

describe("bank selector — own bank is the default, no grant is a wall", () => {
  it("builds all three URLs under the own bank when no bank_id is given", async () => {
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
    // Rejected by shape before a socket is opened — and even if the id regex
    // were removed, encodeURIComponent would leave the traversal an inert,
    // percent-encoded LEAF segment under our own bank.
    await expect(
      admin().getPage({ page_id: `../../${PEER_BANK}/knowledge-base/pages/pg-secret` }),
    ).rejects.toThrow(/is not a knowledge page id/);
    expect(api.seen).toHaveLength(0);
  });

  /**
   * The defect: `encodeURIComponent("..")` is `..` VERBATIM (it is an
   * unreserved-set string), so the URL parser collapses the segment and
   * `.../knowledge-base/pages/..` becomes a GET of `.../knowledge-base/` — a
   * different endpoint whose body was then cast to `KnowledgePage`. Not a
   * bank escape, but a page read must not be able to retarget the request.
   */
  it("a dot-segment page_id is refused instead of retargeting the request", async () => {
    for (const bad of ["..", ".", "../", "a/b", "pg conventions", ""]) {
      await expect(
        admin().getPage({ page_id: bad }),
        `page_id ${JSON.stringify(bad)} must be refused by shape`,
      ).rejects.toThrow(/is not a knowledge page id/);
    }
    // Not one of them reached the network.
    expect(api.seen).toHaveLength(0);

    // ...and the real id spelling upstream mints (`kp-<uuid4 hex>`,
    // memory_engine.py:13477) still passes the gate and is routed as a page.
    await expect(
      admin().getPage({ page_id: "kp-0123456789abcdef0123456789abcdef" }),
    ).rejects.toThrow(/no knowledge page/);
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0].path).toBe(
      `/v1/default/banks/${OWN_BANK}/knowledge-base/pages/kp-0123456789abcdef0123456789abcdef`,
    );

    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_page", { page_id: ".." });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/is not a knowledge page id/);
    });
  });

  it("the three knowledge tools advertise the optional bank_id selector", async () => {
    // The selector is ALWAYS advertised (static schema = single source of
    // truth); the grant check is a runtime value check, not a schema one, so
    // an agent with no grants sees the same schema as one with grants.
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
        const props = Object.keys(
          (tool.inputSchema as { properties: Record<string, unknown> })
            .properties,
        );
        expect(props, `${name} must expose bank_id`).toContain("bank_id");
      }
    });
    // The directive tools, by contrast, carry NO bank_id — their writes stay
    // own-pinned (W-2 pt 2).
    await withShim(OWN_BANK, async (shim) => {
      const list = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result: { tools: { name: string; inputSchema: unknown }[] } };
      for (const name of ["deactivate_directive", "reactivate_directive"]) {
        const tool = list.result.tools.find((t) => t.name === name);
        if (!tool) continue; // only present when the backend advertises them
        expect(
          Object.keys(
            (tool.inputSchema as { properties: Record<string, unknown> })
              .properties,
          ),
          `${name} must NOT expose bank_id`,
        ).not.toContain("bank_id");
      }
    });
  });

  it("an UNGRANTED bank_id is rejected loudly and reads nothing", async () => {
    // The agent's default is OWN_BANK, with NO extraBanks — so naming PEER_BANK
    // is neither its own nor a grant. The wall must be loud (isError, the bank
    // named) and total (not one byte read from anywhere), never a silent
    // coercion to the own bank.
    await withShim(OWN_BANK, async (shim) => {
      const mark = api.seen.length;
      const res = await callTool(shim, "search_knowledge_pages", {
        query: "Peer",
        bank_id: PEER_BANK,
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain(PEER_BANK);
      expect(res.text).toContain(OWN_BANK);
      // Not coerced to the own bank, not read from the peer — nothing at all.
      expect(api.seen.slice(mark)).toEqual([]);
    });
    // Same wall at the KnowledgeAdmin layer, as a typed error.
    await expect(
      admin(OWN_BANK).search({ query: "Peer", bankId: PEER_BANK }),
    ).rejects.toThrow(/not a bank you can read|not your own bank/);
  });

  it("a GRANTED bank_id reads that peer bank, from an agent whose default is OWN", async () => {
    // The OUTCOME W-2 exists for: a page written to PEER_BANK is readable via
    // bank_id=PEER_BANK by an agent whose OWN bank is OWN_BANK, because the
    // operator granted PEER_BANK. Prove it through the full shim tool path.
    await withShim(
      OWN_BANK,
      async (shim) => {
        const mark = api.seen.length;
        const page = await callTool(shim, "get_knowledge_page", {
          page_id: "pg-secret",
          bank_id: PEER_BANK,
        });
        expect(page.isError).toBe(false);
        expect(page.text).toContain("PEER ONLY");
        // The request landed on the PEER bank, not the own bank.
        const paths = api.seen.slice(mark).map((r) => r.path.split("?")[0]);
        expect(paths).toContain(
          `/v1/default/banks/${PEER_BANK}/knowledge-base/pages/pg-secret`,
        );
        expect(
          paths.some((p) => p.includes(`/banks/${OWN_BANK}/`)),
        ).toBe(false);

        // search and tree honour the same grant.
        const hits = await callTool(shim, "search_knowledge_pages", {
          query: "Peer",
          bank_id: PEER_BANK,
        });
        expect(hits.isError).toBe(false);
        expect(hits.text).toContain("pg-secret");

        const tree = await callTool(shim, "get_knowledge_tree", {
          bank_id: PEER_BANK,
        });
        expect(tree.isError).toBe(false);
        expect(tree.text).toContain("pg-secret");
      },
      [PEER_BANK],
    );
  });

  it("naming the OWN bank explicitly is accepted, not treated as a foreign bank", async () => {
    // Passing your own bank_id is a no-op selector, never a rejection.
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_tree", {
        bank_id: OWN_BANK,
      });
      expect(res.isError).toBe(false);
      expect(res.text).toContain("Conventions");
    });
  });

  it("a grant to bank A does not open bank B", async () => {
    // extraBanks is an allowlist, not a blanket cross-bank switch: granting
    // 'empty-bank' must not make PEER_BANK reachable.
    await withShim(
      OWN_BANK,
      async (shim) => {
        const mark = api.seen.length;
        const res = await callTool(shim, "get_knowledge_tree", {
          bank_id: PEER_BANK,
        });
        expect(res.isError).toBe(true);
        expect(res.text).toContain(PEER_BANK);
        // The granted bank IS reachable; the ungranted one is not.
        expect(res.text).toContain("empty-bank");
        expect(api.seen.slice(mark)).toEqual([]);
      },
      ["empty-bank"],
    );
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

  it("search reports the TOTAL alongside the hits, not the hits alone", async () => {
    // With `results` alone the model cannot tell a complete set from one the
    // limit cut short — 10 of 200 hits reads as "there are 10".
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "search_knowledge_pages", {
        query: "Use",
      });
      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.text) as {
        total: number;
        results: { id: string }[];
      };
      expect(parsed.total).toBe(1);
      expect(parsed.results.map((r) => r.id)).toEqual(["pg-conventions"]);
    });
  });
});

// ─── 5. malformed-but-successful responses ────────────────────────────────

/**
 * HTTP 200 is not a promise about the BODY. A field rename on an image bump,
 * or an explicit `null`, yields a successful response whose payload is not the
 * shape the caller casts it to — and a cast is not a check. Each test here
 * pins the failure mode that response used to produce.
 */
describe("a 200 with the wrong body shape", () => {
  it("a page with no markdown is a loud failure, not a text-less content block", async () => {
    api.bodyOverride = (sub) =>
      sub === "pages"
        ? {
            id: "pg-conventions",
            name: "Conventions",
            type: "knowledge-page",
            body: "Use tabs.",
            // `markdown` renamed away upstream — the field the shim renders.
          }
        : undefined;
    await expect(
      admin().getPage({ page_id: "pg-conventions" }),
    ).rejects.toThrow(/no markdown body/);

    await withShim(OWN_BANK, async (shim) => {
      const res = (await shim.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_knowledge_page",
          arguments: { page_id: "pg-conventions" },
        },
      })) as {
        result: { isError: boolean; content: { type: string; text?: string }[] };
      };
      // Unfixed, this returned `{type:"text"}` with NO text key and
      // isError:false — a block that fails MCP client schema validation while
      // claiming success, i.e. a read that silently failed.
      expect(res.result.isError).toBe(true);
      expect(typeof res.result.content[0].text).toBe("string");
      expect(res.result.content[0].text).toContain("pg-conventions");
    });
  });

  it("a null markdown is refused the same way", async () => {
    api.bodyOverride = (sub) =>
      sub === "pages"
        ? { id: "pg-conventions", name: "Conventions", markdown: null }
        : undefined;
    await expect(
      admin().getPage({ page_id: "pg-conventions" }),
    ).rejects.toThrow(/no markdown body/);
  });

  it("a non-array `results` is no results, never echoed as if it were hits", async () => {
    // `"stringy".length` is truthy, so a `?? []` fallback sailed past the
    // empty check and the shim stringified a STRING as the hit list.
    api.bodyOverride = (sub) =>
      sub === "search" ? { results: "stringy", total: 7 } : undefined;
    const res = await admin().search({ query: "Use" });
    expect(res.results).toEqual([]);

    await withShim(OWN_BANK, async (shim) => {
      const out = await callTool(shim, "search_knowledge_pages", {
        query: "Use",
      });
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/no knowledge pages/i);
      expect(out.text).not.toContain("stringy");
    });
  });

  it("a non-array `roots` is an empty tree, never rendered as a tree", async () => {
    api.bodyOverride = (sub) => (sub === "tree" ? { roots: "stringy" } : undefined);
    expect((await admin().tree()).roots).toEqual([]);

    await withShim(OWN_BANK, async (shim) => {
      const out = await callTool(shim, "get_knowledge_tree", {});
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/no pages yet/i);
      expect(out.text).not.toContain("stringy");
    });
  });
});

// ─── 6. response size caps ────────────────────────────────────────────────

/**
 * The forwarded reads are token-budgeted (`DEFAULT_RECALL_MAX_TOKENS`) because
 * an unbounded payload silently overruns the MCP output cap and never lands in
 * the agent's context. The knowledge reads had no equivalent ceiling.
 *
 * The marker is as load-bearing as the cut: a silently-truncated page reads to
 * the model as a complete page that simply ends.
 */
describe("oversized responses are capped, and say so", () => {
  it("a page longer than the char budget is cut with an explicit marker", async () => {
    const huge = "x".repeat(KNOWLEDGE_RESPONSE_MAX_CHARS + 5_000);
    api.bodyOverride = (sub) =>
      sub === "pages"
        ? { id: "pg-conventions", name: "Conventions", markdown: huge }
        : undefined;

    // The REST layer still returns the whole document — the cap is the shim's
    // rendering decision, not a lie told to every caller of KnowledgeAdmin.
    expect((await admin().getPage({ page_id: "pg-conventions" })).markdown)
      .toHaveLength(huge.length);

    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_page", {
        page_id: "pg-conventions",
      });
      expect(res.isError).toBe(false);
      expect(res.text.length).toBeLessThan(huge.length);
      expect(res.text).toMatch(/truncated at \d+ chars/);
      expect(res.text).toContain("PARTIAL");
      expect(res.text).toContain("5000 chars omitted");
    });
  });

  it("a page inside the budget is returned byte-for-byte", async () => {
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_page", {
        page_id: "pg-conventions",
      });
      expect(res.text).toBe("---\nname: Conventions\n---\n\nUse tabs.\n");
      expect(res.text).not.toContain("truncated");
    });
  });

  it("an oversized tree is capped, stays parseable JSON, and states the omission", async () => {
    const total = 700;
    const roots: KnowledgeNode[] = Array.from({ length: total }, (_, i) => ({
      id: `kp-${i}`,
      kind: "page" as const,
      name: `Page ${i}`,
      is_stale: false,
    }));
    api.bodyOverride = (sub) => (sub === "tree" ? { roots } : undefined);

    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_tree", {});
      expect(res.isError).toBe(false);
      expect(res.text).toMatch(
        new RegExp(`…\\d+ of ${total} nodes omitted`),
      );
      expect(res.text).toContain("PARTIAL");
      // The whole render — JSON plus its own footnote — fits the budget.
      expect(res.text.length).toBeLessThanOrEqual(KNOWLEDGE_RESPONSE_MAX_CHARS);
      // A char-level cut of JSON would leave an unparseable document — worse
      // than no answer. The prune is by node, so this always parses.
      const json = res.text.slice(0, res.text.indexOf("\n…"));
      const parsed = JSON.parse(json) as KnowledgeNode[];
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.length).toBeLessThan(total);
      expect(parsed[0].id).toBe("kp-0");
      // The stated count is the truth, not an estimate.
      const omitted = Number(
        /…(\d+) of \d+ nodes omitted/.exec(res.text)![1],
      );
      expect(parsed.length + omitted).toBe(total);
    });
  });

  it("a nested tree is pruned depth-first, never leaving an orphan child", async () => {
    // A folder must never be dropped while its children survive: the ids
    // would be unreachable and the shape a lie about the bank's layout.
    const roots: KnowledgeNode[] = Array.from({ length: 60 }, (_, i) => ({
      id: `kf-${i}`,
      kind: "folder" as const,
      name: `Folder ${i} ${"pad".repeat(30)}`,
      children: Array.from({ length: 20 }, (_, j) => ({
        id: `kp-${i}-${j}`,
        kind: "page" as const,
        name: `Page ${i}/${j} ${"pad".repeat(30)}`,
      })),
    }));
    api.bodyOverride = (sub) => (sub === "tree" ? { roots } : undefined);
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_tree", {});
      expect(res.text.length).toBeLessThanOrEqual(KNOWLEDGE_RESPONSE_MAX_CHARS);
      const parsed = JSON.parse(
        res.text.slice(0, res.text.indexOf("\n…")),
      ) as KnowledgeNode[];
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.length).toBeLessThan(roots.length);
      // Every retained child sits under a retained folder, by construction.
      for (const folder of parsed) {
        expect(folder.kind).toBe("folder");
        for (const child of folder.children ?? []) {
          expect(child.id.startsWith(`${folder.id.replace("kf-", "kp-")}-`)).toBe(
            true,
          );
        }
      }
    });
  });

  it("a small tree is rendered whole, with no omission marker", async () => {
    await withShim(OWN_BANK, async (shim) => {
      const res = await callTool(shim, "get_knowledge_tree", {});
      expect(res.text).not.toContain("omitted");
      expect(JSON.parse(res.text)).toHaveLength(1);
    });
  });
});
