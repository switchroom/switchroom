import { describe, expect, it } from "vitest";

import {
  planScopeCleanup,
  planBankCleanup,
  formatCleanupPlan,
  type ObservationScope,
} from "./observation-scope-cleanup.js";

const scope = (tags: string[], count: number): ObservationScope => ({ tags, count });

// Shapes taken from the live klanker bank on 2026-07-31 (read-only).
const UUID_A = "516929ee-1666-4d5b-9db1-85b5d7a03b30";
const UUID_B = "6ec44942-e9cb-4be5-9bbd-cc653ecc93e7";
const UUID_C = "b11cbaca-fc44-4409-825c-10783f9e1e0f";
const SUB_A = "34c4bbeb-f805-4dd3-b085-46ac2eb57ae9-sub-a5df90f21bb098e8f";
const SUB_B = "68b17a48-f224-4223-964f-925301de960f-sub-a34b4856e57e91924";

describe("all-volatile scopes collapse into the shared scope", () => {
  it("folds N single-UUID per-session scopes into one shared target", () => {
    // The pre-#4035 per-session island: each session got its own bare-UUID
    // scope, so its observations never merged with any other session's.
    const plan = planScopeCleanup("klanker", [
      scope([UUID_A], 50),
      scope([UUID_B], 30),
      scope([UUID_C], 20),
    ]);

    expect(plan.affectedScopes).toBe(3);
    expect(plan.affectedObservations).toBe(100);
    // Three scopes → one `shared` scope.
    expect(plan.resultingScopeCount).toBe(1);
    expect(plan.scopeReduction).toBe(2);
    expect(plan.merges).toEqual([{ target: "shared", sourceScopes: 3, observations: 100 }]);
    expect(plan.breakdown.allVolatileScopes).toBe(3);
    expect(plan.breakdown.allVolatileObservations).toBe(100);
  });

  it("treats a parent_session-tagged scope as volatile too", () => {
    const plan = planScopeCleanup("k", [scope([`parent_session:${UUID_A}`], 7)]);
    expect(plan.reclassified[0]?.to).toBe("shared");
    expect(plan.reclassified[0]?.strippedVolatile).toEqual([`parent_session:${UUID_A}`]);
  });
});

describe("mixed scopes keep their stable tags and merge on them", () => {
  it("strips the volatile provenance and collapses onto the stable-tag scope", () => {
    // Two different sessions, same stable meaning: under curated both land on
    // `[agent_type:worker, sidechain]` and finally merge.
    const plan = planScopeCleanup("klanker", [
      scope([SUB_A, `parent_session:${UUID_A}`, "agent_type:worker", "sidechain"], 12),
      scope([SUB_B, `parent_session:${UUID_B}`, "agent_type:worker", "sidechain"], 9),
    ]);

    expect(plan.affectedScopes).toBe(2);
    expect(plan.resultingScopeCount).toBe(1);
    const target = plan.reclassified[0]?.to;
    expect(target).toBe("agent_type:worker,sidechain");
    expect(plan.merges).toEqual([
      { target: "agent_type:worker,sidechain", sourceScopes: 2, observations: 21 },
    ]);
    expect(plan.breakdown.mixedScopes).toBe(2);
  });

  it("leaves an already-clean stable scope untouched", () => {
    const plan = planScopeCleanup("k", [scope(["lesson"], 100)]);
    expect(plan.affectedScopes).toBe(0);
    expect(plan.scopeReduction).toBe(0);
    expect(plan.merges).toEqual([]);
  });

  it("leaves the untagged shared scope untouched", () => {
    const plan = planScopeCleanup("k", [scope([], 188)]);
    expect(plan.affectedScopes).toBe(0);
  });
});

