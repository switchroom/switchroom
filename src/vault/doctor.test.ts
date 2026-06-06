/**
 * Tests for the vault-doctor pure layer — specifically the
 * identifier-stored-as-secret check (a public ID miscategorised as a vault
 * secret, which the secret-guard PreToolUse hook would then block from ever
 * appearing in a tool call). See src/vault/doctor.ts.
 */

import { describe, expect, it } from "vitest";
import { analyseVaultHealth, looksLikeIdentifierValue } from "./doctor.js";

describe("looksLikeIdentifierValue", () => {
  it("flags identifier-shaped values (digits, optionally grouped)", () => {
    expect(looksLikeIdentifierValue("1356752511")).toBe(true); // Google Ads customer-id
    expect(looksLikeIdentifierValue("8996755792")).toBe(true); // login-customer-id
    expect(looksLikeIdentifierValue("135-675-2511")).toBe(true); // dashed grouping
    expect(looksLikeIdentifierValue("899 675 5792")).toBe(true); // spaced grouping
    expect(looksLikeIdentifierValue(" 1356752511 ")).toBe(true); // surrounding whitespace
  });

  it("does NOT flag real secrets (letters / symbols / high entropy)", () => {
    expect(looksLikeIdentifierValue("ghp_secret_token_12345")).toBe(false);
    expect(looksLikeIdentifierValue("sk-ant-abc123-xyz")).toBe(false);
    expect(looksLikeIdentifierValue("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")).toBe(false);
    expect(looksLikeIdentifierValue("1//04i4ckx6E6BVFCgYIARAAGAQSNwF")).toBe(false); // slash + letters
  });

  it("does NOT flag values shorter than 8 digits or longer than 24 chars", () => {
    expect(looksLikeIdentifierValue("1234567")).toBe(false); // 7 digits — under the guard length
    expect(looksLikeIdentifierValue("abc")).toBe(false);
    expect(looksLikeIdentifierValue("1".repeat(25))).toBe(false); // long numeric — likely a real secret
    expect(looksLikeIdentifierValue("")).toBe(false);
  });
});

describe("analyseVaultHealth — identifier-stored-as-secret", () => {
  const base = {
    agentSchedules: {},
    brokerConfigured: false,
    brokerRunning: undefined,
  };

  it("warns when a vault key holds an identifier-like value", () => {
    const diags = analyseVaultHealth({
      ...base,
      vaultKeys: {
        "google-ads/customer-id": { looksLikeIdentifier: true },
        "google-ads/refresh-token": { looksLikeIdentifier: false },
      },
    });
    const hit = diags.find((d) => d.check === "identifier-stored-as-secret");
    expect(hit).toBeDefined();
    expect(hit?.level).toBe("warn");
    expect(hit?.message).toContain("google-ads/customer-id");
    expect(hit?.message).not.toContain("google-ads/refresh-token");
  });

  it("does not emit the check when no key is identifier-shaped", () => {
    const diags = analyseVaultHealth({
      ...base,
      vaultKeys: {
        "google-ads/refresh-token": { looksLikeIdentifier: false },
        "marko/postiz-api-key": {},
      },
    });
    expect(diags.some((d) => d.check === "identifier-stored-as-secret")).toBe(false);
  });
});
