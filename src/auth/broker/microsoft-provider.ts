/**
 * MicrosoftProvider — Provider implementation for Microsoft OAuth
 * (RFC #1873, PR 1).
 *
 * Wraps `src/microsoft/oauth.ts:refreshMicrosoftAccessToken` as a
 * Provider. Mirrors GoogleProvider's shape: HTTP refresh against
 * Microsoft's v2 `/token` endpoint, error mapping, credential
 * extraction.
 *
 * **What this provider owns:**
 *   - HTTP refresh exchange against Microsoft's `/common` v2 endpoint
 *   - Microsoft-specific error mapping (`invalid_grant` for revoked
 *     RT / password change / app un-consent; rate-limit detection;
 *     429 from Graph throttling)
 *   - Credential shape (`microsoftOauth: { ... }` per protocol.ts —
 *     richer than Google's because we persist tenant + account-type
 *     discriminators)
 *   - Expiry extraction from `microsoftOauth.expiresAt`
 *
 * **What the broker owns:**
 *   - On-disk persistence (`microsoft-storage.ts`)
 *   - Refresh leases (one in-flight refresh per account)
 *   - Drift detection / ACL / fanout
 *
 * **Refresh token rotation**: Microsoft v2 rotates RTs every successful
 * exchange. Provider returns `newRefreshToken` on every success;
 * broker writes the new RT atomically (storage.ts atomic-rename
 * pattern handles torn-write recovery).
 */

import {
  classifyAccountType,
  decodeJwtPayloadUnsafe,
  MicrosoftInvalidGrantError,
  refreshMicrosoftAccessToken,
  type MicrosoftOAuthClientConfig,
  type MicrosoftTokenResponse,
} from "../../microsoft/oauth.js";
import type { Provider, RefreshRequest, RefreshResult } from "./provider.js";
import type { MicrosoftCredentialsShape } from "./protocol.js";

/**
 * Construction options. The OAuth client id (+ optional secret) are
 * passed in by the broker — they're per-install config sourced from
 * the `microsoft_workspace.microsoft_client_id` / `_secret` config
 * block.
 *
 * Public-client flows (loopback + PKCE, device-code) don't strictly
 * need a secret — for switchroom v1 we accept either shape so the
 * operator can pick. The refresh exchange passes the secret only when
 * present.
 */
export interface MicrosoftProviderOptions {
  /** Microsoft OAuth application (client) ID from Entra portal. */
  clientId: string;
  /**
   * Optional client secret. Public-client apps (Mobile + Desktop
   * platform with "Allow public client flows") work without a secret;
   * confidential clients pass one. The refresh exchange includes it
   * in the form body only when non-empty.
   */
  clientSecret?: string;
  /**
   * Injectable fetch — tests pass a stub that returns canned Microsoft
   * token-endpoint responses. Defaults to global fetch.
   */
  fetcher?: typeof fetch;
}

export class MicrosoftProvider implements Provider {
  readonly name = "microsoft" as const;

  constructor(private readonly opts: MicrosoftProviderOptions) {}

  async refresh(req: RefreshRequest): Promise<RefreshResult> {
    if (!req.refreshToken) {
      return {
        ok: false,
        kind: "provider_error",
        detail: "MicrosoftProvider.refresh: refreshToken is required",
      };
    }
    const cfg: MicrosoftOAuthClientConfig = {
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      // Don't narrow scopes on refresh — let Microsoft return the
      // intersection of previously-consented + the empty request,
      // which is the full consented set. PR 2 / launcher does scope
      // shaping at account-add time, not at refresh time.
      scopes: [],
    };
    let token: MicrosoftTokenResponse;
    try {
      token = await refreshMicrosoftAccessToken(
        cfg,
        req.refreshToken,
        this.opts.fetcher ?? fetch,
      );
    } catch (err) {
      if (err instanceof MicrosoftInvalidGrantError) {
        return {
          ok: false,
          kind: "invalid_grant",
          detail: err.message,
        };
      }
      return classifyAsyncError(err);
    }

    const expiresAt = Date.now() + token.expires_in * 1000;

    // Pull canonical identity fields from id_token claims when present.
    // **Critical** — Microsoft's v2 endpoint may omit `id_token` on
    // refresh responses (e.g. under certain scope-narrowing flows, or
    // if Microsoft changes the response shape). When id_token is
    // absent or malformed, fall through to `req.priorCredentials` to
    // preserve the canonical values written at account-add time. The
    // broker writes `rawCredentials` verbatim — if we returned empty
    // placeholders the operator's real tenantId/homeAccountId/
    // accountType would be clobbered. Earlier draft of this provider
    // had that defect; PR 1 review caught it.
    const prior = (req.priorCredentials as MicrosoftCredentialsShape | undefined)
      ?.microsoftOauth;
    let tenantId = prior?.tenantId ?? "";
    let accountType: "personal" | "work" = prior?.accountType ?? "work";
    let homeAccountId = prior?.homeAccountId ?? "";
    let accountEmail = req.accountEmail ?? prior?.accountEmail ?? "";
    if (token.id_token) {
      const claims = decodeJwtPayloadUnsafe(token.id_token);
      if (claims) {
        if (typeof claims.tid === "string") tenantId = claims.tid;
        if (tenantId) accountType = classifyAccountType(tenantId);
        if (typeof claims.oid === "string" && typeof claims.tid === "string") {
          homeAccountId = `${claims.oid}.${claims.tid}`;
        }
        if (typeof claims.preferred_username === "string") {
          accountEmail = claims.preferred_username;
        } else if (typeof claims.email === "string") {
          accountEmail = claims.email;
        }
      }
    }

    const rawCredentials: MicrosoftCredentialsShape = {
      microsoftOauth: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? req.refreshToken,
        expiresAt,
        scope: token.scope ?? "",
        clientId: this.opts.clientId,
        accountEmail,
        tokenType: "Bearer",
        tenantId,
        accountType,
        homeAccountId,
      },
    };

