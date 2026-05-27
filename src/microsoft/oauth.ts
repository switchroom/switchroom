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
import * as http from "node:http";
import { spawn } from "node:child_process";

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

// ────────────────────────────────────────────────────────────────────────
// Tier selection — mirrors src/drive/oauth.ts shape
// ────────────────────────────────────────────────────────────────────────

export type MicrosoftOAuthTier = "device_code" | "desktop_loopback";

export interface MicrosoftOAuthEnv {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  SSH_CONNECTION?: string;
  SSH_TTY?: string;
  /** Test/operator override: force a tier regardless of env. */
  SWITCHROOM_MICROSOFT_OAUTH_TIER?: string;
}

/**
 * Decide whether the host is headless. Same heuristic as drive/oauth.ts:
 * no graphical display server AND inside an SSH session.
 */
export function detectHeadless(env: MicrosoftOAuthEnv): boolean {
  const hasDisplay = Boolean(
    (env.DISPLAY && env.DISPLAY.trim() !== "") ||
    (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim() !== ""),
  );
  const inSsh = Boolean(
    (env.SSH_CONNECTION && env.SSH_CONNECTION.trim() !== "") ||
    (env.SSH_TTY && env.SSH_TTY.trim() !== ""),
  );
  if (hasDisplay && !inSsh) return false;
  return true;
}

/**
 * Pick the preferred OAuth tier. Unlike Google (which has 3 tiers
 * because device-code fails for Drive scopes), Microsoft's device-code
 * works fine for the v1 scope set on personal MSA + work — so we have
 * a clean two-tier ladder. Headless hosts default to device-code;
 * desktops with a browser default to loopback.
 */
export function selectInitialTier(env: MicrosoftOAuthEnv): MicrosoftOAuthTier {
  const override = env.SWITCHROOM_MICROSOFT_OAUTH_TIER;
  if (override === "device_code" || override === "desktop_loopback") {
    return override;
  }
  if (detectHeadless(env)) return "device_code";
  if (hasBrowserOpener(env)) return "desktop_loopback";
  return "device_code";
}

/**
 * Detect whether a browser-opener is available on the host. Tests can
 * short-circuit by setting `SWITCHROOM_MICROSOFT_HAS_BROWSER_OPENER`.
 */
