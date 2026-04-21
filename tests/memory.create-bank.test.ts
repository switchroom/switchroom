import { describe, it, expect, vi } from "vitest";
import { createBank } from "../src/memory/hindsight.js";

describe("createBank", () => {
  it("calls create_bank with bank_id only by default", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await createBank(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any, timeoutMs: 5000 }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // initialize call
    const initCall = mockFetch.mock.calls[0];
    expect(initCall[0]).toBe("http://test.local/mcp/");
    const initHeaders = initCall[1].headers;
    expect(initHeaders["X-Bank-Id"]).toBe("test-bank");
    const initBody = JSON.parse(initCall[1].body);
    expect(initBody.method).toBe("initialize");

    // create_bank tools/call
    const toolCall = mockFetch.mock.calls[1];
    const toolHeaders = toolCall[1].headers;
    expect(toolHeaders["X-Bank-Id"]).toBe("test-bank");
    expect(toolHeaders["mcp-session-id"]).toBe("test-session");
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.method).toBe("tools/call");
    expect(toolBody.params.name).toBe("create_bank");
    expect(toolBody.params.arguments).toEqual({ bank_id: "test-bank" });
  });

  it("passes optional name and mission when provided", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    await createBank(
      "http://test.local/mcp/",
      "foo-agent",
      {
        fetchImpl: mockFetch as any,
        name: "Foo Agent Bank",
        mission: "Help Foo",
      }
    );

    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.params.arguments).toEqual({
      bank_id: "foo-agent",
      name: "Foo Agent Bank",
      mission: "Help Foo",
    });
  });

  it("is idempotent — existing bank returns success", async () => {
    // Hindsight's create_bank is documented as "Create a new memory bank or
    // get an existing one", so a 200 OK on an existing bank is the happy
    // path. We assert we surface { ok: true } and do not retry.
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await createBank(
      "http://test.local/mcp/",
      "existing-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns Unreachable reason when Hindsight daemon is down", async () => {
    // Node's fetch throws a TypeError with cause ECONNREFUSED; we test both
    // the literal "ECONNREFUSED" signal and the generic "fetch failed"
    // message that Node surfaces on connect failure.
    const mockFetch = vi.fn().mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    );

    const result = await createBank(
      "http://127.0.0.1:18888/mcp/",
      "foo",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "Unreachable" });
  });

  it("returns Unreachable when fetch throws with ECONNREFUSED in message", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:18888")
    );

    const result = await createBank(
      "http://127.0.0.1:18888/mcp/",
      "foo",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "Unreachable" });
  });

  it("returns error when Hindsight returns 5xx on init", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as any);

    const result = await createBank(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "HTTP 500" });
  });

  it("returns error when tools/call returns 5xx", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any);

    const result = await createBank(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "Tool call HTTP 500" });
  });

  it("returns Timeout on AbortError", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: any, init: any) => {
      return new Promise((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const timer = setTimeout(
          () => resolve({ ok: true, headers: new Map() } as any),
          10000
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result = await createBank(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any, timeoutMs: 50 }
    );

    expect(result).toEqual({ ok: false, reason: "Timeout" });
  });

  it("returns error when no session ID returned", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Map(), // no mcp-session-id
    } as any);

    const result = await createBank(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "No session ID returned" });
  });
});
