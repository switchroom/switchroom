/**
 * Unit tests for `addMemoryTag` — the TS wrapper that calls Hindsight's
 * `update_memory` MCP tool to append a tag to an existing memory.
 *
 * Mirrors the pattern in `tests/memory.bank-missions.test.ts` (which
 * tests the sibling `updateBankMissions`).
 *
 * Closes the operator loop opened by #432 4.3 (recall_log surfaces
 * memory IDs) + #432 4.4 (demote tag honoured by recall.py) + #475
 * (overlap gate). The CLI dispatcher (`switchroom memory demote`)
 * is covered by `tests/cli.memory.demote.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  addMemoryTag,
  verifyTagWriteResponse,
  DEMOTE_FROM_RECALL_TAG,
} from "../src/memory/hindsight.js";

/**
 * An SSE-framed MCP tools/call response whose `content[0].text` is `body`
 * serialized the way hindsight serializes it — `json.dumps(...)` of the
 * updated memory unit, or of `{"error": ...}`. Both arrive with isError:false.
 */
const mcpBody = (body: unknown): string =>
  "event: message\n" +
  "data: " +
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(body) }],
    },
  }) +
  "\n";

/** The memory unit hindsight returns from update_memory (get_memory_unit's
 *  dict; `tags` is always present, defaulting to []). */
const memoryUnit = (tags: string[]) => ({
  id: "mem-abc123",
  text: "a fact",
  context: "",
  type: "world",
  entities: [],
  tags,
  state: "valid",
});

describe("DEMOTE_FROM_RECALL_TAG", () => {
  it("matches the canonical Python-side filter literal", () => {
    // Source of truth: vendor/hindsight-memory/scripts/recall.py
    // `DEMOTE_TAG_VARIANTS` set (#432 phase 4.4). The bracketed form
    // is the canonical one we write; the Python filter also accepts
    // the bracket-less variant and "no-recall" for robustness.
    expect(DEMOTE_FROM_RECALL_TAG).toBe("[demote-from-recall]");
  });
});

describe("addMemoryTag — happy path", () => {
  it("HONEST FAILURE: returns ok:false when the server rejects update_memory with isError (not a silent ok:true)", async () => {
    // The live server has no `update_memory` tool → HTTP 200 + an MCP error
    // envelope. The prior code only checked HTTP status and reported ok:true,
    // so `memory demote` lied. Now the isError body must surface as ok:false.
    const errorBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"Unknown tool: \'update_memory\'"}]}}\n';
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => errorBody,
      } as any);

    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc123",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any, timeoutMs: 5000 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Unknown tool.*update_memory/);
  });

  it("calls update_memory with add_tags after MCP initialize", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => mcpBody(memoryUnit([DEMOTE_FROM_RECALL_TAG])),
      } as any);

    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc123",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any, timeoutMs: 5000 },
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Initialize step: POST /mcp/, body includes method=initialize.
    const initCall = mockFetch.mock.calls[0];
    expect(initCall[0]).toBe("http://test.local/mcp/");
    const initBody = JSON.parse(initCall[1].body);
    expect(initBody.method).toBe("initialize");
    expect(initBody.params.protocolVersion).toBe("2024-11-05");
    expect(initCall[1].headers["X-Bank-Id"]).toBe("clerk");

    // Tool call step: tools/call → update_memory with add_tags.
    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.method).toBe("tools/call");
    expect(toolBody.params.name).toBe("update_memory");
    expect(toolBody.params.arguments).toEqual({
      bank_id: "clerk",
      memory_id: "mem-abc123",
      add_tags: ["[demote-from-recall]"],
    });
    // Session id from the init response must be threaded into the tool call.
    expect(toolCall[1].headers["mcp-session-id"]).toBe("test-session");
  });

  it("supports a custom tag (operator may use lesson:foo or anti-pattern:bar)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => mcpBody(memoryUnit(["anti-pattern:misleading-reply"])),
      } as any);

    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      "anti-pattern:misleading-reply",
      { fetchImpl: mockFetch as any },
    );

    expect(result).toEqual({ ok: true });
    const toolBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(toolBody.params.arguments.add_tags).toEqual([
      "anti-pattern:misleading-reply",
    ]);
  });
});

