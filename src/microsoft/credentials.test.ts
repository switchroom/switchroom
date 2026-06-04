import { describe, expect, it } from "vitest";
import { buildMicrosoftCredentials } from "./credentials.js";
import type { MicrosoftTokenResponse } from "./oauth.js";

const PERSONAL_MSA_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** Build an unsigned JWT with the given payload (decodeJwtPayloadUnsafe
 *  only reads the payload segment — signature is ignored). */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

function tokens(overrides: Partial<MicrosoftTokenResponse> = {}): MicrosoftTokenResponse {
  return {
    access_token: "at-xyz",
    refresh_token: "rt-xyz",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "Mail.ReadWrite Files.ReadWrite.All",
    ...overrides,
  };
}

describe("buildMicrosoftCredentials", () => {
  it("derives personal account identity from a personal-MSA id_token", () => {
    const id_token = fakeIdToken({
      tid: PERSONAL_MSA_TID,
      oid: "oid-123",
      preferred_username: "Lisa@Outlook.com",
    });
    const built = buildMicrosoftCredentials({
      tokens: tokens({ id_token }),
      clientId: "client-1",
      accountEmail: "", // device-code: no requested email
      fallbackScope: "Mail.ReadWrite",
      now: () => 1_000,
    });
    expect(built.resolvedEmail).toBe("lisa@outlook.com"); // lowercased
    expect(built.emailMismatch).toBe(false); // no requested email to mismatch
    const o = built.credentials.microsoftOauth;
    expect(o.accountType).toBe("personal");
    expect(o.tenantId).toBe(PERSONAL_MSA_TID);
    expect(o.accountEmail).toBe("lisa@outlook.com");
    expect(o.homeAccountId).toBe(`oid-123.${PERSONAL_MSA_TID}`);
    expect(o.expiresAt).toBe(1_000 + 3600 * 1000);
    expect(o.refreshToken).toBe("rt-xyz");
    expect(o.tokenType).toBe("Bearer");
  });

  it("classifies a non-MSA tenant as a work account", () => {
    const id_token = fakeIdToken({
      tid: "contoso-tenant-9999",
      oid: "oid-9",
      preferred_username: "ken@contoso.com",
    });
    const built = buildMicrosoftCredentials({
      tokens: tokens({ id_token }),
      clientId: "client-1",
      accountEmail: "",
      fallbackScope: "Mail.ReadWrite",
    });
    expect(built.credentials.microsoftOauth.accountType).toBe("work");
    expect(built.resolvedEmail).toBe("ken@contoso.com");
  });

  it("flags an email mismatch when the token names a different account than requested", () => {
    const id_token = fakeIdToken({
      tid: PERSONAL_MSA_TID,
      oid: "oid-1",
      preferred_username: "real@outlook.com",
    });
    const built = buildMicrosoftCredentials({
      tokens: tokens({ id_token }),
      clientId: "client-1",
      accountEmail: "typo@outlook.com",
      fallbackScope: "Mail.ReadWrite",
    });
    expect(built.emailMismatch).toBe(true);
    expect(built.resolvedEmail).toBe("real@outlook.com");
  });

  it("falls back to the requested email + empty discriminators when no id_token", () => {
    const built = buildMicrosoftCredentials({
      tokens: tokens({ id_token: undefined }),
      clientId: "client-1",
      accountEmail: "fallback@outlook.com",
      fallbackScope: "Mail.ReadWrite Files.ReadWrite.All",
    });
    expect(built.resolvedEmail).toBe("fallback@outlook.com");
    expect(built.emailMismatch).toBe(false);
    expect(built.credentials.microsoftOauth.tenantId).toBe("");
    expect(built.credentials.microsoftOauth.homeAccountId).toBe("");
  });

  it("uses the granted token scope, falling back when absent", () => {
    const withScope = buildMicrosoftCredentials({
      tokens: tokens({ scope: "Mail.Read" }),
      clientId: "c",
      accountEmail: "a@b.com",
      fallbackScope: "FALLBACK",
    });
    expect(withScope.credentials.microsoftOauth.scope).toBe("Mail.Read");
    const noScope = buildMicrosoftCredentials({
      tokens: tokens({ scope: undefined }),
      clientId: "c",
      accountEmail: "a@b.com",
      fallbackScope: "FALLBACK",
    });
    expect(noScope.credentials.microsoftOauth.scope).toBe("FALLBACK");
  });
});
