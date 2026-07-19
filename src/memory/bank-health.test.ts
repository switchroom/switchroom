/**
 * Coverage for `bank-health.ts` — the read-side integrity surface that tells an
 * operator when memory has silently stopped working. Two failure classes it is
 * built to fingerprint, and which this suite pins:
 *
 *   1. Extraction gaps: documents stored but `memory_unit_count === 0` — the
 *      conversation was retained yet the agent "remembers" nothing from it.
 *   2. Corrupted mental models: a persisted LLM-failure message (quota wall)
 *      standing in for real synthesis, injected into every turn until refreshed.
 *
 * All parsing runs against an injected `fetchImpl` returning the real REST JSON
 * shapes; the classifiers run against constructed summaries.
 */

import { describe, expect, it } from "vitest";
import {
  inspectBankHealth,
  corruptedMentalModels,
  staleMentalModels,
  recentUnextracted,
  ageDays,
  hindsightRestBase,
  type BankMentalModelSummary,
  type BankDocumentSummary,
} from "./bank-health.js";

const MCP_URL = "http://127.0.0.1:18888/mcp/";

function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.includes(suffix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("hindsightRestBase", () => {
  it("strips the /mcp/ suffix to derive the REST root", () => {
    expect(hindsightRestBase("http://127.0.0.1:18888/mcp/")).toBe("http://127.0.0.1:18888");
    expect(hindsightRestBase("http://h/mcp")).toBe("http://h");
    expect(hindsightRestBase("http://h/")).toBe("http://h");
  });
});

describe("inspectBankHealth", () => {
  it("flags documents with zero extracted facts as the extraction-gap fingerprint", async () => {
    const fetchImpl = jsonFetch({
      "/stats": { total_documents: 3, total_nodes: 12, pending_operations: 0 },
      "/documents": {
        items: [
          { id: "d1", created_at: "2026-07-01T00:00:00Z", text_length: 4000, memory_unit_count: 5 },
          { id: "d2", created_at: "2026-07-03T00:00:00Z", text_length: 3000, memory_unit_count: 0 },
          { id: "d3", created_at: "2026-07-02T00:00:00Z", text_length: 2000, memory_unit_count: 0 },
        ],
      },
      "/mental-models": { items: [] },
    });
    const h = await inspectBankHealth(MCP_URL, "coach", { fetchImpl });
    expect(h.ok).toBe(true);
    expect(h.totalDocuments).toBe(3);
    expect(h.totalFacts).toBe(12);
    // Both zero-fact docs surface, sorted oldest-first by createdAt.
    expect(h.unextractedDocuments.map((d) => d.id)).toEqual(["d3", "d2"]);
    // Newest doc timestamp is the max across all docs.
    expect(h.newestDocumentAt).toBe("2026-07-03T00:00:00Z");
  });

  it("summarises mental-model provenance (based_on counts + model→model edges)", async () => {
    const fetchImpl = jsonFetch({
      "/stats": { total_documents: 1, total_nodes: 1, pending_operations: 0 },
      "/documents": { items: [] },
      "/mental-models": {
        items: [
          {
            id: "mm-1",
            name: "training-plan",
            content: "the plan is...",
            source_query: "what's the plan?",
            last_refreshed_at: "2026-07-05T00:00:00Z",
            trigger: { mode: "incremental" },
            reflect_response: {
              based_on: {
                observation: [{ id: "o1" }, { id: "o2" }],
                "mental-models": [{ id: "mm-2" }],
              },
            },
          },
        ],
      },
    });
    const h = await inspectBankHealth(MCP_URL, "coach", { fetchImpl });
    const mm = h.mentalModels[0]!;
    expect(mm.basedOnCounts).toEqual({ observation: 2, "mental-models": 1 });
    expect(mm.totalSourceFacts).toBe(3);
    expect(mm.derivedFromModelIds).toEqual(["mm-2"]);
    expect(mm.refreshMode).toBe("incremental");
    expect(mm.contentHead).toContain("the plan");
  });

  it("drops mental-model rows missing id/name rather than emitting malformed entries", async () => {
    const fetchImpl = jsonFetch({
      "/stats": { total_documents: 0, total_nodes: 0, pending_operations: 0 },
      "/documents": { items: [] },
      "/mental-models": { items: [{ id: "ok", name: "fine" }, { name: "no-id" }, { id: "no-name" }] },
    });
    const h = await inspectBankHealth(MCP_URL, "coach", { fetchImpl });
    expect(h.mentalModels.map((m) => m.id)).toEqual(["ok"]);
  });

  it("counts active directives from the directives REST surface", async () => {
    const fetchImpl = jsonFetch({
      "/stats": { total_documents: 1, total_nodes: 1, pending_operations: 0 },
      "/documents": { items: [] },
      "/mental-models": { items: [] },
      "/directives": { items: [{ id: "x1" }, { id: "x2" }, { id: "x3" }] },
    });
    const h = await inspectBankHealth(MCP_URL, "coach", { fetchImpl });
    expect(h.ok).toBe(true);
    expect(h.activeDirectiveCount).toBe(3);
  });

  it("leaves activeDirectiveCount null (not zero) when the directives fetch fails — without failing the bank", async () => {
    // No /directives route → 404. The directives fetch is best-effort: the bank
    // still inspects ok, but the count is unknown (null), not a misleading 0.
    const fetchImpl = jsonFetch({
      "/stats": { total_documents: 1, total_nodes: 1, pending_operations: 0 },
      "/documents": { items: [] },
      "/mental-models": { items: [] },
    });
    const h = await inspectBankHealth(MCP_URL, "coach", { fetchImpl });
    expect(h.ok).toBe(true);
    expect(h.activeDirectiveCount).toBeNull();
  });

  it("returns ok:false with the failing stage's reason when a REST call errors", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const h = await inspectBankHealth(MCP_URL, "coach", { fetchImpl });
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("HTTP 500");
    expect(h.mentalModels).toEqual([]);
  });
});

