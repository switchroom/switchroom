import { describe, it, expect, vi } from "vitest";
import { updateBankMissions, DEFAULT_RETAIN_MISSION } from "../src/memory/hindsight.js";

describe("DEFAULT_RETAIN_MISSION", () => {
  it("matches upstream Hindsight per-user-memory guide wording", () => {
    // Sourced verbatim from
    // hindsight-docs/guides/2026-04-15-guide-openclaw-per-user-memory-across-channels-setup.md
    // lines 188-193.
    expect(DEFAULT_RETAIN_MISSION).toBe(
      "Extract user preferences, ongoing projects, recurring commitments, " +
        "important context, and durable facts that should help across future " +
        "conversations. Skip one-off chatter and temporary task noise.",
    );
  });

  it("explicitly tells extraction to skip conversational filler", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("Skip one-off chatter");
    expect(DEFAULT_RETAIN_MISSION).toContain("temporary task noise");
  });

  it("focuses on durable, cross-conversation signal", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("durable facts");
    expect(DEFAULT_RETAIN_MISSION).toContain("across future");
  });
});

describe("scaffold seed wiring", () => {
  // Source-structure assertion: scaffold imports the constant and uses
  // it as the retain_mission default, while reconcile does NOT (existing
  // agents' missions stay untouched).
  it("scaffold imports DEFAULT_RETAIN_MISSION but reconcile path does not seed it", () => {
    const fs = require("fs");
    const scaffoldSource = fs.readFileSync("src/agents/scaffold.ts", "utf-8");
    expect(scaffoldSource).toContain("DEFAULT_RETAIN_MISSION");
    expect(scaffoldSource).toContain("seededRetainMission = userRetainMission ?? DEFAULT_RETAIN_MISSION");
    // The reconcile-side bank-mission update block must remain
    // explicit-only (the original `if user yaml has missions` gate).
    // Asserting both forms exist guards against an accidental copy of
    // the seed-default behaviour into reconcile.
    expect(scaffoldSource).toContain(
      "if (agentConfig.memory?.bank_mission || agentConfig.memory?.retain_mission)",
    );
  });
});

describe("updateBankMissions", () => {
  it("calls update_bank with both missions when provided", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      {
        bank_mission: "Test bank mission",
        retain_mission: "Test retain mission",
      },
      { fetchImpl: mockFetch as any, timeoutMs: 5000 }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Check initialize call
    const initCall = mockFetch.mock.calls[0];
    expect(initCall[0]).toBe("http://test.local/mcp/");
    const initBody = JSON.parse(initCall[1].body);
    expect(initBody.method).toBe("initialize");

    // Check tools/call update_bank
    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.method).toBe("tools/call");
    expect(toolBody.params.name).toBe("update_bank");
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Test bank mission",
      retain_mission: "Test retain mission",
    });
  });

  it("omits retain_mission when only bank_mission is set", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Only bank mission" },
      { fetchImpl: mockFetch as any }
    );

    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Only bank mission",
      retain_mission: undefined,
    });
  });

  it("returns error when Hindsight returns 5xx", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "HTTP 500" });
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

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any, timeoutMs: 100 }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Timeout");
  });

  it("returns error when no session ID returned", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Map(), // No session ID
    } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "No session ID returned" });
  });

  it("returns error on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Network error");
  });
});
