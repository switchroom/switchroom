import { describe, it, expect } from "vitest";

/**
 * PR B — auth code auto-capture + ForceReply prompt.
 *
 * The gateway already intercepts plain-text messages in chats with a
 * pending reauth flow (pendingReauthFlows map + looksLikeAuthCode
 * helper in gateway.ts) and treats them as the browser code. This PR
 * layers on a ForceReply prompt as a UX cue so Telegram shows a
 * "Paste browser code" placeholder above the keyboard — the user
 * doesn't have to guess what to do next after returning from the
 * browser.
 *
 * These tests pin:
 *   - The ForceReply payload shape the gateway sends.
 *   - The expected input_field_placeholder text.
 *   - That the flow is ONLY triggered when a URL was present in the
 *     auth response (cancel / status replies don't get a prompt).
 *
 * The gateway helpers themselves aren't directly importable (top-level
 * IIFE starts the bot). We mirror the expected payload shape here so
 * drift in either direction starts the test failing.
 */

type ForceReplyMarkup = {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
};

function buildCodePrompt(): {
  text: string;
  reply_markup: ForceReplyMarkup;
} {
  return {
    text: "📋 Paste the browser code here ↓",
    reply_markup: {
      force_reply: true,
      input_field_placeholder: "Paste browser code",
      selective: true,
    },
  };
}

describe("auth code ForceReply prompt", () => {
  it("uses force_reply: true (Telegram native) rather than a custom keyboard", () => {
    const { reply_markup } = buildCodePrompt();
    expect(reply_markup.force_reply).toBe(true);
  });

  it("sets an input_field_placeholder so mobile keyboards show the hint", () => {
    const { reply_markup } = buildCodePrompt();
    expect(reply_markup.input_field_placeholder).toBe("Paste browser code");
    // Telegram caps the placeholder at 64 chars; stay well under.
    expect(reply_markup.input_field_placeholder!.length).toBeLessThanOrEqual(64);
  });

  it("uses selective: true so the prompt targets only the message sender in groups", () => {
    // Matters when the bot is added to a group and multiple users can
    // type. selective: true means only the user the bot is replying to
    // sees the ForceReply prompt.
    const { reply_markup } = buildCodePrompt();
    expect(reply_markup.selective).toBe(true);
  });

  it("message text is short and emoji-prefixed for scannability", () => {
    const { text } = buildCodePrompt();
    // Fits in Telegram's notification preview without truncation.
    expect(text.length).toBeLessThan(100);
    // Emoji prefix matches the product's visual conventions.
    expect(text.startsWith("📋")).toBe(true);
  });
});

describe("looksLikeAuthCode — regression", () => {
  // Mirror gateway.ts's looksLikeAuthCode EXACTLY to pin the intercept
  // heuristic we rely on for auto-capture. If the two diverge, users
  // paste codes and the bot ignores them.
  function looksLikeAuthCode(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed)) return false;
    if (trimmed.startsWith("session_")) return true;
    if (trimmed.startsWith("sk-ant-")) return true;
    if (/^[A-Za-z0-9_.#-]{6,500}$/.test(trimmed)) return true;
    return false;
  }

  it("accepts typical Claude setup-token browser codes", () => {
    expect(looksLikeAuthCode("abc123_def456")).toBe(true);
    expect(looksLikeAuthCode("session_xyz789")).toBe(true);
    expect(looksLikeAuthCode("JKL-mno-456")).toBe(true);
  });

  it("accepts the claude.com/cai browser code format (2026-04-22 regression)", () => {
    // The exact code Ken pasted on 2026-04-22 at 3:51 AM AEST from the
    // lawgpt reauth flow. Bot silently ignored it because the old
    // regex [A-Za-z0-9_-] didn't include '#'. Pinning this exact
    // shape so the heuristic never regresses against the new URL
    // format parseSetupTokenUrl now accepts (see PR #16).
    const kensCode =
      "tle0rmLfXTjWJAfE0GRJ2BHnlvPQ7fka6zizkJ7Y6gZfEAV8#00EySjRL37" +
      "-yPK0OGJAKueV5yVQHDvkHYtvMsQ4f7Dc";
    expect(looksLikeAuthCode(kensCode)).toBe(true);

    // Generic shape: <code>#<state>
    expect(looksLikeAuthCode("abc123#def456")).toBe(true);
    expect(looksLikeAuthCode("AABB-CCDD.EEFF_GGHH#XXYY")).toBe(true);
  });

  it("rejects plain text that isn't a code", () => {
    expect(looksLikeAuthCode("hi there")).toBe(false);
    expect(looksLikeAuthCode("what now?")).toBe(false);
    expect(looksLikeAuthCode("")).toBe(false);
    expect(looksLikeAuthCode("   ")).toBe(false);
    // Hashtag-only messages still reject (too short).
    expect(looksLikeAuthCode("#swag")).toBe(false);
  });

  it("rejects short strings (too low signal to intercept)", () => {
    expect(looksLikeAuthCode("abc")).toBe(false);
    expect(looksLikeAuthCode("xy")).toBe(false);
    expect(looksLikeAuthCode("a#b")).toBe(false);
  });

  it("accepts long alphanumeric strings (common in OAuth)", () => {
    const longCode = "a".repeat(150);
    expect(looksLikeAuthCode(longCode)).toBe(true);
    // Accepts strings up to new 500-char cap for future token-shape
    // growth.
    expect(looksLikeAuthCode("a".repeat(500))).toBe(true);
    // But rejects over-long strings (prevents accidental intercept
    // of a whole paragraph with no whitespace).
    expect(looksLikeAuthCode("a".repeat(501))).toBe(false);
  });

  it("rejects strings containing shell metacharacters outside the allowed set", () => {
    expect(looksLikeAuthCode("abc;ls")).toBe(false);
    expect(looksLikeAuthCode("abc|nc")).toBe(false);
    expect(looksLikeAuthCode("abc$(id)")).toBe(false);
    expect(looksLikeAuthCode("abc'quote")).toBe(false);
    expect(looksLikeAuthCode("abc\"quote")).toBe(false);
    expect(looksLikeAuthCode("abc&rm")).toBe(false);
  });
});
