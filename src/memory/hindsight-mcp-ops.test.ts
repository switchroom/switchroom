/**
 * Coverage for the Hindsight MCP *write* ops in `hindsight.ts` — the paths
 * most able to silently corrupt or lose memory state. The failure mode this
 * suite exists to kill is the one called out across this module's own comments:
 * a `tools/call` returns HTTP 200 with `result.isError:true` on a renamed /
 * dropped / phantom arg, so an HTTP-status-only check reports success while the
 * server persisted NOTHING (silent no-op = silent data loss).
 *
 * Every test drives the REAL code path with an injected `fetchImpl` that speaks
 * the exact SSE (`event: message\ndata: {…}`) envelope Hindsight returns, and
 * asserts BOTH the wire contract (which tool, which args switchroom actually
 * sends) and the success/failure classification.
 */

import { describe, expect, it } from "vitest";
import {
  createBank,
  updateBankMissions,
  ensureMentalModel,
  ensureDeclaredMentalModels,
  addMemoryTag,
} from "./hindsight.js";

const API_URL = "http://127.0.0.1:18888/mcp/";

interface CapturedCall {
  method: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  bankId: string | null;
  raw: unknown;
}

/** A response body in the SSE frame Hindsight actually emits. */
function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Build a tools/call HTTP-200 envelope, optionally an isError one. */
function toolResult(opts: { isError?: boolean; text?: string } = {}): unknown {
  return {
    jsonrpc: "2.0",
    id: 2,
    result: {
      isError: opts.isError ?? false,
      content: [{ type: "text", text: opts.text ?? "ok" }],
    },
  };
}

/**
 * A scripted fetch. `router` maps a JSON-RPC method (and, for tools/call, the
 * tool name) to a Response. All requests are captured for wire-contract
 * assertions. `initialize` auto-responds 200 with no session id (the stateless
 * Hindsight default) unless the router overrides it.
 */
