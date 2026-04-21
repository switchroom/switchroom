import { describe, it, expect } from "vitest";
import {
  TELEGRAM_BUTTON_LIMITS,
  validateInlineButton,
  validateInlineKeyboard,
  dropInvalidButtons,
  type AnyButton,
} from "../telegram-button-constraints";

describe("TELEGRAM_BUTTON_LIMITS (sourced from Bot API docs)", () => {
  // Anchor values so a well-meaning refactor can't silently loosen them.
  // When Telegram changes the API, update these *and* the source.
  it("pins Bot API field limits", () => {
    expect(TELEGRAM_BUTTON_LIMITS.TEXT_MAX).toBe(64);
    expect(TELEGRAM_BUTTON_LIMITS.URL_MAX).toBe(2048);
    expect(TELEGRAM_BUTTON_LIMITS.CALLBACK_DATA_MAX).toBe(64);
    expect(TELEGRAM_BUTTON_LIMITS.COPY_TEXT_MAX).toBe(256);
    expect(TELEGRAM_BUTTON_LIMITS.LOGIN_URL_MAX).toBe(2048);
  });
});

describe("validateInlineButton", () => {
  it("accepts a valid url button", () => {
    const btn: AnyButton = { text: "Open", url: "https://example.com" };
    expect(validateInlineButton(btn, "test")).toEqual([]);
  });

  it("accepts a valid callback button", () => {
    const btn: AnyButton = { text: "Tap", callback_data: "action:1" };
    expect(validateInlineButton(btn, "test")).toEqual([]);
  });

  it("accepts a valid copy_text button at exactly 256 chars", () => {
    const btn: AnyButton = {
      text: "Copy",
      copy_text: { text: "a".repeat(256) },
    };
    expect(validateInlineButton(btn, "test")).toEqual([]);
  });

  it("rejects empty text", () => {
    const errs = validateInlineButton({ text: "" } as AnyButton, "test");
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("text");
  });

  it("rejects missing text", () => {
    const errs = validateInlineButton({} as AnyButton, "test");
    expect(errs[0].field).toBe("text");
  });

  it("rejects text > 64 chars", () => {
    const errs = validateInlineButton(
      { text: "x".repeat(65) } as AnyButton,
      "test",
    );
    expect(errs[0].field).toBe("text");
    expect(errs[0].actualLength).toBe(65);
    expect(errs[0].limit).toBe(64);
  });

  it("rejects copy_text > 256 chars (the bug that caused PR #30)", () => {
    // Real-world OAuth URL length reproducer. This button shape was
    // exactly what PR #29 shipped — it crashed Telegram's sendMessage
    // with BUTTON_COPY_TEXT_INVALID. This test is the regression
    // anchor: it asserts the validator catches it BEFORE runtime.
    const oauthUrl =
      "https://claude.com/cai/oauth/authorize?code=true" +
      "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
      "&response_type=code" +
      "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=user%3Ainference" +
      "&code_challenge=GoNa9QB-OawV-fm2qWcfQEzCPN2SZRBKUS-nUbyFimU" +
      "&state=abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
    expect(oauthUrl.length).toBeGreaterThan(256);

    const btn: AnyButton = {
      text: "📋 Copy URL",
      copy_text: { text: oauthUrl },
    };
    const errs = validateInlineButton(btn, "test");
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("copy_text.text");
    expect(errs[0].actualLength).toBe(oauthUrl.length);
    expect(errs[0].limit).toBe(256);
  });

  it("rejects copy_text with empty text", () => {
    const errs = validateInlineButton(
      { text: "X", copy_text: { text: "" } } as AnyButton,
      "test",
    );
    expect(errs[0].field).toBe("copy_text.text");
  });

  it("rejects callback_data > 64 bytes", () => {
    const errs = validateInlineButton(
      { text: "X", callback_data: "x".repeat(65) } as AnyButton,
      "test",
    );
    expect(errs[0].field).toBe("callback_data");
    expect(errs[0].actualLength).toBe(65);
  });

  it("measures callback_data in bytes, not characters (unicode)", () => {
    // 64 emoji characters would be 256 bytes — must fail.
    const cb = "🎉".repeat(32); // 32 chars, 128 bytes (4 bytes each)
    const errs = validateInlineButton(
      { text: "X", callback_data: cb } as AnyButton,
      "test",
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("callback_data");
    expect(errs[0].actualLength).toBe(128);
  });

  it("rejects url with non-http(s)/tg scheme", () => {
    const errs = validateInlineButton(
      { text: "X", url: "javascript:alert(1)" } as AnyButton,
      "test",
    );
    expect(errs.some((e) => e.field === "url")).toBe(true);
  });

  it("accepts tg:// url scheme", () => {
    const errs = validateInlineButton(
      { text: "X", url: "tg://user?id=123" } as AnyButton,
      "test",
    );
    expect(errs).toEqual([]);
  });

  it("collects multiple errors in one pass", () => {
    const errs = validateInlineButton(
      {
        text: "x".repeat(65), // exceeds text
        url: "https://" + "x".repeat(2100), // exceeds url
      } as AnyButton,
      "test",
    );
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateInlineKeyboard (full layout)", () => {
  it("returns empty array for valid keyboard", () => {
    const kb: AnyButton[][] = [
      [{ text: "A", url: "https://a.example" }],
      [{ text: "B", callback_data: "b" }],
    ];
    expect(validateInlineKeyboard(kb)).toEqual([]);
  });

  it("flags errors with row+col path for easy debugging", () => {
    const kb: AnyButton[][] = [
      [{ text: "ok", url: "https://a.example" }],
      [{ text: "", url: "https://b.example" }, { text: "x".repeat(70) }],
    ];
    const errs = validateInlineKeyboard(kb);
    expect(errs.length).toBe(2);
    expect(errs[0].path).toBe("row[1].col[0]");
    expect(errs[1].path).toBe("row[1].col[1]");
  });
});

describe("dropInvalidButtons (runtime safety net)", () => {
  it("keeps valid buttons, drops invalid ones", () => {
    const kb: AnyButton[][] = [
      [
        { text: "A", url: "https://a.example" },
        { text: "", url: "https://b.example" }, // invalid
      ],
    ];
    const dropped: string[] = [];
    const cleaned = dropInvalidButtons(kb, (err) => dropped.push(err.field));
    expect(cleaned).toEqual([[{ text: "A", url: "https://a.example" }]]);
    expect(dropped).toEqual(["text"]);
  });

  it("drops empty rows entirely", () => {
    const kb: AnyButton[][] = [
      [{ text: "" }, { text: "" }], // both invalid -> row becomes empty
      [{ text: "B", url: "https://b.example" }],
    ];
    const cleaned = dropInvalidButtons(kb);
    expect(cleaned).toEqual([[{ text: "B", url: "https://b.example" }]]);
  });

  it("returns empty array when every button is invalid", () => {
    const kb: AnyButton[][] = [[{ text: "" }]];
    const cleaned = dropInvalidButtons(kb);
    expect(cleaned).toEqual([]);
  });
});
