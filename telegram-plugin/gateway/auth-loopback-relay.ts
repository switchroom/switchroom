/**
 * Telegram-native OAuth loopback relay for Google / Microsoft account add
 * (issue #2582).
 *
 * The problem: `switchroom auth google|microsoft account add <email>` mints
 * credentials via the desktop-loopback OAuth flow — the CLI binds an ephemeral
 * `127.0.0.1:<port>` listener, prints a consent URL whose `redirect_uri`
 * points at that port, and waits for the browser to redirect back with
 * `?code=...&state=...`. On a headless fleet host the redirect target isn't
 * reachable from the operator's phone, which *looks* un-relayable — but isn't.
 * The operator can open the consent URL on their phone, approve, and although
 * the redirect to `127.0.0.1:<port>` fails to load there, their address bar
 * holds the `?code=...&state=...`. Paste that back over Telegram and the
 * gateway can hand it to the still-waiting loopback listener.
 *
 * This module owns that relay end-to-end, mirroring `auth-add-flow.ts`:
 *
 *   1. Operator sends `/auth google add <email>` (or `/auth microsoft add`).
 *   2. Gateway calls {@link startLoopbackFlow} → spawns the real
 *      `switchroom auth <provider> account add` CLI as a child process with
 *      **piped stdout**, scrapes the consent URL the CLI prints, extracts the
 *      CSRF `state` + loopback `port` from it, and stashes a
 *      {@link PendingLoopbackFlow} keyed by chat.
 *   3. Gateway replies to chat with the consent URL + paste instructions.
 *   4. Operator approves on their phone, copies the failed-redirect URL from
 *      the address bar, pastes it into chat. The gateway's message intercept
 *      catches the paste and calls {@link submitLoopbackRedirect}.
 *   5. Helper validates `state` against the pending flow, then HTTP-GETs the
 *      live loopback listener at `127.0.0.1:<port>` with the pasted query
 *      string. The CLI's own listener re-validates `state`, exchanges the
 *      code, registers the account with the auth-broker, and exits 0.
 *   6. Success = the child process exits 0. Confirmed to chat; the pasted
 *      redirect (which carries the `code`) is redacted by the gateway.
 *
 * Why the CLI subprocess (vs. importing `runLoopbackOAuth` in-process):
 *
 *   - The gateway *can* import `src/` modules (auth-add-flow.ts already
 *     imports `src/auth/manager.js`), so an in-process drive is technically
 *     possible. But `runLoopbackOAuth` only returns a `TokenResponse` — the
 *     large, security-sensitive registration surface (scope selection, vault
 *     client-secret resolution, `buildGoogleCredentials`, broker `addAccount`,
 *     `--replace` semantics) lives in `src/cli/auth-google.ts` /
 *     `src/cli/auth-microsoft.ts`. Reproducing it in the gateway would
 *     duplicate that surface and drift from the CLI. Driving the CLI keeps it
 *     the single source of truth for registration.
 *   - Unlike `claude setup-token` (which writes to `/dev/tty` and needs a
 *     tmux pty — see auth-add-flow.ts), the switchroom CLI prints the consent
 *     URL via `console.log` to stdout. A plain piped child process captures
 *     it — no tmux, no pty. This is the incident-validated mechanism
 *     (2026-06-26): run the flow in the agent container that holds the grant,
 *     feed the listener a loopback GET.
 *
 * **Security invariants (must hold):**
 *   - The `code` and any token are NEVER logged or echoed to chat. This module
 *     does not log. Confirmations name only the account label. The gateway
 *     redacts the pasted redirect message.
 *   - `state` is validated in-process before the loopback GET, AND the CLI's
 *     own listener re-validates it — defence in depth.
 *   - Single-use: a flow that has begun submitting or completed rejects any
 *     further paste (no code accepted after completion). TTL sweep drops
 *     abandoned flows.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export type LoopbackProvider = 'google' | 'microsoft'

/* ── Injectable child-process seam (unit tests mock this) ─────────────────── */

