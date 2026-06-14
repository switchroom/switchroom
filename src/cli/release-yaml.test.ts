import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { setReleasePinInConfig } from "./release-yaml.js";

const DATE = "2026-06-14";

describe("setReleasePinInConfig", () => {
  it("updates an existing pin, refreshes the dated comment, preserves OTHER comments", () => {
    const before = [
      "# top of file comment",
      "release:",
      "  pin: v0.15.17 # 2026-06-13: old theme",
      "",
      "telegram:",
      "  bot_token: vault:x # keep me",
    ].join("\n");
    const after = setReleasePinInConfig(before, "v0.15.18", DATE);
    // pin value updated
    expect(parse(after).release.pin).toBe("v0.15.18");
    // unrelated comments preserved verbatim
    expect(after).toContain("# top of file comment");
    expect(after).toContain("vault:x # keep me");
    // the pin line's stale comment is replaced by a fresh dated note
    expect(after).toContain("v0.15.18");
    expect(after).toContain(DATE);
    expect(after).not.toContain("old theme");
  });

  it("creates the release block when absent, preserving everything else", () => {
    const before = ["# header", "telegram:", "  bot_token: vault:x"].join("\n");
    const after = setReleasePinInConfig(before, "v0.15.18", DATE);
    expect(parse(after).release.pin).toBe("v0.15.18");
    expect(parse(after).telegram.bot_token).toBe("vault:x");
    expect(after).toContain("# header");
  });

  it("deletes a channel when setting a pin (schema mutual-exclusion)", () => {
    const before = ["release:", "  channel: latest"].join("\n");
    const after = setReleasePinInConfig(before, "v0.15.18", DATE);
    const parsed = parse(after);
    expect(parsed.release.pin).toBe("v0.15.18");
    expect(parsed.release.channel).toBeUndefined();
  });

  it("is idempotent (byte-identical) when already on the pin with no channel", () => {
    const text = ["release:", "  pin: v0.15.18 # 2026-06-14: rolled by switchroom rollout", ""].join("\n");
    expect(setReleasePinInConfig(text, "v0.15.18", DATE)).toBe(text);
  });

  it("does rewrite (not skip) when the pin matches but a channel still needs clearing", () => {
    const before = ["release:", "  pin: v0.15.18", "  channel: latest"].join("\n");
    const after = setReleasePinInConfig(before, "v0.15.18", DATE);
    expect(parse(after).release.channel).toBeUndefined();
    expect(parse(after).release.pin).toBe("v0.15.18");
  });
});