describe("addMemoryTag — error paths", () => {
  it("returns error when initialize HTTP fails", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as any);
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );
    expect(result).toEqual({ ok: false, reason: "HTTP 503" });
    // Tool-call step must not fire.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("tolerates a stateless server (no mcp-session-id) and proceeds without the header", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(), // stateless: no mcp-session-id
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => mcpBody(memoryUnit([DEMOTE_FROM_RECALL_TAG])),
      } as any);
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );
    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const toolHeaders = mockFetch.mock.calls[1][1].headers;
    expect("mcp-session-id" in toolHeaders).toBe(false);
  });

  it("returns error when tools/call HTTP fails", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s"]]),
      } as any)
      .mockResolvedValueOnce({ ok: false, status: 400 } as any);
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "bad-mem-id",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );
    expect(result).toEqual({ ok: false, reason: "Tool call HTTP 400" });
  });

  it("returns Timeout reason on AbortError", async () => {
    const mockFetch = vi.fn().mockImplementationOnce(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any, timeoutMs: 1 },
    );
    expect(result).toEqual({ ok: false, reason: "Timeout" });
  });

  it("wraps generic errors in the reason field", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });
});

describe("addMemoryTag — defaults", () => {
  it("uses 5000ms default timeout when not specified", async () => {
    // We can't easily observe the timeout value through mockFetch, but
    // we can confirm the call shape works without an explicit timeoutMs.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => mcpBody(memoryUnit([DEMOTE_FROM_RECALL_TAG])),
      } as any);
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );
    expect(result).toEqual({ ok: true });
  });
});

/**
 * THE SILENT-DROP CLASS — the reason this wrapper cannot trust `isError`.
 *
 * `update_memory` is a real, unconditionally-registered MCP tool, so an unknown
 * ARGUMENT (`add_tags`) is not rejected: hindsight drops it and answers
 * isError:false with a body byte-identical to the same call without it
 * (probed live against 0.8.4). Application errors are equally invisible — a
 * missing memory answers isError:false with `{"error": "Memory '…' not found"}`.
 *
 * So the only honest signal is the tag being present in the memory unit the
 * call returns. Every test here fails if that read-back is removed and the
 * wrapper goes back to returning ok on HTTP-200/!isError.
 */
describe("addMemoryTag — the failure isError cannot see", () => {
  it("returns ok:false when the server accepts the call but the tag is NOT on the returned memory", async () => {
    // This is the real 0.8.4/0.8.5 behaviour: add_tags dropped, tags unchanged.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map() } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => mcpBody(memoryUnit([])),
      } as any);

    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc123",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/WITHOUT/);
      expect(result.reason).toMatch(/silently dropped/i);
    }
  });

  it("returns ok:false on an application error delivered with isError:false", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map() } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => mcpBody({ error: "Memory 'mem-nope' not found" }),
      } as any);

    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-nope",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Memory 'mem-nope' not found");
  });

  it("returns ok:false when the body is unreadable — 'could not verify' is a FAILURE, not a pass", async () => {
    // The pre-#3762 wrapper swallowed a parse failure and returned ok:true.
    // That is how `memory demote` printed "✓ Tag applied." while tagging nothing.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map() } as any)
      .mockResolvedValueOnce({ ok: true, text: async () => "not json at all" } as any);

    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );

    expect(result.ok).toBe(false);
  });
});

describe("verifyTagWriteResponse — pure verdicts", () => {
  const unit = (tags: string[]) =>
    ({
      isError: false,
      content: [{ text: JSON.stringify({ id: "m1", tags }) }],
    }) as const;

  it("ok only when the tag is actually present in the returned unit", () => {
    expect(verifyTagWriteResponse(unit(["[demote-from-recall]"]), "[demote-from-recall]")).toEqual({
      ok: true,
    });
  });

  it("fails when the returned unit carries other tags but not this one", () => {
    const v = verifyTagWriteResponse(unit(["lesson:foo"]), "[demote-from-recall]");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("lesson:foo");
  });

  it("fails when the response has no `tags` field at all", () => {
    const v = verifyTagWriteResponse(
      { isError: false, content: [{ text: JSON.stringify({ id: "m1" }) }] },
      "[demote-from-recall]",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no `tags` field/);
  });

  it("still surfaces a genuine isError (unknown TOOL) — the one thing the envelope does catch", () => {
    const v = verifyTagWriteResponse(
      { isError: true, content: [{ text: "Unknown tool: 'delete_memory'" }] },
      "[demote-from-recall]",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("Unknown tool");
  });

  it("fails on a missing result envelope rather than assuming success", () => {
    expect(verifyTagWriteResponse(undefined, "[demote-from-recall]").ok).toBe(false);
  });
});
