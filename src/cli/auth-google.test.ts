/**
 * Unit tests for `switchroom auth google` helpers.
 *
 * Coverage focus is the pure helpers extracted from registerAccountAdd
 * (Phase 3b.3 de-stub). Wiring of the full `auth google account add`
 * verb (OAuth flow + brokerCall + vault-ref resolution) is exercised
 * by manual smoke (RFC G §6) and the broker-server integration tests.
 */

import { describe, expect, it } from "vitest";

import { _testing } from "./auth-google.js";

const { validateAndNormalizeAccountEmail, buildGoogleCredentials } = _testing;

describe("validateAndNormalizeAccountEmail", () => {
  it("lowercases + trims valid emails", () => {
    expect(validateAndNormalizeAccountEmail("  Alice@Example.COM  ")).toBe(
      "alice@example.com",
    );
  });

  it("rejects malformed emails", () => {
    expect(() => validateAndNormalizeAccountEmail("not-an-email")).toThrow(
      /not a valid Google account email/,
    );
    expect(() => validateAndNormalizeAccountEmail("@example.com")).toThrow();
    expect(() => validateAndNormalizeAccountEmail("alice@")).toThrow();
  });

  it("rejects emails containing colon (would break broker slot-key parser)", () => {
    expect(() =>
      validateAndNormalizeAccountEmail("alice:bob@example.com"),
    ).toThrow();
  });
});

