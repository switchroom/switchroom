import { describe, it, expect } from "vitest";
import {
  inspectBankHealth,
  getMentalModelDetail,
  hindsightRestBase,
  staleMentalModels,
  corruptedMentalModels,
  recentUnextracted,
  ageDays,
} from "../src/memory/bank-health.js";
import { checkBankIngestHealth, checkBankObservationsMissions } from "../src/cli/doctor.js";
import {
  DEFAULT_OBSERVATIONS_MISSION,
  SUPERSEDED_OBSERVATIONS_MISSIONS,
  PROFILE_MEMORY_DEFAULTS,
} from "../src/memory/hindsight.js";
import { handleGetMemoryHealth } from "../src/web/api.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const NOW = new Date("2026-06-10T12:00:00Z");

/** Routes the three REST endpoints to canned JSON per bank. */
function fakeFetchFor(banks: Record<string, {
  stats?: unknown;
  documents?: unknown;
  models?: unknown;
  directives?: unknown;
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
    const m = url.match(/\/v1\/default\/banks\/([^/?]+)\/(stats|documents|mental-models|directives)/);
    if (!m) return new Response("not found", { status: 404 });
    const bank = decodeURIComponent(m[1]);
    const fixture = banks[bank];
    if (!fixture) return new Response("no bank", { status: 404 });
    if (fixture.failWith) return new Response("err", { status: fixture.failWith });
    const body =
      m[2] === "stats" ? fixture.stats ?? {} :
      m[2] === "documents" ? fixture.documents ?? { items: [] } :
      m[2] === "directives" ? fixture.directives ?? { items: [] } :
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
      { id: "m1", name: "Case State", last_refreshed_at: "2026-06-10T01:00:00Z", created_at: "2026-04-01T00:00:00Z", content: "# Case State\n\nA healthy, substantive synthesis of the matter.", source_query: "What is the current state of the matter?", trigger: { mode: "full" } },
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
      { id: "m1", name: "Old Map", last_refreshed_at: "2026-05-20T00:00:00Z", created_at: "2026-04-01T00:00:00Z", content: "# Old Map\n\nReal content, just not refreshed lately." },
      { id: "m2", name: "Fresh", last_refreshed_at: "2026-06-10T00:00:00Z", created_at: "2026-04-01T00:00:00Z", content: "# Fresh\n\nRecently refreshed real content." },
    ],
  },
};

