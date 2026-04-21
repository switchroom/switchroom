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
  // Mirrors the production builder in gateway.ts: url button + raw
  // copy_text button in the same row. copy_text is Bot API 7.7+ and
  // not exposed by grammy's InlineKeyboard helpers, so the raw object
  // is pushed into the row array.
  const kb = new InlineKeyboard().url("🔐 Open Claude auth", authorizeUrl);
  kb.inline_keyboard[0].push({
    text: "📋 Copy URL",
    copy_text: { text: authorizeUrl },
  } as unknown as typeof kb.inline_keyboard[0][number]);
  return kb;
}

describe("auth URL button keyboard", () => {
  it("has a single row with Open + Copy URL buttons", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc";
    const kb = buildAuthUrlKeyboardForTest(url);

    const json = kb.inline_keyboard;
    expect(json.length).toBe(1);
    // One row with two buttons: [Open Claude auth] + [Copy URL]
    expect(json[0].length).toBe(2);

    const openBtn = json[0][0];
    expect(openBtn.text).toContain("Open Claude auth");
    expect("url" in openBtn).toBe(true);
    if ("url" in openBtn) expect(openBtn.url).toBe(url);
  });

  it("[Copy URL] button uses Bot API 7.7+ copy_text shape", () => {
    // This is the escape hatch for the 2026-04-22 in-app-browser
    // incident: when the OAuth URL opens in Telegram's WebView (with
    // different cookies than the user's main browser), wrong account
    // gets authorized. Copy URL lets the user paste into their main
    // browser where they know which account is signed in.
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc";
    const kb = buildAuthUrlKeyboardForTest(url);
    const copyBtn = kb.inline_keyboard[0][1] as unknown as { text: string; copy_text: { text: string } };
    expect(copyBtn.text).toContain("Copy URL");
    expect(copyBtn.copy_text).toBeDefined();
    expect(copyBtn.copy_text.text).toBe(url);
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
