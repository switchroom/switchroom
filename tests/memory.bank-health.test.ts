import { describe, it, expect } from "vitest";
import {
  inspectBankHealth,
  hindsightRestBase,
  staleMentalModels,
  recentUnextracted,
  ageDays,
} from "../src/memory/bank-health.js";
import { checkBankIngestHealth } from "../src/cli/doctor.js";
import { handleGetMemoryHealth } from "../src/web/api.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const NOW = new Date("2026-06-10T12:00:00Z");

/** Routes the three REST endpoints to canned JSON per bank. */
function fakeFetchFor(banks: Record<string, {
  stats?: unknown;
  documents?: unknown;
  models?: unknown;
  failWith?: number;
}>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/mcp\/?$/.test(url)) {
      // MCP initialize probe (probeHindsight)
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "hindsight", version: "test" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const m = url.match(/\/v1\/default\/banks\/([^/]+)\/(stats|documents|mental-models)/);
    if (!m) return new Response("not found", { status: 404 });
    const bank = decodeURIComponent(m[1]);
    const fixture = banks[bank];
    if (!fixture) return new Response("no bank", { status: 404 });
    if (fixture.failWith) return new Response("err", { status: fixture.failWith });
    const body =
      m[2] === "stats" ? fixture.stats ?? {} :
      m[2] === "documents" ? fixture.documents ?? { items: [] } :
      fixture.models ?? { items: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const HEALTHY_BANK = {
  stats: { total_documents: 42, total_nodes: 900, pending_operations: 0 },
  documents: {
    items: [
      { id: "d1", created_at: "2026-06-09T10:00:00Z", text_length: 5000, memory_unit_count: 12 },
      { id: "d2", created_at: "2026-06-01T10:00:00Z", text_length: 800, memory_unit_count: 3 },
    ],
  },
  models: {
    items: [
      { id: "m1", name: "Case State", last_refreshed_at: "2026-06-10T01:00:00Z", created_at: "2026-04-01T00:00:00Z" },
    ],
  },
};

const GAPPED_BANK = {
  stats: { total_documents: 10, total_nodes: 100, pending_operations: 0 },
  documents: {
    items: [
      { id: "ok1", created_at: "2026-06-08T10:00:00Z", text_length: 900, memory_unit_count: 4 },
      { id: "gap1", created_at: "2026-06-05T10:00:00Z", text_length: 30000, memory_unit_count: 0 },
      { id: "gap2", created_at: "2026-06-03T10:00:00Z", text_length: 36000, memory_unit_count: 0 },
      // Ancient zero-fact doc — outside the 30d actionable window.
      { id: "old0", created_at: "2026-01-01T00:00:00Z", text_length: 500, memory_unit_count: 0 },
    ],
  },
  models: { items: [] },
};

const STALE_MODEL_BANK = {
  stats: { total_documents: 5, total_nodes: 50, pending_operations: 0 },
  documents: {
    items: [{ id: "d1", created_at: "2026-06-09T00:00:00Z", text_length: 100, memory_unit_count: 2 }],
  },
  models: {
    items: [
      { id: "m1", name: "Old Map", last_refreshed_at: "2026-05-20T00:00:00Z", created_at: "2026-04-01T00:00:00Z" },
      { id: "m2", name: "Fresh", last_refreshed_at: "2026-06-10T00:00:00Z", created_at: "2026-04-01T00:00:00Z" },
    ],
  },
};

describe("hindsightRestBase", () => {
  it("strips the /mcp/ suffix", () => {
    expect(hindsightRestBase("http://127.0.0.1:18888/mcp/")).toBe("http://127.0.0.1:18888");
    expect(hindsightRestBase("http://127.0.0.1:18888/mcp")).toBe("http://127.0.0.1:18888");
    expect(hindsightRestBase("http://h:8888/")).toBe("http://h:8888");
  });
});

describe("inspectBankHealth", () => {
  it("summarizes a healthy bank", async () => {
    const h = await inspectBankHealth("http://x/mcp/", "lawgpt", {
      fetchImpl: fakeFetchFor({ lawgpt: HEALTHY_BANK }),
    });
    expect(h.ok).toBe(true);
    expect(h.totalDocuments).toBe(42);
    expect(h.totalFacts).toBe(900);
    expect(h.newestDocumentAt).toBe("2026-06-09T10:00:00Z");
    expect(h.unextractedDocuments).toHaveLength(0);
    expect(h.mentalModels).toHaveLength(1);
  });

  it("collects zero-fact documents oldest-first", async () => {
    const h = await inspectBankHealth("http://x/mcp/", "marko", {
      fetchImpl: fakeFetchFor({ marko: GAPPED_BANK }),
    });
    expect(h.ok).toBe(true);
    expect(h.unextractedDocuments.map((d) => d.id)).toEqual(["old0", "gap2", "gap1"]);
  });

  it("degrades to ok:false with a reason on HTTP failure (never throws)", async () => {
    const h = await inspectBankHealth("http://x/mcp/", "down", {
      fetchImpl: fakeFetchFor({ down: { failWith: 503 } }),
    });
    expect(h.ok).toBe(false);
    expect(h.reason).toContain("503");
  });
});

describe("helpers", () => {
  it("ageDays handles null and bad input", () => {
    expect(ageDays(null, NOW)).toBeNull();
    expect(ageDays("not-a-date", NOW)).toBeNull();
    expect(ageDays("2026-06-09T12:00:00Z", NOW)).toBeCloseTo(1, 1);
  });

  it("staleMentalModels uses lastRefreshed, falling back to createdAt", () => {
    const stale = staleMentalModels(
      [
        { id: "a", name: "a", lastRefreshedAt: "2026-05-01T00:00:00Z", createdAt: null },
        { id: "b", name: "b", lastRefreshedAt: null, createdAt: "2026-06-09T00:00:00Z" },
        { id: "c", name: "c", lastRefreshedAt: "2026-06-10T00:00:00Z", createdAt: null },
      ],
      7,
      NOW,
    );
    expect(stale.map((m) => m.id)).toEqual(["a"]);
  });

  it("recentUnextracted windows by age and ignores trivial documents", () => {
    const docs = [
      { id: "new", createdAt: "2026-06-05T00:00:00Z", textLength: 5000, memoryUnitCount: 0 },
      { id: "old", createdAt: "2026-01-01T00:00:00Z", textLength: 5000, memoryUnitCount: 0 },
      // A one-line ack/stub legitimately extracts nothing — not a gap.
      { id: "tiny", createdAt: "2026-06-05T00:00:00Z", textLength: 515, memoryUnitCount: 0 },
    ];
    expect(recentUnextracted(docs, 30, NOW).map((d) => d.id)).toEqual(["new"]);
  });
});

function minimalConfig(agents: Record<string, { memory?: { collection?: string } }>): SwitchroomConfig {
  return {
    memory: { backend: "hindsight", config: { url: "http://x/mcp/" } },
    agents,
  } as unknown as SwitchroomConfig;
}

describe("checkBankIngestHealth (doctor)", () => {
  it("fails the bank with recent unextracted documents and carries the reprocess fix", async () => {
    const results = await checkBankIngestHealth(
      minimalConfig({ marko: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeFetchFor({ marko: GAPPED_BANK }), now: NOW },
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("2 document(s)");
    expect(results[0].fix).toContain("/documents/gap2/reprocess");
  });

  it("warns on stale mental models, ok otherwise, and dedupes shared banks", async () => {
    const results = await checkBankIngestHealth(
      minimalConfig({
        clerk: { memory: { collection: "assistant" } },
        helper: { memory: { collection: "assistant" } },
        lawgpt: {},
        ziggy: { memory: { collection: "stale" } },
      }),
      "http://x/mcp/",
      {
        fetchImpl: fakeFetchFor({
          assistant: HEALTHY_BANK,
          lawgpt: HEALTHY_BANK,
          stale: STALE_MODEL_BANK,
        }),
        now: NOW,
      },
    );
    expect(results).toHaveLength(3);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName["bank assistant (clerk, helper)"].status).toBe("ok");
    expect(byName["bank lawgpt"].status).toBe("ok");
    expect(byName["bank stale (ziggy)"].status).toBe("warn");
    expect(byName["bank stale (ziggy)"].detail).toContain("Old Map");
  });

  it("warns (not fail) when the bank inspection itself errors", async () => {
    const results = await checkBankIngestHealth(
      minimalConfig({ ziggy: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeFetchFor({ ziggy: { failWith: 500 } }), now: NOW },
    );
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("inspection failed");
  });
});

describe("handleGetMemoryHealth (dashboard)", () => {
  it("returns per-bank rows with doctor-equivalent statuses", async () => {
    const health = await handleGetMemoryHealth(
      minimalConfig({
        lawgpt: {},
        marko: {},
        ziggy: { memory: { collection: "stale" } },
      }),
      {
        fetchImpl: fakeFetchFor({
          lawgpt: HEALTHY_BANK,
          marko: GAPPED_BANK,
          stale: STALE_MODEL_BANK,
        }),
        now: NOW,
      },
    );
    expect(health.reachable).toBe(true);
    expect(health.banks.map((b) => b.bank)).toEqual(["lawgpt", "marko", "stale"]);
    const byBank = Object.fromEntries(health.banks.map((b) => [b.bank, b]));
    expect(byBank.lawgpt.status).toBe("ok");
    expect(byBank.marko.status).toBe("fail");
    expect(byBank.marko.recentUnextractedCount).toBe(2);
    expect(byBank.marko.oldestUnextractedAt).toBe("2026-06-03T10:00:00Z");
    expect(byBank.stale.status).toBe("warn");
    expect(byBank.stale.staleMentalModelCount).toBe(1);
    expect(byBank.stale.agents).toEqual(["ziggy"]);
  });

  it("reports unreachable without throwing when hindsight is down", async () => {
    const down = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const health = await handleGetMemoryHealth(minimalConfig({ a: {} }), {
      fetchImpl: down,
      now: NOW,
    });
    expect(health.reachable).toBe(false);
    expect(health.banks).toEqual([]);
  });
});
