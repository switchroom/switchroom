import { describe, it, expect, vi } from "vitest";
import { updateBankMissions } from "../src/memory/hindsight.js";

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
    const mockFetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, headers: new Map() } as any), 10000);
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
