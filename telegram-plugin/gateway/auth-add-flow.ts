/**
 * `/auth add <label>` Telegram chat flow (RFC H §4.3 add-account, §7.3).
 *
 * The headline use case: every account on the fleet is rate-limited,
 * the LLM is unreachable, and the operator is on their phone. They
 * need a deterministic — LLM-free — chat path to add a fresh Anthropic
 * OAuth account. This module owns that flow end-to-end:
 *
 *   1. Operator sends `/auth add <label>`.
 *   2. Gateway calls {@link startAccountAuthSession} → spawns
 *      `claude setup-token` against a scratch directory under
 *      `~/.switchroom/accounts/.in-progress/<label>-<rand>/`, captures
 *      the OAuth authorize URL, and tucks pending state into
 *      {@link pendingAuthAddFlows}.
 *   3. Gateway replies to chat with the URL + paste instructions.
 *   4. Operator opens URL, logs in, copies the browser code, pastes
 *      into chat. Gateway's `pendingReauthFlows`-style intercept
 *      catches the paste and calls {@link submitAccountAuthCode}.
 *   5. Helper reads `<scratch>/.credentials.json` (the dotfile that
 *      `claude setup-token` writes on success — pinned in
 *      `src/auth/broker/server-add-account.test.ts`), builds the
 *      {@link AddAccountCredentials} payload, and the gateway calls
 *      broker `addAccount(label, credentials, replace=false)`.
 *   6. Scratch dir is wiped on every code path — success, cancel,
 *      paste-failure, TTL timeout, gateway shutdown.
 *
 * Why a separate module (vs reusing `src/auth/manager.ts`):
 *
 *   - `startAuthSession` writes `<agentDir>/.claude/.setup-token.session.json`
 *     and is built around the per-agent OAuth flow. The `/auth add`
 *     flow has no agent — the resulting credentials become a
 *     broker-managed account that any agent can be set to. Threading
 *     `agentDir` through it would corrupt the agent's own auth state
 *     if the operator's add-flow collides with a normal reauth.
 *   - The chat-flow surface is deterministic and stateless beyond
 *     `pendingAuthAddFlows`. Reusing the full manager would inherit
 *     legacy slot logic, tmp-dir cleanup heuristics, and stale-session
 *     detection that doesn't apply when each `/auth add` creates a
 *     fresh, unguessable scratch dir of its own.
 *
 * What we DO reuse: the pure parsing helpers — `parseSetupTokenUrl`
 * (handles both claude.ai/oauth and claude.com/cai/oauth shapes),
 * `extractCodeChallenge` (PKCE stale-session detection), and
 * `readTokenFromCredentialsFile` (validates the `sk-ant-oat...` token
 * shape). Those are label-agnostic.
 *
 * **Hard rule: NEVER touch the agent's claude process.** This flow runs
 * as a deterministic chat handler in the gateway. The URL goes straight
 * to chat via `bot.api.sendMessage`. The code paste is intercepted by
 * the gateway, never forwarded to the agent's bridge. If every account
 * on the fleet is rate-limited the LLM is unreachable — that's the
 * whole point of the flow existing.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  parseSetupTokenUrl,
  readTokenFromCredentialsFile,
} from '../../src/auth/manager.js'
import type { AddAccountCredentials } from '../../src/auth/broker/client.js'

/* ── Pending-state map ────────────────────────────────────────────────── */

/**
 * In-flight `/auth add` flow keyed by Telegram chat id. The gateway's
 * generic message intercept (sibling to `pendingReauthFlows`) reads
 * this map to decide whether a sk-ant-…-shaped paste belongs to an
 * add flow or to a reauth flow.
 *
 * TTL matches `REAUTH_INTERCEPT_TTL_MS` (10 minutes); the reaper sweep
 * in gateway.ts walks both maps each minute.
 */
export interface PendingAuthAddFlow {
  label: string
  scratchDir: string
  /** PID of the spawned `claude setup-token` process, for cancel-kill. */
  child: ChildProcess
  startedAt: number
}
export const pendingAuthAddFlows = new Map<string, PendingAuthAddFlow>()

/* ── Scratch dir lifecycle ────────────────────────────────────────────── */

