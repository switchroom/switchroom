import { describe, it, expect, vi } from "vitest";
import {
  ensureMentalModel,
  ensureDeclaredMentalModels,
  USER_PROFILE_SOURCE_QUERY,
} from "../src/memory/hindsight.js";

/**
 * Phase 5 — operator-declared per-specialist mental models.
 *
 * The invariant these tests pin: NOTHING is created unless the operator
 * declared it (no blind seeding — that is the #2447 regression), and the
 * generalized ensure sends the schema-correct create payload.
 */

function initResponse() {
  return {
    ok: true,
    headers: new Map([["mcp-session-id", "s"]]),
    text: async () => "",
  } as any;
}
function listResponse(names: string[]) {
  const items = names.map((n) => ({ name: n }));
  const inner = JSON.stringify({ items });
  return {
    ok: true,
    text: async () =>
      `data: {"result":{"content":[{"text":${JSON.stringify(inner)}}]}}\n`,
  } as any;
}
function createOk() {
  return { ok: true, text: async () => 'data: {"result":{"isError":false}}\n' } as any;
}

describe("ensureMentalModel — generalized create", () => {
  it("creates a named model with the given source_query and no extra args when knobs unset", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse([])) // empty → create
      .mockResolvedValueOnce(createOk());

    const result = await ensureMentalModel(
      "http://test.local/mcp/",
      "coach-bank",
      { name: "training-plan-state", sourceQuery: "What is the athlete's current plan?" },
      { fetchImpl: mockFetch as any },
    );

    expect(result).toEqual({ ok: true });
    const createBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(createBody.params.name).toBe("create_mental_model");
    expect(createBody.params.arguments.name).toBe("training-plan-state");
    expect(createBody.params.arguments.source_query).toBe(
      "What is the athlete's current plan?",
    );
    // No optional knobs → payload stays minimal and schema-clean.
    expect(createBody.params.arguments.trigger_refresh_after_consolidation).toBeUndefined();
    expect(createBody.params.arguments.max_tokens).toBeUndefined();
    // `query` (the wrong upstream name) and schema-unknown `types` must be absent.
    expect(createBody.params.arguments.query).toBeUndefined();
    expect(createBody.params.arguments.types).toBeUndefined();
  });

  it("forwards refresh_after_consolidation + max_tokens only when set", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(createOk());

    await ensureMentalModel(
      "http://test.local/mcp/",
      "law-bank",
      {
        name: "open-matters",
        sourceQuery: "Which matters are open?",
        refreshAfterConsolidation: true,
        maxTokens: 2048,
      },
      { fetchImpl: mockFetch as any },
    );

    const createBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(createBody.params.arguments.trigger_refresh_after_consolidation).toBe(true);
    expect(createBody.params.arguments.max_tokens).toBe(2048);
  });

  it("is idempotent — no create when a model with the same exact name exists", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse(["open-matters"])); // present → skip create

    const result = await ensureMentalModel(
      "http://test.local/mcp/",
      "law-bank",
      { name: "open-matters", sourceQuery: "Which matters are open?" },
      { fetchImpl: mockFetch as any },
    );

    expect(result).toEqual({ ok: true });
    // Only init + list — create was NOT called.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("matches existence by EXACT name — a substring sibling does not false-positive", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse(["open-matters-archive"])) // substring-ish sibling
      .mockResolvedValueOnce(createOk());

    const result = await ensureMentalModel(
      "http://test.local/mcp/",
      "law-bank",
      { name: "open-matters", sourceQuery: "Which matters are open?" },
      { fetchImpl: mockFetch as any },
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(3); // create DID fire
  });

  it("USER_PROFILE_SOURCE_QUERY is exported and unchanged (dormant dashboard path)", () => {
    expect(USER_PROFILE_SOURCE_QUERY).toContain("key facts, preferences");
  });
});

describe("ensureDeclaredMentalModels — no blind seeding (the #2447 guard)", () => {
  it("does NOTHING when no models are declared (undefined)", async () => {
    const mockFetch = vi.fn();
    const outcomes = await ensureDeclaredMentalModels(
      "http://test.local/mcp/",
      "bank",
      undefined,
      { fetchImpl: mockFetch as any },
    );
    expect(outcomes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOTHING when the declared list is empty", async () => {
    const mockFetch = vi.fn();
    const outcomes = await ensureDeclaredMentalModels(
      "http://test.local/mcp/",
      "bank",
      [],
      { fetchImpl: mockFetch as any },
    );
    expect(outcomes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ensures each declared model and reports per-model outcomes", async () => {
    // Two models, both absent → each does init+list+create (6 calls total).
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(createOk());

    const outcomes = await ensureDeclaredMentalModels(
      "http://test.local/mcp/",
      "coach-bank",
      [
        { name: "training-plan-state", source_query: "plan?" },
        { name: "injury-history", source_query: "injuries?", max_tokens: 1024 },
      ],
      { fetchImpl: mockFetch as any },
    );

    expect(outcomes).toEqual([
      { name: "training-plan-state", ok: true },
      { name: "injury-history", ok: true },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it("surfaces a per-model failure honestly (ok:false with reason) without throwing", async () => {
    const errorBody =
      'data: {"result":{"isError":true,"content":[{"text":"boom"}]}}\n';
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce({ ok: true, text: async () => errorBody } as any);

    const outcomes = await ensureDeclaredMentalModels(
      "http://test.local/mcp/",
      "bank",
      [{ name: "flaky", source_query: "q?" }],
      { fetchImpl: mockFetch as any },
    );

    expect(outcomes).toEqual([{ name: "flaky", ok: false, reason: "boom" }]);
  });
});
