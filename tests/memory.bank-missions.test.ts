import { describe, it, expect, vi } from "vitest";
import {
  updateBankMissions,
  DEFAULT_RETAIN_MISSION,
  resolveBankMissionExtras,
  PROFILE_MEMORY_DEFAULTS,
} from "../src/memory/hindsight.js";
import { AgentMemorySchema } from "../src/config/schema.js";

/** Drive updateBankMissions with a two-call mock and return the update_bank args. */
async function captureUpdateBankArgs(
  missions: Parameters<typeof updateBankMissions>[2],
): Promise<Record<string, unknown>> {
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, headers: new Map() } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  const result = await updateBankMissions("http://test.local/mcp/", "test-bank", missions, {
    fetchImpl: mockFetch as any,
  });
  expect(result).toEqual({ ok: true });
  return JSON.parse(mockFetch.mock.calls[1][1].body).params.arguments;
}

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
    // The `?? DEFAULT_RETAIN_MISSION` seed-default fallback must appear
    // EXACTLY ONCE (scaffold only). More than one occurrence means the
    // seed-default behaviour was copied into reconcile, which would clobber
    // an operator's customized retain mission on every `switchroom apply`.
    const seedOccurrences = scaffoldSource.split("?? DEFAULT_RETAIN_MISSION").length - 1;
    expect(seedOccurrences).toBe(1);
    // Reconcile still gates its retain push on explicit operator config.
    expect(scaffoldSource).toContain("if (agentConfig.memory?.retain_mission) {");
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
    // retain_mission is NOT a top-level update_bank arg (the server silently
    // drops it) — it is a config field routed through config_updates.
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Test bank mission",
      config_updates: { retain_mission: "Test retain mission" },
    });
  });

  it("omits config_updates when only bank_mission is set (no retain_mission)", async () => {
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

  it("tolerates a stateless server (no mcp-session-id) and proceeds without the header", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(), // stateless: no mcp-session-id
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const toolHeaders = mockFetch.mock.calls[1][1].headers;
    expect("mcp-session-id" in toolHeaders).toBe(false);
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

  // --- Phase 2: reflect_mission / observations_mission / disposition ---

  it("routes reflect_mission + observations_mission through config_updates", async () => {
    const args = await captureUpdateBankArgs({
      reflect_mission: "You are a legal analyst.",
      observations_mission: "Synthesise obligations and risks.",
    });
    // reflect_mission is explicit → NO top-level `mission` (they target the
    // same engine field; explicit reflect_mission wins deterministically).
    expect(args).toEqual({
      bank_id: "test-bank",
      config_updates: {
        reflect_mission: "You are a legal analyst.",
        observations_mission: "Synthesise obligations and risks.",
      },
    });
    expect("mission" in args).toBe(false);
  });

  it("flattens disposition to disposition_* integer config fields", async () => {
    const args = await captureUpdateBankArgs({
      disposition: { skepticism: 4, literalism: 5, empathy: 2 },
    });
    expect(args.config_updates).toEqual({
      disposition_skepticism: 4,
      disposition_literalism: 5,
      disposition_empathy: 2,
    });
  });

  it("omits unset disposition traits from config_updates", async () => {
    const args = await captureUpdateBankArgs({ disposition: { empathy: 5 } });
    expect(args.config_updates).toEqual({ disposition_empathy: 5 });
  });

  it("keeps the legacy top-level mission route for a bare bank_mission", async () => {
    const args = await captureUpdateBankArgs({ bank_mission: "Persona X" });
    expect(args).toEqual({ bank_id: "test-bank", mission: "Persona X" });
  });

  it("reflect_mission wins over bank_mission (drops the top-level mission)", async () => {
    const args = await captureUpdateBankArgs({
      bank_mission: "legacy persona",
      reflect_mission: "explicit persona",
    });
    expect("mission" in args).toBe(false);
    expect(args.config_updates).toEqual({ reflect_mission: "explicit persona" });
  });

  it("omits config_updates entirely when only a bank_mission is set", async () => {
    const args = await captureUpdateBankArgs({ bank_mission: "just persona" });
    expect("config_updates" in args).toBe(false);
  });
});

describe("resolveBankMissionExtras", () => {
  it("returns built-in profile defaults when config is empty", () => {
    expect(resolveBankMissionExtras(undefined, "health-coach")).toEqual({
      disposition: { skepticism: 2, literalism: 2, empathy: 5 },
      observations_mission: PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission,
    });
  });

  it("returns nothing for a profile without defaults and no config", () => {
    expect(resolveBankMissionExtras(undefined, "default")).toEqual({});
    expect(resolveBankMissionExtras({}, "some-unknown-profile")).toEqual({});
  });

  it("merges disposition per-key: config trait overrides, others inherit profile", () => {
    const extras = resolveBankMissionExtras({ disposition: { empathy: 1 } }, "health-coach");
    expect(extras.disposition).toEqual({ skepticism: 2, literalism: 2, empathy: 1 });
  });

  it("config observations_mission overrides the profile default wholesale", () => {
    const extras = resolveBankMissionExtras(
      { observations_mission: "custom" },
      "health-coach",
    );
    expect(extras.observations_mission).toBe("custom");
  });

  it("passes reflect_mission straight through (no profile default for it)", () => {
    const extras = resolveBankMissionExtras({ reflect_mission: "hi" }, "coding");
    expect(extras.reflect_mission).toBe("hi");
    // coding still contributes its disposition default
    expect(extras.disposition).toEqual({ skepticism: 4, literalism: 5, empathy: 2 });
  });
});

describe("AgentMemorySchema — Phase 2 fields", () => {
  it("accepts reflect_mission, observations_mission, and in-range disposition", () => {
    const parsed = AgentMemorySchema.parse({
      collection: "b",
      reflect_mission: "r",
      observations_mission: "o",
      disposition: { skepticism: 1, literalism: 3, empathy: 5 },
    });
    expect(parsed.disposition).toEqual({ skepticism: 1, literalism: 3, empathy: 5 });
  });

  it("rejects disposition traits outside 1-5", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { empathy: 6 } }),
    ).toThrow();
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { skepticism: 0 } }),
    ).toThrow();
  });

  it("rejects non-integer disposition traits", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { literalism: 2.5 } }),
    ).toThrow();
  });
});