/**
 * The narrow slice of `ChildProcess` the relay drives. Injected in tests as a
 * fake so no real CLI is spawned; satisfied by a real `ChildProcess` in prod.
 */
export interface RelayChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'exit', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface SpawnRelayOpts {
  replace?: boolean
  /** Google `--write` (Drive write scope). */
  write?: boolean
  /** Google `--calendar` (read-only Calendar scope). */
  calendar?: boolean
  /** Microsoft `--org-mode`. */
  orgMode?: boolean
  /** Override the CLI binary (tests / non-default install). */
  binary?: string
}

export type SpawnRelay = (
  provider: LoopbackProvider,
  email: string,
  opts: SpawnRelayOpts,
) => RelayChild

/**
 * Build the `switchroom auth <provider> account add` argv the relay spawns.
 *
 * Pure + exported so the flag plumbing is unit-pinned: every opt-in flag
 * the chat command accepts has to actually reach the CLI, and a flag that
 * was NOT requested must never appear (the relay is the only path most
 * operators use, so a dropped `--calendar` here is indistinguishable from
 * the feature not existing, and a spurious one silently widens a grant).
 */
export function buildRelayArgs(
  provider: LoopbackProvider,
  email: string,
  opts: SpawnRelayOpts,
): string[] {
  return provider === 'google'
    ? [
        'auth',
        'google',
        'account',
        'add',
        email,
        ...(opts.replace ? ['--replace'] : []),
        ...(opts.write ? ['--write'] : []),
        ...(opts.calendar ? ['--calendar'] : []),
      ]
    : [
        'auth',
        'microsoft',
        'account',
        'add',
        email,
        ...(opts.replace ? ['--replace'] : []),
        ...(opts.orgMode ? ['--org-mode'] : []),
      ]
}

/**
 * Default spawn: the real `switchroom` CLI, stdout+stderr piped, stdin
 * ignored. `BROWSER=/bin/true` suppresses any browser auto-open; the Drive
 * tier is pinned to desktop-loopback (the only Drive-viable flow — see
 * src/drive/oauth.ts). stdin is `ignore` so a stray interactive prompt gets
 * EOF and the child exits with an error rather than hanging forever.
 */
export function defaultSpawnRelay(
  provider: LoopbackProvider,
  email: string,
  opts: SpawnRelayOpts,
): RelayChild {
  const binary = opts.binary ?? 'switchroom'
  const args = buildRelayArgs(provider, email, opts)
  const child: ChildProcess = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BROWSER: '/bin/true',
      SWITCHROOM_DRIVE_OAUTH_TIER:
        process.env.SWITCHROOM_DRIVE_OAUTH_TIER ?? 'desktop_loopback',
    },
  })
  return child
}

/* ── Pending-state map ────────────────────────────────────────────────────── */

/**
 * In-flight loopback relay keyed by Telegram chat/thread key. The gateway's
 * generic message intercept reads this map to decide whether a pasted
 * `127.0.0.1:<port>/?...` redirect belongs to a loopback relay flow.
 */
export interface PendingLoopbackFlow {
  provider: LoopbackProvider
  email: string
  /** CSRF state parsed from the consent URL — the paste must echo it. */
  state: string
  /** Ephemeral loopback port the CLI listener is bound to. */
  port: number
  /** The consent URL surfaced to chat (never contains the code). */
  consentUrl: string
  /** The live CLI child process (its listener awaits the loopback GET). */
  child: RelayChild
  startedAt: number
  /**
   * Set once a valid paste has been accepted and the loopback GET is in
   * flight / the flow has completed. Guards against a second paste replaying
   * or racing the first (single-use).
   */
  submitting: boolean
  /**
   * Retryable-rejection counter (bad paste, wrong state, wrong port). The
   * flow is ended after {@link MAX_PASTE_ATTEMPTS} rejections rather than
   * waiting for the TTL — an operator repeatedly pasting the wrong thing
   * should get a decisive stop, not a silent 10-minute window.
   */
  attempts: number
  /** Set by {@link trackFlowExit} once the CLI child has exited. */
  exited?: boolean
  /** Exit code recorded by {@link trackFlowExit} (null = signal-killed). */
  exitCode?: number | null
}

