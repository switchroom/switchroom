/**
 * Tests for MicrosoftProvider — RFC #1873 PR 1.
 *
 * Mirrors `google-provider.test.ts` structure: stub fetcher returning
 * canned Microsoft v2 `/token` responses, exercises refresh
 * success/failure paths, error classification, extractExpiresAt,
 * validateCredentialShape.
 *
 * Microsoft-specific additions vs Google's tests:
 *   - id_token decoding (tid/oid/preferred_username → tenantId,
 *     homeAccountId, accountType, accountEmail in rawCredentials)
 *   - accountType discriminator (personal MSA tid vs work tenant GUID)
 *   - 429 / AADSTS50196 throttling → quota_exceeded
 */

import { describe, expect, it } from "vitest";

import { MicrosoftProvider } from "./microsoft-provider.js";

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const PERSONAL_MSA_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const WORK_TENANT_TID = "11111111-2222-3333-4444-555555555555";

function stubFetcher(status: number, body: unknown): typeof fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function failingFetcher(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function makeProvider(fetcher: typeof fetch): MicrosoftProvider {
  return new MicrosoftProvider({
    clientId: "test-client-id",
    clientSecret: "test-secret",
    fetcher,
  });
}

/**
 * Build a synthetic id_token JWT with the given claims. Signature is a
 * fixed placeholder — provider decodes unsafely (no verification).
 */
function makeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims))
    .toString("base64url");
  // Signature placeholder — provider never validates.
  const signature = "fake-signature";
  return `${header}.${payload}.${signature}`;
}

function microsoftSuccessBody(opts: {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  idTokenClaims?: Record<string, unknown> | null;
} = {}): Record<string, unknown> {
  const claims = opts.idTokenClaims === null
    ? null
    : opts.idTokenClaims ?? {
        tid: PERSONAL_MSA_TID,
        oid: "user-object-id-1",
        preferred_username: "alice@outlook.com",
        email: "alice@outlook.com",
      };
  const body: Record<string, unknown> = {
    access_token: opts.accessToken ?? "new-access",
    refresh_token: opts.refreshToken ?? "new-refresh",
    expires_in: opts.expiresIn ?? 3600,
    token_type: "Bearer",
    scope: opts.scope ?? "openid profile email offline_access User.Read",
  };
  if (claims !== null) {
    body.id_token = makeIdToken(claims);
  }
  return body;
}

// ────────────────────────────────────────────────────────────────────────
// refresh — success path
// ────────────────────────────────────────────────────────────────────────

