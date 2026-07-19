/**
 * `/auth add <label>` Telegram chat flow (RFC H §4.3 add-account, §7.3).
 *
 * The headline use case: every account on the fleet is rate-limited,
 * the LLM is unreachable, and the operator is on their phone. They
 * need a deterministic — LLM-free — chat path to add a fresh Anthropic
 * OAuth account. This module owns that flow end-to-end:
 *
 *   1. Operator sends `/auth add <label>`.
 *   2. Gateway calls {@link startAccountAuthSession} → launches
 *      `claude setup-token` inside a detached tmux session, captures
 *      the OAuth authorize URL via `capture-pane`, and tucks pending
 *      state into {@link pendingAuthAddFlows}.
 *   3. Gateway replies to chat with the URL + paste instructions.
 *   4. Operator opens URL, logs in, copies the browser code, pastes
 *      into chat. Gateway's `pendingReauthFlows`-style intercept
 *      catches the paste and calls {@link submitAccountAuthCode}.
 *   5. Helper submits the code via `send-keys`, then polls only the
 *      filesystem + tmux session liveness for success/failure — no
 *      capture-pane after code submission (the echoed code is a secret).
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
 *
 * **tmux is required** because `claude setup-token` writes the OAuth URL
 * and reads the browser code directly through `/dev/tty` (not
 * stdout/stderr/stdin). Pipe-based spawning (`stdio: ['pipe','pipe','pipe']`)
 * leaves the URL buffer permanently empty — the process writes to /dev/tty
 * which no pipe captures. A tmux pty gives setup-token the tty it needs;
 * we scrape the URL via `capture-pane` and inject the code via `send-keys`.
 * This requires `SWITCHROOM_TMUX_SUPERVISOR=1` in the agent's environment.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  parseSetupTokenUrl,
  readTokenFromCredentialsFile,
} from '../../src/auth/manager.js'
import { PRE_PASTE_RULES } from '../../src/auth/via-claude.js'
import type {
  AddAccountCredentials,
  AnthropicAddAccountCredentials,
} from '../../src/auth/broker/client.js'

/* ── Injectable tmux ops (mirrors makeTmuxRunner in src/agents/inject.ts) ─── */

/**
 * Injectable tmux operations for the auth-add flow.
 *
 * Co-located here (rather than importing from inject.ts) because:
 *   - The gateway must not depend on the CLI src/agents/ subtree at runtime.
 *   - The shape is narrower (capture + send + has-session + new-session +
 *     kill-session) and carries `-L <socket>` for isolated socket routing.
 *   - Unit tests mock this interface; the integration test uses
 *     {@link makeAuthAddTmuxOps} against a throwaway socket.
 */
export interface AuthAddTmuxOps {
  /**
   * `tmux -L <socket> new-session -d -s <session> -e KEY=VAL ... -x 400 -y 50 <cmd>`
   * Returns the tmux new-session stdout (usually empty).
   */
  newSession(socket: string, session: string, env: Record<string, string>, cmd: string): void
  /**
   * `tmux -L <socket> capture-pane -p -t <session> -S -200`
   * Returns pane content or null if the session/pane is gone.
   */
  capture(socket: string, session: string): string | null
  /**
   * Two `send-keys` calls mirroring src/auth/manager.ts:866-867:
   *   1. `send-keys -l -t <session> <text>` (literal, no key-name expansion)
   *   2. `send-keys    -t <session> Enter`
   * Throws on tmux error; caller is responsible for not calling this after
   * the session has ended.
   */
  send(socket: string, session: string, text: string): void
  /**
   * `tmux -L <socket> send-keys -t <session> <key>` — a SINGLE key-name
   * dispatch (e.g. `Enter`), with NO `-l` literal prefix and NO pane
   * capture. Used for:
   *   - pre-paste picker choreography (theme / login-method Enters) during
   *     the URL-poll phase, before any secret is on the pane; and
   *   - blind post-paste Enter dispatches to advance past Enter-gated
   *     "Logged in / Security notes" screens in the via-claude picker flow.
   * It reads nothing from the pane, so it can never leak the echoed code —
   * this is the deterministic replacement for via-claude's capture-driven
   * post-paste dispatch (see prb-safety.md).
   */
  sendKey(socket: string, session: string, key: string): void
  /** `tmux -L <socket> has-session -t <session>` — returns true if alive. */
  hasSession(socket: string, session: string): boolean
  /** `tmux -L <socket> kill-session -t <session>` — best-effort. */
  killSession(socket: string, session: string): void
}