/**
 * Bounded paste attempts — after this many retryable rejections the flow is
 * ended (non-retryable) so a confused paste loop can't run to the TTL.
 */
export const MAX_PASTE_ATTEMPTS = 5

export const pendingLoopbackFlows = new Map<string, PendingLoopbackFlow>()

/* ── ANSI stripping ───────────────────────────────────────────────────────── */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/* ── Consent-URL extraction + parsing ─────────────────────────────────────── */

const CONSENT_HOST: Record<LoopbackProvider, RegExp> = {
  // Google: https://accounts.google.com/o/oauth2/auth?...
  google: /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/,
  // Microsoft: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize?...
  microsoft: /https:\/\/login\.microsoftonline\.com\/[^\s"'<>]+/,
}

/**
 * Scrape the provider's consent URL out of a chunk of CLI stdout. Returns the
 * first match that carries both a `redirect_uri` and a `state` param (the
 * loopback consent URL), or `null` if none is present yet.
 */
export function extractConsentUrl(
  text: string,
  provider: LoopbackProvider,
): string | null {
  const clean = stripAnsi(text)
  const re = new RegExp(CONSENT_HOST[provider].source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const candidate = m[0]
    // Trim trailing punctuation the terminal may append (rare, but the
    // regex class already excludes whitespace/quotes/angle-brackets).
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    if (url.searchParams.has('redirect_uri') && url.searchParams.has('state')) {
      return candidate
    }
  }
  return null
}

export interface ParsedConsentUrl {
  state: string
  port: number
  redirectUri: string
}

/**
 * Pull the CSRF `state` and the loopback `port` out of a consent URL. Throws
 * if the URL is malformed or is not a loopback (`127.0.0.1` / `localhost`)
 * redirect — a non-loopback redirect means this isn't a relayable flow.
 */
export function parseConsentUrl(consentUrl: string): ParsedConsentUrl {
  const url = new URL(consentUrl)
  const state = url.searchParams.get('state')
  const redirectUri = url.searchParams.get('redirect_uri')
  if (!state) throw new Error('consent URL missing state parameter')
  if (!redirectUri) throw new Error('consent URL missing redirect_uri parameter')
  let redir: URL
  try {
    redir = new URL(redirectUri)
  } catch {
    throw new Error('consent URL redirect_uri is not a valid URL')
  }
  if (redir.hostname !== '127.0.0.1' && redir.hostname !== 'localhost') {
    throw new Error(
      `redirect_uri host is ${redir.hostname}, not a loopback address — not a relayable flow`,
    )
  }
  const port = Number(redir.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`redirect_uri has no usable port (got ${redir.port || '(none)'})`)
  }
  return { state, port, redirectUri }
}

/* ── Pasted-redirect parsing ──────────────────────────────────────────────── */

export type ParsedRedirect =
  | { ok: true; host: string; port: number; code: string; state: string }
  | { ok: false; reason: string }

/**
 * Parse the redirect URL the operator pastes back from their phone's address
 * bar. Tolerant of surrounding whitespace and a missing scheme
 * (`127.0.0.1:1234/?code=...` → treated as `http://`). Rejects non-loopback
 * hosts and anything missing `code` or `state`.
 *
 * The `code` is returned so the caller can forward it to the loopback
 * listener — it is NEVER logged.
 */
export function parseLoopbackRedirect(input: string): ParsedRedirect {
  const trimmed = (input ?? '').trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty input' }
  // Accept a bare `127.0.0.1:port/?...` (no scheme) by prepending http://.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return {
      ok: false,
      reason: `host is ${url.hostname || '(none)'}, expected 127.0.0.1`,
    }
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'missing or invalid port' }
  }
  const err = url.searchParams.get('error')
  if (err) {
    return { ok: false, reason: `provider returned error: ${err}` }
  }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) return { ok: false, reason: 'missing code parameter' }
  if (!state) return { ok: false, reason: 'missing state parameter' }
  return { ok: true, host: url.hostname, port, code, state }
}

