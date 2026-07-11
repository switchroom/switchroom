/**
 * Google Drive OAuth flow — three-tier auto-selection (RFC C §3).
 *
 * Generic tier ladder (in order):
 *   1. RFC 8628 device-code (works over SSH, no port binding).
 *   2. OOB-paste.
 *   3. Desktop loopback (needs a reachable browser / SSH port-forward).
 *
 * **Drive-scope reality (load-bearing — verified empirically):** for the
 * Drive scopes switchroom requests, tiers 1 and 2 are dead ends — Google
 * returns `invalid_scope` for Drive on the device-code endpoint, and the
 * OOB redirect (`urn:ietf:wg:oauth:2.0:oob`) was retired by Google in
 * 2022 (HTTP 400 `invalid_request`). The generic ladder does NOT
 * self-recover on a headless host: #1352 keeps device-code's rejection
 * from crashing, but the next tier (OOB) then blocks on an
 * un-answerable paste prompt and `nextTier()` returns `null` before
 * loopback — so an unguided headless Drive `account add` aborts without
 * ever trying loopback. The only Drive-viable flow is
 * **desktop-loopback with a Desktop OAuth client**. Therefore
 * `account add` defaults its initial tier to `desktop_loopback` for
 * Drive (see `src/cli/auth-google.ts`; operator-overridable via
 * `SWITCHROOM_DRIVE_OAUTH_TIER`), and `selectInitialTier` honours that
 * override ahead of its headless-avoidance — so loopback is selected
 * even headless, and the operator completes the one browser step over
 * an SSH port-forward to the printed `127.0.0.1:<port>`. The generic
 * ladder stays accurate for any future non-Drive scope set.
 *
 * Auto-detect headlessness from env: if `$DISPLAY` and `$WAYLAND_DISPLAY` are
 * both empty AND we are inside an SSH session (`$SSH_CONNECTION` present),
 * the host is headless and we MUST avoid the loopback path.
 *
 * Pure functions where possible. Network I/O lives in the `*Exchange` helpers
 * so unit tests can drive the selector and the polling logic without hitting
 * Google.
 */

export type OAuthTier = "device_code" | "oob_paste" | "desktop_loopback";

export interface OAuthEnv {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  SSH_CONNECTION?: string;
  SSH_TTY?: string;
  /** Test override: force a tier regardless of env. */
  SWITCHROOM_DRIVE_OAUTH_TIER?: string;
}

/**
 * Decide whether the host is headless. A host is "headless" when there is no
 * graphical display server AND we are inside an SSH login.
 */
export function detectHeadless(env: OAuthEnv): boolean {
  const hasDisplay = Boolean(
    (env.DISPLAY && env.DISPLAY.trim() !== "") ||
    (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim() !== ""),
  );
  const inSsh = Boolean(
    (env.SSH_CONNECTION && env.SSH_CONNECTION.trim() !== "") ||
    (env.SSH_TTY && env.SSH_TTY.trim() !== ""),
  );
  // "Local desktop" = DISPLAY/WAYLAND set AND not over SSH (X-forwarding
  // can set DISPLAY remotely, in which case we still can't reliably pop a
  // browser on the user's screen). Anything else is headless.
  if (hasDisplay && !inSsh) return false;
  return true;
}

/**
 * Pick the preferred OAuth tier given the host environment.
 *
 * The selector is conservative: it returns the tier we'll TRY FIRST.
 * Runtime fall-through (device-code rejected by Google for the configured
 * scopes → OOB-paste) is the caller's responsibility.
 */
export function selectInitialTier(env: OAuthEnv): OAuthTier {
  const override = env.SWITCHROOM_DRIVE_OAUTH_TIER;
  if (override === "device_code" || override === "oob_paste" || override === "desktop_loopback") {
    return override;
  }

  if (detectHeadless(env)) {
    // Headless: device-code first, OOB on rejection.
    return "device_code";
  }

  // Has a display AND a browser-opener on PATH → loopback gives the cleanest
  // UX (no copy-paste, no code transcription). Otherwise fall back to
  // device-code which works without a port bind.
  if (hasBrowserOpener(env)) {
    return "desktop_loopback";
  }
  return "device_code";
}

/**
 * Detect whether a browser-opener is available on the host. We check PATH
 * for `xdg-open` / `open` / `start` based on platform. Tests can short-circuit
 * by setting `SWITCHROOM_DRIVE_HAS_BROWSER_OPENER=1` or `=0`.
 */
export function hasBrowserOpener(
  env: OAuthEnv & { SWITCHROOM_DRIVE_HAS_BROWSER_OPENER?: string; PATH?: string } = {},
  platform: NodeJS.Platform = process.platform,
): boolean {
  const override = env.SWITCHROOM_DRIVE_HAS_BROWSER_OPENER;
  if (override === "1") return true;
  if (override === "0") return false;

  if ((platform as string) === "win32") return true; // `start` is a cmd.exe builtin
  const candidate = platform === "darwin" ? "open" : "xdg-open";

  // Check PATH directories synchronously. We avoid require('fs') at top level
  // to keep the module browser-friendly; use dynamic import-like access.
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
        /* not here, keep scanning */
      }
    }
  } catch {
    /* fall through */
  }
  return false;
}

