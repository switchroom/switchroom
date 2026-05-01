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
  DEMOTE_FROM_RECALL_TAG,
} from "../src/memory/hindsight.js";

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
  it("calls update_memory with add_tags after MCP initialize", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({ ok: true } as any);

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
      .mockResolvedValueOnce({ ok: true } as any);

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

  it("returns error when initialize returns no session ID", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Map(), // no mcp-session-id
    } as any);
    const result = await addMemoryTag(
      "http://test.local/mcp/",
      "clerk",
      "mem-abc",
      DEMOTE_FROM_RECALL_TAG,
      { fetchImpl: mockFetch as any },
    );
    expect(result).toEqual({ ok: false, reason: "No session ID returned" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({ ok: true } as any);
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