describe("buildGoogleCredentials", () => {
  const baseTokens = {
    access_token: "ya29.test-access",
    refresh_token: "1//test-refresh",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/drive.readonly",
  };

  it("constructs the GoogleAddAccountCredentials shape the broker expects", () => {
    const creds = buildGoogleCredentials({
      tokens: baseTokens,
      clientId: "client-id-123.apps.googleusercontent.com",
      accountEmail: "alice@example.com",
      fallbackScope: "https://www.googleapis.com/auth/drive.readonly",
      now: () => 1_000_000,
    });
    expect(creds.googleOauth.accessToken).toBe("ya29.test-access");
    expect(creds.googleOauth.refreshToken).toBe("1//test-refresh");
    expect(creds.googleOauth.expiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(creds.googleOauth.scope).toBe(
      "https://www.googleapis.com/auth/drive.readonly",
    );
    expect(creds.googleOauth.clientId).toBe(
      "client-id-123.apps.googleusercontent.com",
    );
    expect(creds.googleOauth.accountEmail).toBe("alice@example.com");
    expect(creds.googleOauth.tokenType).toBe("Bearer");
  });

  it("falls back to fallbackScope when Google omits scope", () => {
    const creds = buildGoogleCredentials({
      tokens: { ...baseTokens, scope: undefined },
      clientId: "x",
      accountEmail: "a@b.com",
      fallbackScope: "scope-a scope-b",
      now: () => 0,
    });
    expect(creds.googleOauth.scope).toBe("scope-a scope-b");
  });

  it("throws when refresh_token is missing", () => {
    expect(() =>
      buildGoogleCredentials({
        tokens: { ...baseTokens, refresh_token: undefined },
        clientId: "x",
        accountEmail: "a@b.com",
        fallbackScope: "x",
      }),
    ).toThrow(/refresh_token/);
  });
});

describe("oauthClientSetupGuidance", () => {
  const { oauthClientSetupGuidance } = _testing;

  it("leads with the caller-supplied reason", () => {
    const msg = oauthClientSetupGuidance("SPECIFIC_REASON_X");
    expect(msg.startsWith("SPECIFIC_REASON_X")).toBe(true);
  });

  it("surfaces the native one-command fix first, then the manual path", () => {
    const msg = oauthClientSetupGuidance("r");
    expect(msg).toContain("switchroom auth google connect");
    expect(msg).toContain("switchroom vault set google-oauth-client-id");
    expect(msg).toContain("switchroom vault set google-oauth-client-secret");
    expect(msg).toContain("google_workspace:");
    const nativeIdx = msg.indexOf("switchroom auth google connect");
    const manualIdx = msg.indexOf("switchroom vault set");
    expect(nativeIdx).toBeGreaterThan(-1);
    expect(nativeIdx).toBeLessThan(manualIdx);
  });

  it("points at the canonical doc section", () => {
    expect(oauthClientSetupGuidance("r")).toContain(
      "docs/google-workspace.md",
    );
  });

  it("distinguishes the two callsites by reason", () => {
    const a = oauthClientSetupGuidance("no block");
    const b = oauthClientSetupGuidance("empty id/secret");
    expect(a).not.toBe(b);
    expect(a).toContain("no block");
    expect(b).toContain("empty id/secret");
  });
});

describe("interpretConnectPutResult", () => {
  const { interpretConnectPutResult } = _testing;

  it("passes a successful put through", () => {
    expect(interpretConnectPutResult("k", { kind: "ok" })).toEqual({
      ok: true,
    });
  });

  it("unreachable → not stored + points at broker recovery, no direct-file fallback", () => {
    const v = interpretConnectPutResult("google-oauth-client-id", {
      kind: "unreachable",
      msg: "ENOENT socket",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("google-oauth-client-id");
    expect(v.message).toContain("was not");
    expect(v.message).toContain("switchroom vault broker status");
    expect(v.message).toContain("ENOENT socket");
    // Must NOT suggest bypassing the broker — that's the bug we removed.
    expect(v.message.toLowerCase()).not.toContain("--no-broker");
    expect(v.message.toLowerCase()).not.toContain("vault.enc");
  });

  it("unreachable + broker deliberately disabled → manual-seed guidance, not 'restart the broker'", () => {
    const v = interpretConnectPutResult(
      "google-oauth-client-id",
      { kind: "unreachable", msg: "broker disabled" },
      true,
    );
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("vault.broker.enabled is false");
    // Broker-disabled host: --no-broker direct seed is the CORRECT path
    // here (file isn't broker-owned), so it must be offered.
    expect(v.message).toContain("--no-broker");
    expect(v.message).toContain("google-oauth-client-secret");
    expect(v.message).toContain("docs/google-workspace.md");
    // Don't tell them to restart a broker they intentionally don't run.
    expect(v.message).not.toContain("docker compose");
  });

  it("denied → surfaces code/msg and the passphrase-mismatch hint", () => {
    const v = interpretConnectPutResult("google-oauth-client-secret", {
      kind: "denied",
      code: "DENIED",
      msg: "supplied passphrase does not match",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("[DENIED]");
    expect(v.message).toContain("supplied passphrase does not match");
    expect(v.message.toLowerCase()).toContain("passphrase");
  });

  it("not_found → explains operator attestation is required", () => {
    const v = interpretConnectPutResult("google-oauth-client-id", {
      kind: "not_found",
      code: "UNKNOWN_KEY",
      msg: "unknown key",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("[UNKNOWN_KEY]");
    expect(v.message.toLowerCase()).toContain("attest");
  });
});

describe("interpretRefGetResult", () => {
  const { interpretRefGetResult } = _testing;

  it("string entry → resolved value", () => {
    const v = interpretRefGetResult("google_client_id", "google-oauth-client-id", {
      kind: "ok",
      entry: { kind: "string", value: "abc.apps.googleusercontent.com" },
    });
    expect(v).toEqual({ ok: true, value: "abc.apps.googleusercontent.com" });
  });

  it("non-string entry → hard error, no fallback", () => {
    const v = interpretRefGetResult("google_client_secret", "k", {
      kind: "ok",
      entry: { kind: "binary", value: "deadbeef" },
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.fallback).toBe(false);
    if (v.fallback) throw new Error("unreachable");
    expect(v.message).toContain("is not a string");
    expect(v.message).toContain("kind=binary");
  });

  it("unreachable → fallback to direct read (the only fallback-eligible case)", () => {
    const v = interpretRefGetResult("google_client_id", "k", {
      kind: "unreachable",
      msg: "no socket",
    });
    expect(v).toEqual({ ok: false, fallback: true });
  });

  it("not_found → hard error, NOT fallback (reached broker is authoritative)", () => {
    const v = interpretRefGetResult("google_client_id", "google-oauth-client-id", {
      kind: "not_found",
      code: "UNKNOWN_KEY",
      msg: "Key not found",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.fallback).toBe(false);
    if (v.fallback) throw new Error("unreachable");
    expect(v.message).toContain("google-oauth-client-id");
    expect(v.message).toContain("[UNKNOWN_KEY]");
  });

  it("denied → hard error with operator-scope hint, NOT fallback", () => {
    const v = interpretRefGetResult("google_client_secret", "google-oauth-client-secret", {
      kind: "denied",
      code: "DENIED",
      msg: "scope excludes operator",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.fallback).toBe(false);
    if (v.fallback) throw new Error("unreachable");
    expect(v.message).toContain("[DENIED]");
    expect(v.message.toLowerCase()).toContain("operator");
    // Must not silently mask a real ACL/scope problem by reading the file.
    expect(v.message).toContain("scope excludes operator");
  });
});


describe("buildScopeReconsentRequiredError — never a silent no-op", () => {
  const { buildScopeReconsentRequiredError } = _testing;

  it("names the missing scope and prints the exact --replace command", () => {
    const msg = buildScopeReconsentRequiredError("you@example.com", [
      "calendar",
    ]);
    expect(msg).toContain("you@example.com");
    expect(msg).toContain("calendar.readonly");
    expect(msg).toContain("already registered");
    expect(msg).toContain(
      "switchroom auth google account add you@example.com --replace --calendar",
    );
  });

  it("explains WHY (scopes fixed at consent time) so the operator can recover", () => {
    const msg = buildScopeReconsentRequiredError("a@b.com", ["calendar"]);
    expect(msg).toContain("fixed at consent time");
  });

  it("reassures that existing scopes are carried forward, not dropped", () => {
    const msg = buildScopeReconsentRequiredError("a@b.com", ["calendar"]);
    expect(msg).toMatch(/carried forward/i);
  });

  it("lists every newly-requested capability in one command", () => {
    const msg = buildScopeReconsentRequiredError("a@b.com", [
      "write",
      "calendar",
    ]);
    expect(msg).toContain("drive.file, calendar.readonly");
    expect(msg).toContain("--replace --write --calendar");
  });
});

describe("buildCarryForwardNotices — carry-forward is announced, not silent", () => {
  const { buildCarryForwardNotices } = _testing;

  it("nothing carried → no notices", () => {
    expect(buildCarryForwardNotices([])).toEqual([]);
  });

  it("names the scope, the flag that was omitted, and the consequence", () => {
    const [line] = buildCarryForwardNotices(["write"]);
    expect(line).toContain("drive.file");
    expect(line).toContain("--write");
    expect(line).toMatch(/revoke/i);
  });

  it("emits one notice per carried capability", () => {
    const lines = buildCarryForwardNotices(["write", "calendar"]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("calendar.readonly");
    expect(lines[1]).toContain("--calendar");
  });
});

// ── buildSelectionReconsentRequiredError (v1 selection flags) ────────────

describe("buildSelectionReconsentRequiredError", () => {
  it("names the exact --replace command carrying the requested selection", () => {
    const msg = _testing.buildSelectionReconsentRequiredError("a@b.com", {
      readonly: true,
      services: "cal,drive",
    });
    expect(msg).toContain(
      "switchroom auth google account add a@b.com --replace --readonly --services cal,drive",
    );
    expect(msg).toContain("fixed at consent time");
  });

  it("readonly-only request omits --services from the recovery command", () => {
    const msg = _testing.buildSelectionReconsentRequiredError("a@b.com", {
      readonly: true,
    });
    expect(msg).toContain("--replace --readonly");
    expect(msg).not.toContain("--services");
  });
});
