import { describe, it, expect, vi } from "vitest";
import { ensureUserProfileMentalModel } from "../src/memory/hindsight.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

    // Verify create_mental_model was called
    const createCall = mockFetch.mock.calls[2];
    const createBody = JSON.parse(createCall[1].body);
    expect(createBody.params.name).toBe("create_mental_model");
    expect(createBody.params.arguments.name).toBe("user-profile");
    expect(createBody.params.arguments.query).toContain("key facts, preferences");
    expect(createBody.params.arguments.types).toEqual(["world", "experience"]);
  });

  it("returns success when MM already exists (idempotent)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
        json: async () => ({}),
        text: async () => JSON.stringify({}),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { content: [{ text: "user-profile\nother-model" }] } }),
        text: async () => JSON.stringify({ result: { content: [{ text: "user-profile\nother-model" }] } }),
      } as any);

    const result = await ensureUserProfileMentalModel(
      "http://test.local/mcp/",
      "test-bank",
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2); // Only init + list, no create
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
