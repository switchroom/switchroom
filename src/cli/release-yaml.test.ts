import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { setReleasePinInConfig, deleteReleasePinInConfig } from "./release-yaml.js";
import { RootReleaseBlock } from "../config/schema.js";

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

describe("deleteReleasePinInConfig", () => {
  const commentLines = (s: string) => s.split("\n").filter((l) => l.trim().startsWith("#"));

  it("is a byte-identical no-op when there is no pin to delete", () => {
    const text = ["# header", "telegram:", "  bot_token: x", ""].join("\n");
    expect(deleteReleasePinInConfig(text)).toBe(text);
  });

  it("drops a husk the roll SYNTHESIZED, restoring the file byte-for-byte", () => {
    // The `release:` block did not exist before the roll, so nothing is
    // commented onto it and removing it entirely is the correct revert.
    const before = ["# header", "telegram:", "  bot_token: x # keep me", ""].join("\n");
    const pinned = setReleasePinInConfig(before, "v0.15.18", DATE);
    expect(parse(pinned).release.pin).toBe("v0.15.18");
    expect(deleteReleasePinInConfig(pinned)).toBe(before);
  });

  it("KEEPS the husk rather than destroying the block's comment header", () => {
    // THE bug: `yaml` attaches a key's preceding comment block to the key node
    // as `commentBefore`, so `doc.delete("release")` silently took the whole
    // documented header with it. On the production config that is 15 lines.
    const before = [
      "telegram:",
      "  bot_token: x",
      "",
      "# Release channel / pin.",
      "# `channel` and `pin` are mutually exclusive.",
      "# Set by `switchroom rollout --pin`; reverted if the roll fails.",
      "release:",
      "  pin: v0.15.18 # 2026-06-14: rolled by switchroom rollout",
      "",
      "agents:",
      "  clerk: {}",
      "",
    ].join("\n");

    const after = deleteReleasePinInConfig(before);

    // The pin is gone…
    expect(parse(after).release?.pin).toBeUndefined();
    // …the documentation is NOT (every `#` line survives, in order)…
    expect(commentLines(after)).toEqual([
      "# Release channel / pin.",
      "# `channel` and `pin` are mutually exclusive.",
      "# Set by `switchroom rollout --pin`; reverted if the roll fails.",
    ]);
    // …and every other key is untouched.
    expect(parse(after).telegram.bot_token).toBe("x");
    expect(parse(after).agents.clerk).toEqual({});
  });

  it("the kept husk is schema-VALID (an empty release block passes)", () => {
    // The husk removal was justified by "`release: {}` is invalid per the
    // schema refine". It is not: every field is optional and the refine only
    // rejects channel+pin together. Asserted against the real schema so the
    // justification can't silently rot back in.
    const before = ["# docs", "release:", "  pin: v0.15.18", ""].join("\n");
    const after = deleteReleasePinInConfig(before);
    expect(after).toMatch(/release:/);
    expect(RootReleaseBlock.safeParse(parse(after).release).success).toBe(true);
  });

  it("leaves a non-empty release block alone apart from the pin", () => {
    const before = ["release:", "  pin: v0.15.18", "  auto_update: true", ""].join("\n");
    const after = deleteReleasePinInConfig(before);
    expect(parse(after).release).toEqual({ auto_update: true });
  });
});