function scriptedFetch(
  router: (call: CapturedCall) => Response | undefined,
  calls: CapturedCall[],
  opts: { sessionId?: string } = {},
): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const headers = init.headers as Record<string, string>;
    const call: CapturedCall = {
      method: body.method,
      toolName: body.params?.name,
      arguments: body.params?.arguments,
      bankId: headers?.["X-Bank-Id"] ?? null,
      raw: body,
    };
    calls.push(call);

    const override = router(call);
    if (override) return override;

    if (body.method === "initialize") {
      const h = new Headers();
      if (opts.sessionId) h.set("mcp-session-id", opts.sessionId);
      return new Response(
        sse({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "hindsight", version: "test" } } }),
        { status: 200, headers: h },
      );
    }
    // Default: a clean tool success.
    return new Response(sse(toolResult()), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("createBank — MCP envelope classification", () => {
  it("sends create_bank with bank_id and returns ok on a clean envelope", async () => {
    const calls: CapturedCall[] = [];
    const r = await createBank(API_URL, "coach", { fetchImpl: scriptedFetch(() => undefined, calls) });
    expect(r.ok).toBe(true);
    const toolCall = calls.find((c) => c.method === "tools/call");
    expect(toolCall?.toolName).toBe("create_bank");
    expect(toolCall?.arguments).toMatchObject({ bank_id: "coach" });
    expect(toolCall?.bankId).toBe("coach");
  });

  it("threads optional name + mission into the create_bank args when set", async () => {
    const calls: CapturedCall[] = [];
    await createBank(API_URL, "coach", {
      fetchImpl: scriptedFetch(() => undefined, calls),
      name: "Coach Bank",
      mission: "help the user train",
    });
    const toolCall = calls.find((c) => c.method === "tools/call");
    expect(toolCall?.arguments).toMatchObject({ bank_id: "coach", name: "Coach Bank", mission: "help the user train" });
  });

  it("does NOT report success when create_bank returns isError:true (silent no-op guard)", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch((c) => {
      if (c.toolName === "create_bank") {
        return new Response(sse(toolResult({ isError: true, text: "Missing required argument: bank_id" })), { status: 200 });
      }
      return undefined;
    }, calls);
    const r = await createBank(API_URL, "coach", { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("bank_id");
  });

  it("fails on a non-200 tool response", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch((c) => {
      if (c.method === "tools/call") return new Response("nope", { status: 503 });
      return undefined;
    }, calls);
    const r = await createBank(API_URL, "coach", { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Tool call HTTP 503");
  });

  it("forwards mcp-session-id onto the tool call when the server issues one", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch(() => undefined, calls, { sessionId: "sess-123" });
    // Wrap to capture the session header on the SECOND (tool) request.
    let toolSessionHeader: string | null = null;
    const wrapped = (async (url: string, init: RequestInit) => {
      const resp = await (fetchImpl as unknown as typeof fetch)(url, init);
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method === "tools/call") {
        toolSessionHeader = (init.headers as Record<string, string>)["mcp-session-id"] ?? null;
      }
      return resp;
    }) as unknown as typeof fetch;
    await createBank(API_URL, "coach", { fetchImpl: wrapped });
    expect(toolSessionHeader).toBe("sess-123");
  });
});

describe("updateBankMissions — mission routing (silent-drop guards)", () => {
  it("routes retain_mission through config_updates, NOT a dropped top-level arg", async () => {
    const calls: CapturedCall[] = [];
    const r = await updateBankMissions(
      API_URL,
      "coach",
      { retain_mission: "extract durable facts" },
      { fetchImpl: scriptedFetch(() => undefined, calls) },
    );
    expect(r.ok).toBe(true);
    const args = calls.find((c) => c.method === "tools/call")?.arguments as Record<string, unknown>;
    // The server SILENTLY DROPS a top-level retain_mission — it must ride in config_updates.
    expect(args).not.toHaveProperty("retain_mission");
    expect(args.config_updates).toMatchObject({ retain_mission: "extract durable facts" });
  });

  it("sends a bare bank_mission via the legacy top-level `mission` field", async () => {
    const calls: CapturedCall[] = [];
    await updateBankMissions(API_URL, "coach", { bank_mission: "be the coach" }, { fetchImpl: scriptedFetch(() => undefined, calls) });
    const args = calls.find((c) => c.method === "tools/call")?.arguments as Record<string, unknown>;
    expect(args.mission).toBe("be the coach");
  });

  it("when reflect_mission is set, routes it via config_updates and DROPS top-level mission (no race)", async () => {
    const calls: CapturedCall[] = [];
    await updateBankMissions(
      API_URL,
      "coach",
      { bank_mission: "legacy", reflect_mission: "the real reflect persona" },
      { fetchImpl: scriptedFetch(() => undefined, calls) },
    );
    const args = calls.find((c) => c.method === "tools/call")?.arguments as Record<string, unknown>;
    expect(args).not.toHaveProperty("mission");
    expect(args.config_updates).toMatchObject({ reflect_mission: "the real reflect persona" });
  });

  it("flattens the nested disposition into disposition_* integer config fields", async () => {
    const calls: CapturedCall[] = [];
    await updateBankMissions(
      API_URL,
      "coach",
      { disposition: { skepticism: 4, literalism: 5, empathy: 2 } },
      { fetchImpl: scriptedFetch(() => undefined, calls) },
    );
    const args = calls.find((c) => c.method === "tools/call")?.arguments as Record<string, unknown>;
    expect(args.config_updates).toMatchObject({
      disposition_skepticism: 4,
      disposition_literalism: 5,
      disposition_empathy: 2,
    });
  });

  it("does NOT report success when update_bank returns isError:true", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch((c) => {
      if (c.toolName === "update_bank") return new Response(sse(toolResult({ isError: true, text: "Unknown argument" })), { status: 200 });
      return undefined;
    }, calls);
    const r = await updateBankMissions(API_URL, "coach", { retain_mission: "x" }, { fetchImpl });
    expect(r.ok).toBe(false);
  });
});