export function hasBrowserOpener(
  env: MicrosoftOAuthEnv & {
    SWITCHROOM_MICROSOFT_HAS_BROWSER_OPENER?: string;
    PATH?: string;
  } = {},
  platform: NodeJS.Platform = process.platform,
): boolean {
  const override = env.SWITCHROOM_MICROSOFT_HAS_BROWSER_OPENER;
  if (override === "1") return true;
  if (override === "0") return false;

  if ((platform as string) === "win32") return true;
  const candidate = platform === "darwin" ? "open" : "xdg-open";

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const pathEnv = env.PATH ?? process.env.PATH ?? "";
    const sep = (platform as string) === "win32" ? ";" : ":";
    for (const dir of pathEnv.split(sep)) {
      if (!dir) continue;
      try {
        const full = path.join(dir, candidate);
        fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  } catch {
    /* fall through */
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────
// Auth-code exchange (PKCE) — used by loopback flow
// ────────────────────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for tokens. Includes PKCE
 * `code_verifier`. Used by the loopback flow after the browser callback.
 */
export async function exchangeAuthCode(
  cfg: MicrosoftOAuthClientConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftTokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (cfg.client_secret !== undefined && cfg.client_secret.length > 0) {
    body.set("client_secret", cfg.client_secret);
  }
  if (cfg.scopes && cfg.scopes.length > 0) {
    body.set("scope", cfg.scopes.join(" "));
  }
  const res = await fetchImpl(`${MICROSOFT_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

/**
 * Build the loopback consent URL targeting an ephemeral local
 * redirect_uri with PKCE `code_challenge`.
 *
 * Microsoft's v2 `/authorize` endpoint. `prompt=select_account`
 * always shows the account picker (better for multi-account users).
 */
export function buildLoopbackAuthUrl(
  cfg: MicrosoftOAuthClientConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const u = new URL(`${MICROSOFT_OAUTH_BASE}/authorize`);
  u.searchParams.set("client_id", cfg.client_id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/**
 * Best-effort browser open. Returns true on successful spawn.
 */
export async function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): Promise<boolean> {
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if ((platform as string) === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  return new Promise<boolean>((resolve) => {
    try {
      const p = spawnImpl(cmd, args, { stdio: "ignore", detached: true });
      p.once("error", () => resolve(false));
      p.once("spawn", () => {
        try {
          p.unref();
        } catch {
          /* noop */
        }
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export interface MicrosoftLoopbackOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  openImpl?: (url: string) => Promise<boolean>;
  onAuthUrl?: (url: string, opened: boolean) => void;
  host?: string;
}

/**
 * Run the desktop-loopback OAuth flow against Microsoft v2:
 *   1. Generate PKCE pair + CSRF state
 *   2. Bind 127.0.0.1:0
 *   3. Open Microsoft consent URL (or print it)
 *   4. Wait for Microsoft to redirect back with ?code=...&state=...
 *   5. Validate state, exchange code at /token with code_verifier
 *
 * Always closes the ephemeral server before returning.
 */
export async function runLoopbackOAuth(
  cfg: MicrosoftOAuthClientConfig,
  opts: MicrosoftLoopbackOptions = {},
): Promise<MicrosoftTokenResponse> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const host = opts.host ?? "127.0.0.1";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const openImpl = opts.openImpl ?? openBrowser;
  const state = crypto.randomBytes(16).toString("hex");
  const { verifier, challenge } = generatePkcePair();

  let server: http.Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = null;
      s.close(() => resolve());
      try {
        s.unref();
      } catch {
        /* noop */
      }
    });

  try {
    const { code, redirectUri } = await new Promise<{
      code: string;
      redirectUri: string;
    }>((resolve, reject) => {
      server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "/", `http://${host}`);
          if (url.pathname !== "/") {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not found");
            return;
          }
          const gotState = url.searchParams.get("state");
          const gotCode = url.searchParams.get("code");
          const gotErr = url.searchParams.get("error");
          const gotErrDesc = url.searchParams.get("error_description");

          if (gotErr) {
            renderHtml(
              res,
              400,
              "Authorization failed",
              `Microsoft returned: ${escapeHtml(gotErr)}. ${escapeHtml(gotErrDesc ?? "")} You can close this tab.`,
            );
            reject(new Error(`OAuth error from Microsoft: ${gotErr} ${gotErrDesc ?? ""}`));
            return;
          }
          if (!gotState || gotState !== state) {
            renderHtml(res, 400, "Authorization failed", "State parameter mismatch — refusing this callback. You can close this tab.");
            reject(new Error("OAuth state parameter mismatch (possible CSRF)."));
            return;
          }
          if (!gotCode) {
            renderHtml(res, 400, "Authorization failed", "No authorization code present. You can close this tab.");
            reject(new Error("OAuth callback missing 'code' parameter."));
            return;
          }
          renderHtml(res, 200, "Microsoft authorization complete", "You can close this tab and return to the terminal.");
          const hostHeader = req.headers.host ?? `${host}:?`;
          resolve({
            code: gotCode,
            redirectUri: `http://${hostHeader}`,
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      server.on("error", (e) => reject(e));

      server.listen(0, host, () => {
        const addr = server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to determine ephemeral port for loopback OAuth."));
          return;
        }
        const redirectUri = `http://${host}:${addr.port}`;
        const authUrl = buildLoopbackAuthUrl(cfg, redirectUri, state, challenge);
        openImpl(authUrl)
          .then((opened) => opts.onAuthUrl?.(authUrl, opened))
          .catch(() => opts.onAuthUrl?.(authUrl, false));
      });

      timer = setTimeout(() => {
        reject(
          new Error(
            `Loopback OAuth timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser callback.`,
          ),
        );
      }, timeoutMs);
    });

    if (timer) clearTimeout(timer);
    await closeServer();
    return await exchangeAuthCode(cfg, code, redirectUri, verifier, fetchImpl);
  } finally {
    if (timer) clearTimeout(timer);
    await closeServer();
  }
}

function renderHtml(
  res: http.ServerResponse,
  status: number,
  title: string,
  body: string,
): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:4em auto;padding:0 1em;color:#222}h1{font-size:1.25em}</style></head><body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ────────────────────────────────────────────────────────────────────────
// Device-code flow (RFC 8628) — Microsoft v2
// ────────────────────────────────────────────────────────────────────────

export interface MicrosoftDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Some Microsoft responses include this; not in RFC 8628. Optional. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  message?: string;
}

/**
 * RFC 8628 device-authorization request against Microsoft v2 `/devicecode`.
 * Note: Microsoft's older docs (since corrected in MSAL.NET 4.5+ release
 * notes) claimed device-code didn't work on /common — it does. See RFC
 * §4.2 "stale-doc trap".
 */
export async function requestDeviceCode(
  cfg: MicrosoftOAuthClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftDeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    scope: cfg.scopes.join(" "),
  });
  const res = await fetchImpl(
    `https://login.microsoftonline.com/common/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`device_code request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as MicrosoftDeviceCodeResponse;
}

/**
 * Poll the token endpoint until the user completes consent or we time out.
 * Implements RFC 8628 §3.5: respect `interval`, back off on `slow_down`,
 * terminate on `authorization_declined` / `expired_token`.
 */
export async function pollDeviceToken(
  cfg: MicrosoftOAuthClientConfig,
  device: MicrosoftDeviceCodeResponse,
  opts: {
    fetchImpl?: typeof fetch;
    sleepMs?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<MicrosoftTokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepMs = opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  let interval = device.interval > 0 ? device.interval : 5;
  const deadline = now() + device.expires_in * 1000;

  while (now() < deadline) {
    await sleepMs(interval * 1000);
    const body = new URLSearchParams({
      client_id: cfg.client_id,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (cfg.client_secret !== undefined && cfg.client_secret.length > 0) {
      body.set("client_secret", cfg.client_secret);
    }
    const res = await fetchImpl(`${MICROSOFT_OAUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof json.access_token === "string") {
      return json as unknown as MicrosoftTokenResponse;
    }
    const err = json.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "authorization_declined" || err === "access_denied") {
      throw new Error("User denied the consent request.");
    }
    if (err === "expired_token" || err === "code_expired") {
      throw new Error("Device code expired before consent.");
    }
    throw new Error(`Token poll failed: ${JSON.stringify(json)}`);
  }
  throw new Error("Device-code consent timed out.");
}