/**
 * Compute the fall-through tier given the current tier failed.
 * Returns null when there are no more tiers to try.
 */
export function nextTier(current: OAuthTier, env: OAuthEnv): OAuthTier | null {
  if (current === "device_code") {
    // Device-code failed (e.g. Google rejected it for Drive scopes) →
    // OOB-paste works universally over SSH.
    return "oob_paste";
  }
  if (current === "oob_paste") {
    // OOB-paste failed → only loopback remains, and only if we have a
    // browser. On a truly headless host, return null.
    if (detectHeadless(env)) return null;
    return "desktop_loopback";
  }
  return null;
}

// ─── Network shapes (Google's RFC 8628 + token endpoint) ─────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  scopes: string[];
}

/**
 * RFC 8628 §3.1: device-authorization request.
 * Hits https://oauth2.googleapis.com/device/code with form-urlencoded body.
 * Throws OAuthTierRejected when Google refuses the scope set.
 */
export async function requestDeviceCode(
  cfg: OAuthClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    scope: cfg.scopes.join(" "),
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    // Tier-rejection signals — all mean "this client/scope combo can't
    // do device-code; fall through to the next tier" rather than a hard
    // crash:
    //   - 400 / 403 (invalid_scope / disabled_client): device-code not
    //     whitelisted for the requested scopes.
    //   - 401 invalid_client ("Invalid client type."): the OAuth client
    //     is a Desktop/Web type, not "TVs and Limited Input devices".
    //     Common operator mistake (setup docs historically said
    //     "Desktop app"). Falling through reaches oob_paste, which
    //     works with any client type — so degrade gracefully instead
    //     of dumping a raw stack.
    if (
      res.status === 400 ||
      res.status === 403 ||
      (res.status === 401 && /invalid_client/.test(text))
    ) {
      throw new OAuthTierRejected(
        `device_code rejected (${res.status}): ${text}`,
      );
    }
    throw new Error(`device_code request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Poll the token endpoint until the user completes consent or we time out.
 * Implements RFC 8628 §3.5 polling semantics: respect `interval`, back off on
 * `slow_down`, terminate on `access_denied` / `expired_token`.
 */
export async function pollDeviceToken(
  cfg: OAuthClientConfig,
  device: DeviceCodeResponse,
  opts: {
    fetchImpl?: typeof fetch;
    sleepMs?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepMs = opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  let interval = device.interval > 0 ? device.interval : 5;
  const deadline = now() + device.expires_in * 1000;

  while (now() < deadline) {
    await sleepMs(interval * 1000);
    const body = new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof json.access_token === "string") {
      return json as unknown as TokenResponse;
    }
    const err = json.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "access_denied") {
      throw new Error("User denied the consent request.");
    }
    if (err === "expired_token") {
      throw new Error("Device code expired before consent.");
    }
    throw new Error(`Token poll failed: ${JSON.stringify(json)}`);
  }
  throw new Error("Device-code consent timed out.");
}

/**
 * Build the OOB consent URL the user opens in any browser; they paste back the
 * code Google shows them. Universal fallback when device-code is rejected.
 */
export function buildOobAuthUrl(cfg: OAuthClientConfig): string {
  const u = new URL("https://accounts.google.com/o/oauth2/auth");
  u.searchParams.set("client_id", cfg.client_id);
  u.searchParams.set("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Exchange a pasted OOB auth code for tokens. */
export async function exchangeOobCode(
  cfg: OAuthClientConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  // OOB is a paste flow with no loopback interception surface, so it
  // carries no PKCE verifier (pass `undefined`).
  return exchangeAuthCode(cfg, code, "urn:ietf:wg:oauth:2.0:oob", undefined, fetchImpl);
}

/**
 * Shared authorization_code → token exchange. Used by both OOB-paste and
 * desktop-loopback flows; only the redirect_uri differs.
 *
 * `codeVerifier` is the PKCE verifier (sec F1). The desktop-loopback flow
 * passes it so Google can bind the exchange to the `code_challenge` it saw
 * on the auth URL; the OOB flow passes `undefined` (no PKCE). When set, it
 * is sent as `code_verifier` on the token request.
 */
export async function exchangeAuthCode(
  cfg: OAuthClientConfig,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (codeVerifier !== undefined && codeVerifier.length > 0) {
    body.set("code_verifier", codeVerifier);
  }
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

// ─── Desktop-loopback flow (RFC C §3 tier 3) ────────────────────────────────

import * as http from "node:http";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Generate a PKCE code verifier + S256 challenge pair for the OAuth code
 * flow. RFC 7636: verifier is 43-128 chars unreserved set
 * (`[A-Z][a-z][0-9]-._~`); challenge is base64url(SHA-256(verifier)).
 *
 * Mirrors `src/microsoft/oauth.ts:generatePkcePair` exactly — the two
 * OAuth modules keep the same PKCE primitive rather than cross-importing
 * (avoids a drive↔microsoft dep). Used by the desktop-loopback flow to
 * close the Google-vs-Microsoft asymmetry (sec F1): the loopback redirect
 * lands on `127.0.0.1`, so an authorization code intercepted on the
 * loopback interface (a co-resident local process racing the callback)
 * is useless without the verifier held only in this process's memory.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/**
 * Build the loopback consent URL targeting an ephemeral local redirect_uri,
 * carrying the PKCE `code_challenge` (S256).
 */
export function buildLoopbackAuthUrl(
  cfg: OAuthClientConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const u = new URL("https://accounts.google.com/o/oauth2/auth");
  u.searchParams.set("client_id", cfg.client_id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/**
 * Best-effort browser open. Returns true if we successfully spawned an opener
 * that exited 0; false otherwise. Caller should print the URL as a fallback.
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

export interface LoopbackOptions {
  /** Timeout in ms before we abort waiting for the callback. Default 5min. */
  timeoutMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override browser-opener (for tests; return false to skip opening). */
  openImpl?: (url: string) => Promise<boolean>;
  /** Called once we know the auth URL — e.g. to print it for the user. */
  onAuthUrl?: (url: string, opened: boolean) => void;
  /** Bind host. Default 127.0.0.1. */
  host?: string;
}

/**
 * Run the desktop-loopback OAuth flow:
 *   1. Bind 127.0.0.1:0
 *   2. Open Google consent URL in the user's browser (or print the URL)
 *   3. Wait for Google to redirect back with ?code=...&state=...
 *   4. Validate state, exchange the code at the token endpoint
 *
 * Always closes the ephemeral server before returning, success or fail.
 */
export async function runLoopbackOAuth(
  cfg: OAuthClientConfig,
  opts: LoopbackOptions = {},
): Promise<TokenResponse> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const host = opts.host ?? "127.0.0.1";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const openImpl = opts.openImpl ?? openBrowser;
  const state = crypto.randomBytes(16).toString("hex");
  // PKCE (sec F1): bind the loopback code exchange to a per-flow verifier so
  // an intercepted authorization code on 127.0.0.1 can't be redeemed without
  // the verifier held only in this process's memory.
  const { verifier, challenge } = generatePkcePair();

  // Capture the callback via a single-shot promise.
  let server: http.Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = null;
      s.close(() => resolve());
      // unref so we don't hang the process if a stray connection lingers
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

          if (gotErr) {
            renderHtml(
              res,
              400,
              "Authorization failed",
              `Google returned an error: ${escapeHtml(gotErr)}. You can close this tab.`,
            );
            reject(new Error(`OAuth error from Google: ${gotErr}`));
            return;
          }
          if (!gotState || gotState !== state) {
            renderHtml(
              res,
              400,
              "Authorization failed",
              "State parameter mismatch — refusing this callback. You can close this tab.",
            );
            reject(new Error("OAuth state parameter mismatch (possible CSRF)."));
            return;
          }
          if (!gotCode) {
            renderHtml(
              res,
              400,
              "Authorization failed",
              "No authorization code present. You can close this tab.",
            );
            reject(new Error("OAuth callback missing 'code' parameter."));
            return;
          }
          renderHtml(
            res,
            200,
            "Authorization complete",
            "Authorization complete. You can close this tab and return to the terminal.",
          );
          // We don't know the actual redirectUri until after listen(); resolve
          // with a placeholder and let the outer scope fill it in. Instead,
          // capture from the Host header to be safe.
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
        // Fire-and-forget the browser open; if it fails the user has the URL.
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:4em auto;padding:0 1em;color:#222}h1{font-size:1.25em}</style></head><body><h1>${escapeHtml(
    title,
  )}</h1><p>${body}</p></body></html>`;
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

/**
 * Refresh an access token using the durable refresh token.
 * Throws InvalidGrantError when Google has rotated/revoked the refresh token
 * — caller (drive wrapper) catches and updates the sidecar status slot.
 */
export class InvalidGrantError extends Error {
  constructor(public detail: string) {
    super(`invalid_grant: ${detail}`);
    this.name = "InvalidGrantError";
  }
}

export class OAuthTierRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthTierRejected";
  }
}

export async function refreshAccessToken(
  cfg: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    if (typeof json.error === "string" && json.error === "invalid_grant") {
      throw new InvalidGrantError(
        typeof json.error_description === "string"
          ? json.error_description
          : "refresh token rejected by Google",
      );
    }
    throw new Error(`refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json as unknown as TokenResponse;
}

/**
 * Best-effort revoke. Google's revoke endpoint returns 200 on success and
 * 400 ({error: invalid_token}) when the token is already invalid. We treat
 * both as "the local view is now consistent with Google's view."
 */
export async function revokeRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  try {
    const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    if (res.ok) return { ok: true };
    if (res.status === 400) {
      // already invalidated — treat as success for our purposes
      return { ok: true };
    }
    const text = await res.text();
    return { ok: false, status: res.status, detail: text };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