describe("corruptedMentalModels", () => {
  function mm(over: Partial<BankMentalModelSummary>): BankMentalModelSummary {
    return {
      id: "id",
      name: "n",
      lastRefreshedAt: "2026-07-01T00:00:00Z",
      createdAt: "2026-06-01T00:00:00Z",
      contentLength: 500,
      contentHead: "healthy synthesized content",
      sourceQuery: "q",
      refreshMode: "full",
      basedOnCounts: {},
      totalSourceFacts: 0,
      derivedFromModelIds: [],
      ...over,
    };
  }

  it("flags a tiny model whose content is a quota/limit failure message", () => {
    const bad = mm({ contentLength: 60, contentHead: "You're out of extra usage · resets 3am (UTC)" });
    expect(corruptedMentalModels([bad, mm({})]).map((m) => m.id)).toEqual(["id"]);
  });

  it("flags an empty-content model that HAS refreshed (refresh produced nothing)", () => {
    const empty = mm({ contentLength: 0, lastRefreshedAt: "2026-07-01T00:00:00Z" });
    expect(corruptedMentalModels([empty])).toHaveLength(1);
  });

  it("does NOT flag an empty model that has never refreshed (nothing to synthesise yet)", () => {
    const fresh = mm({ contentLength: 0, lastRefreshedAt: null });
    expect(corruptedMentalModels([fresh])).toHaveLength(0);
  });

  it("does NOT flag a large model that merely mentions a limit phrase (real synthesis)", () => {
    const big = mm({ contentLength: 800, contentHead: "The user hit your usage limit last week and was frustrated..." });
    expect(corruptedMentalModels([big])).toHaveLength(0);
  });
});

describe("staleMentalModels", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  function mm(refreshed: string | null, created: string | null): BankMentalModelSummary {
    return {
      id: "id", name: "n", lastRefreshedAt: refreshed, createdAt: created,
      contentLength: 100, contentHead: "x", sourceQuery: "q", refreshMode: "full",
      basedOnCounts: {}, totalSourceFacts: 0, derivedFromModelIds: [],
    };
  }
  it("flags a model whose last refresh is older than the threshold", () => {
    expect(staleMentalModels([mm("2026-07-01T00:00:00Z", null)], 7, now)).toHaveLength(1);
  });
  it("does not flag a recently-refreshed model", () => {
    expect(staleMentalModels([mm("2026-07-09T00:00:00Z", null)], 7, now)).toHaveLength(0);
  });
  it("falls back to createdAt when never refreshed", () => {
    expect(staleMentalModels([mm(null, "2026-06-01T00:00:00Z")], 7, now)).toHaveLength(1);
  });
});

describe("recentUnextracted", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  function doc(over: Partial<BankDocumentSummary>): BankDocumentSummary {
    return { id: "d", createdAt: "2026-07-08T00:00:00Z", textLength: 4000, memoryUnitCount: 0, ...over };
  }
  it("excludes short documents (a one-line retain can legitimately yield no facts)", () => {
    expect(recentUnextracted([doc({ textLength: 200 })], 30, now, 1000)).toHaveLength(0);
  });
  it("includes a recent, substantial doc that extracted nothing", () => {
    expect(recentUnextracted([doc({ textLength: 4000 })], 30, now, 1000)).toHaveLength(1);
  });
  it("excludes docs older than the window", () => {
    expect(recentUnextracted([doc({ createdAt: "2026-01-01T00:00:00Z" })], 30, now, 1000)).toHaveLength(0);
  });
});

describe("ageDays", () => {
  it("returns fractional days, floored at zero, null on bad input", () => {
    const now = new Date("2026-07-10T00:00:00Z");
    expect(ageDays("2026-07-09T00:00:00Z", now)).toBeCloseTo(1, 5);
    expect(ageDays(null)).toBeNull();
    expect(ageDays("not-a-date")).toBeNull();
    // A future timestamp clamps to 0 rather than going negative.
    expect(ageDays("2026-07-11T00:00:00Z", now)).toBe(0);
  });
});
