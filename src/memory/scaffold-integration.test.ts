/**
 * RFC G — `getGdriveMcpSettingsEntry()` launcher wiring.
 *
 * The entry used to be a bare `uvx` command with a dead
 * `GOOGLE_OAUTH_TOKEN_FROM_VAULT` env. It now points at the switchroom
 * CLI's hidden `drive-mcp-launcher` verb (the launcher seeds a
 * refresh-token credentials file and execs upstream `--single-user`).
 * These tests pin: the launcher command, no env block, and the tier
 * pass-through. The shared broker-ACL gate predicate
 * (`shouldEmitGdriveMcp`) moved to `config/google-workspace-acl.ts` —
 * its contract tests live alongside it.
 */

import { describe, expect, it } from "vitest";

import {
  getGdriveMcpSettingsEntry,
  type GdriveMcpTier,
} from "./scaffold-integration.js";

const CLI = "/usr/local/bin/switchroom";

describe("getGdriveMcpSettingsEntry — launcher command", () => {
  it("uses the switchroom CLI's drive-mcp-launcher verb as the command", () => {
    const entry = getGdriveMcpSettingsEntry(CLI);
    expect(entry.key).toBe("gdrive");
    expect(entry.value.command).toBe(CLI);
    expect(entry.value.args?.[0]).toBe("drive-mcp-launcher");
  });

  it("does NOT emit a uvx command or any GOOGLE_OAUTH_*_FROM_VAULT env", () => {
    const entry = getGdriveMcpSettingsEntry(CLI);
    expect(entry.value.command).not.toBe("uvx");
    // The dead env injection is gone entirely.
    expect(entry.value.env).toBeUndefined();
  });

  it("emits no --tier flag when called with no options (back-compat)", () => {
    const entry = getGdriveMcpSettingsEntry(CLI);
    expect(entry.value.args).not.toContain("--tier");
  });

  it("emits no --tier flag when tier is explicitly undefined", () => {
    const entry = getGdriveMcpSettingsEntry(CLI, { tier: undefined });
    expect(entry.value.args).not.toContain("--tier");
  });

  it.each<GdriveMcpTier>(["core", "extended", "complete"])(
    "passes --tier %s through to the launcher when tier is set",
    (tier) => {
      const entry = getGdriveMcpSettingsEntry(CLI, { tier });
      const args = entry.value.args ?? [];
      const flagIdx = args.indexOf("--tier");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(args[flagIdx + 1]).toBe(tier);
      // Flag comes after the verb positional, not before.
      expect(flagIdx).toBeGreaterThan(args.indexOf("drive-mcp-launcher"));
    },
  );
});
