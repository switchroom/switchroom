/**
 * Linear OAuth app-token refresh — pure logic (#2298 follow-up).
 *
 * Linear's `actor=app` token exchange returns a SHORT-LIVED access token
 * (`expires_in ≈ 24h`) plus a `refresh_token`. The original
 * `linear-agent setup` stored only the access token, so app actors went
 * dead every day and needed a manual browser re-auth. This module is the
 * durable fix's core: exchange the refresh token for a fresh access token
 * (and possibly-rotated refresh token) so an agent stays a first-class
 * Linear app actor without operator hand-holding.
 *
 * Pure + injectable (`fetchImpl`, `nowSec`) so it is unit-testable without
 * the network or a clock. The refresh BUNDLE — `{client_id, client_secret,
 * refresh_token, expires_at}` — is stored in the vault under
 * `linear/<agent>/oauth` (a JSON string); the access token stays at
 * `linear/<agent>/token` (what the runtime reads). Both are rotated in
 * place via the broker `put` op (the #950 in-container rotation path), so
 * neither the agent nor a scheduled refresh needs the operator passphrase.
 */

export const LINEAR_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";

/** Default proactive-refresh skew: refresh when the access token is within
 *  2h of expiry, so a near-expiry token is replaced on its next use rather
 *  than failing the call. */
export const DEFAULT_REFRESH_SKEW_SEC = 2 * 3600;

export interface LinearOAuthBundle {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Epoch SECONDS at which the current access token expires. Optional —
   *  bundles provisioned before expiry tracking won't carry it. */
  expiresAt?: number;
}

export type RefreshResult =
  | {
      ok: true;
      accessToken: string;
      /** The refresh token to persist — the rotated one if Linear returned
       *  a new one, else the same one we sent (Linear may or may not
       *  rotate). */
      refreshToken: string;
      /** Epoch seconds the new access token expires. */
      expiresAt: number;
      scope?: string;
    }
  | {
      ok: false;
      /** `revoked` = the refresh token itself is dead (operator must
       *  re-authorize in a browser); everything else is transient/retryable. */
      reason: "revoked" | "network" | "http_error" | "bad_response";
      detail: string;
    };

/**
 * Exchange a refresh token for a fresh access token at Linear's token
 * endpoint. Never throws — returns a tagged result. NEVER logs the token
 * values (the caller controls logging; this returns data, not side effects).
 */
export async function refreshLinearAppToken(
  bundle: Pick<LinearOAuthBundle, "clientId" | "clientSecret" | "refreshToken">,
  opts: { fetchImpl?: typeof fetch; nowSec?: () => number } = {},
): Promise<RefreshResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refreshToken,
    client_id: bundle.clientId,
    client_secret: bundle.clientSecret,
  });

  let resp: Response;
  try {
    resp = await fetchImpl(LINEAR_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    return { ok: false, reason: "network", detail: (err as Error).message };
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    // A dead refresh token surfaces as 400 invalid_grant — that's the one
    // case unattended refresh can't fix; the operator must re-authorize.
    const revoked = resp.status === 400 || /invalid_grant|invalid_token/i.test(txt);
    return {
      ok: false,
      reason: revoked ? "revoked" : "http_error",
      detail: `HTTP ${resp.status}${txt ? ` ${txt.slice(0, 200)}` : ""}`,
    };
  }

  let json: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  try {
    json = (await resp.json()) as typeof json;
  } catch {
    return { ok: false, reason: "bad_response", detail: "non-JSON token response" };
  }

  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, reason: "bad_response", detail: "no access_token in response" };
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 86400;
  const rotated =
    typeof json.refresh_token === "string" && json.refresh_token.length > 0
      ? json.refresh_token
      : bundle.refreshToken;

  return {
    ok: true,
    accessToken,
    refreshToken: rotated,
    expiresAt: nowSec() + expiresIn,
    ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
  };
}

/**
 * Whether a proactive refresh is due. True when the access token is at or
 * past `expiresAt - skew`. Unknown expiry (`undefined`) returns false: we
 * don't churn on bundles that predate expiry tracking — the on-401 reactive
 * path still covers them.
 */