/**
 * A loopback host reference (`127.0.0.1` / `localhost`) anywhere in the text.
 * Anchors the fail-safe detection to the loopback OAuth flow so a bare `code=`
 * on some foreign host is NOT swept up (preserves the deliberate narrowness).
 */
const LOOPBACK_HOST_REF_RE = /(?:127\.0\.0\.1|localhost)/i

/**
 * A `code=` / token param carrying a non-empty value — the same param shapes
 * the well-formed loopback-redirect path exchanges. Matched loosely (no strict
 * URL structure) so a malformed paste — dropped port, missing `/`, stray
 * surrounding text — that still carries a live OAuth `code` is caught.
 */
const AUTH_CODE_PARAM_RE =
  /[?&#/]?\b(?:code|access_token|refresh_token|id_token)=[^\s&#]+/i

/** A provider-denied `error=` param (the flow should surface + end). */
const PROVIDER_ERROR_PARAM_RE = /[?&]error=[^\s&]+/i

/**
 * Fail-safe (security audit #3084, F2): does this text *look like* a loopback
 * OAuth paste that carries a live `code` (or a provider `error`), even when it
 * is too malformed to parse as a clean redirect URL? True only when BOTH a
 * loopback host reference AND a code/token/error param are present — so
 * unrelated chatter mentioning `localhost` (no `code=`) still flows through.
 *
 * This is intentionally broader than {@link parseLoopbackRedirect}: a paste
 * with a dropped port or a missing `/` won't parse, yet may still hold a live
 * credential that must be redacted rather than forwarded to the agent.
 */
export function looksLikeLoopbackCodePaste(text: string): boolean {
  const trimmed = (text ?? '').trim()
  if (trimmed.length === 0) return false
  if (!LOOPBACK_HOST_REF_RE.test(trimmed)) return false
  return (
    AUTH_CODE_PARAM_RE.test(trimmed) || PROVIDER_ERROR_PARAM_RE.test(trimmed)
  )
}

/**
 * Decide whether an inbound chat message should be CONSUMED by the loopback
 * paste intercept (and therefore never reach other handlers, and be deleted
 * from history). Deliberately narrow: a message merely *mentioning*
 * `localhost`/`127.0.0.1` ("what's listening on localhost?") must flow
 * through untouched. We consume when the text parses as a loopback redirect
 * URL carrying a `code` — or a loopback URL carrying an `error` param (the
 * provider-denied case, which the flow should surface) — OR, fail-safe, when
 * it merely *looks like* a loopback code paste that is too malformed to parse
 * cleanly but still carries a live `code` (security audit #3084, F2). A live
 * credential must never fall through to the agent session unredacted.
 */
export function shouldConsumeLoopbackPaste(text: string): boolean {
  const trimmed = (text ?? '').trim()
  if (trimmed.length === 0) return false
  const parsed = parseLoopbackRedirect(trimmed)
  if (parsed.ok) return true
  // parseLoopbackRedirect rejects the error-param case with a
  // "provider returned error" reason — that IS a redirect paste and the
  // intercept should consume it to end/inform the flow.
  if (!parsed.ok && parsed.reason.startsWith('provider returned error')) {
    return true
  }
  // Fail-safe: malformed-but-code-bearing loopback paste.
  if (looksLikeLoopbackCodePaste(trimmed)) return true
  return false
}

/**
 * Attach an exit tracker to a pending flow so a child that dies BEFORE the
 * operator pastes (crash, listener error) is observable: `flow.exited` /
 * `flow.exitCode` are set, and {@link submitLoopbackRedirect} fails fast with
 * a clear message instead of hanging out its completion timeout waiting for
 * an `exit` event that already fired.
 */
export function trackFlowExit(flow: PendingLoopbackFlow): void {
  flow.child.on('exit', (code) => {
    flow.exited = true
    flow.exitCode = code
  })
}

/* ── Flow lifecycle ───────────────────────────────────────────────────────── */

export interface StartLoopbackResult {
  consentUrl: string
  state: string
  port: number
  child: RelayChild
}

export interface StartLoopbackOpts extends SpawnRelayOpts {
  spawnImpl?: SpawnRelay
  /** How long to wait for the CLI to print its consent URL. Default 20s. */
  urlTimeoutMs?: number
}

/**
 * Spawn the CLI account-add flow and resolve once its consent URL has been
 * scraped from stdout. On timeout or premature child exit the child is killed
 * and the promise rejects. The caller stashes the returned handle in
 * {@link pendingLoopbackFlows} and keeps the child alive until the operator
 * pastes the redirect (or the flow is cancelled / reaped).
 */
export async function startLoopbackFlow(
  provider: LoopbackProvider,
  email: string,
  opts: StartLoopbackOpts = {},
): Promise<StartLoopbackResult> {
  const spawnImpl = opts.spawnImpl ?? defaultSpawnRelay
  const urlTimeoutMs = opts.urlTimeoutMs ?? 20_000
  const child = spawnImpl(provider, email, {
    replace: opts.replace,
    write: opts.write,
    orgMode: opts.orgMode,
    binary: opts.binary,
  })

  return await new Promise<StartLoopbackResult>((resolve, reject) => {
    let settled = false
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const finishOk = (result: StartLoopbackResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const finishErr = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        child.kill()
      } catch {
        /* best-effort */
      }
      reject(err)
    }

    timer = setTimeout(() => {
      finishErr(
        new Error(
          `CLI did not print a consent URL within ${Math.round(urlTimeoutMs / 1000)}s`,
        ),
      )
    }, urlTimeoutMs)

    const onChunk = (chunk: Buffer | string) => {
      // Cap the buffer so a chatty CLI can't grow it unbounded before the URL.
      buffer = (buffer + chunk.toString()).slice(-16_384)
      const consentUrl = extractConsentUrl(buffer, provider)
      if (!consentUrl) return
      let parsed: ParsedConsentUrl
      try {
        parsed = parseConsentUrl(consentUrl)
      } catch (e) {
        finishErr(e instanceof Error ? e : new Error(String(e)))
        return
      }
      finishOk({ consentUrl, state: parsed.state, port: parsed.port, child })
    }

    child.stdout?.on('data', onChunk)
    // Some CLIs print prompts to stderr; scan it too.
    child.stderr?.on('data', onChunk)
    child.on('error', (err) => finishErr(err))
    child.on('exit', (code) => {
      finishErr(
        new Error(
          `CLI exited (code ${code ?? 'null'}) before printing a consent URL`,
        ),
      )
    })
  })
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }

