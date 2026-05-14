/**
 * Tests for GoogleProvider — RFC G Phase 3b.2a.
 *
 * Drives `refresh()` against a stub fetcher returning canned Google
 * token-endpoint responses. Validates:
 *   - Successful refresh round-trips into a RefreshSuccess shape
 *   - Google's `invalid_grant` (rotation / revocation / 7-day expiry)
 *     maps to RefreshErrorKind="invalid_grant"
 *   - Network failures map to "network"
 *   - 429 / quota responses map to "quota_exceeded"
 *   - Other failures map to "provider_error" with the raw detail
 *   - extractExpiresAt + validateCredentialShape correctness
 *
 * Replay-style: tests pass a fetcher that returns a Response from a
 * captured Google response body, no network round-trip.
 */

import { describe, expect, it } from "vitest";

import { GoogleProvider } from "./google-provider.js";

// ────────────────────────────────────────────────────────────────────────
// Stub fetcher helpers — wraps a status + body into a Response that
// matches the shape `refreshAccessToken` expects.
// ────────────────────────────────────────────────────────────────────────

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

function makeProvider(fetcher: typeof fetch): GoogleProvider {
  return new GoogleProvider({
    clientId: "test-client-id",
    clientSecret: "test-secret",
    fetcher,
  });
}

// ────────────────────────────────────────────────────────────────────────
// refresh — success path
// ────────────────────────────────────────────────────────────────────────

