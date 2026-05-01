/**
 * Tests for the BotFather walkthrough (epic #543, workstream 2 — closes #188).
 *
 * All Telegram I/O is mocked via the injectable `validate` hook, and all
 * console output / stdin is captured via injected `log` / `readLine`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  runBotFatherWalkthrough,
  suggestUsername,
  printWalkthrough,
} from "./botfather-walkthrough.js";

describe("suggestUsername", () => {
  it("appends _bot to the slug", () => {
    expect(suggestUsername("ziggy")).toBe("ziggy_bot");
  });

  it("lowercases and sanitises the slug", () => {
    expect(suggestUsername("Health-Coach")).toBe("health_coach_bot");
  });
});

describe("printWalkthrough", () => {
  it("references the suggested username and BotFather URL", () => {
    const lines: string[] = [];
    printWalkthrough("ziggy", (l) => lines.push(l));
    const all = lines.join("\n");
    expect(all).toMatch(/@BotFather/);
    expect(all).toMatch(/t\.me\/BotFather/);
    expect(all).toMatch(/ziggy_bot/);
    expect(all).toMatch(/\/newbot/);
  });
});

describe("runBotFatherWalkthrough", () => {
  it("fast path: validates an existingToken without printing the walkthrough", async () => {
    const validate = vi.fn().mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Ken",
      username: "ken_bot",
    });
    const log = vi.fn();
    const result = await runBotFatherWalkthrough({
      agentSlug: "ken",
      existingToken: "1:abcdefghijklmnopqrstuvwxyz",
      log,
      validate,
    });
    expect(result.token).toBe("1:abcdefghijklmnopqrstuvwxyz");
    expect(result.bot.username).toBe("ken_bot");
    expect(result.walkthroughShown).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledOnce();
  });

  it("fast path: throws when the bot username doesn't contain the agent slug", async () => {
    const validate = vi.fn().mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Different",
      username: "totally_unrelated_bot",
    });
    await expect(
      runBotFatherWalkthrough({
        agentSlug: "ziggy",
        existingToken: "1:fake",
        validate,
        log: () => {},
      }),
    ).rejects.toThrow(/expected username to contain "ziggy"/);
  });

  it("fast path: --loose downgrades username mismatch to a warn", async () => {
    const validate = vi.fn().mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Different",
      username: "totally_unrelated_bot",
    });
    const warn = vi.fn();
    const result = await runBotFatherWalkthrough({
      agentSlug: "ziggy",
      existingToken: "1:fake",
      loose: true,
      validate,
      log: () => {},
      warn,
    });
    expect(result.token).toBe("1:fake");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/--loose was set/);
  });

  it("interactive path: prints walkthrough then accepts the pasted token", async () => {
    const validate = vi.fn().mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Ziggy",
      username: "ziggy_bot",
    });
    const log = vi.fn();
    const readLine = vi.fn().mockResolvedValue("123456:AAH-pasted-from-botfather-XX");

    const result = await runBotFatherWalkthrough({
      agentSlug: "ziggy",
      readLine,
      validate,
      log,
    });

    expect(result.walkthroughShown).toBe(true);
    expect(result.token).toBe("123456:AAH-pasted-from-botfather-XX");
    expect(readLine).toHaveBeenCalledOnce();
    // Walkthrough copy was emitted.
    const all = log.mock.calls.flat().join("\n");
    expect(all).toMatch(/@BotFather/);
    expect(all).toMatch(/ok — bot @ziggy_bot \(Ziggy\) accepted/);
  });

  it("interactive path: re-prompts on validation failure, succeeds on retry", async () => {
    const validate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invalid bot token: Unauthorized"))
      .mockResolvedValueOnce({
        id: 2,
        is_bot: true,
        first_name: "Ziggy",
        username: "ziggy_bot",
      });
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("first:badtoken")
      .mockResolvedValueOnce("123456:AAH-real-token-XX");
    const log = vi.fn();

    const result = await runBotFatherWalkthrough({
      agentSlug: "ziggy",
      readLine,
      validate,
      log,
    });

    expect(result.token).toBe("123456:AAH-real-token-XX");
    expect(readLine).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).toMatch(/Telegram rejected the token/);
  });

  it("interactive path: re-prompts on username mismatch, succeeds on retry", async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce({
        id: 3,
        is_bot: true,
        first_name: "Wrong",
        username: "some_other_bot",
      })
      .mockResolvedValueOnce({
        id: 4,
        is_bot: true,
        first_name: "Ziggy",
        username: "ziggy_bot",
      });
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("1:wrong")
      .mockResolvedValueOnce("2:right");

    const result = await runBotFatherWalkthrough({
      agentSlug: "ziggy",
      readLine,
      validate,
      log: () => {},
    });

    expect(result.token).toBe("2:right");
    expect(readLine).toHaveBeenCalledTimes(2);
  });

  it("interactive path: gives up after maxAttempts and throws actionable error", async () => {
    const validate = vi.fn().mockRejectedValue(new Error("Invalid bot token: Unauthorized"));
    const readLine = vi.fn().mockResolvedValue("nope:nope");
    await expect(
      runBotFatherWalkthrough({
        agentSlug: "ziggy",
        readLine,
        validate,
        log: () => {},
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/failed after 2 attempts/);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("interactive path: empty paste re-prompts without burning a network call", async () => {
    const validate = vi.fn().mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Ziggy",
      username: "ziggy_bot",
    });
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("1:real");

    const result = await runBotFatherWalkthrough({
      agentSlug: "ziggy",
      readLine,
      validate,
      log: () => {},
    });

    expect(result.token).toBe("1:real");
    // Only the second (non-empty) attempt should call validate.
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith("1:real");
  });

  it("throws when no token and no readLine are supplied (non-interactive)", async () => {
    await expect(
      runBotFatherWalkthrough({
        agentSlug: "ziggy",
        log: () => {},
      }),
    ).rejects.toThrow(/no interactive reader|--bot-token/);
  });
});
