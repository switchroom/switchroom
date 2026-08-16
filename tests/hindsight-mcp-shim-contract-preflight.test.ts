/**
 * End-to-end outcome test for the shim's route-contract preflight
 * (design-v2.md §2.5's "engine version pin") wired into
 * `HindsightShim.synthesizedCall` (src/cli/hindsight-mcp-shim.ts), driven
 * through the real `tools/call` JSON-RPC path against a REST mock that
 * serves BOTH `/openapi.json` and the knowledge-base endpoints.
 *
 * This is the guard the task called for explicitly: "one that fails if a
 * synthesized tool's route vanishes and the shim stays quiet". Without the
 * preflight wired in, `search_knowledge_pages` against a REST 404 answers
 * `isError:true` too — but for the WRONG reason (a bare "HTTP 404"), and
 * critically the request still reaches the server. This test asserts BOTH
 * that the call fails loudly with the missing route named AND that the
 * request never left the shim — proving the rejection happens at the
 * contract layer, not as an incidental REST failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HindsightShim } from "../src/cli/hindsight-mcp-shim.js";

const BANK = "agent-own-bank";
const KNOWLEDGE_SEARCH_PATH =
  "/v1/default/banks/{bank_id}/knowledge-base/search";
const KNOWLEDGE_TREE_PATH = "/v1/default/banks/{bank_id}/knowledge-base/tree";
const DIRECTIVES_PATH = "/v1/default/banks/{bank_id}/directives";
const DIRECTIVE_ITEM_PATH = "/v1/default/banks/{bank_id}/directives/{directive_id}";
const KNOWLEDGE_PAGE_PATH =
  "/v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}";

interface Mock {
  baseUrl: string;
  server: Server;
  seen: { method: string; path: string }[];
  /** Paths present in the /openapi.json this server answers. Mutate to drift the spec. */
  presentPaths: Set<string>;
  close: () => Promise<void>;
}

function fullOpenApiPaths(): Set<string> {
  return new Set([
    DIRECTIVES_PATH,
    DIRECTIVE_ITEM_PATH,
    KNOWLEDGE_SEARCH_PATH,
    KNOWLEDGE_PAGE_PATH,
    KNOWLEDGE_TREE_PATH,
  ]);
}

async function startMock(): Promise<Mock> {
  const state: Mock = {
    baseUrl: "",
    server: undefined as unknown as Server,
    seen: [],
    presentPaths: fullOpenApiPaths(),
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

      if (path === "/openapi.json") {
        const paths: Record<string, Record<string, unknown>> = {};
        const methodsFor = (p: string): Record<string, unknown> => {
          if (p === DIRECTIVES_PATH) return { get: {}, post: {} };
          if (p === DIRECTIVE_ITEM_PATH) return { get: {}, patch: {}, delete: {} };
          return { get: {} };
        };
        for (const p of state.presentPaths) paths[p] = methodsFor(p);
        return send(200, { info: { version: "0.9.0" }, paths });
      }

      const [rawPath, rawQuery] = path.split("?");
      const query = new URLSearchParams(rawQuery ?? "");
      const m =
        /^\/v1\/default\/banks\/([^/]+)\/knowledge-base\/(tree|search)$/.exec(
          rawPath,
        );
      if (m && decodeURIComponent(m[1]) === BANK) {
        if (m[2] === "search") {
          const q = query.get("q") ?? "";
          if (q.length === 0) return send(422, { detail: "q too short" });
          return send(200, {
            results: [
              {
                id: "pg-1",
                name: "A page",
                snippet: "hit",
                score: 0.9,
              },
            ],
            total: 1,
          });
        }
        return send(200, { roots: [] });
      }
      return send(404, { detail: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.server = server;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

async function withShim<T>(
  mock: Mock,
  fn: (shim: HindsightShim) => Promise<T>,
): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), "shim-contract-preflight-"));
  try {
    return await fn(
      new HindsightShim({
        // /mcp/ on the mock 404s — the synthesized path never touches it.
        url: `${mock.baseUrl}/mcp/`,
        bankId: BANK,
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

let mock: Mock;
beforeEach(async () => {
  mock = await startMock();
});
afterEach(async () => {
  await mock.close();
});

describe("route-contract preflight, end to end through tools/call", () => {
  it("baseline: succeeds normally when the live spec has every route", async () => {
    await withShim(mock, async (shim) => {
      const result = await callTool(shim, "search_knowledge_pages", {
        query: "hit",
      });
      expect(result.isError).toBe(false);
      expect(
        mock.seen.some(
          (r) =>
            r.method === "GET" &&
            r.path.includes(`/knowledge-base/search`),
        ),
      ).toBe(true);
    });
  });

  it(
    "THE GUARD: when /openapi.json drops the search route, the call fails " +
      "LOUDLY naming the missing route, and the REST search endpoint is " +
      "NEVER hit — proving the shim did not just stay quiet",
    async () => {
      mock.presentPaths.delete(KNOWLEDGE_SEARCH_PATH);
      await withShim(mock, async (shim) => {
        const result = await callTool(shim, "search_knowledge_pages", {
          query: "hit",
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("search_knowledge_pages");
        expect(result.text).toContain("GET " + KNOWLEDGE_SEARCH_PATH);
        // The whole point: this is a REFUSAL, not an attempted call that
        // happened to fail. If the shim regressed to "try anyway", this
        // request would show up in `seen` as a 422/200 against the mock.
        expect(
          mock.seen.some((r) => r.path.includes("/knowledge-base/search")),
        ).toBe(false);
      });
    },
  );

  it("a route drop on ONE synthesized tool does not block a sibling tool", async () => {
    mock.presentPaths.delete(KNOWLEDGE_SEARCH_PATH);
    await withShim(mock, async (shim) => {
      const tree = await callTool(shim, "get_knowledge_tree", {});
      expect(tree.isError).toBe(false);
    });
  });

});
