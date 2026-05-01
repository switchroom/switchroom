/**
 * Unit tests for bot-token validation helpers in telegram-api.ts.
 *
 * Covers:
 *   - assertBotUsernameMatchesAgent: pure slug-in-username check
 *   - validateBotTokenMatchesAgent: integration of getMe + slug check (fetch mocked)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertBotUsernameMatchesAgent,
  validateBotToken,
  validateBotTokenMatchesAgent,
} from "./telegram-api.js";

// ---------------------------------------------------------------------------
// assertBotUsernameMatchesAgent — pure unit tests, no network
// ---------------------------------------------------------------------------

describe("assertBotUsernameMatchesAgent", () => {
  it("passes when slug is a substring of username (suffix pattern)", () => {
    // e.g. @clerk_meken_bot → slug "clerk"
    expect(() =>
      assertBotUsernameMatchesAgent("clerk_meken_bot", "clerk"),
    ).not.toThrow();
  });

  it("passes when slug is a substring of username (prefix pattern)", () => {
    // e.g. @meken_gymbro_bot → slug "gymbro"
    expect(() =>
      assertBotUsernameMatchesAgent("meken_gymbro_bot", "gymbro"),
    ).not.toThrow();
  });

  it("passes when slug is the entire username (exact match)", () => {
    expect(() =>
      assertBotUsernameMatchesAgent("finn_bot", "finn"),
    ).not.toThrow();
  });

  it("is case-insensitive on both sides", () => {
    expect(() =>
      assertBotUsernameMatchesAgent("MEKEN_GYMBRO_BOT", "gymbro"),
    ).not.toThrow();
  });

  it("throws when slug is absent from username — the finn/clerk mix-up scenario", () => {
    // finn's .env got clerk's token → getMe returns @clerk_meken_bot
    expect(() =>
      assertBotUsernameMatchesAgent("clerk_meken_bot", "finn"),
    ).toThrow(/agent "finn" bot_token resolves to @clerk_meken_bot/);
  });

  it("throws error message that names the actual username and expected slug", () => {
    let caught: Error | null = null;
    try {
      assertBotUsernameMatchesAgent("other_bot", "myagent");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/@other_bot/);
    expect(caught!.message).toMatch(/"myagent"/);
    expect(caught!.message).toMatch(/vault/i);
  });

  it("throws for an empty username", () => {
    expect(() =>
      assertBotUsernameMatchesAgent("", "finn"),
    ).toThrow();
  });

  describe("with expectedUsername override", () => {
    it("accepts an exact match (case-insensitive) even when slug isn't in the username", () => {
      expect(() =>
        assertBotUsernameMatchesAgent("meken_law_bot", "lawgpt", "meken_law_bot"),
      ).not.toThrow();
      expect(() =>
        assertBotUsernameMatchesAgent("MEKEN_LAW_BOT", "lawgpt", "meken_law_bot"),
      ).not.toThrow();
    });

    it("rejects a username that doesn't equal the declared expected one", () => {
      let caught: Error | null = null;
      try {
        assertBotUsernameMatchesAgent("meken_other_bot", "lawgpt", "meken_law_bot");
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/@meken_other_bot/);
      expect(caught!.message).toMatch(/@meken_law_bot/);
      expect(caught!.message).toMatch(/bot_username/);
    });

    it("substring match alone is not enough when an exact override is set", () => {
      expect(() =>
        assertBotUsernameMatchesAgent("meken_law_bot_v2", "lawgpt", "meken_law_bot"),
      ).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// validateBotTokenMatchesAgent — mocks fetch, tests combined flow
// ---------------------------------------------------------------------------

describe("validateBotTokenMatchesAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGetMe(username: string) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        ok: true,
        result: {
          id: 123456,
          is_bot: true,
          first_name: "TestBot",
          username,
        },
      }),
    } as Response);
  }

  function mockGetMeNetworkError() {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
  }

  function mockGetMeInvalidToken() {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        ok: false,
        description: "Unauthorized",
      }),
    } as Response);
  }

  it("resolves with BotInfo when token is valid and username matches slug", async () => {
    mockGetMe("meken_finn_bot");
    const info = await validateBotTokenMatchesAgent("valid-token", "finn");
    expect(info.username).toBe("meken_finn_bot");
  });

  it("throws on username mismatch — the finn/clerk mix-up", async () => {
    mockGetMe("clerk_meken_bot");
    await expect(
      validateBotTokenMatchesAgent("clerk-token", "finn"),
    ).rejects.toThrow(/agent "finn" bot_token resolves to @clerk_meken_bot/);
  });

  it("throws on invalid token (Telegram returns ok:false)", async () => {
    mockGetMeInvalidToken();
    await expect(
      validateBotTokenMatchesAgent("bad-token", "finn"),
    ).rejects.toThrow(/Invalid bot token/);
  });

  it("throws on network error with a redacted message", async () => {
    mockGetMeNetworkError();
    await expect(
      validateBotTokenMatchesAgent("my-secret-token", "finn"),
    ).rejects.toThrow(/Network error/);
  });

  it("does not leak the token in a network-error message", async () => {
    mockGetMeNetworkError();
    let caught: Error | null = null;
    try {
      await validateBotTokenMatchesAgent("my-secret-token-value", "finn");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain("my-secret-token-value");
  });
});

// ---------------------------------------------------------------------------
// validateBotToken — sanity check that existing function still works
// ---------------------------------------------------------------------------

describe("validateBotToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns BotInfo on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        ok: true,
        result: { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" },
      }),
    } as Response);
    const info = await validateBotToken("token");
    expect(info.username).toBe("test_bot");
  });

  it("throws on ok:false response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({ ok: false, description: "Not Found" }),
    } as Response);
    await expect(validateBotToken("bad")).rejects.toThrow(/Invalid bot token/);
  });
});