/**
 * Build the real {@link AuthAddTmuxOps} backed by the system `tmux` binary.
 *
 * Pass a custom `tmuxBin` to use an alternate binary path in integration
 * tests. The socket name is always passed via `-L` so every call is routed
 * to the correct tmux server instance.
 */
export function makeAuthAddTmuxOps(tmuxBin = 'tmux'): AuthAddTmuxOps {
  return {
    newSession(socket, session, env, cmd) {
      const envFlags: string[] = []
      for (const [k, v] of Object.entries(env)) {
        envFlags.push('-e', `${k}=${v}`)
      }
      execFileSync(
        tmuxBin,
        ['-L', socket, 'new-session', '-d', '-s', session, ...envFlags, '-x', '400', '-y', '50', cmd],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
    },
    capture(socket, session) {
      try {
        return execFileSync(
          tmuxBin,
          ['-L', socket, 'capture-pane', '-p', '-t', session, '-S', '-200'],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        )
      } catch {
        return null
      }
    },
    send(socket, session, text) {
      // Mirror src/auth/manager.ts:866-867 exactly:
      //   1. send the literal code (no key-name expansion)
      //   2. send Enter separately
      execFileSync(tmuxBin, ['-L', socket, 'send-keys', '-l', '-t', session, text.trim()], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      execFileSync(tmuxBin, ['-L', socket, 'send-keys', '-t', session, 'Enter'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
    sendKey(socket, session, key) {
      // Single key-name dispatch, no -l literal prefix, no capture.
      execFileSync(tmuxBin, ['-L', socket, 'send-keys', '-t', session, key], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
    hasSession(socket, session) {
      try {
        execFileSync(tmuxBin, ['-L', socket, 'has-session', '-t', session], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return true
      } catch {
        return false
      }
    },
    killSession(socket, session) {
      try {
        execFileSync(tmuxBin, ['-L', socket, 'kill-session', '-t', session], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        // best-effort
      }
    },
  }
}

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
/**
 * Which credential minter drives the flow.
 *
 *   - `'via-claude'` (DEFAULT): spawn the bare `claude` login picker, which
 *     mints the broad scope set (`org:create_api_key user:profile
 *     user:inference user:sessions:claude_code user:mcp_servers
 *     user:file_upload`) that `server:` mode agents require at boot. This is
 *     the default because `claude setup-token` tokens carry only
 *     `user:inference` and are REFUSED by server: agents (via-claude.ts:9-17).
 *   - `'setup-token'`: spawn `claude setup-token` (narrow `user:inference`).
 *     Kept for completeness / legacy narrow-scope adds.
 */
export type AuthAddMode = 'via-claude' | 'setup-token'

export interface PendingAuthAddFlow {
  label: string
  scratchDir: string
  /** tmux socket name (`switchroom-<agentName>`). */
  tmuxSocket: string
  /** tmux session name (`auth-add-<label>-<hex>`). */
  tmuxSession: string
  startedAt: number
  /**
   * Minter mode this flow was started in. `submitAccountAuthCode` reads it to
   * decide whether to dispatch blind post-paste Enter key-presses (via-claude
   * picker screens) — setup-token exits after the code so needs none.
   * Optional for back-compat with callers/tests that construct flows directly;
   * absent is treated as `'via-claude'` (the default minter).
   */
  mode?: AuthAddMode
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

/* ── Orphan cleanup ───────────────────────────────────────────────────── */

/**
 * Filename written into the scratch dir at session start so that a
 * subsequent `startAccountAuthSession` can identify and kill orphaned
 * tmux sessions from crashed/restarted gateways.
 */
const AUTH_TMUX_SESSION_FILE = '.auth-tmux-session'

/**
 * Sweep `~/.switchroom/accounts/.in-progress/` for dirs older than
 * 10 minutes (stale from a prior gateway crash). For each, read the
 * `.auth-tmux-session` file, best-effort kill the tmux session, then
 * remove the dir.
 *
 * Called at the start of every `startAccountAuthSession` invocation.
 */
function sweepOrphanSessions(
  home: string,
  tmux: AuthAddTmuxOps,
  nowMs: number = Date.now(),
): void {
  const inProgressDir = join(home, '.switchroom', 'accounts', '.in-progress')
  if (!existsSync(inProgressDir)) return
  let entries: string[]
  try {
    entries = readdirSync(inProgressDir)
  } catch {
    return
  }
  const tenMinMs = 10 * 60_000
  for (const entry of entries) {
    const dir = join(inProgressDir, entry)
    // Check age via the session file's mtime (proxy for dir creation time).
    const sessionFile = join(dir, AUTH_TMUX_SESSION_FILE)
    if (!existsSync(sessionFile)) continue
    let fileContents: string
    let fileMtime: number
    try {
      const stat = statSync(sessionFile)
      fileMtime = stat.mtimeMs
      fileContents = readFileSync(sessionFile, 'utf8').trim()
    } catch {
      continue
    }
    if (nowMs - fileMtime < tenMinMs) continue
    // Old enough — try to kill the session.
    if (fileContents) {
      const [socket, session] = fileContents.split('\n')
      if (socket && session) {
        tmux.killSession(socket.trim(), session.trim())
      }
    }
    // Remove the dir.
    cleanScratchDir(dir)
  }
}

/* ── Subprocess lifecycle ─────────────────────────────────────────────── */

export interface StartAccountAuthSessionResult {
  loginUrl: string
  scratchDir: string
  tmuxSocket: string
  tmuxSession: string
  /** The minter mode the session was started in. */
  mode: AuthAddMode
}

/**
 * Launch `claude setup-token` inside a detached tmux session and
 * resolve once the authorize URL has been scraped from the pane.
 *
 * Why tmux (not a pipe): `claude setup-token` writes the OAuth URL and
 * reads the browser code directly through `/dev/tty`, bypassing
 * stdout/stderr/stdin entirely. A pipe-spawned process sees an empty
 * buffer forever. A tmux pane provides the tty; `capture-pane` scrapes
 * what setup-token wrote there.
 *
 * **Critical env footgun:** the tmux server's environment is frozen at
 * container boot. Ambient inheritance via `process.env` does NOT flow
 * into a `new-session` call — every variable that must reach the child
 * MUST be passed explicitly via `-e KEY=VAL` flags. This applies to
 * `CLAUDE_CONFIG_DIR`, `BROWSER`, `HOME`, and `PATH`.
 *
 * **Socket:** `switchroom-<SWITCHROOM_AGENT_NAME>` — the same socket
 * the agent's gateway supervisor uses. This requires
 * `SWITCHROOM_TMUX_SUPERVISOR=1` to be set in the gateway's environment.
 *
 * Credential file lands at `<scratchDir>/.credentials.json` because
 * `CLAUDE_CONFIG_DIR=scratchDir` is passed explicitly into the session.
 *
 * Timeout default: 12 seconds to see the URL. `claude setup-token`
 * typically renders the URL within ~3–5s; 12s covers an unloaded VM.
 *
 * @throws if `SWITCHROOM_TMUX_SUPERVISOR` is not set to '1'.
 * @throws if the URL is not captured within `urlTimeoutMs`.
 */
export async function startAccountAuthSession(
  label: string,
  opts: {
    home?: string
    urlTimeoutMs?: number
    /** Override the tmux binary (integration tests). */
    tmuxBin?: string
    /** Override tmux ops entirely (unit tests). */
    tmuxOps?: AuthAddTmuxOps
    /** Override the agent name (tests). */
    agentName?: string
    /** Override the claude binary name (tests). */
    claudeBinary?: string
    /**
     * Credential minter. Defaults to `'via-claude'` (broad scope) — see
     * {@link AuthAddMode}. Pass `'setup-token'` for the narrow-scope minter.
     */
    mode?: AuthAddMode
  } = {},
): Promise<StartAccountAuthSessionResult> {
  if (process.env.SWITCHROOM_TMUX_SUPERVISOR !== '1' && !opts.tmuxOps) {
    throw new Error(
      'tmux supervisor required for /auth add: SWITCHROOM_TMUX_SUPERVISOR is not set to "1". ' +
        'Legacy pipe-based setup-token is unsupported (setup-token writes to /dev/tty, not stdout/stderr).',
    )
  }

  const home = opts.home ?? homedir()
  // 30s (was 12s): the via-claude login picker adds keystroke-choreography
  // latency (theme + login-method Enters) before the URL renders, and an
  // unloaded VM can be slow. via-claude's own default is 20s; 30s is generous.
  const urlTimeoutMs = opts.urlTimeoutMs ?? 30_000
  const agentName = opts.agentName ?? process.env.SWITCHROOM_AGENT_NAME ?? 'gateway'
  const tmux = opts.tmuxOps ?? makeAuthAddTmuxOps(opts.tmuxBin)
  const binary = opts.claudeBinary ?? 'claude'
  const mode: AuthAddMode = opts.mode ?? 'via-claude'

  const scratchDir = pickScratchDir(label, home)
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 })

  // Sweep orphan sessions BEFORE creating the new one so the dir count
  // stays bounded even across repeated gateway restarts.
  sweepOrphanSessions(home, tmux)

  // Session name reuses the random hex already in the scratchDir basename.
  const hexSuffix = scratchDir.slice(scratchDir.lastIndexOf('-') + 1)
  const tmuxSocket = `switchroom-${agentName}`
  const tmuxSession = `auth-add-${label}-${hexSuffix}`.slice(0, 64)

  // Write the session coordinates to the scratch dir for orphan cleanup.
  try {
    writeFileSync(join(scratchDir, AUTH_TMUX_SESSION_FILE), `${tmuxSocket}\n${tmuxSession}`, 'utf8')
  } catch {
    // best-effort — orphan cleanup is non-critical
  }

  // Build the env passed explicitly into the tmux session.
  // CRITICAL: tmux server env is frozen at container boot; ambient
  // inheritance does NOT carry CLAUDE_CONFIG_DIR or BROWSER into the
  // child. Every required variable must appear as a -e flag here.
  const sessionEnv: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    CLAUDE_CONFIG_DIR: scratchDir,
    BROWSER: '/bin/true',
  }
  // Forward any extra vars the operator may have set.
  if (process.env.CLAUDE_CONFIG_DIR) sessionEnv['CLAUDE_CONFIG_DIR'] = scratchDir // always override
  if (process.env.XDG_CONFIG_HOME) sessionEnv['XDG_CONFIG_HOME'] = process.env.XDG_CONFIG_HOME

  // Command: bare `claude` for the broad-scope login picker (via-claude), or
  // `claude setup-token` for the narrow-scope minter.
  const sessionCmd = mode === 'via-claude' ? binary : binary + ' setup-token'
  const minterLabel = mode === 'via-claude' ? 'claude login' : 'claude setup-token'
  try {
    tmux.newSession(tmuxSocket, tmuxSession, sessionEnv, sessionCmd)
  } catch (err) {
    cleanScratchDir(scratchDir)
    throw new Error(`Failed to start tmux session for ${minterLabel}: ${(err as Error).message}`)
  }

  // Poll capture-pane every 500ms up to the URL timeout.
  //
  // In via-claude mode we ALSO dispatch the pre-paste picker choreography
  // (theme picker → Enter, login-method picker → Enter) each tick, at most
  // once per rule. This runs BEFORE any secret is on the pane, so capturing
  // here is safe. parseSetupTokenUrl matches both the claude.ai/oauth and
  // claude.com/cai/oauth shapes, which is exactly the URL the picker renders.
  const preFired = new Set<string>()
  const loginUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(ticker)
      tmux.killSession(tmuxSocket, tmuxSession)
      cleanScratchDir(scratchDir)
      reject(new Error(`${minterLabel} did not print an OAuth URL within ${urlTimeoutMs}ms`))
    }, urlTimeoutMs)

    const ticker = setInterval(() => {
      const pane = tmux.capture(tmuxSocket, tmuxSession)
      if (pane === null) {
        // Session died before URL appeared.
        clearTimeout(deadline)
        clearInterval(ticker)
        cleanScratchDir(scratchDir)
        reject(new Error(`${minterLabel} exited before printing OAuth URL`))
        return
      }
      if (mode === 'via-claude') {
        for (const rule of PRE_PASTE_RULES) {
          if (preFired.has(rule.name)) continue
          if (rule.match.test(pane)) {
            preFired.add(rule.name)
            // The pre-paste rules dispatch bare key-names (Enter); use the
            // single-key primitive, not the literal-code `send`.
            for (const key of rule.keys) tmux.sendKey(tmuxSocket, tmuxSession, key)
          }
        }
      }
      const url = parseSetupTokenUrl(pane)
      if (url) {
        clearTimeout(deadline)
        clearInterval(ticker)
        // Leave the session alive — operator has not yet pasted the code.
        resolve(url)
      }
    }, 500)
  })

  return { loginUrl, scratchDir, tmuxSocket, tmuxSession, mode }
}

/**
 * Submit the operator's browser code into the live tmux session and
 * wait for the success-written credentials.json.
 *
 * Code is submitted via TWO `send-keys` calls (mirroring
 * `src/auth/manager.ts:866-867`):
 *   1. `send-keys -l -t <session> <code.trim()>` — literal, no key expansion
 *   2. `send-keys    -t <session> Enter`
 *
 * **After code submission, capture-pane is NEVER called again.**
 * The echoed code is a secret OAuth token; scraping the pane post-submit
 * would risk logging it. Success is detected exclusively via:
 *   - Filesystem: `<scratchDir>/.credentials.json` appearing.
 *   - Session liveness: `has-session` returning false after code submit
 *     with no cred file → invalid/expired code (clean error, not 300s hang).
 *
 * Code timeout raised to 300s (vs the prior 120s) to give the operator
 * adequate time to complete the browser flow on their phone.
 */
export async function submitAccountAuthCode(
  flow: PendingAuthAddFlow,
  code: string,
  opts: {
    pollIntervalMs?: number
    pollTimeoutMs?: number
    tmuxOps?: AuthAddTmuxOps
    /**
     * Blind post-paste Enter schedule (ms after the code paste) for the
     * via-claude picker flow: advances past the Enter-gated "Logged in /
     * Security notes" screens WITHOUT ever capturing the pane (the echoed
     * code is a secret — see prb-safety.md). Defaults derive from
     * `flow.mode`: via-claude → `[1500, 3000, 5000]`, setup-token → `[]`
     * (setup-token exits after the code, so no screens to dismiss). Pass an
     * explicit array to override (tests use tight schedules).
     */
    blindEnterDelaysMs?: number[]
  } = {},
): Promise<AddAccountCredentials> {
  const pollIntervalMs = opts.pollIntervalMs ?? 250
  const pollTimeoutMs = opts.pollTimeoutMs ?? 300_000
  const tmux = opts.tmuxOps ?? makeAuthAddTmuxOps()
  const mode: AuthAddMode = flow.mode ?? 'via-claude'
  const blindEnterDelaysMs =
    opts.blindEnterDelaysMs ?? (mode === 'via-claude' ? [1500, 3000, 5000] : [])

  const credentialsPath = join(flow.scratchDir, '.credentials.json')

  // Submit the code via two send-keys calls.
  // After this point, capture-pane is NEVER called (code is a secret).
  try {
    tmux.send(flow.tmuxSocket, flow.tmuxSession, code)
  } catch (err) {
    cleanScratchDir(flow.scratchDir)
    throw new Error(
      `Failed to submit auth code to tmux session: ${(err as Error).message}`,
    )
  }

  // Blind post-paste Enter schedule (via-claude picker). Absolute deadlines;
  // each fires at most once. NEVER reads the pane — sendKey only writes.
  const pasteAt = Date.now()
  const blindEnters = blindEnterDelaysMs.map((d) => ({ at: pasteAt + d, fired: false }))

  // Poll filesystem + session liveness only — no capture-pane.
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))

    // Dispatch any due blind Enters (best-effort; a dead session just throws
    // and we swallow it — the fs poll below is the real success signal).
    for (const be of blindEnters) {
      if (!be.fired && Date.now() >= be.at) {
        be.fired = true
        try {
          tmux.sendKey(flow.tmuxSocket, flow.tmuxSession, 'Enter')
        } catch {
          // best-effort — session may have already exited on success
        }
      }
    }

    if (existsSync(credentialsPath)) {
      const token = readTokenFromCredentialsFile(credentialsPath)
      if (token) {
        try {
          const raw = readFileSync(credentialsPath, 'utf-8')
          const parsed = JSON.parse(raw) as { claudeAiOauth?: AnthropicAddAccountCredentials['claudeAiOauth'] }
          if (parsed.claudeAiOauth?.accessToken) {
            // Kill the tmux session cleanly — it's served its purpose.
            tmux.killSession(flow.tmuxSocket, flow.tmuxSession)
            return { claudeAiOauth: parsed.claudeAiOauth }
          }
        } catch {
          // fall through — file may be mid-write; next tick retries.
        }
      }
    }

    // Detect session death: if session is gone AND no cred file → invalid code.
    if (!tmux.hasSession(flow.tmuxSocket, flow.tmuxSession)) {
      if (!existsSync(credentialsPath)) {
        cleanScratchDir(flow.scratchDir)
        throw new Error(
          'claude setup-token exited without writing credentials — the code may be invalid or expired',
        )
      }
    }
  }

  // Timeout — kill session + wipe scratch.
  tmux.killSession(flow.tmuxSocket, flow.tmuxSession)
  cleanScratchDir(flow.scratchDir)
  throw new Error(
    `No credentials file appeared at ${credentialsPath} within ${Math.round(pollTimeoutMs / 1000)}s`,
  )
}

/**
 * Cancel an in-flight `/auth add` flow: kill the tmux session, wipe
 * the scratch dir, and let the caller delete the `pendingAuthAddFlows`
 * entry. Idempotent — safe to call when the session has already exited.
 */
export function cancelAccountAuthSession(
  flow: PendingAuthAddFlow,
  tmuxOps?: AuthAddTmuxOps,
): void {
  const tmux = tmuxOps ?? makeAuthAddTmuxOps()
  tmux.killSession(flow.tmuxSocket, flow.tmuxSession)
  cleanScratchDir(flow.scratchDir)
}