    return {
      ok: true,
      accessToken: token.access_token,
      expiresAt,
      newRefreshToken: token.refresh_token,
      rawCredentials,
    };
  }

  /**
   * Extract expiry from Microsoft credentials. Returns undefined for
   * malformed / missing — broker treats undefined as "needs immediate
   * refresh."
   */
  extractExpiresAt(credentials: unknown): number | undefined {
    const c = credentials as MicrosoftCredentialsShape | null | undefined;
    return c?.microsoftOauth?.expiresAt;
  }

  /**
   * Validate the on-disk shape Microsoft credentials must conform to.
   * Returns null on success; an actionable error string on failure.
   *
   * Mirrors MicrosoftCredentialsSchema in protocol.ts but with
   * actionable messages — at this layer we know we're validating an
   * operator-or-OAuth-flow input.
   */
  validateCredentialShape(credentials: unknown): string | null {
    if (!credentials || typeof credentials !== "object") {
      return "Microsoft credentials must be an object";
    }
    const c = credentials as { microsoftOauth?: unknown };
    if (!c.microsoftOauth || typeof c.microsoftOauth !== "object") {
      return "Microsoft credentials must have a microsoftOauth object";
    }
    const oauth = c.microsoftOauth as Record<string, unknown>;
    const required = [
      "accessToken",
      "refreshToken",
      "expiresAt",
      "scope",
      "clientId",
      "accountEmail",
      "tenantId",
      "accountType",
      "homeAccountId",
    ];
    for (const field of required) {
      if (oauth[field] === undefined || oauth[field] === null) {
        return `Microsoft microsoftOauth.${field} is required`;
      }
    }
    if (typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      return "Microsoft microsoftOauth.accessToken must be a non-empty string";
    }
    if (typeof oauth.refreshToken !== "string" || oauth.refreshToken.length === 0) {
      return "Microsoft microsoftOauth.refreshToken must be a non-empty string";
    }
    if (typeof oauth.expiresAt !== "number" || oauth.expiresAt <= 0) {
      return "Microsoft microsoftOauth.expiresAt must be a positive unix-ms timestamp";
    }
    if (oauth.tokenType !== "Bearer") {
      return "Microsoft microsoftOauth.tokenType must be 'Bearer'";
    }
    if (oauth.accountType !== "personal" && oauth.accountType !== "work") {
      return "Microsoft microsoftOauth.accountType must be 'personal' or 'work'";
    }
    return null;
  }
}

/**
 * Map non-InvalidGrant errors from Microsoft's OAuth endpoint to the
 * broker's RefreshErrorKind discriminant.
 *
 * Microsoft error patterns:
 *   - 429 / "too many requests" / "AADSTS50196" (throttled) → quota_exceeded
 *   - ETIMEDOUT / ECONNRESET / fetch failed → network
 *   - everything else → provider_error
 */
function classifyAsyncError(err: unknown): RefreshResult {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("getaddrinfo")
  ) {
    return { ok: false, kind: "network", detail: msg };
  }
  if (
    lower.includes("429") ||
    lower.includes("rate") ||
    lower.includes("quota") ||
    lower.includes("too many requests") ||
    lower.includes("aadsts50196")
  ) {
    return { ok: false, kind: "quota_exceeded", detail: msg };
  }
  return { ok: false, kind: "provider_error", detail: msg };
}
