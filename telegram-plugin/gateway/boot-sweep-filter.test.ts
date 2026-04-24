import { describe, expect, it } from "vitest";
import { shouldSweepChatAtBoot } from "./boot-sweep-filter";

describe("shouldSweepChatAtBoot", () => {
  // User DM IDs — positive integers. Bot has no chat record until the user
  // messages first. getChat() returns `400 chat not found`.
  it("returns false for a typical user ID (positive integer string)", () => {
    expect(shouldSweepChatAtBoot("123456789")).toBe(false);
    expect(shouldSweepChatAtBoot("1")).toBe(false);
    expect(shouldSweepChatAtBoot("999999999999")).toBe(false);
  });

  // Group/supergroup IDs — negative integers. Bot is a member and getChat works.
  it("returns true for a typical group ID (negative integer string)", () => {
    expect(shouldSweepChatAtBoot("-100123456789")).toBe(true);
    expect(shouldSweepChatAtBoot("-1")).toBe(true);
    expect(shouldSweepChatAtBoot("-987654321")).toBe(true);
  });

  // Edge cases — malformed / zero input should NOT be swept.
  it("returns false for zero", () => {
    expect(shouldSweepChatAtBoot("0")).toBe(false);
  });

  it("returns false for non-numeric strings", () => {
    expect(shouldSweepChatAtBoot("")).toBe(false);
    expect(shouldSweepChatAtBoot("abc")).toBe(false);
    expect(shouldSweepChatAtBoot("undefined")).toBe(false);
    expect(shouldSweepChatAtBoot("NaN")).toBe(false);
  });

  it("returns false for floating-point strings (non-integer chat IDs don't exist)", () => {
    expect(shouldSweepChatAtBoot("1.5")).toBe(false);
    expect(shouldSweepChatAtBoot("-1.5")).toBe(false);
  });

  it("returns false for Infinity / -Infinity strings", () => {
    expect(shouldSweepChatAtBoot("Infinity")).toBe(false);
    expect(shouldSweepChatAtBoot("-Infinity")).toBe(false);
  });

  // Table-driven summary to make PR review easy.
  it.each([
    // [chatId, expected, description]
    ["111111111", false, "user DM — positive"],
    ["-1001234567890", true, "supergroup — large negative"],
    ["0", false, "zero — invalid"],
    ["not-a-number", false, "non-numeric"],
    ["-100000000000", true, "valid negative group"],
    ["2", false, "small positive user id"],
  ])("shouldSweepChatAtBoot(%s) === %s (%s)", (chatId, expected) => {
    expect(shouldSweepChatAtBoot(chatId)).toBe(expected);
  });
});
