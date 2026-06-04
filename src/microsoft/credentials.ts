/**
 * Build the broker on-disk credentials shape from a Microsoft token
 * response (RFC #1873).
 *
 * Extracted from `src/cli/auth-microsoft.ts` so the Telegram-native
 * device-code connect flow (which has no CLI / no console) can reuse it.
 * This core is **side-effect free** — it returns the resolved identity
 * (email/tenant/type) so the caller decides how to surface a
 * requested-vs-authenticated email mismatch (the CLI prints a warning;
 * the gateway shows it on the connect card; the device-code flow has no
 * requested email at all and simply adopts the authenticated one).
 *
 * Identity fields (tenantId / accountType / homeAccountId / email) come
 * from the `id_token` claims when present — the same logic the broker's
 * MicrosoftProvider uses on refresh. When `id_token` is absent we fall
 * back to the caller-supplied `accountEmail` and leave the discriminators
 * empty (the next refresh that returns an id_token will populate them).
 */

import {
  buildHomeAccountId,
  classifyAccountType,
  decodeJwtPayloadUnsafe,
  type MicrosoftTokenResponse,
} from "./oauth.js";
import type { MicrosoftCredentialsShape } from "../auth/broker/protocol.js";

export interface BuiltMicrosoftCredentials {
  credentials: MicrosoftCredentialsShape;
  /** The email the broker should index this account by (from id_token
   *  when available, else the caller-supplied `accountEmail`). */
  resolvedEmail: string;
  /** True when an id_token was present and named a different email than
   *  the caller requested — the caller decides whether to warn. */
  emailMismatch: boolean;
}

export function buildMicrosoftCredentials(opts: {
  tokens: MicrosoftTokenResponse;
  clientId: string;
  /** Email the caller requested (CLI arg). Empty string is fine for the
   *  device-code flow, which learns the email from the token. */
  accountEmail: string;
  /** Granted-scope fallback when the token response omits `scope`. */
  fallbackScope: string;
  now?: () => number;
}): BuiltMicrosoftCredentials {
  const { tokens, clientId, accountEmail, fallbackScope } = opts;
  const now = opts.now ?? Date.now;

  let tenantId = "";
  let accountType: "personal" | "work" = "work";
  let homeAccountId = "";
  let resolvedEmail = accountEmail;

  if (tokens.id_token) {
    const claims = decodeJwtPayloadUnsafe(tokens.id_token);
    if (claims) {
      if (typeof claims.tid === "string") tenantId = claims.tid;
      if (tenantId) accountType = classifyAccountType(tenantId);
      const home = buildHomeAccountId(claims);
      if (home) homeAccountId = home;
      if (typeof claims.preferred_username === "string") {
        resolvedEmail = claims.preferred_username.toLowerCase();
      } else if (typeof claims.email === "string") {
        resolvedEmail = claims.email.toLowerCase();
      }
    }
  }

  const emailMismatch =
    accountEmail.length > 0 &&
    resolvedEmail.toLowerCase() !== accountEmail.toLowerCase();

  return {
    credentials: {
      microsoftOauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        expiresAt: now() + tokens.expires_in * 1000,
        scope: tokens.scope ?? fallbackScope,
        clientId,
        accountEmail: resolvedEmail,
        tokenType: "Bearer",
        tenantId,
        accountType,
        homeAccountId,
      },
    },
    resolvedEmail,
    emailMismatch,
  };
}