// A bank whose hub model synthesizes two leaf models (the relationship graph).
const HUB_BANK = {
  stats: { total_documents: 12, total_nodes: 120, pending_operations: 0 },
  documents: {
    items: [{ id: "d1", created_at: "2026-06-09T00:00:00Z", text_length: 4000, memory_unit_count: 9 }],
  },
  models: {
    items: [
      {
        id: "hub", name: "hub",
        last_refreshed_at: "2026-06-10T00:00:00Z", created_at: "2026-04-01T00:00:00Z",
        content: "# Hub\n\nSynthesis of the leaves.", source_query: "the big picture?",
        trigger: { mode: "full" },
        reflect_response: { based_on: { observation: [{}, {}, {}, {}, {}], directives: [{}, {}], "mental-models": [{ id: "leaf-1" }, { id: "leaf-2" }] } },
      },
      {
        id: "leaf-1", name: "Leaf One",
        last_refreshed_at: "2026-06-10T00:00:00Z", created_at: "2026-04-01T00:00:00Z",
        content: "# Leaf One", source_query: "leaf one?",
        reflect_response: { based_on: { directives: [{}, {}, {}, {}] } },
      },
      {
        id: "leaf-2", name: "Leaf Two",
        last_refreshed_at: "2026-06-10T00:00:00Z", created_at: "2026-04-01T00:00:00Z",
        content: "# Leaf Two", source_query: "leaf two?",
        reflect_response: { based_on: { directives: [{}, {}] } },
      },
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
    // The model summary now carries the "why" (source_query) + refresh mode.
    expect(h.mentalModels[0].sourceQuery).toBe("What is the current state of the matter?");
    expect(h.mentalModels[0].refreshMode).toBe("full");
  });

  it("defaults sourceQuery/refreshMode when the model omits them", async () => {
    const h = await inspectBankHealth("http://x/mcp/", "stale", {
      fetchImpl: fakeFetchFor({ stale: STALE_MODEL_BANK }),
    });
    expect(h.ok).toBe(true);
    expect(h.mentalModels[0].sourceQuery).toBe("");
    expect(h.mentalModels[0].refreshMode).toBeNull();
  });

  it("extracts provenance counts + model→model edges from the list call", async () => {
    const h = await inspectBankHealth("http://x/mcp/", "assistant", {
      fetchImpl: fakeFetchFor({ assistant: HUB_BANK }),
    });
    expect(h.ok).toBe(true);
    const byName = Object.fromEntries(h.mentalModels.map((mm) => [mm.name, mm]));
    // Hub: derives from two leaf models + raw facts.
    expect(byName.hub.derivedFromModelIds).toEqual(["leaf-1", "leaf-2"]);
    expect(byName.hub.basedOnCounts).toEqual({ observation: 5, directives: 2, "mental-models": 2 });
    expect(byName.hub.totalSourceFacts).toBe(9);
    // Leaf: no outgoing edges.
    expect(byName["Leaf One"].derivedFromModelIds).toEqual([]);
    expect(byName["Leaf One"].basedOnCounts).toEqual({ directives: 4 });
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

describe("getMentalModelDetail", () => {
  // The by-id endpoint (/mental-models/<id>) — NOT the list. The full-content
  // detail with provenance from reflect_response.based_on.
  function fakeDetailFetch(body: unknown, status = 200): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!/\/mental-models\/[^/]+$/.test(url)) {
        return new Response("wrong route", { status: 404 });
      }
      if (status !== 200) return new Response("err", { status });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("returns full content + provenance counts by fact type", async () => {
    const res = await getMentalModelDetail("http://x/mcp/", "assistant", "mm-1", {
      fetchImpl: fakeDetailFetch({
        id: "mm-1",
        name: "user-profile",
        source_query: "What do we know about the user?",
        content: "# User Profile\n\nKen builds switchroom.",
        last_refreshed_at: "2026-06-15T11:00:00Z",
        created_at: "2026-06-06T00:00:00Z",
        trigger: { mode: "full" },
        reflect_response: {
          based_on: {
            observation: [{}, {}, {}],
            directives: [{}, {}],
            world: [],
            "mental-models": [{ id: "leaf-a" }, { id: "leaf-b" }],
          },
        },
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.sourceQuery).toBe("What do we know about the user?");
    expect(res.model.content).toContain("Ken builds switchroom");
    expect(res.model.refreshMode).toBe("full");
    expect(res.model.basedOnCounts).toEqual({
      observation: 3,
      directives: 2,
      world: 0,
      "mental-models": 2,
    });
    expect(res.model.totalSourceFacts).toBe(7);
    // The model→model edges (relationships) are extracted from the
    // mental-models bucket's ids.
    expect(res.model.derivedFromModelIds).toEqual(["leaf-a", "leaf-b"]);
  });

  it("tolerates a missing reflect_response (no provenance, no edges)", async () => {
    const res = await getMentalModelDetail("http://x/mcp/", "assistant", "mm-2", {
      fetchImpl: fakeDetailFetch({ id: "mm-2", name: "Bare", content: "x" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.totalSourceFacts).toBe(0);
    expect(res.model.basedOnCounts).toEqual({});
    expect(res.model.derivedFromModelIds).toEqual([]);
    expect(res.model.sourceQuery).toBe("");
    expect(res.model.refreshMode).toBeNull();
  });

  it("degrades to ok:false with a reason on HTTP failure (never throws)", async () => {
    const res = await getMentalModelDetail("http://x/mcp/", "assistant", "mm-3", {
      fetchImpl: fakeDetailFetch({}, 404),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("404");
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

  it("corruptedMentalModels fingerprints persisted LLM-failure content", () => {
    const mk = (id: string, contentHead: string, contentLength: number, refreshed: string | null = "2026-06-10T01:39:00Z") =>
      ({ id, name: id, lastRefreshedAt: refreshed, createdAt: "2026-04-01T00:00:00Z", contentLength, contentHead });
    const corrupted = corruptedMentalModels([
      // The live 2026-06-10 incident strings:
      mk("quota", "You're out of extra usage · resets 3am (UTC)", 44),
      mk("session", "You've hit your session limit · resets 1pm (Australia/Melbourne)", 65),
      // Empty content but HAS refreshed → corrupt; never refreshed → fine.
      mk("empty-refreshed", "", 0),
      mk("empty-never", "", 0, null),
      // Real content mentioning limits is NOT corrupt (length >= 300).
      mk("real", "# Case State — discusses the usage limit of the trust...", 8000),
      // Short but genuine content without failure phrasing is NOT corrupt.
      mk("short-real", "## Notes\nNothing recorded yet beyond the kickoff.", 49),
    ]);
    expect(corrupted.map((m) => m.id)).toEqual(["quota", "session", "empty-refreshed"]);
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

  it("sweeps profile banks too, labelled '(profile)' (not '()')", async () => {
    const config = {
      memory: { backend: "hindsight", config: { url: "http://x/mcp/" } },
      agents: {
        clerk: { memory: { collection: "clerk", recall: { additional_banks: ["ken-profile"] } } },
      },
    } as unknown as SwitchroomConfig;
    const results = await checkBankIngestHealth(config, "http://x/mcp/", {
      fetchImpl: fakeFetchFor({ clerk: HEALTHY_BANK, "ken-profile": HEALTHY_BANK }),
      now: NOW,
    });
    const names = results.map((r) => r.name);
    expect(names).toContain("bank ken-profile (profile)");
    // the agent-less profile bank must NOT render the empty "()" label
    expect(names).not.toContain("bank ken-profile ()");
  });

  it("emits a FAIL directives row surfacing MAX_DIRECTIVES truncation (workstream C2), alongside the ingest row", async () => {
    const OVER_CAP = {
      ...HEALTHY_BANK,
      directives: { items: Array.from({ length: 31 }, (_, i) => ({ id: `dir-${i}` })) },
    };
    const results = await checkBankIngestHealth(
      minimalConfig({ marko: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeFetchFor({ marko: OVER_CAP }), now: NOW },
    );
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    // Healthy ingest row still present…
    expect(byName["bank marko"].status).toBe("ok");
    // …plus a distinct FAIL directives row that names the truncation.
    const dir = byName["bank marko directives"];
    expect(dir.status).toBe("fail");
    expect(dir.detail).toMatch(/truncated/i);
    expect(dir.detail).toContain("31 active directives");
  });

  it("emits a WARN directives row at 25, and NO directives row at 24 or below", async () => {
    const WARN_BANK = {
      ...HEALTHY_BANK,
      directives: { items: Array.from({ length: 25 }, (_, i) => ({ id: `dir-${i}` })) },
    };
    const OK_BANK = {
      ...HEALTHY_BANK,
      directives: { items: Array.from({ length: 24 }, (_, i) => ({ id: `dir-${i}` })) },
    };
    const warn = await checkBankIngestHealth(
      minimalConfig({ marko: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeFetchFor({ marko: WARN_BANK }), now: NOW },
    );
    expect(warn.find((r) => r.name === "bank marko directives")?.status).toBe("warn");

    const ok = await checkBankIngestHealth(
      minimalConfig({ marko: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeFetchFor({ marko: OK_BANK }), now: NOW },
    );
    // At the threshold and below, no directives row is emitted at all.
    expect(ok.some((r) => r.name === "bank marko directives")).toBe(false);
  });

  it("omits the fleet consolidation-backlog row unless opted in (#2903 fix 5.3)", async () => {
    const BACKLOGGED = {
      stats: { total_documents: 5, total_nodes: 50, pending_operations: 250 },
      documents: { items: [{ id: "d1", created_at: "2026-06-09T00:00:00Z", text_length: 100, memory_unit_count: 2 }] },
      models: { items: [] },
    };
    const cfg = minimalConfig({ marko: {} });
    const fetchImpl = fakeFetchFor({ marko: BACKLOGGED });

    // Default: per-bank rows only, no backlog aggregate (protects the contract
    // the other tests in this file assert exact lengths against).
    const bare = await checkBankIngestHealth(cfg, "http://x/mcp/", { fetchImpl, now: NOW });
    expect(bare.some((r) => /backlog/i.test(r.name))).toBe(false);

    // Opted in (as the CLI doctor does): the aggregate row is appended last.
    const withBacklog = await checkBankIngestHealth(cfg, "http://x/mcp/", {
      fetchImpl,
      now: NOW,
      includeConsolidationBacklog: true,
    });
    expect(withBacklog.length).toBe(bare.length + 1);
    expect(/backlog/i.test(withBacklog[withBacklog.length - 1].name)).toBe(true);
  });
});

const CORRUPT_MODEL_BANK = {
  stats: { total_documents: 5, total_nodes: 50, pending_operations: 0 },
  documents: {
    items: [{ id: "d1", created_at: "2026-06-09T00:00:00Z", text_length: 100, memory_unit_count: 2 }],
  },
  models: {
    items: [
      {
        id: "m1", name: "Case State",
        last_refreshed_at: "2026-06-10T01:39:00Z", created_at: "2026-04-01T00:00:00Z",
        content: "You're out of extra usage · resets 3am (UTC)",
      },
    ],
  },
};

describe("corruption detection end-to-end", () => {
  it("doctor fails the bank and names the corrupted model", async () => {
    const results = await checkBankIngestHealth(
      minimalConfig({ lawgpt: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeFetchFor({ lawgpt: CORRUPT_MODEL_BANK }), now: NOW },
    );
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("Case State");
    expect(results[0].detail).toContain("LLM-failure message");
  });

  it("dashboard row carries fail status + corrupted names", async () => {
    const health = await handleGetMemoryHealth(minimalConfig({ lawgpt: {} }), {
      fetchImpl: fakeFetchFor({ lawgpt: CORRUPT_MODEL_BANK }),
      now: NOW,
    });
    expect(health.banks[0].status).toBe("fail");
    expect(health.banks[0].corruptedMentalModelNames).toEqual(["Case State"]);
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

  it("surfaces profile banks as agent-less rows with kind:'profile'", async () => {
    const config = {
      memory: { backend: "hindsight", config: { url: "http://x/mcp/" } },
      agents: {
        clerk: {
          memory: { collection: "clerk", recall: { additional_banks: ["ken-profile"] } },
        },
      },
    } as unknown as SwitchroomConfig;
    const health = await handleGetMemoryHealth(config, {
      fetchImpl: fakeFetchFor({ clerk: HEALTHY_BANK, "ken-profile": HEALTHY_BANK }),
      now: NOW,
    });
    const byBank = Object.fromEntries(health.banks.map((b) => [b.bank, b]));
    // agent bank: owned, kind 'agent'
    expect(byBank.clerk.kind).toBe("agent");
    expect(byBank.clerk.agents).toEqual(["clerk"]);
    // profile bank: no owning agent, kind 'profile'
    expect(byBank["ken-profile"].kind).toBe("profile");
    expect(byBank["ken-profile"].agents).toEqual([]);
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

/**
 * `observations_mission` doctor row.
 *
 * Why a LIVE-read check rather than a yaml one: `observations_mission` is
 * pushed by scaffold/reconcile and is never set in yaml on a default setup, so
 * a yaml-shaped check is structurally incapable of seeing the failure. The
 * failure it must see was measured on 2026-07-28 — all 27 live banks read
 * `observations_mission: null`, i.e. the whole fleet consolidating under
 * Hindsight's stock mission, with every other memory row green.
 */
describe("checkBankObservationsMissions (doctor)", () => {
  /** Serves GET /v1/default/banks/<id>/config from a per-bank fixture. */
  function fakeConfigFetch(
    banks: Record<string, { observations_mission?: string | null; failWith?: number }>,
  ): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = url.match(/\/v1\/default\/banks\/([^/?]+)\/config/);
      if (!m) return new Response("not found", { status: 404 });
      const fixture = banks[decodeURIComponent(m[1])];
      if (!fixture) return new Response("no bank", { status: 404 });
      if (fixture.failWith) return new Response("err", { status: fixture.failWith });
      return new Response(
        JSON.stringify({
          config: { retain_mission: null, observations_mission: fixture.observations_mission ?? null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  }

  it("WARNS on the measured fleet state — an unset mission means the engine's stock mission", async () => {
    const results = await checkBankObservationsMissions(
      minimalConfig({ ziggy: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeConfigFetch({ ziggy: { observations_mission: null } }) },
    );
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("bank ziggy observations_mission");
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("unset");
    expect(results[0].fix).toBe("Run: switchroom agent reconcile ziggy");
  });

  it("passes a bank carrying the current fleet default", async () => {
    const results = await checkBankObservationsMissions(
      minimalConfig({ ziggy: {} }),
      "http://x/mcp/",
      {
        fetchImpl: fakeConfigFetch({
          ziggy: { observations_mission: DEFAULT_OBSERVATIONS_MISSION },
        }),
      },
    );
    expect(results[0].status).toBe("ok");
    expect(results[0].detail).toBe("switchroom fleet default");
  });

  it("passes an operator hand-authored mission — the never-clobber rule is not a defect", async () => {
    const results = await checkBankObservationsMissions(
      minimalConfig({ overlord: {} }),
      "http://x/mcp/",
      {
        fetchImpl: fakeConfigFetch({
          overlord: { observations_mission: "You consolidate the memory of overlord…" },
        }),
      },
    );
    expect(results[0].status).toBe("ok");
    expect(results[0].detail).toContain("operator-authored");
  });

  it("warns that a superseded switchroom default is waiting on reconcile", async () => {
    const results = await checkBankObservationsMissions(
      minimalConfig({ gymbro: {} }),
      "http://x/mcp/",
      {
        fetchImpl: fakeConfigFetch({
          gymbro: { observations_mission: SUPERSEDED_OBSERVATIONS_MISSIONS[0] },
        }),
      },
    );
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("superseded");
    expect(results[0].fix).toContain("reconcile gymbro");
  });

  it("reads the profile default for a profiled agent, and passes when the bank matches", async () => {
    const config = {
      memory: { backend: "hindsight", config: { url: "http://x/mcp/" } },
      agents: { dev: { extends: "coding" } },
    } as unknown as SwitchroomConfig;
    const coding = PROFILE_MEMORY_DEFAULTS.coding.observations_mission!;

    const matching = await checkBankObservationsMissions(config, "http://x/mcp/", {
      fetchImpl: fakeConfigFetch({ dev: { observations_mission: coding } }),
    });
    expect(matching[0].status).toBe("ok");
    expect(matching[0].detail).toBe("switchroom coding-profile default");

    // The generic fleet default on a coding bank is an UPGRADE pending, not ok.
    const generic = await checkBankObservationsMissions(config, "http://x/mcp/", {
      fetchImpl: fakeConfigFetch({ dev: { observations_mission: DEFAULT_OBSERVATIONS_MISSION } }),
    });
    expect(generic[0].status).toBe("warn");
  });

  // Option-B red-team: the drift row must key off the RESOLVED memory profile
  // (memory.profile → extends → default), not raw `extends`. An agent on the
  // `default` PERSONA profile that opts its bank into the `coding` MEMORY bundle
  // via `memory.profile` carries the coding mission on its bank (scaffold seeds
  // it). If doctor keyed off `extends` ("default"), the coding mission would be
  // seen as a superseded switchroom default and the row would FALSE-FLAG the
  // opted-in agent as drifted, sending the operator to a reconcile that would
  // (correctly) re-push the same coding mission — a no-op churn loop.
  //
  // Verified to bite: reverting doctor's `resolveMemoryProfile(entry.config)`
  // back to `entry.config.extends ?? DEFAULT_PROFILE` flips this row to `warn`.
  it("keys the drift row off memory.profile, not extends (no false drift for opted-in agents)", async () => {
    const config = {
      memory: { backend: "hindsight", config: { url: "http://x/mcp/" } },
      agents: { dev: { extends: "default", memory: { profile: "coding" } } },
    } as unknown as SwitchroomConfig;
    const coding = PROFILE_MEMORY_DEFAULTS.coding.observations_mission!;

    // Bank correctly carries the coding mission → steady state, not drift.
    const matching = await checkBankObservationsMissions(config, "http://x/mcp/", {
      fetchImpl: fakeConfigFetch({ dev: { observations_mission: coding } }),
    });
    expect(matching[0].status).toBe("ok");
    expect(matching[0].detail).toBe("switchroom coding-profile default");

    // And the generic fleet default IS a real upgrade-pending for this bank.
    const generic = await checkBankObservationsMissions(config, "http://x/mcp/", {
      fetchImpl: fakeConfigFetch({ dev: { observations_mission: DEFAULT_OBSERVATIONS_MISSION } }),
    });
    expect(generic[0].status).toBe("warn");
  });

  it("reports a failed read as unknown, never as unset", async () => {
    const results = await checkBankObservationsMissions(
      minimalConfig({ ziggy: {} }),
      "http://x/mcp/",
      { fetchImpl: fakeConfigFetch({ ziggy: { failWith: 503 } }) },
    );
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("could not read");
    expect(results[0].detail).not.toContain("unset");
    // No remediation: reconciling does not fix an unreachable backend, and the
    // push path refuses to treat a failed read as upgradable either.
    expect(results[0].fix).toBeUndefined();
  });

  it("dedupes agents sharing one bank and labels them", async () => {
    const results = await checkBankObservationsMissions(
      minimalConfig({
        clerk: { memory: { collection: "assistant" } },
        helper: { memory: { collection: "assistant" } },
      }),
      "http://x/mcp/",
      { fetchImpl: fakeConfigFetch({ assistant: { observations_mission: null } }) },
    );
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("bank assistant observations_mission (clerk, helper)");
  });
});