describe("ensureMentalModel — idempotent create keyed on EXACT name", () => {
  /** Router that lists the given model names and treats create as success. */
  function routerWithExisting(names: string[]): (c: CapturedCall) => Response | undefined {
    return (c) => {
      if (c.toolName === "list_mental_models") {
        const items = names.map((n) => ({ name: n }));
        return new Response(
          sse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ items }) }] } }),
          { status: 200 },
        );
      }
      return undefined;
    };
  }

  it("skips create when a model with the EXACT name already exists", async () => {
    const calls: CapturedCall[] = [];
    const r = await ensureMentalModel(
      API_URL,
      "coach",
      { name: "training-plan", sourceQuery: "what's the plan?" },
      { fetchImpl: scriptedFetch(routerWithExisting(["training-plan", "other"]), calls) },
    );
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.toolName === "create_mental_model")).toBe(false);
  });

  it("does NOT false-positive on a SUBSTRING match (the #2447-class bug)", async () => {
    const calls: CapturedCall[] = [];
    // "training-plan" is a substring of "training-plan-archive" but not an exact name.
    await ensureMentalModel(
      API_URL,
      "coach",
      { name: "training-plan", sourceQuery: "q" },
      { fetchImpl: scriptedFetch(routerWithExisting(["training-plan-archive"]), calls) },
    );
    const create = calls.find((c) => c.toolName === "create_mental_model");
    expect(create).toBeDefined();
    expect(create?.arguments).toMatchObject({ name: "training-plan", source_query: "q" });
  });

  it("uses source_query (NOT query) as the create arg", async () => {
    const calls: CapturedCall[] = [];
    await ensureMentalModel(
      API_URL,
      "coach",
      { name: "m", sourceQuery: "the standing question" },
      { fetchImpl: scriptedFetch(routerWithExisting([]), calls) },
    );
    const create = calls.find((c) => c.toolName === "create_mental_model");
    expect(create?.arguments).toHaveProperty("source_query", "the standing question");
    expect(create?.arguments).not.toHaveProperty("query");
  });

  it("only serialises optional knobs when set", async () => {
    const calls: CapturedCall[] = [];
    await ensureMentalModel(
      API_URL,
      "coach",
      { name: "m", sourceQuery: "q", refreshAfterConsolidation: true, maxTokens: 500 },
      { fetchImpl: scriptedFetch(routerWithExisting([]), calls) },
    );
    const create = calls.find((c) => c.toolName === "create_mental_model");
    expect(create?.arguments).toMatchObject({
      trigger_refresh_after_consolidation: true,
      max_tokens: 500,
    });
  });

  it("reports failure when create returns isError:true (renamed-arg no-op guard)", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch((c) => {
      if (c.toolName === "list_mental_models") {
        return new Response(sse({ jsonrpc: "2.0", id: 2, result: { content: [{ text: JSON.stringify({ items: [] }) }] } }), { status: 200 });
      }
      if (c.toolName === "create_mental_model") {
        return new Response(sse(toolResult({ isError: true, text: "Missing required argument: source_query" })), { status: 200 });
      }
      return undefined;
    }, calls);
    const r = await ensureMentalModel(API_URL, "coach", { name: "m", sourceQuery: "q" }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("source_query");
  });
});

describe("ensureDeclaredMentalModels — batch dedupe + per-model outcomes", () => {
  function okFetch(calls: CapturedCall[]): typeof fetch {
    return scriptedFetch((c) => {
      if (c.toolName === "list_mental_models") {
        return new Response(sse({ jsonrpc: "2.0", id: 2, result: { content: [{ text: JSON.stringify({ items: [] }) }] } }), { status: 200 });
      }
      return undefined;
    }, calls);
  }

  it("returns [] and makes no calls when nothing is declared", async () => {
    const calls: CapturedCall[] = [];
    const out = await ensureDeclaredMentalModels(API_URL, "coach", undefined, { fetchImpl: okFetch(calls) });
    expect(out).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("de-dupes by name so one bad config can't double-create", async () => {
    const calls: CapturedCall[] = [];
    const out = await ensureDeclaredMentalModels(
      API_URL,
      "coach",
      [
        { name: "dup", source_query: "a" },
        { name: "dup", source_query: "b" },
      ],
      { fetchImpl: okFetch(calls) },
    );
    expect(out).toEqual([{ name: "dup", ok: true }]);
    const creates = calls.filter((c) => c.toolName === "create_mental_model");
    expect(creates.length).toBe(1);
  });

  it("records a per-model failure without aborting the batch", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch((c) => {
      if (c.toolName === "list_mental_models") {
        return new Response(sse({ jsonrpc: "2.0", id: 2, result: { content: [{ text: JSON.stringify({ items: [] }) }] } }), { status: 200 });
      }
      if (c.toolName === "create_mental_model" && (c.arguments?.name === "bad")) {
        return new Response(sse(toolResult({ isError: true, text: "boom" })), { status: 200 });
      }
      return undefined;
    }, calls);
    const out = await ensureDeclaredMentalModels(
      API_URL,
      "coach",
      [
        { name: "good", source_query: "a" },
        { name: "bad", source_query: "b" },
      ],
      { fetchImpl },
    );
    expect(out).toEqual([
      { name: "good", ok: true },
      { name: "bad", ok: false, reason: "boom" },
    ]);
  });
});

describe("addMemoryTag — honest failure on the phantom update_memory tool", () => {
  it("returns ok:false when the server reports Unknown tool (no silent success)", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = scriptedFetch((c) => {
      if (c.toolName === "update_memory") {
        return new Response(sse(toolResult({ isError: true, text: "Unknown tool: 'update_memory'" })), { status: 200 });
      }
      return undefined;
    }, calls);
    const r = await addMemoryTag(API_URL, "coach", "mem-1", "[demote-from-recall]", { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("update_memory");
    const call = calls.find((c) => c.toolName === "update_memory");
    expect(call?.arguments).toMatchObject({ bank_id: "coach", memory_id: "mem-1", add_tags: ["[demote-from-recall]"] });
  });
});