describe("MicrosoftProvider.refresh — success", () => {
  it("returns RefreshSuccess from a canned Microsoft 200 response", async () => {
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody()));
    const r = await provider.refresh({
      refreshToken: "old-refresh",
      accountEmail: "alice@outlook.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accessToken).toBe("new-access");
      expect(r.newRefreshToken).toBe("new-refresh");
      const expectedMin = Date.now() + 3590_000;
      const expectedMax = Date.now() + 3610_000;
      expect(r.expiresAt).toBeGreaterThan(expectedMin);
      expect(r.expiresAt).toBeLessThan(expectedMax);
    }
  });

  it("populates MicrosoftCredentialsShape rawCredentials with personal MSA discriminator", async () => {
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody({
      idTokenClaims: {
        tid: PERSONAL_MSA_TID,
        oid: "personal-oid",
        preferred_username: "alice@outlook.com",
      },
    })));
    const r = await provider.refresh({
      refreshToken: "old-refresh",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        microsoftOauth: {
          tenantId: string;
          accountType: string;
          homeAccountId: string;
          accountEmail: string;
        };
      };
      expect(creds.microsoftOauth.tenantId).toBe(PERSONAL_MSA_TID);
      expect(creds.microsoftOauth.accountType).toBe("personal");
      expect(creds.microsoftOauth.homeAccountId).toBe(`personal-oid.${PERSONAL_MSA_TID}`);
      expect(creds.microsoftOauth.accountEmail).toBe("alice@outlook.com");
    }
  });

  it("populates work account discriminator when tid is a real tenant GUID", async () => {
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody({
      idTokenClaims: {
        tid: WORK_TENANT_TID,
        oid: "work-oid",
        preferred_username: "alice@contoso.com",
      },
    })));
    const r = await provider.refresh({ refreshToken: "old-refresh" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        microsoftOauth: { tenantId: string; accountType: string };
      };
      expect(creds.microsoftOauth.tenantId).toBe(WORK_TENANT_TID);
      expect(creds.microsoftOauth.accountType).toBe("work");
    }
  });

  it("preserves the OLD refresh token when Microsoft omits a new one", async () => {
    const provider = makeProvider(stubFetcher(200, {
      access_token: "new-access",
      // No refresh_token field — Microsoft normally rotates, but
      // handle the omitted case defensively.
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid offline_access",
    }));
    const r = await provider.refresh({
      refreshToken: "kept-refresh",
      accountEmail: "alice@outlook.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newRefreshToken).toBeUndefined();
      const creds = r.rawCredentials as {
        microsoftOauth: { refreshToken: string };
      };
      expect(creds.microsoftOauth.refreshToken).toBe("kept-refresh");
    }
  });

  it("falls back to req.accountEmail when id_token has no preferred_username", async () => {
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody({
      idTokenClaims: { tid: PERSONAL_MSA_TID, oid: "no-username-oid" },
    })));
    const r = await provider.refresh({
      refreshToken: "old-refresh",
      accountEmail: "fallback@example.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        microsoftOauth: { accountEmail: string };
      };
      expect(creds.microsoftOauth.accountEmail).toBe("fallback@example.com");
    }
  });

  it("preserves canonical identity fields from priorCredentials when id_token is absent", async () => {
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody({
      idTokenClaims: null,
    })));
    const r = await provider.refresh({
      refreshToken: "old-refresh",
      accountEmail: "alice@outlook.com",
      priorCredentials: {
        microsoftOauth: {
          accessToken: "old-at",
          refreshToken: "old-refresh",
          expiresAt: 1,
          scope: "openid",
          clientId: "test-client-id",
          accountEmail: "alice@outlook.com",
          tokenType: "Bearer",
          tenantId: PERSONAL_MSA_TID,
          accountType: "personal",
          homeAccountId: `original-oid.${PERSONAL_MSA_TID}`,
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        microsoftOauth: {
          tenantId: string;
          accountType: string;
          homeAccountId: string;
          accountEmail: string;
        };
      };
      // Without id_token, fall back to prior — canonical fields
      // preserved across refresh, not clobbered with empty
      // placeholders.
      expect(creds.microsoftOauth.tenantId).toBe(PERSONAL_MSA_TID);
      expect(creds.microsoftOauth.accountType).toBe("personal");
      expect(creds.microsoftOauth.homeAccountId).toBe(`original-oid.${PERSONAL_MSA_TID}`);
      expect(creds.microsoftOauth.accountEmail).toBe("alice@outlook.com");
    }
  });

  it("falls back to empty placeholders when both id_token AND priorCredentials are absent", async () => {
    // Defensive case — should never happen in practice (broker always
    // passes priorCredentials when refreshing existing accounts), but
    // verify the safe-default behavior.
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody({
      idTokenClaims: null,
    })));
    const r = await provider.refresh({
      refreshToken: "old-refresh",
      accountEmail: "alice@outlook.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        microsoftOauth: { tenantId: string; accountType: string };
      };
      expect(creds.microsoftOauth.tenantId).toBe("");
      expect(creds.microsoftOauth.accountType).toBe("work");
    }
  });

  it("id_token claims override prior credentials (fresh truth wins)", async () => {
    const WORK_TENANT = "11111111-2222-3333-4444-555555555555";
    const provider = makeProvider(stubFetcher(200, microsoftSuccessBody({
      idTokenClaims: {
        tid: WORK_TENANT,
        oid: "new-oid",
        preferred_username: "alice@contoso.com",
      },
    })));
    const r = await provider.refresh({
      refreshToken: "old-refresh",
      priorCredentials: {
        microsoftOauth: {
          accessToken: "old-at",
          refreshToken: "old-refresh",
          expiresAt: 1,
          scope: "openid",
          clientId: "test-client-id",
          accountEmail: "stale@example.com",
          tokenType: "Bearer",
          tenantId: PERSONAL_MSA_TID,
          accountType: "personal",
          homeAccountId: `old-oid.${PERSONAL_MSA_TID}`,
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        microsoftOauth: { tenantId: string; accountType: string };
      };
      expect(creds.microsoftOauth.tenantId).toBe(WORK_TENANT);
      expect(creds.microsoftOauth.accountType).toBe("work");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// refresh — error classification
// ────────────────────────────────────────────────────────────────────────

describe("MicrosoftProvider.refresh — error classification", () => {
  it("maps Microsoft invalid_grant to RefreshErrorKind invalid_grant", async () => {
    const provider = makeProvider(stubFetcher(400, {
      error: "invalid_grant",
      error_description: "AADSTS70008: The refresh token has expired",
    }));
    const r = await provider.refresh({ refreshToken: "stale" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invalid_grant");
      expect(r.detail).toContain("AADSTS70008");
    }
  });

  it("maps 429 to quota_exceeded", async () => {
    const provider = makeProvider(stubFetcher(429, {
      error: "temporarily_unavailable",
      error_description: "Too many requests",
    }));
    const r = await provider.refresh({ refreshToken: "old" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("quota_exceeded");
  });

  it("maps AADSTS50196 throttling to quota_exceeded", async () => {
    const provider = makeProvider(stubFetcher(429, {
      error: "rate_limit",
      error_description: "AADSTS50196: too many requests for this client",
    }));
    const r = await provider.refresh({ refreshToken: "old" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("quota_exceeded");
  });

  it("maps ETIMEDOUT network failures to network", async () => {
    const provider = makeProvider(failingFetcher("ETIMEDOUT: connect timed out"));
    const r = await provider.refresh({ refreshToken: "old" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("maps fetch failed to network", async () => {
    const provider = makeProvider(failingFetcher("fetch failed"));
    const r = await provider.refresh({ refreshToken: "old" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("maps unknown error responses to provider_error with raw detail", async () => {
    const provider = makeProvider(stubFetcher(500, {
      error: "unknown_error",
      error_description: "Internal server error",
    }));
    const r = await provider.refresh({ refreshToken: "old" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("provider_error");
      expect(r.detail).toContain("500");
    }
  });

  it("rejects empty refreshToken before hitting the network", async () => {
    const provider = makeProvider(stubFetcher(200, {}));
    const r = await provider.refresh({ refreshToken: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("provider_error");
      expect(r.detail).toContain("refreshToken is required");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// extractExpiresAt
// ────────────────────────────────────────────────────────────────────────

describe("MicrosoftProvider.extractExpiresAt", () => {
  const provider = new MicrosoftProvider({ clientId: "test-id" });

  it("returns expiresAt from microsoftOauth", () => {
    expect(
      provider.extractExpiresAt({
        microsoftOauth: { expiresAt: 1234567890 },
      }),
    ).toBe(1234567890);
  });

  it("returns undefined for missing microsoftOauth", () => {
    expect(provider.extractExpiresAt({})).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(provider.extractExpiresAt(null)).toBeUndefined();
  });

  it("does NOT return expiresAt from googleOauth (provider isolation)", () => {
    expect(
      provider.extractExpiresAt({
        googleOauth: { expiresAt: 9999999999 },
      }),
    ).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateCredentialShape
// ────────────────────────────────────────────────────────────────────────

describe("MicrosoftProvider.validateCredentialShape", () => {
  const provider = new MicrosoftProvider({ clientId: "test-id" });
  const valid = {
    microsoftOauth: {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      scope: "openid profile email offline_access",
      clientId: "test-id",
      accountEmail: "alice@outlook.com",
      tokenType: "Bearer" as const,
      tenantId: PERSONAL_MSA_TID,
      accountType: "personal" as const,
      homeAccountId: `oid.${PERSONAL_MSA_TID}`,
    },
  };

  it("accepts valid Microsoft credentials", () => {
    expect(provider.validateCredentialShape(valid)).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(provider.validateCredentialShape("not-an-object"))
      .toContain("must be an object");
    expect(provider.validateCredentialShape(null))
      .toContain("must be an object");
  });

  it("rejects missing microsoftOauth", () => {
    expect(provider.validateCredentialShape({}))
      .toContain("must have a microsoftOauth object");
  });

  it("rejects missing accessToken with field-name in error", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, accessToken: undefined },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("microsoftOauth.accessToken is required");
  });

  it("rejects missing tenantId", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, tenantId: undefined },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("microsoftOauth.tenantId is required");
  });

  it("rejects missing homeAccountId", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, homeAccountId: undefined },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("microsoftOauth.homeAccountId is required");
  });

  it("rejects empty accessToken", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, accessToken: "" },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("non-empty string");
  });

  it("rejects non-positive expiresAt", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, expiresAt: 0 },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("positive unix-ms timestamp");
  });

  it("rejects wrong tokenType", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, tokenType: "Mac" },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("'Bearer'");
  });

  it("rejects invalid accountType discriminator", () => {
    const bad = {
      microsoftOauth: { ...valid.microsoftOauth, accountType: "consumer" },
    };
    expect(provider.validateCredentialShape(bad))
      .toContain("'personal' or 'work'");
  });

  it("rejects Google-shaped credentials (provider isolation)", () => {
    expect(provider.validateCredentialShape({
      googleOauth: { accessToken: "x", refreshToken: "y" },
    })).toContain("must have a microsoftOauth object");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Provider interface contract
// ────────────────────────────────────────────────────────────────────────

describe("MicrosoftProvider — Provider interface contract", () => {
  it("has name === 'microsoft'", () => {
    const provider = new MicrosoftProvider({ clientId: "test-id" });
    expect(provider.name).toBe("microsoft");
  });
});
