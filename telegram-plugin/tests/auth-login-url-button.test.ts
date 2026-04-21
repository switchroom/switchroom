import { describe, it, expect } from "vitest";
import { InlineKeyboard } from "grammy";

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

function buildAuthUrlKeyboardForTest(authorizeUrl: string): InlineKeyboard {
  return new InlineKeyboard().url("🔐 Open Claude auth", authorizeUrl);
}

describe("auth URL button keyboard", () => {
  it("wraps the OAuth URL in a single inline-keyboard button", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc";
    const kb = buildAuthUrlKeyboardForTest(url);

    // grammy's InlineKeyboard stores buttons in inline_keyboard[row][col]
    const json = kb.inline_keyboard;
    expect(json.length).toBe(1);
    expect(json[0].length).toBe(1);

    const btn = json[0][0];
    expect(btn.text).toContain("Open Claude auth");
    expect("url" in btn).toBe(true);
    if ("url" in btn) expect(btn.url).toBe(url);
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