/**
 * Pick a fresh scratch path under
 * `~/.switchroom/accounts/.in-progress/<label>-<rand>/`.
 *
 * The leading dot keeps the dir hidden from `listAccounts(home)` in
 * `src/auth/account-store.ts`, which enumerates accounts by scanning
 * `~/.switchroom/accounts/`. That listing is the source of truth for
 * broker `list-state` — a half-written add-in-progress must NOT
 * appear there. `.in-progress/` is also outside the broker's
 * managed-artifact whitelist, so a stray dir won't blow up on the
 * next apply.
 *
 * Random suffix is 8 bytes of crypto-grade randomness so:
 *   - two concurrent operators adding the same label can't collide
 *     on the scratch path
 *   - an attacker watching `~/.switchroom/accounts/.in-progress/`
 *     can't predict the next dir name and squat a symlink
 */
export function pickScratchDir(label: string, home: string = homedir()): string {
  const suffix = randomBytes(8).toString('hex')
  return join(home, '.switchroom', 'accounts', '.in-progress', `${label}-${suffix}`)
}

/**
 * Best-effort scratch-dir wipe. Used on every exit path — success,
 * cancel, timeout, error. Synchronous because the caller has already
 * settled the user-facing reply by the time we get here; an extra
 * tick of latency is not worth event-loop juggling.
 */
export function cleanScratchDir(scratchDir: string): void {
  try {
    rmSync(scratchDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/* ── Subprocess lifecycle ─────────────────────────────────────────────── */

export interface StartAccountAuthSessionResult {
  loginUrl: string
  scratchDir: string
  child: ChildProcess
}

/**
 * Spawn `claude setup-token` against a fresh scratch directory and
 * resolve once the authorize URL has been parsed from its stdout/stderr.
 *
 * Why we *don't* use tmux: the `submitAuthCode` path in
 * `src/auth/manager.ts` uses tmux because that flow is interactive —
 * an operator on a host can `tmux attach` to inspect the auth prompt
 * if anything goes wrong. The chat flow has no equivalent escape
 * hatch (the operator is on their phone) and a pipe-based subprocess
 * is far easier to lifecycle-manage from a long-running gateway. We
 * write the code to the child's stdin in {@link submitAccountAuthCode}.
 *
 * The child is left running between {@link startAccountAuthSession}
 * and {@link submitAccountAuthCode} — closing stdin before the code
 * is pasted would tear down the OAuth session.
 *
 * Timeout default: 12 seconds to see the URL. claude setup-token
 * typically prints the URL within ~3–5s; 12s covers an unloaded VM
 * with slow startup. Caller passes the timeout via opts so tests can
 * shorten it.
 */
export async function startAccountAuthSession(
  label: string,
  opts: {
    home?: string
    urlTimeoutMs?: number
    /** Override the binary name (tests). */
    claudeBinary?: string
  } = {},
): Promise<StartAccountAuthSessionResult> {
  const home = opts.home ?? homedir()
  const urlTimeoutMs = opts.urlTimeoutMs ?? 12_000
  const binary = opts.claudeBinary ?? 'claude'

  const scratchDir = pickScratchDir(label, home)
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 })

  // BROWSER=/bin/true: same rationale as src/auth/manager.ts's
  // startAuthSession — suppress claude setup-token's host-side browser
  // auto-launch (would land on Claude's login page with no cookies on
  // a headless box). The chat flow is paste-only.
  const child = spawn(binary, ['setup-token'], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: scratchDir,
      BROWSER: '/bin/true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Aggregate stdout+stderr; the URL can land on either channel
  // depending on claude CLI version.
  let buffer = ''
  const collect = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  // Race: URL detection vs timeout vs child exit before URL appeared.
  const loginUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup()
      reject(new Error(`claude setup-token did not print an OAuth URL within ${urlTimeoutMs}ms`))
    }, urlTimeoutMs)

    const tick = setInterval(() => {
      const url = parseSetupTokenUrl(buffer)
      if (url) {
        cleanup()
        resolve(url)
      }
    }, 200)

    const onExit = (code: number | null): void => {
      cleanup()
      reject(new Error(`claude setup-token exited (code ${code}) before printing OAuth URL`))
    }
    child.once('exit', onExit)

    function cleanup(): void {
      clearTimeout(deadline)
      clearInterval(tick)
      child.removeListener('exit', onExit)
    }
  }).catch((err) => {
    // Kill the child and wipe the scratch dir before re-raising so
    // failed-to-start sessions don't leak.
    try { child.kill('SIGTERM') } catch { /* best-effort */ }
    cleanScratchDir(scratchDir)
    throw err
  })

  return { loginUrl, scratchDir, child }
}

