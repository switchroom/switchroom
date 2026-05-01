import { describe, expect, it } from "vitest";
import { redactToken } from "./redact-token.js";

describe("redactToken", () => {
  it("replaces every occurrence of the token with the placeholder", () => {
    const token = "1234567890:ABCDEFghijklmnopqrstuvwxyz_-12345";
    const msg = `Network error: failed to fetch https://api.telegram.org/bot${token}/createForumTopic`;
    const out = redactToken(msg, token);
    expect(out).not.toContain(token);
    expect(out).toContain("<redacted-bot-token>");
  });

  it("redacts multiple occurrences in the same message", () => {
    const token = "tok-abcdefgh-12345678";
    const msg = `${token} happened, then ${token} again`;
    expect(redactToken(msg, token)).toBe("<redacted-bot-token> happened, then <redacted-bot-token> again");
  });

  it("returns the message unchanged when token is empty", () => {
    expect(redactToken("hello", "")).toBe("hello");
  });

  it("returns the message unchanged when token is implausibly short", () => {
    // Avoid over-redacting innocuous strings like "1" or short fingerprints.
    expect(redactToken("the value 1234 is here", "1234")).toBe("the value 1234 is here");
  });

  it("handles tokens that contain regex metacharacters safely", () => {
    // Uses split/join so regex metacharacters are treated literally — no
    // need for the caller to escape the token.
    const token = "weird.token+with*meta?chars";
    const msg = `error fetching with ${token} happened`;
    expect(redactToken(msg, token)).toBe("error fetching with <redacted-bot-token> happened");
  });
});
