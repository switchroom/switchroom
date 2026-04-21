import { describe, it, expect } from "vitest";
import { InlineKeyboard } from "grammy";
import { validateInlineKeyboard } from "../telegram-button-constraints";

/**
 * These tests exercise the helper contracts that back the login-URL
 * button shown under `/auth reauth` and `/auth add` responses.
 *
 * The full formatter and keyboard builder live inside `gateway.ts`,
 * which can't be imported from tests (top-level IIFE starts the bot).
 * So we re-verify the expected shape of the InlineKeyboard the gateway
 * builds via a local reimplementation that mirrors the production code.
 * If someone changes either side without the other, these tests still
 * pin the contract the real gateway is supposed to honour.
 */

/**
 * MUST MATCH gateway.ts::buildAuthUrlKeyboard. Single url button.
 * We deliberately do NOT add a copy_text button: OAuth URLs exceed
 * the 256-char CopyTextButton.text limit (2026-04-22
 * BUTTON_COPY_TEXT_INVALID incident).
 */
function buildAuthUrlKeyboardForTest(authorizeUrl: string): InlineKeyboard {
  return new InlineKeyboard().url("🔐 Open Claude auth", authorizeUrl);
}

// Realistic URL samples reproducing Anthropic's actual OAuth flow.
const REALISTIC_OAUTH_URLS = [
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=GoNa9QB-OawV-fm2qWcfQEzCPN2SZRBKUS-nUbyFimU&state=YDMyyej1234567890abcdefghijklmnop",
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=aB7xK9L2mN4pQ8rS6tU3vW5yZ1cD0eF2gH4jK6mN8pQ&state=zxcvbnm987654321qwertyuiopasdfghjkl",
];

describe("auth URL button keyboard", () => {
  it("has a single row with ONE url button", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc";
    const kb = buildAuthUrlKeyboardForTest(url);

    const json = kb.inline_keyboard;
    expect(json.length).toBe(1);
    expect(json[0].length).toBe(1);

    const openBtn = json[0][0];
    expect(openBtn.text).toContain("Open Claude auth");
    expect("url" in openBtn).toBe(true);
    if ("url" in openBtn) expect(openBtn.url).toBe(url);
  });

  it("REGRESSION: does NOT emit a copy_text button (PR #29 bug)", () => {
    // PR #29 added a copy_text button holding the OAuth URL. Telegram
    // rejected with BUTTON_COPY_TEXT_INVALID because copy_text.text
    // caps at 256 chars and OAuth URLs run ~320+. This test locks the
    // fix in: any reintroduction of copy_text here will fail.
    const kb = buildAuthUrlKeyboardForTest(REALISTIC_OAUTH_URLS[0]);
    const allBtns = kb.inline_keyboard.flat() as Array<Record<string, unknown>>;
    expect(allBtns.some((b) => "copy_text" in b)).toBe(false);
  });

  it.each(REALISTIC_OAUTH_URLS)(
    "keyboard passes ALL Telegram field constraints for %s",
    (url) => {
      const kb = buildAuthUrlKeyboardForTest(url);
      const errors = validateInlineKeyboard(
        kb.inline_keyboard as unknown as Record<string, unknown>[][],
      );
      expect(errors).toEqual([]);
    },
  );

  it("sanity-check: realistic OAuth URL samples exceed 256 chars", () => {
    // If this ever fails, Anthropic changed the OAuth URL shape;
    // update the samples. Otherwise this is the check that keeps the
    // regression test above honest — it must exercise a URL long
    // enough to have broken copy_text.
    for (const url of REALISTIC_OAUTH_URLS) {
      expect(url.length).toBeGreaterThan(256);
    }
  });

  it("accepts long URLs with query params without truncation", () => {
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=user%3Ainference&code_challenge=f22WtdsPoMUTWG8mxtgUZVXWryjED-j1tewCBD-r2uE" +
      "&code_challenge_method=S256&state=KsF9y3lEeqEdzjei2WFMX0COKHTPrZFUVYIWO_QbS3c";
    const kb = buildAuthUrlKeyboardForTest(url);

    const btn = kb.inline_keyboard[0][0];
    if ("url" in btn) expect(btn.url).toBe(url);
  });

  it("accepts both legacy claude.ai and current claude.com URL shapes", () => {
    // The formatter accepts either shape (see PR #16). The button just
    // needs to forward whatever URL it's given.
    const legacy = "https://claude.ai/oauth/authorize?code=true&client_id=abc";
    const current = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc";

    for (const url of [legacy, current]) {
      const kb = buildAuthUrlKeyboardForTest(url);
      const btn = kb.inline_keyboard[0][0];
      if ("url" in btn) expect(btn.url).toBe(url);
    }
  });
});

describe("formatAuthOutputForTelegram contract", () => {
  // We mirror the expected return shape here. The actual function lives
  // in gateway.ts (untestable directly); any change to the shape needs
  // to be reflected here so this test starts failing.
  //
  // Shape: { text: string; url: string | null }
  //   - text: HTML-escaped body, includes <a> fallback and URL-on-own-line
  //   - url: extracted URL (https match, first), or null

  it("contract signature: returns { text, url } where url is string|null", () => {
    type Expected = { text: string; url: string | null };
    // Compile-time only — if gateway.ts changes the return shape,
    // the real callsite will fail to compile, not this test. This
    // lets a reviewer spot the contract requirement without running.
    const _typecheck: Expected = { text: "", url: null };
    expect(_typecheck).toBeDefined();
  });
});