export interface SubmitOpts {
  fetchImpl?: typeof fetch
  /** How long to wait for the child to exit 0 after the loopback GET. Default 60s. */
  completionTimeoutMs?: number
}

const CODE_LIKE_RE = /\b(code|access_token|refresh_token|id_token)=[^\s&]+/gi
const LOOPBACK_URL_RE = /https?:\/\/(127\.0\.0\.1|localhost):\d+\/\S*/gi

/**
 * Scrub anything code/token/loopback-URL-shaped out of a string before it is
 * shown to the operator. Defence in depth — the CLI does not print the code,
 * but stderr tails are attacker-adjacent text.
 */
export function scrubSensitive(s: string): string {
  return s
    .replace(LOOPBACK_URL_RE, '[redirect-url-redacted]')
    .replace(CODE_LIKE_RE, (_m, k) => `${k}=[redacted]`)
}

/**
 * Validate the pasted redirect against the pending flow and, on success,
 * hand the code to the live loopback listener. Resolves `{ ok: true }` once
 * the CLI child exits 0 (account registered).
 *
 * Retryable failures (bad paste, state mismatch, wrong port) leave the flow
 * pending so the operator can paste again. Non-retryable failures
 * (already-submitted, listener/registration error) end the flow — the caller
 * removes it from the pending map.
 */