describe("stale agent-<hex> producer tags", () => {
  const stale = scope(["agent-a0114e4b60521433b"], 40);

  it("counts them but does NOT retire them by default (not part of the #4035 heal)", () => {
    const plan = planScopeCleanup("klanker", [stale]);
    expect(plan.breakdown.staleScopes).toBe(1);
    expect(plan.breakdown.staleObservations).toBe(40);
    // agent-<hex> is not volatile, so with retireStale off nothing changes.
    expect(plan.affectedScopes).toBe(0);
  });

  it("retires them into shared when explicitly asked", () => {
    const plan = planScopeCleanup("klanker", [stale], { retireStale: true });
    expect(plan.affectedScopes).toBe(1);
    expect(plan.reclassified[0]?.to).toBe("shared");
    expect(plan.reclassified[0]?.strippedStale).toEqual(["agent-a0114e4b60521433b"]);
  });

  it("keeps a stable tag when retiring the stale one from a scope that has both", () => {
    const plan = planScopeCleanup("klanker", [scope(["agent-a039d22e5cc4d8fc0", "lesson"], 5)], {
      retireStale: true,
    });
    expect(plan.reclassified[0]?.to).toBe("lesson");
  });
});

describe("blast radius summary", () => {
  it("reports the total scope reduction across a mixed bank", () => {
    const plan = planScopeCleanup("klanker", [
      scope([UUID_A], 10),
      scope([UUID_B], 10),
      scope([SUB_A, "lesson"], 5),
      scope([SUB_B, "lesson"], 5),
      scope(["lesson"], 100), // already clean — the merge TARGET for the two above
      scope([], 188), // shared, untouched
    ]);

    // The two bare-UUID scopes → shared (new). The two sub-lesson scopes →
    // `lesson` (existing). Resulting distinct scopes: shared, lesson = 2.
    expect(plan.resultingScopeCount).toBe(2);
    expect(plan.totalScopes).toBe(6);
    expect(plan.scopeReduction).toBe(4);
    expect(plan.affectedScopes).toBe(4);
    expect(plan.affectedObservations).toBe(30);
    // `lesson` gains the two sub-scopes → a merge of 3 sources (2 changed + the
    // clean one), all folding into `lesson`.
    const lessonMerge = plan.merges.find((m) => m.target === "lesson");
    expect(lessonMerge?.sourceScopes).toBe(3);
    expect(lessonMerge?.observations).toBe(110);
  });

  it("orders reclassified scopes worst (largest) first", () => {
    const plan = planScopeCleanup("k", [scope([UUID_A], 5), scope([UUID_B], 500)]);
    expect(plan.reclassified[0]?.count).toBe(500);
  });
});

describe("formatting", () => {
  it("renders the blast radius and top merges for an operator", () => {
    const plan = planScopeCleanup("klanker", [
      scope([UUID_A], 10),
      scope([UUID_B], 20),
    ]);
    const out = formatCleanupPlan(plan);
    expect(out).toContain("bank klanker");
    expect(out).toContain("2 → 1 scopes");
    expect(out).toContain("2 scopes → shared");
  });

  it("renders an unreadable bank plainly", () => {
    const out = formatCleanupPlan({
      bankId: "down",
      ok: false,
      reason: "Timeout",
      totalScopes: 0,
      totalObservations: 0,
      reclassified: [],
      merges: [],
      affectedScopes: 0,
      affectedObservations: 0,
      resultingScopeCount: 0,
      scopeReduction: 0,
      breakdown: {
        allVolatileScopes: 0,
        allVolatileObservations: 0,
        mixedScopes: 0,
        mixedObservations: 0,
        staleScopes: 0,
        staleObservations: 0,
      },
    });
    expect(out).toContain("down");
    expect(out).toContain("UNREADABLE");
  });
});

describe("planBankCleanup over REST (read-only)", () => {
  const stubFetch = (routes: Record<string, unknown>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      for (const [needle, body] of Object.entries(routes)) {
        if (url.includes(needle)) {
          return { ok: true, status: 200, json: async () => body } as unknown as Response;
        }
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

  it("fetches the scope table and plans from it", async () => {
    const plan = await planBankCleanup(
      "http://h:1/mcp",
      "klanker",
      {},
      {
        fetchImpl: stubFetch({
          "/observations/scopes": { scopes: [scope([UUID_A], 3), scope([UUID_B], 4)] },
        }),
      },
    );
    expect(plan.ok).toBe(true);
    expect(plan.affectedScopes).toBe(2);
    expect(plan.merges[0]?.target).toBe("shared");
  });

  it("surfaces an unreadable bank without throwing", async () => {
    const plan = await planBankCleanup(
      "http://h:1/mcp",
      "gone",
      {},
      { fetchImpl: stubFetch({}) },
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("404");
  });
});
