/**
 * Coverage for `mental-model-refresh.ts` — the RFC-P10 stale-model refresh
 * sweep. The load-bearing behaviours this suite pins are exactly the ones a
 * regression would silently break:
 *
 *   1. SELECTION — only models past the staleness interval are refreshed; a
 *      fresh model is never POSTed. This is the whole point of the feature
 *      ("past their declared refresh interval", not "refresh everything"), so
 *      the test asserts the set of ids that actually hit the wire, not just a
 *      count.
 *   2. DRY-RUN — stale models are reported but ZERO refresh POSTs are issued.
 *   3. PARTIAL FAILURE — a tool-level `isError` on one model is counted failed
 *      and the sweep still refreshes the rest (never throws, never aborts).
 *   4. INSPECT FAILURE — a bank whose REST inspect fails yields `ok:false`
 *      without throwing, and a fleet where EVERY bank fails inspection sets
 *      `couldNotComplete` (the only condition that fails the cron tick), while
 *      per-model refresh failures do NOT.
 *
 * All wire traffic runs against an injected `fetchImpl`: GET → the hindsight
 * REST shapes `inspectBankHealth` parses; POST `/mcp/` → the MCP
 * `refresh_mental_model` envelope (SSE `data:` line), with per-id outcomes the
 * test controls.
 */

import { describe, expect, it } from "vitest";
import {
  refreshMentalModel,
  refreshStaleModelsInBank,
  runMentalModelRefresh,
} from "./mental-model-refresh.js";

const MCP_URL = "http://127.0.0.1:18888/mcp/";
const NOW = new Date("2026-08-17T00:00:00Z");

interface ModelSpec {
  id: string;
  name: string;
  last_refreshed_at: string | null;
  created_at: string | null;
}

/** Per-id refresh outcome the mock enacts. */
type RefreshOutcome = "ok" | { isError: string } | "throw";

interface HarnessOpts {
  models: ModelSpec[];
  /** Default `ok` for any id not named. */
  refresh?: Record<string, RefreshOutcome>;
  /** Force the REST stats fetch to fail (simulates engine unreachable). */
  inspectFails?: boolean;
}

/** Records every mental_model_id that reached the refresh tool over the wire. */
interface Harness {
  fetchImpl: typeof fetch;
  refreshedIds: string[];
}

function harness(opts: HarnessOpts): Harness {
  const refreshedIds: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // WRITE path: POST to the MCP endpoint.
    if (method === "POST" && url.includes("/mcp/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: { name?: string; arguments?: { mental_model_id?: string } };
      };
      if (body.method === "initialize") {
        return sse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      }
      if (body.method === "tools/call" && body.params?.name === "refresh_mental_model") {
        const id = body.params.arguments?.mental_model_id ?? "";
        refreshedIds.push(id);
        const outcome = opts.refresh?.[id] ?? "ok";
        if (outcome === "throw") throw new Error("connection reset");
        if (outcome === "ok") return sse({ jsonrpc: "2.0", id: 2, result: { content: [{ text: "refreshed" }] } });
        return sse({
          jsonrpc: "2.0",
          id: 2,
          result: { isError: true, content: [{ text: outcome.isError }] },
        });
      }
      return sse({ jsonrpc: "2.0", id: 2, result: {} });
    }
    // READ path: the REST surface inspectBankHealth walks.
    if (opts.inspectFails && url.includes("/stats")) {
      return new Response("boom", { status: 503 });
    }
    if (url.includes("/stats")) {
      return json({ total_documents: opts.models.length, total_nodes: 10, pending_operations: 0 });
    }
    if (url.includes("/documents")) return json({ items: [] });
    if (url.includes("/mental-models")) {
      return json({
        items: opts.models.map((m) => ({
          id: m.id,
          name: m.name,
          last_refreshed_at: m.last_refreshed_at,
          created_at: m.created_at,
          content: "some synthesized content",
        })),
      });
    }
    if (url.includes("/directives")) return json({ items: [] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, refreshedIds };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Wrap a JSON-RPC result the way the hindsight MCP server does — as an SSE `data:` line. */
function sse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200 });
}

/** Refreshed 30 days before NOW → stale at the 7-day default. */
const STALE_REFRESH = "2026-07-18T00:00:00Z";
/** Refreshed 1 day before NOW → fresh. */
const FRESH_REFRESH = "2026-08-16T00:00:00Z";
/** Created 40 days before NOW, never refreshed → stale via created_at fallback. */
const STALE_CREATED = "2026-07-08T00:00:00Z";

describe("refreshStaleModelsInBank — selection", () => {
  it("refreshes ONLY models past the staleness interval, never fresh ones", async () => {
    const h = harness({
      models: [
        { id: "stale-1", name: "A", last_refreshed_at: STALE_REFRESH, created_at: "2026-01-01T00:00:00Z" },
        { id: "fresh-1", name: "B", last_refreshed_at: FRESH_REFRESH, created_at: "2026-01-01T00:00:00Z" },
        { id: "never-1", name: "C", last_refreshed_at: null, created_at: STALE_CREATED },
      ],
    });
    const r = await refreshStaleModelsInBank(MCP_URL, "coach", { fetchImpl: h.fetchImpl, now: NOW });

    expect(r.ok).toBe(true);
    expect(r.totalModels).toBe(3);
    expect(r.staleModels).toBe(2);
    expect(r.refreshed).toBe(2);
    expect(r.failed).toBe(0);
    // The fresh model must NOT have hit the wire.
    expect(h.refreshedIds.sort()).toEqual(["never-1", "stale-1"]);
    expect(h.refreshedIds).not.toContain("fresh-1");
  });

  it("honours a custom --stale-days threshold", async () => {
    const h = harness({
      models: [
        { id: "d30", name: "A", last_refreshed_at: STALE_REFRESH, created_at: null },
        { id: "d1", name: "B", last_refreshed_at: FRESH_REFRESH, created_at: null },
      ],
    });
    // A 40-day threshold makes the 30-day model fresh too → nothing refreshed.
    const r = await refreshStaleModelsInBank(MCP_URL, "coach", { fetchImpl: h.fetchImpl, now: NOW, staleDays: 40 });
    expect(r.staleModels).toBe(0);
    expect(h.refreshedIds).toEqual([]);
  });
});

