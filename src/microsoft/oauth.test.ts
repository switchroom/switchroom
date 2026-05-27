/**
 * Tests for src/microsoft/oauth.ts — RFC #1873 PR 1.
 *
 * Covers the OAuth primitives used by both the broker's refresh path
 * and PR 2's account-add flow:
 *   - refreshMicrosoftAccessToken: form-body construction, error mapping
 *   - decodeJwtPayloadUnsafe: base64url decode, malformed-input tolerance
 *   - classifyAccountType: tid → personal/work discriminator
 *   - buildHomeAccountId: oid+tid composition
 *   - generatePkcePair: shape + S256 challenge validation
 */

import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";

import {
  buildHomeAccountId,
  classifyAccountType,
  decodeJwtPayloadUnsafe,
  generatePkcePair,
  MICROSOFT_OAUTH_BASE,
  MicrosoftInvalidGrantError,
  PERSONAL_MSA_TENANT_ID,
  refreshMicrosoftAccessToken,
} from "./oauth.js";

// ────────────────────────────────────────────────────────────────────────
// refreshMicrosoftAccessToken
// ────────────────────────────────────────────────────────────────────────

function stubFetcher(status: number, body: unknown, capture?: {
  url?: string;
  body?: string;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = typeof input === "string" ? input : input.toString();
      capture.body = init?.body as string | undefined;
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("refreshMicrosoftAccessToken", () => {
  it("hits Microsoft's v2 /common token endpoint", async () => {
    const capture: { url?: string } = {};
    await refreshMicrosoftAccessToken(
      { client_id: "test-id", scopes: [] },
      "old-refresh",
      stubFetcher(200, {
        access_token: "new",
        expires_in: 3600,
        token_type: "Bearer",
      }, capture),
    );
    expect(capture.url).toBe(`${MICROSOFT_OAUTH_BASE}/token`);
  });

  it("builds correct refresh_token grant body", async () => {
    const capture: { body?: string } = {};
    await refreshMicrosoftAccessToken(
      { client_id: "test-id", scopes: [] },
      "old-refresh",
      stubFetcher(200, { access_token: "x", expires_in: 3600, token_type: "Bearer" }, capture),
    );
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("client_id")).toBe("test-id");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("grant_type")).toBe("refresh_token");
  });

  it("omits client_secret for public-client apps (no secret)", async () => {
    const capture: { body?: string } = {};
    await refreshMicrosoftAccessToken(
      { client_id: "test-id", scopes: [] },
      "old-refresh",
      stubFetcher(200, { access_token: "x", expires_in: 3600, token_type: "Bearer" }, capture),
    );
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("client_secret")).toBeNull();
  });

  it("includes client_secret when provided (confidential client)", async () => {
    const capture: { body?: string } = {};
    await refreshMicrosoftAccessToken(
      { client_id: "test-id", client_secret: "shh", scopes: [] },
      "old-refresh",
      stubFetcher(200, { access_token: "x", expires_in: 3600, token_type: "Bearer" }, capture),
    );
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("client_secret")).toBe("shh");
  });

  it("omits scope param when scopes array is empty (let Microsoft return full set)", async () => {
    const capture: { body?: string } = {};
    await refreshMicrosoftAccessToken(
      { client_id: "test-id", scopes: [] },
      "old",
      stubFetcher(200, { access_token: "x", expires_in: 3600, token_type: "Bearer" }, capture),
    );
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("scope")).toBeNull();
  });

  it("includes space-joined scope when scopes array is non-empty", async () => {
    const capture: { body?: string } = {};
    await refreshMicrosoftAccessToken(
      { client_id: "test-id", scopes: ["User.Read", "Mail.ReadWrite"] },
      "old",
      stubFetcher(200, { access_token: "x", expires_in: 3600, token_type: "Bearer" }, capture),
    );
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("scope")).toBe("User.Read Mail.ReadWrite");
  });

  it("throws MicrosoftInvalidGrantError on invalid_grant response", async () => {
    await expect(refreshMicrosoftAccessToken(
      { client_id: "id", scopes: [] },
      "stale",
      stubFetcher(400, {
        error: "invalid_grant",
        error_description: "AADSTS70008: refresh token expired",
      }),
    )).rejects.toThrow(MicrosoftInvalidGrantError);
  });

  it("throws generic Error for non-invalid_grant failures", async () => {
    await expect(refreshMicrosoftAccessToken(
      { client_id: "id", scopes: [] },
      "old",
      stubFetcher(500, { error: "server_error" }),
    )).rejects.toThrow(/refresh failed \(500\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// decodeJwtPayloadUnsafe
// ────────────────────────────────────────────────────────────────────────

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

describe("decodeJwtPayloadUnsafe", () => {
  it("decodes a well-formed JWT payload", () => {
    const jwt = makeJwt({ tid: "abc", oid: "def", preferred_username: "x@y.z" });
    const claims = decodeJwtPayloadUnsafe(jwt);
    expect(claims).toEqual({ tid: "abc", oid: "def", preferred_username: "x@y.z" });
  });

  it("returns null for malformed JWT (wrong segment count)", () => {
    expect(decodeJwtPayloadUnsafe("only.two")).toBeNull();
    expect(decodeJwtPayloadUnsafe("a.b.c.d")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(decodeJwtPayloadUnsafe("aaa.@@@.bbb")).toBeNull();
  });

  it("returns null for non-object JSON payload", () => {
    const payload = Buffer.from(JSON.stringify("just a string")).toString("base64url");
    const jwt = `header.${payload}.sig`;
    expect(decodeJwtPayloadUnsafe(jwt)).toBeNull();
  });

  it("handles base64url padding correctly", () => {
    // Payloads of various lengths to exercise the padding logic
    for (const claims of [
      { a: 1 },                           // short
      { a: 1, b: 2, c: 3 },               // medium
      { a: "x".repeat(100) },             // long
    ]) {
      const jwt = makeJwt(claims);
      expect(decodeJwtPayloadUnsafe(jwt)).toEqual(claims);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// classifyAccountType
// ────────────────────────────────────────────────────────────────────────

describe("classifyAccountType", () => {
  it("returns 'personal' for the well-known MSA tenant", () => {
    expect(classifyAccountType(PERSONAL_MSA_TENANT_ID)).toBe("personal");
  });

  it("returns 'work' for any other tenant GUID", () => {
    expect(classifyAccountType("11111111-2222-3333-4444-555555555555")).toBe("work");
  });

  it("returns 'work' for empty string (defensive default)", () => {
    expect(classifyAccountType("")).toBe("work");
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildHomeAccountId
// ────────────────────────────────────────────────────────────────────────

describe("buildHomeAccountId", () => {
  it("composes <oid>.<tid> when both present", () => {
    expect(buildHomeAccountId({ oid: "user-oid", tid: "tenant-tid" }))
      .toBe("user-oid.tenant-tid");
  });

  it("returns null when oid is missing", () => {
    expect(buildHomeAccountId({ tid: "x" })).toBeNull();
  });

  it("returns null when tid is missing", () => {
    expect(buildHomeAccountId({ oid: "x" })).toBeNull();
  });

  it("returns null when oid is empty string", () => {
    expect(buildHomeAccountId({ oid: "", tid: "x" })).toBeNull();
  });

  it("returns null when oid is not a string", () => {
    expect(buildHomeAccountId({ oid: 42, tid: "x" })).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// PR 2 additions — loopback + device-code + tier selection
// ────────────────────────────────────────────────────────────────────────

describe("selectInitialTier", () => {
  it("forces tier from SWITCHROOM_MICROSOFT_OAUTH_TIER override", async () => {
    const { selectInitialTier } = await import("./oauth.js");
    expect(selectInitialTier({ SWITCHROOM_MICROSOFT_OAUTH_TIER: "device_code" }))
      .toBe("device_code");
    expect(selectInitialTier({ SWITCHROOM_MICROSOFT_OAUTH_TIER: "desktop_loopback" }))
      .toBe("desktop_loopback");
  });

  it("returns device_code on headless host (SSH, no DISPLAY)", async () => {
    const { selectInitialTier } = await import("./oauth.js");
    expect(selectInitialTier({
      SSH_CONNECTION: "1.2.3.4 4242 5.6.7.8 22",
    })).toBe("device_code");
  });

  it("returns desktop_loopback when DISPLAY set + browser available", async () => {
    const { selectInitialTier } = await import("./oauth.js");
    expect(selectInitialTier({
      DISPLAY: ":0",
      ["SWITCHROOM_MICROSOFT_HAS_BROWSER_OPENER"]: "1",
    } as Record<string, string>)).toBe("desktop_loopback");
  });

  it("falls back to device_code when DISPLAY set but no browser opener", async () => {
    const { selectInitialTier } = await import("./oauth.js");
    expect(selectInitialTier({
      DISPLAY: ":0",
      ["SWITCHROOM_MICROSOFT_HAS_BROWSER_OPENER"]: "0",
    } as Record<string, string>)).toBe("device_code");
  });
});

describe("detectHeadless", () => {
  it("headless when SSH and no DISPLAY", async () => {
    const { detectHeadless } = await import("./oauth.js");
    expect(detectHeadless({ SSH_CONNECTION: "x" })).toBe(true);
  });

  it("not headless when DISPLAY and no SSH", async () => {
    const { detectHeadless } = await import("./oauth.js");
    expect(detectHeadless({ DISPLAY: ":0" })).toBe(false);
  });

  it("headless when SSH set even with DISPLAY (X-forwarding case)", async () => {
    const { detectHeadless } = await import("./oauth.js");
    expect(detectHeadless({ SSH_CONNECTION: "x", DISPLAY: ":0" })).toBe(true);
  });
});

describe("buildLoopbackAuthUrl", () => {
  it("constructs URL with PKCE challenge + state", async () => {
    const { buildLoopbackAuthUrl } = await import("./oauth.js");
    const url = buildLoopbackAuthUrl(
      { client_id: "test-id", scopes: ["User.Read", "Mail.ReadWrite"] },
      "http://127.0.0.1:8080",
      "state-xyz",
      "challenge-abc",
    );
    const u = new URL(url);
    expect(u.hostname).toBe("login.microsoftonline.com");
    expect(u.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("client_id")).toBe("test-id");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8080");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("User.Read Mail.ReadWrite");
    expect(u.searchParams.get("state")).toBe("state-xyz");
    expect(u.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("exchangeAuthCode", () => {
  it("posts code + code_verifier to token endpoint", async () => {
    const { exchangeAuthCode } = await import("./oauth.js");
    const capture: { body?: string } = {};
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capture.body = init?.body as string;
      return new Response(JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await exchangeAuthCode(
      { client_id: "test-id", scopes: [] },
      "auth-code-xyz",
      "http://127.0.0.1:8080",
      "verifier-xyz",
      fetcher,
    );
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("client_id")).toBe("test-id");
    expect(params.get("code")).toBe("auth-code-xyz");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:8080");
    expect(params.get("code_verifier")).toBe("verifier-xyz");
  });

  it("throws on non-2xx response", async () => {
    const { exchangeAuthCode } = await import("./oauth.js");
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(exchangeAuthCode(
      { client_id: "id", scopes: [] },
      "bad", "http://x", "v", fetcher,
    )).rejects.toThrow(/token exchange failed \(400\)/);
  });
});

describe("requestDeviceCode", () => {
  it("hits Microsoft's /devicecode endpoint", async () => {
    const { requestDeviceCode } = await import("./oauth.js");
    const capture: { url?: string; body?: string } = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capture.url = typeof input === "string" ? input : input.toString();
      capture.body = init?.body as string;
      return new Response(JSON.stringify({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const resp = await requestDeviceCode(
      { client_id: "test-id", scopes: ["User.Read"] },
      fetcher,
    );
    expect(capture.url).toContain("/devicecode");
    const params = new URLSearchParams(capture.body ?? "");
    expect(params.get("client_id")).toBe("test-id");
    expect(params.get("scope")).toBe("User.Read");
    expect(resp.user_code).toBe("ABCD-1234");
  });
});

describe("pollDeviceToken", () => {
  it("returns token on success", async () => {
    const { pollDeviceToken } = await import("./oauth.js");
    const fetcher = (async () =>
      new Response(JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
    const sleepMs = async () => {};
    const result = await pollDeviceToken(
      { client_id: "id", scopes: [] },
      { device_code: "dc", user_code: "AB-12", verification_uri: "x", expires_in: 60, interval: 1 },
      { fetchImpl: fetcher, sleepMs },
    );
    expect(result.access_token).toBe("at");
  });

  it("retries on authorization_pending", async () => {
    const { pollDeviceToken } = await import("./oauth.js");
    let callCount = 0;
    const fetcher = (async () => {
      callCount++;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        access_token: "at",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sleepMs = async () => {};
    const result = await pollDeviceToken(
      { client_id: "id", scopes: [] },
      { device_code: "dc", user_code: "AB", verification_uri: "x", expires_in: 60, interval: 1 },
      { fetchImpl: fetcher, sleepMs },
    );
    expect(callCount).toBe(3);
    expect(result.access_token).toBe("at");
  });

  it("throws on authorization_declined", async () => {
    const { pollDeviceToken } = await import("./oauth.js");
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "authorization_declined" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const sleepMs = async () => {};
    await expect(pollDeviceToken(
      { client_id: "id", scopes: [] },
      { device_code: "dc", user_code: "x", verification_uri: "x", expires_in: 60, interval: 1 },
      { fetchImpl: fetcher, sleepMs },
    )).rejects.toThrow(/User denied/);
  });

  it("throws on expired_token", async () => {
    const { pollDeviceToken } = await import("./oauth.js");
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "expired_token" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const sleepMs = async () => {};
    await expect(pollDeviceToken(
      { client_id: "id", scopes: [] },
      { device_code: "dc", user_code: "x", verification_uri: "x", expires_in: 60, interval: 1 },
      { fetchImpl: fetcher, sleepMs },
    )).rejects.toThrow(/Device code expired/);
  });

  it("times out if deadline passes", async () => {
    const { pollDeviceToken } = await import("./oauth.js");
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const sleepMs = async () => {};
    let nowVal = 1_000_000;
    const now = () => {
      nowVal += 30_000;
      return nowVal;
    };
    await expect(pollDeviceToken(
      { client_id: "id", scopes: [] },
      { device_code: "dc", user_code: "x", verification_uri: "x", expires_in: 1, interval: 1 },
      { fetchImpl: fetcher, sleepMs, now },
    )).rejects.toThrow(/timed out/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// generatePkcePair
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// runLoopbackOAuth — full flow integration (ported from drive/oauth.test.ts
// state-mismatch + happy-path patterns)
// ────────────────────────────────────────────────────────────────────────

describe("runLoopbackOAuth", () => {
  it("happy path: opens server, completes consent, exchanges code", async () => {
    const { runLoopbackOAuth } = await import("./oauth.js");
    let authUrl = "";
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const params = new URLSearchParams(init?.body as string);
      // Verify code_verifier was forwarded
      expect(params.get("code_verifier")).toBeTruthy();
      expect(params.get("code")).toBe("real-auth-code");
      return new Response(JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const openImpl = async (url: string): Promise<boolean> => {
      authUrl = url;
      // Simulate Microsoft redirecting back to the loopback after consent.
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "real-auth-code");
      callback.searchParams.set("state", state);
      // Microsoft's actual redirect — let it land asynchronously after listen.
      setTimeout(() => {
        // Use Node's http.get to hit the loopback callback.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("node:http") as typeof import("node:http");
        const req = http.get(callback.toString());
        req.on("error", () => { /* ignore */ });
      }, 10);
      return true;
    };

    const tokens = await runLoopbackOAuth(
      { client_id: "test-id", scopes: ["User.Read"] },
      { fetchImpl: fetcher, openImpl, timeoutMs: 10_000 },
    );
    expect(tokens.access_token).toBe("at");
    expect(tokens.refresh_token).toBe("rt");
    expect(authUrl).toContain("login.microsoftonline.com");
  }, 20_000);

  it("rejects state mismatch (CSRF guard)", async () => {
    const { runLoopbackOAuth } = await import("./oauth.js");
    const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const openImpl = async (url: string): Promise<boolean> => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "code");
      callback.searchParams.set("state", "wrong-state");
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("node:http") as typeof import("node:http");
        const req = http.get(callback.toString());
        req.on("error", () => { /* ignore */ });
      }, 10);
      return true;
    };
    await expect(runLoopbackOAuth(
      { client_id: "test-id", scopes: ["User.Read"] },
      { fetchImpl: fetcher, openImpl, timeoutMs: 10_000 },
    )).rejects.toThrow(/state parameter mismatch/);
  }, 20_000);

  it("rejects callback with no code parameter", async () => {
    const { runLoopbackOAuth } = await import("./oauth.js");
    const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const openImpl = async (url: string): Promise<boolean> => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const state = parsed.searchParams.get("state")!;
      const callback = new URL(redirectUri);
      callback.searchParams.set("state", state);
      // No code param
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("node:http") as typeof import("node:http");
        const req = http.get(callback.toString());
        req.on("error", () => { /* ignore */ });
      }, 10);
      return true;
    };
    await expect(runLoopbackOAuth(
      { client_id: "test-id", scopes: ["User.Read"] },
      { fetchImpl: fetcher, openImpl, timeoutMs: 10_000 },
    )).rejects.toThrow(/missing 'code'/);
  }, 20_000);

  it("propagates Microsoft error response from callback", async () => {
    const { runLoopbackOAuth } = await import("./oauth.js");
    const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const openImpl = async (url: string): Promise<boolean> => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const callback = new URL(redirectUri);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "User denied consent");
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("node:http") as typeof import("node:http");
        const req = http.get(callback.toString());
        req.on("error", () => { /* ignore */ });
      }, 10);
      return true;
    };
    await expect(runLoopbackOAuth(
      { client_id: "test-id", scopes: ["User.Read"] },
      { fetchImpl: fetcher, openImpl, timeoutMs: 10_000 },
    )).rejects.toThrow(/access_denied/);
  }, 20_000);

  it("times out if no callback ever arrives", async () => {
    const { runLoopbackOAuth } = await import("./oauth.js");
    const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const openImpl = async () => true; // Don't actually call back
    await expect(runLoopbackOAuth(
      { client_id: "test-id", scopes: ["User.Read"] },
      { fetchImpl: fetcher, openImpl, timeoutMs: 200 },
    )).rejects.toThrow(/timed out/);
  });
});

describe("generatePkcePair", () => {
  it("returns a verifier + challenge with non-empty shapes", () => {
    const pair = generatePkcePair();
    expect(pair.verifier.length).toBeGreaterThan(40);
    expect(pair.challenge.length).toBeGreaterThan(20);
  });

  it("challenge is S256 of verifier (RFC 7636)", () => {
    const pair = generatePkcePair();
    const expected = crypto
      .createHash("sha256")
      .update(pair.verifier)
      .digest("base64url");
    expect(pair.challenge).toBe(expected);
  });

  it("generates different pairs on successive calls", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("uses URL-safe base64 (no +, /, or =)", () => {
    const pair = generatePkcePair();
    expect(pair.verifier).not.toMatch(/[+/=]/);
    expect(pair.challenge).not.toMatch(/[+/=]/);
  });
});