export async function submitLoopbackRedirect(
  flow: PendingLoopbackFlow,
  pastedText: string,
  opts: SubmitOpts = {},
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const completionTimeoutMs = opts.completionTimeoutMs ?? 60_000

  // A retryable rejection that would exceed the attempt budget becomes a
  // non-retryable flow-ending one (bounded paste attempts — see
  // MAX_PASTE_ATTEMPTS).
  const rejectRetryable = (reason: string): SubmitResult => {
    flow.attempts += 1
    if (flow.attempts >= MAX_PASTE_ATTEMPTS) {
      return {
        ok: false,
        reason:
          `${reason} — ${MAX_PASTE_ATTEMPTS} rejected pastes; ending this flow. ` +
          `Start over with a fresh add command.`,
        retryable: false,
      }
    }
    return { ok: false, reason, retryable: true }
  }

  if (flow.submitting) {
    return {
      ok: false,
      reason: 'this flow has already been completed',
      retryable: false,
    }
  }
  if (flow.exited) {
    // Child died before the paste (crash, port bind error). The listener is
    // gone — no paste can ever succeed; fail fast instead of timing out.
    return {
      ok: false,
      reason: `the CLI exited (code ${flow.exitCode ?? 'null'}) before the paste — start a new flow`,
      retryable: false,
    }
  }

  const parsed = parseLoopbackRedirect(pastedText)
  if (!parsed.ok) {
    return rejectRetryable(parsed.reason)
  }
  if (parsed.state !== flow.state) {
    // CSRF guard — keep waiting; the operator may have pasted a stale URL.
    return rejectRetryable('state parameter does not match this flow (CSRF guard)')
  }
  if (parsed.port !== flow.port) {
    return rejectRetryable(
      `redirect port ${parsed.port} does not match this flow's listener`,
    )
  }
  // Single-use latch — set before any await so a racing second paste bounces.
  flow.submitting = true

  // Forward the code + state to the live loopback listener. The listener
  // re-validates state, exchanges the code, registers the account, exits 0.
  const loopbackUrl = new URL(`http://127.0.0.1:${flow.port}/`)
  loopbackUrl.searchParams.set('state', parsed.state)
  loopbackUrl.searchParams.set('code', parsed.code)

  // Collect a bounded stderr tail for error reporting (scrubbed before use).
  let stderrTail = ''
  const onErrChunk = (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2_048)
  }
  flow.child.stderr?.on('data', onErrChunk)

  const exitPromise = new Promise<number | null>((resolve) => {
    // Guard the tiny race where the child exits between the upfront
    // `flow.exited` check and this listener registration — an `exit` event
    // that already fired never re-fires, which would hang us to the timeout.
    if (flow.exited) {
      resolve(flow.exitCode ?? null)
      return
    }
    flow.child.on('exit', (code) => resolve(code))
  })

  try {
    await fetchImpl(loopbackUrl.toString(), { method: 'GET' })
  } catch (e) {
    // The listener typically closes the socket immediately after accepting
    // the code, which can surface as a fetch error even on success — so we
    // do NOT treat a fetch error as fatal here; the child exit code is the
    // real signal. Fall through to await the exit.
    void e
  }

  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), completionTimeoutMs),
  )
  const outcome = await Promise.race([exitPromise, timeout])

  if (outcome === 'timeout') {
    try {
      flow.child.kill()
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      reason: `registration did not complete within ${Math.round(
        completionTimeoutMs / 1000,
      )}s`,
      retryable: false,
    }
  }

  if (outcome === 0) {
    return { ok: true }
  }
  const tail = scrubSensitive(stripAnsi(stderrTail)).trim()
  return {
    ok: false,
    reason: tail
      ? `CLI exited with code ${outcome}: ${tail}`
      : `CLI exited with code ${outcome}`,
    retryable: false,
  }
}

/**
 * Cancel an in-flight loopback relay: kill the CLI child. Idempotent — safe to
 * call after the child has already exited. The caller removes the pending map
 * entry.
 */
export function cancelLoopbackFlow(flow: PendingLoopbackFlow): void {
  try {
    flow.child.kill()
  } catch {
    /* best-effort */
  }
}