describe("refreshStaleModelsInBank — dry-run", () => {
  it("reports stale models but issues NO refresh POSTs", async () => {
    const h = harness({
      models: [{ id: "stale-1", name: "A", last_refreshed_at: STALE_REFRESH, created_at: null }],
    });
    const r = await refreshStaleModelsInBank(MCP_URL, "coach", { fetchImpl: h.fetchImpl, now: NOW, dryRun: true });
    expect(r.staleModels).toBe(1);
    expect(r.refreshed).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(h.refreshedIds).toEqual([]);
    expect(r.models[0]).toMatchObject({ id: "stale-1", refreshed: false });
  });
});

describe("refreshStaleModelsInBank — partial failure", () => {
  it("counts a tool-level isError as failed and still refreshes the rest", async () => {
    const h = harness({
      models: [
        { id: "stale-1", name: "A", last_refreshed_at: STALE_REFRESH, created_at: null },
        { id: "stale-2", name: "B", last_refreshed_at: STALE_REFRESH, created_at: null },
        { id: "stale-3", name: "C", last_refreshed_at: STALE_REFRESH, created_at: null },
      ],
      refresh: { "stale-2": { isError: "model not found" } },
    });
    const r = await refreshStaleModelsInBank(MCP_URL, "coach", { fetchImpl: h.fetchImpl, now: NOW });
    expect(r.refreshed).toBe(2);
    expect(r.failed).toBe(1);
    // All three were ATTEMPTED — the failure did not abort the sweep.
    expect(h.refreshedIds.sort()).toEqual(["stale-1", "stale-2", "stale-3"]);
    const failed = r.models.find((m) => m.id === "stale-2");
    expect(failed).toMatchObject({ refreshed: false, reason: "model not found" });
  });

  it("counts a transport throw as failed without aborting", async () => {
    const h = harness({
      models: [
        { id: "stale-1", name: "A", last_refreshed_at: STALE_REFRESH, created_at: null },
        { id: "stale-2", name: "B", last_refreshed_at: STALE_REFRESH, created_at: null },
      ],
      refresh: { "stale-1": "throw" },
    });
    const r = await refreshStaleModelsInBank(MCP_URL, "coach", { fetchImpl: h.fetchImpl, now: NOW });
    expect(r.refreshed).toBe(1);
    expect(r.failed).toBe(1);
  });
});

describe("refreshStaleModelsInBank — inspect failure", () => {
  it("returns ok:false without throwing when the bank cannot be inspected", async () => {
    const h = harness({ models: [], inspectFails: true });
    const r = await refreshStaleModelsInBank(MCP_URL, "coach", { fetchImpl: h.fetchImpl, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(h.refreshedIds).toEqual([]);
  });
});

describe("refreshMentalModel", () => {
  it("returns ok on a clean tool response", async () => {
    const h = harness({ models: [] });
    const res = await refreshMentalModel(MCP_URL, "coach", "m1", { fetchImpl: h.fetchImpl });
    expect(res.ok).toBe(true);
  });

  it("surfaces a non-200 as a transport failure", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "initialize") return new Response("{}", { status: 200 });
        return new Response("nope", { status: 500 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await refreshMentalModel(MCP_URL, "coach", "m1", { fetchImpl });
    expect(res).toEqual({ ok: false, reason: "HTTP 500" });
  });
});

describe("runMentalModelRefresh — fleet couldNotComplete semantics", () => {
  it("does NOT set couldNotComplete when at least one bank inspects, even with refresh failures", async () => {
    const h = harness({
      models: [{ id: "stale-1", name: "A", last_refreshed_at: STALE_REFRESH, created_at: null }],
      refresh: { "stale-1": { isError: "boom" } },
    });
    const r = await runMentalModelRefresh({
      mcpUrl: MCP_URL,
      bankIds: ["coach"],
      now: NOW,
      fetchImpl: h.fetchImpl,
    });
    expect(r.couldNotComplete).toBe(false);
    expect(r.totalFailed).toBe(1);
    expect(r.totalRefreshed).toBe(0);
  });

  it("sets couldNotComplete when EVERY bank fails inspection", async () => {
    const h = harness({ models: [], inspectFails: true });
    const r = await runMentalModelRefresh({
      mcpUrl: MCP_URL,
      bankIds: ["coach", "clerk"],
      now: NOW,
      fetchImpl: h.fetchImpl,
    });
    expect(r.couldNotComplete).toBe(true);
    expect(r.banks.every((b) => !b.ok)).toBe(true);
  });

  it("processes banks sequentially and aggregates totals", async () => {
    const h = harness({
      models: [
        { id: "s1", name: "A", last_refreshed_at: STALE_REFRESH, created_at: null },
        { id: "s2", name: "B", last_refreshed_at: STALE_REFRESH, created_at: null },
      ],
    });
    const r = await runMentalModelRefresh({
      mcpUrl: MCP_URL,
      bankIds: ["coach", "clerk"],
      now: NOW,
      fetchImpl: h.fetchImpl,
    });
    // Two banks, each sees the same two stale models → 4 refreshes total.
    expect(r.totalRefreshed).toBe(4);
    expect(r.banks).toHaveLength(2);
  });
});