export function needsRefresh(
  expiresAt: number | undefined,
  nowSec: number,
  skewSec: number = DEFAULT_REFRESH_SKEW_SEC,
): boolean {
  if (expiresAt == null) return false;
  return nowSec >= expiresAt - skewSec;
}

/** Parse the JSON-string bundle stored at `linear/<agent>/oauth`. Returns
 *  null on absent / malformed / incomplete (missing required field) input —
 *  callers treat null as "no refresh capability". */
export function parseBundle(raw: string | null | undefined): LinearOAuthBundle | null {
  if (raw == null || raw === "") return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    typeof o.client_id === "string" &&
    typeof o.client_secret === "string" &&
    typeof o.refresh_token === "string" &&
    o.client_id.length > 0 &&
    o.client_secret.length > 0 &&
    o.refresh_token.length > 0
  ) {
    return {
      clientId: o.client_id,
      clientSecret: o.client_secret,
      refreshToken: o.refresh_token,
      ...(typeof o.expires_at === "number" ? { expiresAt: o.expires_at } : {}),
    };
  }
  return null;
}

/** Serialize a bundle to the JSON-string vault shape. */
export function serializeBundle(b: LinearOAuthBundle): string {
  return JSON.stringify({
    client_id: b.clientId,
    client_secret: b.clientSecret,
    refresh_token: b.refreshToken,
    ...(b.expiresAt != null ? { expires_at: b.expiresAt } : {}),
  });
}

/**
 * Injectable I/O for {@link performLinearRefresh} — the same orchestration
 * the host `linear-agent refresh` verb (vault-backed) and the in-container
 * runtime auto-refresh (broker-backed) both run. Reads the bundle, exchanges
 * the refresh token, and persists the new access token + rotated bundle.
 */
export interface RefreshIO {
  /** Return the raw JSON bundle from `linear/<agent>/oauth` (or null). */
  readBundle: () => Promise<string | null>;
  /** Persist the fresh access token to `linear/<agent>/token`. */
  writeToken: (accessToken: string) => Promise<void>;
  /** Persist the rotated bundle JSON to `linear/<agent>/oauth`. */
  writeBundle: (json: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
}

export type PerformRefreshResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | {
      ok: false;
      reason: "no_bundle" | "revoked" | "network" | "http_error" | "bad_response" | "persist_failed";
      detail: string;
    };

/**
 * Read bundle → refresh → persist token + rotated bundle. Pure orchestration
 * over injected I/O so it is identical and testable across the host (vault)
 * and runtime (broker) call sites. On any read/refresh/persist failure it
 * returns a tagged result and writes nothing further (so a failed persist
 * can't leave the access token rotated while the bundle still holds the old
 * refresh token).
 */
export async function performLinearRefresh(io: RefreshIO): Promise<PerformRefreshResult> {
  const raw = await io.readBundle();
  const bundle = parseBundle(raw);
  if (!bundle) {
    return { ok: false, reason: "no_bundle", detail: "no/invalid refresh bundle" };
  }
  const res = await refreshLinearAppToken(bundle, {
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(io.nowSec ? { nowSec: io.nowSec } : {}),
  });
  if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail };
  try {
    // Persist the rotated bundle FIRST: if the token write then fails, the
    // bundle still carries the (now-current) refresh token, so a retry can
    // recover. Persisting the token first and the bundle-write failing would
    // strand the rotated refresh token (next refresh would use the dead one).
    await io.writeBundle(
      serializeBundle({
        clientId: bundle.clientId,
        clientSecret: bundle.clientSecret,
        refreshToken: res.refreshToken,
        expiresAt: res.expiresAt,
      }),
    );
    await io.writeToken(res.accessToken);
  } catch (err) {
    return { ok: false, reason: "persist_failed", detail: (err as Error).message };
  }
  return { ok: true, accessToken: res.accessToken, expiresAt: res.expiresAt };
}
