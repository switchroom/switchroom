/**
 * Tests for microsoft-workspace-acl — RFC #1873 PR 3.
 * Mirrors `google-workspace-acl.test.ts` shape.
 */

import { describe, expect, it } from "vitest";

import {
  isMicrosoftClientCredentialKeyForAgent,
  shouldEmitMs365Mcp,
  vaultRefKey,
} from "./microsoft-workspace-acl.js";
import type { SwitchroomConfig } from "./schema.js";

describe("shouldEmitMs365Mcp", () => {
  it("returns false when account is undefined", () => {
    expect(shouldEmitMs365Mcp("clerk", undefined, {})).toBe(false);
  });

  it("returns false when account is empty string", () => {
    expect(shouldEmitMs365Mcp("clerk", "", {})).toBe(false);
  });

  it("returns false when microsoft_accounts is undefined", () => {
    expect(shouldEmitMs365Mcp("clerk", "ken@outlook.com", undefined)).toBe(false);
  });

  it("returns false when account is not in microsoft_accounts", () => {
    expect(
      shouldEmitMs365Mcp("clerk", "ken@outlook.com", {
        "other@outlook.com": { enabled_for: ["clerk"] },
      }),
    ).toBe(false);
  });

  it("returns false when agent is not in enabled_for[]", () => {
    expect(
      shouldEmitMs365Mcp("clerk", "ken@outlook.com", {
        "ken@outlook.com": { enabled_for: ["lawgpt"] },
      }),
    ).toBe(false);
  });

  it("returns true when agent is in enabled_for[]", () => {
    expect(
      shouldEmitMs365Mcp("clerk", "ken@outlook.com", {
        "ken@outlook.com": { enabled_for: ["clerk", "finn"] },
      }),
    ).toBe(true);
  });

  it("normalizes account name (case-insensitive + trim)", () => {
    expect(
      shouldEmitMs365Mcp("clerk", "  KEN@Outlook.COM  ", {
        "ken@outlook.com": { enabled_for: ["clerk"] },
      }),
    ).toBe(true);
  });

  it("handles dormant accounts (empty enabled_for)", () => {
    expect(
      shouldEmitMs365Mcp("clerk", "ken@outlook.com", {
        "ken@outlook.com": { enabled_for: [] },
      }),
    ).toBe(false);
  });
});

describe("vaultRefKey", () => {
  it("extracts key from vault:<key> form", () => {
    expect(vaultRefKey("vault:microsoft-oauth-client-id")).toBe(
      "microsoft-oauth-client-id",
    );
  });

  it("strips #scope suffix", () => {
    expect(vaultRefKey("vault:foo#admin")).toBe("foo");
  });

  it("returns null for non-vault refs", () => {
    expect(vaultRefKey("literal-secret")).toBeNull();
    expect(vaultRefKey("")).toBeNull();
    expect(vaultRefKey(undefined)).toBeNull();
    expect(vaultRefKey(null)).toBeNull();
    expect(vaultRefKey(42)).toBeNull();
  });

  it("returns null for vault: with empty key", () => {
    expect(vaultRefKey("vault:")).toBeNull();
  });
});

describe("isMicrosoftClientCredentialKeyForAgent", () => {
  const baseConfig = (overrides: Partial<SwitchroomConfig> = {}): SwitchroomConfig =>
    ({
      agents: {
        clerk: {
          microsoft_workspace: { account: "ken@outlook.com" },
        },
      },
      microsoft_accounts: {
        "ken@outlook.com": { enabled_for: ["clerk"] },
      },
      microsoft_workspace: {
        microsoft_client_id: "vault:microsoft-oauth-client-id",
        microsoft_client_secret: "vault:microsoft-oauth-client-secret",
      },
      ...overrides,
    }) as SwitchroomConfig;

  it("returns true for the client id vault key on an enabled agent", () => {
    expect(
      isMicrosoftClientCredentialKeyForAgent(baseConfig(), "clerk", "microsoft-oauth-client-id"),
    ).toBe(true);
  });

  it("returns true for the client secret vault key", () => {
    expect(
      isMicrosoftClientCredentialKeyForAgent(baseConfig(), "clerk", "microsoft-oauth-client-secret"),
    ).toBe(true);
  });

  it("returns false for an unrelated vault key", () => {
    expect(
      isMicrosoftClientCredentialKeyForAgent(baseConfig(), "clerk", "some-other-key"),
    ).toBe(false);
  });

  it("returns false when agent is not in enabled_for", () => {
    const cfg = baseConfig({
      microsoft_accounts: {
        "ken@outlook.com": { enabled_for: ["other-agent"] },
      },
    });
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "microsoft-oauth-client-id"),
    ).toBe(false);
  });

  it("returns false when agent has mcp_servers.ms-365 = false (hard opt-out)", () => {
    const cfg = baseConfig();
    cfg.agents.clerk = {
      ...cfg.agents.clerk,
      mcp_servers: { "ms-365": false } as unknown as Record<string, unknown>,
    };
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "microsoft-oauth-client-id"),
    ).toBe(false);
  });

  it("returns false when microsoft_workspace block is absent", () => {
    const cfg = baseConfig();
    delete cfg.microsoft_workspace;
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "microsoft-oauth-client-id"),
    ).toBe(false);
  });

  it("returns false when client_secret is missing (public-client app)", () => {
    const cfg = baseConfig();
    delete cfg.microsoft_workspace!.microsoft_client_secret;
    // Client id still matches; secret key resolution should be false.
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "microsoft-oauth-client-id"),
    ).toBe(true);
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "microsoft-oauth-client-secret"),
    ).toBe(false);
  });

  it("handles literal (non-vault) client_id correctly", () => {
    const cfg = baseConfig({
      microsoft_workspace: {
        microsoft_client_id: "literal-client-id-value",
      },
    });
    // Literal values produce vaultRefKey === null → no match for any key
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "literal-client-id-value"),
    ).toBe(false);
    expect(
      isMicrosoftClientCredentialKeyForAgent(cfg, "clerk", "microsoft-oauth-client-id"),
    ).toBe(false);
  });
});
