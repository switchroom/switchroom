/**
 * Single-account OAuth refresh primitive.
 *
 * Post-RFC-H, the broker is the sole refresher. The old per-agent
 * fanout (`fanoutAccountToAgents`, `enabledAgentsForAccount`,
 * `refreshAllAccounts`) lived here pre-broker; it was deleted with
 * RFC H since the broker owns the per-account refresh loop and the
 * per-agent mirror writes. What's left is the one-account-one-tick
 * function the broker imports.
 *
 * Pure side-effect function: read disk → conditionally hit Anthropic →
 * atomically rewrite the global account credentials. Safe to call
 * repeatedly. When nothing needs refreshing it's a no-op (no network,
 * no writes).
 */

import {
  patchAccountMeta,
  readAccountCredentials,
  writeAccountCredentials,
  type AccountCredentials,
} from "./account-store.js";

/**
 * Refresh threshold — refresh when the account's access token has less
 * than this remaining. 60 minutes is the broker's threshold per RFC H
 * §4.3, "strictly before" claude's own <5min refresh window.
 */
export const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

const DEFAULT_TOKEN_URL =
  process.env.SWITCHROOM_OAUTH_TOKEN_URL ??
  "https://console.anthropic.com/v1/oauth/token";

const DEFAULT_CLIENT_ID =
  process.env.SWITCHROOM_OAUTH_CLIENT_ID ??
  "9d1cd16e-bcb9-40c9-a915-196412f27aa6";

interface AnthropicRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  /** seconds */
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/** Outcome of a single account's refresh attempt. */
export type AccountRefreshOutcome =
  | { kind: "skipped-no-credentials"; account: string }
  | { kind: "skipped-malformed"; account: string; reason: string }
  | { kind: "skipped-fresh"; account: string; expiresAt: number; remainingMs: number }
  | { kind: "skipped-no-refresh-token"; account: string; expiresAt?: number }
  | { kind: "refreshed"; account: string; oldExpiresAt?: number; newExpiresAt: number }
  | { kind: "failed"; account: string; httpStatus?: number; error: string };

/** Hook for unit tests to swap the HTTP layer. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export interface AccountRefreshOptions {
  /** Threshold below which we refresh. Default REFRESH_THRESHOLD_MS. */
  thresholdMs?: number;
  now?: () => number;
  tokenUrl?: string;
  clientId?: string;
  fetcher?: Fetcher;
  /** Override homedir() for tests. */
  home?: string;
}

/**
 * If the account's access token is expiring soon AND a refreshToken is
 * present, exchange it via Anthropic OAuth and atomically persist the
 * new credentials. Returns a structured outcome — never throws on the
 * network failure path.
 */
export async function refreshAccountIfNeeded(
  label: string,
  opts: AccountRefreshOptions = {},
): Promise<AccountRefreshOutcome> {
  const thresholdMs = opts.thresholdMs ?? REFRESH_THRESHOLD_MS;
  const now = opts.now ?? Date.now;
  const tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const home = opts.home;

  const creds = readAccountCredentials(label, home);
  if (!creds) {
    return { kind: "skipped-no-credentials", account: label };
  }
  const oauth = creds.claudeAiOauth;
  if (
    !oauth ||
    typeof oauth.accessToken !== "string" ||
    oauth.accessToken.length === 0
  ) {
    return {
      kind: "skipped-malformed",
      account: label,
      reason: "credentials present but missing claudeAiOauth.accessToken",
    };
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return {
      kind: "skipped-malformed",
      account: label,
      reason: "credentials have invalid expiresAt",
    };
  }

  const remainingMs = expiresAt - now();
  if (remainingMs > thresholdMs) {
    return { kind: "skipped-fresh", account: label, expiresAt, remainingMs };
  }

  if (!oauth.refreshToken || oauth.refreshToken.length === 0) {
    return { kind: "skipped-no-refresh-token", account: label, expiresAt };
  }

  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: clientId,
  });

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await fetcher(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
  } catch (err) {
    return {
      kind: "failed",
      account: label,
      error: `network error: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return {
      kind: "failed",
      account: label,
      httpStatus: res.status,
      error: `HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
    };
  }

  let parsed: AnthropicRefreshResponse;
  try {
    parsed = JSON.parse(await res.text()) as AnthropicRefreshResponse;
  } catch (err) {
    return {
      kind: "failed",
      account: label,
      httpStatus: res.status,
      error: `unparseable response: ${(err as Error).message}`,
    };
  }

  const newAccessToken = parsed.access_token;
  if (typeof newAccessToken !== "string" || newAccessToken.length === 0) {
    return {
      kind: "failed",
      account: label,
      httpStatus: res.status,
      error: "refresh response missing access_token",
    };
  }

  const newExpiresAt =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
      ? now() + parsed.expires_in * 1000
      : now() + 8 * 60 * 60 * 1000; // sensible default
  const newRefreshToken =
    typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : oauth.refreshToken; // some providers don't rotate

  const updated: AccountCredentials = {
    ...creds,
    claudeAiOauth: {
      ...oauth,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
    },
  };
  try {
    writeAccountCredentials(label, updated, home);
  } catch (err) {
    return {
      kind: "failed",
      account: label,
      error: `failed to write credentials.json: ${(err as Error).message}`,
    };
  }
  patchAccountMeta(label, { lastRefreshedAt: now() }, home);

  return {
    kind: "refreshed",
    account: label,
    oldExpiresAt: expiresAt,
    newExpiresAt,
  };
}