/**
 * Paste the operator's browser code into the live `claude setup-token`
 * child's stdin and wait for the success-written credentials.json.
 *
 * Returns the `AddAccountCredentials` shape the broker's add-account
 * verb expects — same `claudeAiOauth: { accessToken, refreshToken,
 * expiresAt, scopes, subscriptionType, rateLimitTier }` envelope.
 *
 * On success: the caller is responsible for invoking
 * `cleanScratchDir(scratchDir)` after `addAccount` returns; we
 * deliberately don't wipe here because the broker call might race the
 * filesystem cleanup. On failure (invalid code, expired code, timeout)
 * the helper throws and cleans the scratch dir itself.
 *
 * Poll interval default: 250ms — same as `submitAuthCode`'s 500ms
 * halved because there's no tmux capture-pane overhead per tick.
 * Timeout default: 120s, matching the env var in `submitAuthCode`.
 */
export async function submitAccountAuthCode(
  flow: PendingAuthAddFlow,
  code: string,
  opts: { pollIntervalMs?: number; pollTimeoutMs?: number } = {},
): Promise<AddAccountCredentials> {
  const pollIntervalMs = opts.pollIntervalMs ?? 250
  const pollTimeoutMs = opts.pollTimeoutMs ?? 120_000

  const credentialsPath = join(flow.scratchDir, '.credentials.json')

  // Write the code + newline to stdin. claude setup-token's prompt
  // expects line-buffered input — see the manual-paste paste at the
  // bottom of `submitAuthCode`. We use a single write here (vs the
  // two send-keys calls of the tmux path) because there's no
  // terminfo-flake concern over a pipe.
  if (!flow.child.stdin || flow.child.stdin.destroyed) {
    cleanScratchDir(flow.scratchDir)
    throw new Error('claude setup-token process stdin is not writable (child may have exited)')
  }
  flow.child.stdin.write(code.trim() + '\n')

  // Poll for the credentials file. Same two-channel design as
  // submitAuthCode but tmux-pane-scrape and log-scrape are out (the
  // pane scrape was a fallback for older claude CLI versions; the
  // chat flow targets the current CLI by definition).
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    if (existsSync(credentialsPath)) {
      const token = readTokenFromCredentialsFile(credentialsPath)
      if (token) {
        // Parse the full credentials envelope to forward to the
        // broker. readTokenFromCredentialsFile already validated the
        // accessToken regex, so the JSON is well-formed.
        try {
          const raw = readFileSync(credentialsPath, 'utf-8')
          const parsed = JSON.parse(raw) as { claudeAiOauth?: AddAccountCredentials['claudeAiOauth'] }
          if (parsed.claudeAiOauth?.accessToken) {
            // Drain the child so it exits cleanly after success.
            try { flow.child.stdin?.end() } catch { /* best-effort */ }
            return { claudeAiOauth: parsed.claudeAiOauth }
          }
        } catch {
          // fall through — file may be mid-write; next tick retries.
        }
      }
    }
    // Detect child early exit (invalid code → claude prints + exits).
    if (flow.child.exitCode != null) {
      cleanScratchDir(flow.scratchDir)
      throw new Error(
        `claude setup-token exited (code ${flow.child.exitCode}) — code may have been invalid or expired`,
      )
    }
  }

  // Timeout — kill the child + wipe scratch.
  try { flow.child.kill('SIGTERM') } catch { /* best-effort */ }
  cleanScratchDir(flow.scratchDir)
  throw new Error(`No credentials file appeared at ${credentialsPath} within ${Math.round(pollTimeoutMs / 1000)}s`)
}

/**
 * Cancel an in-flight `/auth add` flow: kill the `claude setup-token`
 * child, wipe the scratch dir, and let the caller delete the
 * `pendingAuthAddFlows` entry. Idempotent — safe to call when the
 * child has already exited.
 */
export function cancelAccountAuthSession(flow: PendingAuthAddFlow): void {
  try {
    if (flow.child.exitCode == null) flow.child.kill('SIGTERM')
  } catch {
    // best-effort
  }
  cleanScratchDir(flow.scratchDir)
}
