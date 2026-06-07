import { describe, it, expect, vi } from "vitest";
import { ensureUserProfileMentalModel } from "../src/memory/hindsight.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

describe("user-profile-refresh-hook.sh — refresh actually fires (source guards)", () => {
  const hook = readFileSync(
    resolve(__dirname, "..", "bin", "user-profile-refresh-hook.sh"),
    "utf-8",
  );

  it("does NOT gate the refresh on a session id (the stateless server returns none)", () => {
    // The old `if [ -n "$SESSION" ]` gate meant the refresh never fired on the
    // stateless server. The gate must be gone.
    expect(hook).not.toMatch(/if \[ -n "\$SESSION" \]/);
    expect(hook).not.toMatch(/mcp-session-id: \$SESSION/);
  });

  it("refreshes by mental_model_id (resolved via list), not by name", () => {
    // refresh_mental_model requires mental_model_id, not name.
    expect(hook).toMatch(/list_mental_models/);
    expect(hook).toMatch(/select\(\.name=="user-profile"\) \| \.id/);
    expect(hook).toMatch(/mental_model_id\\?":\\?"\$MM_ID/);
    // The old name-based refresh call must be gone.
    expect(hook).not.toMatch(/refresh_mental_model[^}]*name\\?":\\?"user-profile/);
  });
});

describe("ensureUserProfileMentalModel", () => {
  it("creates mental model when list returns empty", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
        json: async () => ({}),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { content: [{ text: "" }] } }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify create_mental_model was called with the CORRECT arg name. The
    // server's argument is `source_query`, not `query` (an upstream rename) —
    // passing `query` returns isError "Missing required argument: source_query"
    // and creates nothing.
    const createCall = mockFetch.mock.calls[2];
    const createBody = JSON.parse(createCall[1].body);
    expect(createBody.params.name).toBe("create_mental_model");
    expect(createBody.params.arguments.name).toBe("user-profile");
    expect(createBody.params.arguments.source_query).toContain("key facts, preferences");
    expect(createBody.params.arguments.query).toBeUndefined();
    // `types` is NOT sent — it is not in create_mental_model's schema, so the
    // server would silently drop it (caught by memory.hindsight-contract.fixture).
    expect(createBody.params.arguments.types).toBeUndefined();
  });

  it("HONEST FAILURE: returns ok:false when create returns isError (not a silent ok:true)", async () => {
    // The old code only checked HTTP status and reported ok:true even when the
    // server rejected the create (isError) — so "User-profile Mental Model
    // ready" printed while the bank stayed empty. The isError envelope must
    // surface as ok:false.
    const errorBody =
      'data: {"jsonrpc":"2.0","id":3,"result":{"isError":true,"content":[{"type":"text","text":"Missing required argument: source_query"}]}}\n';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map(), text: async () => "" } as any) // initialize
      .mockResolvedValueOnce({ ok: true, text: async () => 'data: {"result":{"content":[{"text":"{\\"items\\":[]}"}]}}\n' } as any) // list (empty)
      .mockResolvedValueOnce({ ok: true, text: async () => errorBody } as any); // create → isError

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/source_query/);
  });

  it("returns success when MM already exists (idempotent) — matched by exact name", async () => {
    // The list payload is a JSON string of {items:[{name,...}]}. An item NAMED
    // user-profile means it exists → skip create.
    const listBody = JSON.stringify({
      result: { content: [{ text: JSON.stringify({ items: [{ name: "user-profile" }, { name: "Active Projects" }] }) }] },
    });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map(), text: async () => "" } as any) // init
      .mockResolvedValueOnce({ ok: true, text: async () => `data: ${listBody}\n` } as any); // list (has user-profile)

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2); // init + list, NO create
  });

  it("FALSE-POSITIVE GUARD: creates when no item is NAMED user-profile, even if another model mentions the substring", async () => {
    // The old substring check skipped creation whenever ANY model's name/query/
    // content contained "user-profile" — leaving banks (e.g. lawgpt's
    // Lisa-focused models) without a real user-profile model. Match by name.
    const listBody = JSON.stringify({
      result: { content: [{ text: JSON.stringify({ items: [
        { name: "Lisa Profile", source_query: "what to know about the user-profile of Lisa" },
        { name: "User Profile" },
      ] }) }] },
    });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map(), text: async () => "" } as any) // init
      .mockResolvedValueOnce({ ok: true, text: async () => `data: ${listBody}\n` } as any) // list (substring present, no exact name)
      .mockResolvedValueOnce({ ok: true, text: async () => 'data: {"result":{"isError":false}}\n' } as any); // create

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "lawgpt",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(3); // init + list + CREATE (not skipped)
  });

  it("returns error when Hindsight unreachable", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as any);

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HTTP 500");
  });

  it("returns error on timeout", async () => {
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

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any, timeoutMs: 100 }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Timeout");
  });

  it("returns error when MM creation fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
        json: async () => ({}),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { content: [{ text: "" }] } }),
      } as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any);

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Create MM HTTP 500");
  });
});

describe("user-profile-refresh-hook.sh", () => {
  it("exists and is executable", () => {
    const hookPath = join(process.cwd(), "bin", "user-profile-refresh-hook.sh");
    expect(existsSync(hookPath)).toBe(true);
    // Check executable bit (mode & 0o111)
    const fs = require("fs");
    const stat = fs.statSync(hookPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });
});