describe("GoogleProvider.refresh — success", () => {
  it("returns RefreshSuccess from a canned Google 200 response", async () => {
    const provider = makeProvider(
      stubFetcher(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/drive",
      }),
    );
    const r = await provider.refresh({
      refreshToken: "old-refresh",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accessToken).toBe("new-access");
      expect(r.newRefreshToken).toBe("new-refresh");
      // expiresAt is computed as Date.now() + expires_in*1000; just
      // verify it's in the right range (within 5s of now+1h).
      const expectedMin = Date.now() + 3590_000;
      const expectedMax = Date.now() + 3610_000;
      expect(r.expiresAt).toBeGreaterThan(expectedMin);
      expect(r.expiresAt).toBeLessThan(expectedMax);
    }
  });

  it("preserves the OLD refresh token when Google omits a new one (no rotation)", async () => {
    const provider = makeProvider(
      stubFetcher(200, {
        access_token: "new-access",
        // refresh_token field omitted — Google sometimes doesn't rotate
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    const r = await provider.refresh({
      refreshToken: "kept-refresh",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // newRefreshToken on the wire reflects what Google returned (undefined).
      expect(r.newRefreshToken).toBeUndefined();
      // rawCredentials.googleOauth.refreshToken is the OLD token (preserved).
      const creds = r.rawCredentials as { googleOauth: { refreshToken: string } };
      expect(creds.googleOauth.refreshToken).toBe("kept-refresh");
    }
  });

  it("populates GoogleCredentialsShape rawCredentials with all required fields", async () => {
    const provider = makeProvider(
      stubFetcher(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/docs",
      }),
    );
    const r = await provider.refresh({
      refreshToken: "old-rt",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const creds = r.rawCredentials as {
        googleOauth: {
          accessToken: string;
          refreshToken: string;
          expiresAt: number;
          scope: string;
          clientId: string;
          accountEmail: string;
          tokenType: "Bearer";
        };
      };
      expect(creds.googleOauth.accessToken).toBe("at-1");
      expect(creds.googleOauth.refreshToken).toBe("rt-1");
      expect(creds.googleOauth.scope).toContain("drive");
      expect(creds.googleOauth.scope).toContain("docs");
      expect(creds.googleOauth.clientId).toBe("test-client-id");
      expect(creds.googleOauth.accountEmail).toBe("alice@example.com");
      expect(creds.googleOauth.tokenType).toBe("Bearer");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// refresh — error mapping
// ────────────────────────────────────────────────────────────────────────

describe("GoogleProvider.refresh — error classification", () => {
  it("maps Google invalid_grant to RefreshErrorKind invalid_grant", async () => {
    const provider = makeProvider(
      stubFetcher(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    );
    const r = await provider.refresh({
      refreshToken: "rotated-rt",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invalid_grant");
      expect(r.detail).toContain("expired or revoked");
    }
  });

  it("maps 429 / rate-limit to quota_exceeded", async () => {
    const provider = makeProvider(
      stubFetcher(429, { error: "rateLimitExceeded" }),
    );
    const r = await provider.refresh({
      refreshToken: "rt",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("quota_exceeded");
  });

  it("maps network failures (ETIMEDOUT) to network", async () => {
    const provider = makeProvider(failingFetcher("ETIMEDOUT connect 142.250.x.x:443"));
    const r = await provider.refresh({
      refreshToken: "rt",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("maps fetch failed to network", async () => {
    const provider = makeProvider(failingFetcher("fetch failed"));
    const r = await provider.refresh({
      refreshToken: "rt",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("maps unknown error responses to provider_error with raw detail", async () => {
    const provider = makeProvider(
      stubFetcher(500, { error: "internal_server_error", error_description: "boom" }),
    );
    const r = await provider.refresh({
      refreshToken: "rt",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("provider_error");
      expect(r.detail).toContain("internal_server_error");
    }
  });

  it("rejects empty refreshToken before hitting the network", async () => {
    let calls = 0;
    const fetcher: typeof fetch = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetcher);
    const r = await provider.refresh({
      refreshToken: "",
      clientId: "alice@example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("provider_error");
      expect(r.detail).toContain("refreshToken is required");
    }
    expect(calls).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// extractExpiresAt
// ────────────────────────────────────────────────────────────────────────

describe("GoogleProvider.extractExpiresAt", () => {
  it("returns expiresAt from googleOauth", () => {
    const provider = makeProvider(stubFetcher(200, {}));
    expect(
      provider.extractExpiresAt({ googleOauth: { expiresAt: 9999 } }),
    ).toBe(9999);
  });

  it("returns undefined for missing googleOauth", () => {
    const provider = makeProvider(stubFetcher(200, {}));
    expect(provider.extractExpiresAt({})).toBeUndefined();
    expect(provider.extractExpiresAt(null)).toBeUndefined();
  });

  it("does NOT return expiresAt from claudeAiOauth (provider isolation)", () => {
    const provider = makeProvider(stubFetcher(200, {}));
    // Anthropic-shaped credentials should yield undefined when read by
    // Google provider. Pins that the providers correctly stay in their
    // lanes per the AccountKey collision-avoidance contract.
    expect(
      provider.extractExpiresAt({ claudeAiOauth: { expiresAt: 9999 } }),
    ).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateCredentialShape
// ────────────────────────────────────────────────────────────────────────

describe("GoogleProvider.validateCredentialShape", () => {
  const validCreds = {
    googleOauth: {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1234,
      scope: "drive",
      clientId: "cid",
      accountEmail: "alice@example.com",
      tokenType: "Bearer",
    },
  };

  function provider() {
    return makeProvider(stubFetcher(200, {}));
  }

  it("accepts valid Google credentials", () => {
    expect(provider().validateCredentialShape(validCreds)).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(provider().validateCredentialShape("not-an-object")).toContain("must be an object");
    expect(provider().validateCredentialShape(null)).toContain("must be an object");
  });

  it("rejects missing googleOauth", () => {
    expect(provider().validateCredentialShape({})).toContain("googleOauth object");
  });

  it("rejects missing required fields with field-name in error", () => {
    const noAccessToken = {
      googleOauth: { ...validCreds.googleOauth, accessToken: undefined },
    };
    expect(provider().validateCredentialShape(noAccessToken)).toContain("accessToken");
  });

  it("rejects empty accessToken", () => {
    const empty = {
      googleOauth: { ...validCreds.googleOauth, accessToken: "" },
    };
    expect(provider().validateCredentialShape(empty)).toContain("non-empty");
  });

  it("rejects non-positive expiresAt", () => {
    const bad = {
      googleOauth: { ...validCreds.googleOauth, expiresAt: -1 },
    };
    expect(provider().validateCredentialShape(bad)).toContain("positive");
  });

  it("rejects wrong tokenType", () => {
    const bad = {
      googleOauth: { ...validCreds.googleOauth, tokenType: "MAC" },
    };
    expect(provider().validateCredentialShape(bad)).toContain("Bearer");
  });

  it("rejects Anthropic-shaped credentials (provider isolation)", () => {
    expect(
      provider().validateCredentialShape({
        claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1 },
      }),
    ).toContain("googleOauth");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Provider interface contract
// ────────────────────────────────────────────────────────────────────────

describe("GoogleProvider — Provider interface contract", () => {
  it("has name === 'google'", () => {
    const provider = makeProvider(stubFetcher(200, {}));
    expect(provider.name).toBe("google");
  });

  it("is the same Provider type the registry accepts", async () => {
    const { ProviderRegistry } = await import("./provider.js");
    const reg = new ProviderRegistry();
    const provider = makeProvider(stubFetcher(200, {}));
    reg.register(provider);
    expect(reg.lookup("google")).toBe(provider);
    expect(reg.has("google")).toBe(true);
  });
});
