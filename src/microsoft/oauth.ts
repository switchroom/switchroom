/**
 * Microsoft Graph OAuth exchanges — RFC #1873 (Microsoft 365 integration).
 *
 * Mirrors `src/drive/oauth.ts`'s shape: pure functions for URL/body
 * construction + `*Exchange` helpers that hold the network I/O so tests
 * can drive selector + polling logic without hitting Microsoft.
 *
 * **Design note — no MSAL-Node dep.** The RFC originally specified
 * MSAL-Node, but the broker's `Provider.refresh()` contract is a
 * one-shot exchange — MSAL's value (cache management, transparent
 * rotation) doesn't manifest at this layer. Direct fetch against
 * Microsoft's `/token` endpoint mirrors the Google + Anthropic
 * providers' existing patterns, drops a dep, and is the same shape
 * the operator's family-calendar app already uses. Refresh-token
 * rotation is handled explicitly: every successful exchange returns
 * the new RT as `newRefreshToken` so the broker can write it.
 *
 * **Endpoint shape:** v2.0 endpoint at `/common` authority — single
 * URL handles both personal MSA and work/school tenants per the
 * `AzureADandPersonalMicrosoftAccount` app registration audience.
 */

import * as crypto from "node:crypto";

/**
 * Microsoft's v2.0 OAuth/OIDC base. `/common` accepts both personal MSA
 * tokens and work/school tokens; the audience is determined at app
 * registration time, not at request time.
 */
export const MICROSOFT_OAUTH_BASE =
  "https://login.microsoftonline.com/common/oauth2/v2.0";

/**
 * Personal MSA tenant constant — duplicated from
 * `src/auth/broker/protocol.ts:PERSONAL_MSA_TENANT_ID` so this module
 * doesn't pull a circular dep on broker types. Microsoft's documented
 * well-known `tid` for all consumer accounts. **Keep both in sync.**
 */
export const PERSONAL_MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Lifetime in seconds (typically 3600). */
  expires_in: number;
  token_type: string;
  /** Space-separated granted scopes. May differ from requested set. */
  scope?: string;
  /** OIDC id_token (only present when `openid` was in scope). */
  id_token?: string;
}

export interface MicrosoftOAuthClientConfig {
  client_id: string;
  /**
   * Optional. Public clients (Mobile and desktop applications platform
   * with "Allow public client flows" enabled) don't need a secret —
   * loopback + PKCE and device-code both work without it. Confidential
   * clients pass the secret.
   */
  client_secret?: string;
  scopes: string[];
}

/**
 * Microsoft returns `error: "invalid_grant"` when the refresh token is
 * revoked, the user changed their password, the app was un-consented,
 * or the token has aged out. Caller (broker) catches and surfaces as
 * `RefreshErrorKind.invalid_grant` so downstream UX can prompt re-auth.
 */
export class MicrosoftInvalidGrantError extends Error {
  constructor(public detail: string) {
    super(`invalid_grant: ${detail}`);
    this.name = "MicrosoftInvalidGrantError";
  }
}

/**
 * Refresh an access token using the durable refresh token.
 *
 * Refresh tokens rotate every successful exchange on Microsoft's v2
 * endpoint — the caller MUST persist `response.refresh_token` (when
 * present) atomically; the old RT is invalidated immediately by
 * Microsoft, so a torn write means operator re-auth.
 */
export async function refreshMicrosoftAccessToken(
  cfg: MicrosoftOAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftTokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (cfg.client_secret !== undefined && cfg.client_secret.length > 0) {
    body.set("client_secret", cfg.client_secret);
  }
  // Re-assert scopes on refresh; Microsoft narrows the response to the
  // intersection of what was previously consented + what's requested.
  // If we omit scope, Microsoft returns the full previously-consented set
  // (which is what we want for the broker's one-account-one-scope-set
  // model). Pass scope only when caller has a reason to narrow.
  if (cfg.scopes && cfg.scopes.length > 0) {
    body.set("scope", cfg.scopes.join(" "));
  }
  const res = await fetchImpl(`${MICROSOFT_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    if (typeof json.error === "string" && json.error === "invalid_grant") {
      throw new MicrosoftInvalidGrantError(
        typeof json.error_description === "string"
          ? json.error_description
          : "refresh token rejected by Microsoft",
      );
    }
    throw new Error(`refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json as unknown as MicrosoftTokenResponse;
}

/**
 * Decode a JWT's payload claims without verifying the signature. We're
 * NOT validating the token (Microsoft already validated it when issuing);
 * we're extracting claims to populate switchroom's credential shape
 * (`tid`, `oid`, `preferred_username`). Verification would require
 * pulling Microsoft's signing keys which is its own architectural piece.
 *
 * Returns null on any parse failure — caller should treat missing
 * claims defensively (fall back to `/me` Graph call per RFC §4.2).
 */
export function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    // JWT uses base64url, not base64; pad and convert.
    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
    const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(base64, "base64");
    const json = JSON.parse(buf.toString("utf-8")) as unknown;
    if (json && typeof json === "object") {
      return json as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify an id_token's tenant as personal-MSA or work/school based on
 * the `tid` claim. Microsoft mints all consumer-account tokens with
 * `tid` set to the well-known MSA constant; work/school tokens carry
 * the org's tenant GUID.
 */
export function classifyAccountType(tenantId: string): "personal" | "work" {
  return tenantId === PERSONAL_MSA_TENANT_ID ? "personal" : "work";
}

/**
 * Build the MSAL-style `homeAccountId` from `oid` + `tid` claims.
 * Used as the stable per-account key — survives email renames and is
 * what Microsoft's own libraries use internally as the cache partition
 * key. Returns null if either claim is missing.
 */
export function buildHomeAccountId(
  claims: Record<string, unknown>,
): string | null {
  const oid = claims.oid;
  const tid = claims.tid;
  if (typeof oid !== "string" || oid.length === 0) return null;
  if (typeof tid !== "string" || tid.length === 0) return null;
  return `${oid}.${tid}`;
}

/**
 * Generate a PKCE code verifier + S256 challenge pair for OAuth code
 * flow. RFC 7636: verifier is 43-128 chars unreserved set
 * (`[A-Z][a-z][0-9]-._~`); challenge is base64url(SHA-256(verifier)).
 *
 * Used by PR 2's loopback handler; landed here in PR 1 so the
 * `microsoft/oauth.ts` module is the single home for OAuth primitives
 * (mirrors `drive/oauth.ts` shape).
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
