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
// generatePkcePair
// ────────────────────────────────────────────────────────────────────────

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
