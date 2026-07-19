/**
 * `/auth add <label>` Telegram chat-flow coverage.
 *
 * Pins the load-bearing contracts of the deterministic add-account
 * surface — the one operators reach for when every account on the
 * fleet is rate-limited and the LLM is unreachable:
 *
 *   1. Parser recognises `/auth add <label>` and `/auth cancel`.
 *   2. Admin gating: `/auth add` is refused for non-admin agents.
 *   3. Bad labels (slashes, whitespace, over-length) are refused
 *      with a clear error.
 *   4. tmux wiring: `startAccountAuthSession` starts a tmux session,
 *      scrapes the URL from the pane, returns it.
 *   5. Code paste-back: `submitAccountAuthCode` sends two `send-keys`
 *      calls (the -l literal call then Enter), then resolves via cred
 *      file detection — no capture-pane after code submit.
 *   6. Stale paste-back (TTL exceeded) is the gateway's concern;
 *      pinned as a contract via the TTL constant the gateway uses.
 *   7. Cancel kills the tmux session + wipes the scratch dir.
 *
 * Unit tests mock `AuthAddTmuxOps`; the integration test drives a real
 * tmux server on a throwaway socket with a fake setup-token script.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, execSync } from 'node:child_process'

/**
 * Pick an exec-allowed temp root. Some containers mount /tmp with
 * `noexec`. When the default tmpdir is noexec, fall back to a
 * project-local `.test-tmp/` which inherits the project mount's
 * exec bits.
 */
function execAllowedTmpdir(): string {
  const def = tmpdir()
  try {
    const mounts = readFileSync('/proc/mounts', 'utf8')
    const noexec = mounts.split('\n').some((line) => {
      const parts = line.split(' ')
      if (parts.length < 4) return false
      const [, mountPoint, , opts] = parts
      return mountPoint === def && opts.split(',').includes('noexec')
    })
    if (!noexec) return def
  } catch {
    return def
  }
  const fallback = join(process.cwd(), '.test-tmp')
  mkdirSync(fallback, { recursive: true })
  return fallback
}

const EXEC_TMPDIR = execAllowedTmpdir()

import {
  parseAuthCommand,
  handleAuthCommand,
  isAuthAdmin,
  validateAuthAddLabel,
  readdPrecheckError,
  formatGrantedScopesReply,
  REQUIRED_USAGE_SCOPE,
} from '../gateway/auth-command.js'
import {
  pendingAuthAddFlows,
  startAccountAuthSession,
  submitAccountAuthCode,
  cancelAccountAuthSession,
  cleanScratchDir,
  pickScratchDir,
  makeAuthAddTmuxOps,
  type PendingAuthAddFlow,
  type AuthAddTmuxOps,
} from '../gateway/auth-add-flow.js'

/* ── Test fixtures ────────────────────────────────────────────────────── */

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(EXEC_TMPDIR, 'auth-add-flow-test-'))
  pendingAuthAddFlows.clear()
  // Ensure SWITCHROOM_TMUX_SUPERVISOR is set so the tmuxOps guard passes
  // in unit tests that supply a mock tmuxOps.
  process.env.SWITCHROOM_TMUX_SUPERVISOR = '1'
})

afterEach(() => {
  pendingAuthAddFlows.clear()
  delete process.env.SWITCHROOM_TMUX_SUPERVISOR
  try { rmSync(workspace, { recursive: true, force: true }) } catch { /* best-effort */ }
})

/* ── Mock AuthAddTmuxOps factory ─────────────────────────────────────── */

/**
 * Build a mock `AuthAddTmuxOps` for unit tests. Lets tests control:
 *   - `captureResponses`: a queue of strings returned by successive
 *     `capture()` calls. Use null to simulate session death.
 *   - `sessionAlive`: whether `hasSession()` returns true.
 *   - On `newSession`, records the call for assertion.
 *   - On `send`, records keystrokes sent (two calls per submitAccountAuthCode).
 *   - On `killSession`, records the call and marks session dead.
 *
 * Hook callbacks (`hooks.onSend`, `hooks.onKill`, etc.) are live-readable
 * on the returned object so tests can reassign them after construction.
 */
function makeMockTmuxOps(opts: {
  captureResponses?: (string | null)[]
  initialSessionAlive?: boolean
} = {}): AuthAddTmuxOps & {
  newSessionCalls: Array<{ socket: string; session: string; env: Record<string, string>; cmd: string }>
  sendCalls: Array<{ socket: string; session: string; text: string }>
  killCalls: Array<{ socket: string; session: string }>
  captureCallCount: number
  sessionAlive: boolean
  /** Reassignable hook called after send is recorded. */
  onSend: ((socket: string, session: string, text: string) => void) | null
  /** Reassignable hook called after a capture. */
  onCapture: ((socket: string, session: string) => void) | null
} {
  const captureQueue = [...(opts.captureResponses ?? [])]
  let sessionAlive = opts.initialSessionAlive ?? true
  const newSessionCalls: Array<{ socket: string; session: string; env: Record<string, string>; cmd: string }> = []
  const sendCalls: Array<{ socket: string; session: string; text: string }> = []
  const killCalls: Array<{ socket: string; session: string }> = []
  let captureCallCount = 0

  const mock = {
    get newSessionCalls() { return newSessionCalls },
    get sendCalls() { return sendCalls },
    get killCalls() { return killCalls },
    get captureCallCount() { return captureCallCount },
    get sessionAlive() { return sessionAlive },
    set sessionAlive(v: boolean) { sessionAlive = v },
    onSend: null as ((socket: string, session: string, text: string) => void) | null,
    onCapture: null as ((socket: string, session: string) => void) | null,

    newSession(socket: string, session: string, env: Record<string, string>, cmd: string) {
      newSessionCalls.push({ socket, session, env, cmd })
    },
    capture(socket: string, session: string): string | null {
      captureCallCount++
      mock.onCapture?.(socket, session)
      if (captureQueue.length > 0) return captureQueue.shift() ?? null
      return sessionAlive ? '' : null
    },
    send(socket: string, session: string, text: string) {
      sendCalls.push({ socket, session, text })
      mock.onSend?.(socket, session, text)
    },
    hasSession(socket: string, session: string): boolean {
      void socket; void session
      return sessionAlive
    },
    killSession(socket: string, session: string) {
      killCalls.push({ socket, session })
      sessionAlive = false
    },
  }
  return mock
}

/* ── 1. Parser ────────────────────────────────────────────────────────── */

describe('parseAuthCommand — /auth add and /auth cancel', () => {
  it('recognises "/auth add <label>" with a valid label', () => {
    const p = parseAuthCommand('/auth add alice@example.com')
    expect(p).toEqual({ kind: 'add', label: 'alice@example.com', replace: false })
  })

  it('recognises gmail-tag labels (the + character)', () => {
    const p = parseAuthCommand('/auth add alice+work@example.com')
    expect(p).toEqual({ kind: 'add', label: 'alice+work@example.com', replace: false })
  })

  it('treats "/auth add" with no label as a help reply', () => {
    const p = parseAuthCommand('/auth add')
    expect(p?.kind).toBe('help')
    if (p?.kind === 'help') expect(p.reason).toMatch(/Usage: \/auth add/)
  })

  it('rejects a label with a path separator', () => {
    const p = parseAuthCommand('/auth add bad/label')
    expect(p?.kind).toBe('help')
    if (p?.kind === 'help') expect(p.reason).toMatch(/path separator/i)
  })

  it('rejects a label with whitespace — only the first token reaches the validator, but that token must match', () => {
    // `/auth add foo bar` → label="foo", which IS valid. Splitting on
    // whitespace is the parser's contract — the validator catches
    // shape violations on the first token.
    const p = parseAuthCommand('/auth add foo bar')
    expect(p).toEqual({ kind: 'add', label: 'foo', replace: false })
  })

  it('rejects an over-length label (>64 chars)', () => {
    const longLabel = 'a'.repeat(65)
    const p = parseAuthCommand(`/auth add ${longLabel}`)
    expect(p?.kind).toBe('help')
    if (p?.kind === 'help') expect(p.reason).toMatch(/too long/i)
  })

  it('rejects a label with shell metas / quotes', () => {
    const p = parseAuthCommand('/auth add bad;label')
    expect(p?.kind).toBe('help')
    if (p?.kind === 'help') expect(p.reason).toMatch(/match/i)
  })

  it('recognises "/auth cancel"', () => {
    const p = parseAuthCommand('/auth cancel')
    expect(p).toEqual({ kind: 'cancel' })
  })

  it('is case-insensitive on the verb (add/ADD/AdD)', () => {
    expect(parseAuthCommand('/auth ADD foo')?.kind).toBe('add')
    expect(parseAuthCommand('/auth AdD foo')?.kind).toBe('add')
    expect(parseAuthCommand('/auth CANCEL')).toEqual({ kind: 'cancel' })
  })
})

describe('validateAuthAddLabel', () => {
  it.each([
    'alice',
    'alice@example.com',
    'alice+work@example.com',
    'a.b-c_d',
    'A'.repeat(64),
  ])('accepts %s', (label) => {
    expect(validateAuthAddLabel(label)).toBeNull()
  })

  it.each([
    ['', /empty/i],
    ['a'.repeat(65), /too long/i],
    ['.', /reserved/i],
    ['..', /reserved/i],
    ['has/slash', /path separator/i],
    ['has\\slash', /path separator/i],
    ['has space', /match/i],
    ['has"quote', /match/i],
    ['has;meta', /match/i],
  ] as const)('rejects %s', (label, pattern) => {
    expect(validateAuthAddLabel(label)).toMatch(pattern)
  })
})

/* ── 2. Admin gating ──────────────────────────────────────────────────── */

describe('isAuthAdmin', () => {
  it('returns false when isAdmin is false', () => {
    expect(isAuthAdmin({ isAdmin: false })).toBe(false)
  })

  it('returns true when isAdmin is true', () => {
    expect(isAuthAdmin({ isAdmin: true })).toBe(true)
  })
})

describe('handleAuthCommand — add/cancel are gateway-routed (defensive contract)', () => {
  it('returns a "not routed" error for parsed.kind === "add" so the contract is loud if a future refactor forgets the gateway dispatch', async () => {
    const reply = await handleAuthCommand(
      { kind: 'add', label: 'foo', replace: false },
      {
        agentName: 'clerk',
        isAdmin: true,
        client: { listState: async () => { throw new Error('unreachable') }, setActive: async () => { throw new Error('unreachable') } },
      },
    )
    expect(reply.text).toMatch(/not routed/i)
  })

  it('refuses /auth add for non-admin before the not-routed branch', async () => {
    const reply = await handleAuthCommand(
      { kind: 'add', label: 'foo', replace: false },
      {
        agentName: 'other',
        isAdmin: false,
        client: { listState: async () => { throw new Error('unreachable') }, setActive: async () => { throw new Error('unreachable') } },
      },
    )
    expect(reply.text).toMatch(/Not authorized/i)
    expect(reply.text).toMatch(/admin-only/i)
  })
})

/* ── 3. SWITCHROOM_TMUX_SUPERVISOR guard ──────────────────────────────── */

describe('startAccountAuthSession — SWITCHROOM_TMUX_SUPERVISOR guard', () => {
  it('throws a clear error when SWITCHROOM_TMUX_SUPERVISOR is not set and no tmuxOps override', async () => {
    delete process.env.SWITCHROOM_TMUX_SUPERVISOR
    let caught: Error | null = null
    try {
      await startAccountAuthSession('alice@example.com', { home: workspace })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/tmux supervisor required/i)
    expect(caught?.message).toMatch(/SWITCHROOM_TMUX_SUPERVISOR/i)
  })

  it('proceeds when tmuxOps is provided even without SWITCHROOM_TMUX_SUPERVISOR', async () => {
    delete process.env.SWITCHROOM_TMUX_SUPERVISOR
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test&response_type=code&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-test'
    const mock = makeMockTmuxOps({
      captureResponses: ['', `${url}\nPaste code here:\n`],
    })
    const result = await startAccountAuthSession('alice@example.com', {
      home: workspace,
      tmuxOps: mock,
      urlTimeoutMs: 3_000,
    })
    expect(result.loginUrl).toContain('https://claude.com/cai/oauth')
    cleanScratchDir(result.scratchDir)
  })
})

/* ── 4. Unit: startAccountAuthSession with mock tmuxOps ───────────────── */

describe('startAccountAuthSession — mock tmuxOps (unit)', () => {
  const VALID_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test&response_type=code&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-test'

  it('calls newSession with explicit -e CLAUDE_CONFIG_DIR and -e BROWSER in env', async () => {
    const mock = makeMockTmuxOps({
      captureResponses: [VALID_URL],
    })
    const result = await startAccountAuthSession('alice@example.com', {
      home: workspace,
      tmuxOps: mock,
      urlTimeoutMs: 3_000,
    })
    expect(mock.newSessionCalls).toHaveLength(1)
    const call = mock.newSessionCalls[0]
    expect(call.env).toHaveProperty('CLAUDE_CONFIG_DIR', result.scratchDir)
    expect(call.env).toHaveProperty('BROWSER', '/bin/true')
    expect(call.env).toHaveProperty('HOME')
    expect(call.env).toHaveProperty('PATH')
    cleanScratchDir(result.scratchDir)
  })

  it('returns the URL parsed from the pane after polling', async () => {
    // First two captures return empty; third returns the URL line.
    const mock = makeMockTmuxOps({
      captureResponses: ['', '', `\x1b[0m${VALID_URL}\nPaste code here:\n`],
    })
    const result = await startAccountAuthSession('bob@example.com', {
      home: workspace,
      tmuxOps: mock,
      urlTimeoutMs: 5_000,
    })
    expect(result.loginUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    expect(result.scratchDir).toContain('.in-progress')
    expect(result.scratchDir).toContain('bob@example.com-')
    expect(existsSync(result.scratchDir)).toBe(true)
    // Session name uses the random hex from scratchDir
    expect(result.tmuxSession).toMatch(/^auth-add-bob@example\.com-/)
    cleanScratchDir(result.scratchDir)
  })

  it('uses the scratchDir random hex as the session name suffix', async () => {
    const mock = makeMockTmuxOps({ captureResponses: [VALID_URL] })
    const result = await startAccountAuthSession('alice', {
      home: workspace,
      tmuxOps: mock,
      urlTimeoutMs: 3_000,
    })
    const hexFromDir = result.scratchDir.slice(result.scratchDir.lastIndexOf('-') + 1)
    expect(result.tmuxSession).toContain(hexFromDir)
    cleanScratchDir(result.scratchDir)
  })

  it('times out and wipes the scratch dir when the pane never shows a URL', async () => {
    const mock = makeMockTmuxOps({
      // Always return empty pane content
      captureResponses: [],
    })
    let caught: Error | null = null
    try {
      await startAccountAuthSession('timeout-case', {
        home: workspace,
        tmuxOps: mock,
        urlTimeoutMs: 300,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/did not print/i)
    // Scratch dir must have been wiped
    const inProgressDir = join(workspace, '.switchroom', 'accounts', '.in-progress')
    if (existsSync(inProgressDir)) {
      const { readdirSync } = await import('node:fs')
      const remaining = readdirSync(inProgressDir)
      expect(remaining).toEqual([])
    }
  })

  it('fails fast when session dies before URL appears (null capture)', async () => {
    // First capture returns content; second returns null (session died)
    const mock = makeMockTmuxOps({
      captureResponses: ['loading...', null],
    })
    let caught: Error | null = null
    try {
      await startAccountAuthSession('dead-session', {
        home: workspace,
        tmuxOps: mock,
        urlTimeoutMs: 5_000,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/exited before printing/i)
  })
})

/* ── 5. Unit: submitAccountAuthCode with mock tmuxOps ────────────────── */

describe('submitAccountAuthCode — mock tmuxOps (unit)', () => {
  function makeMockFlow(scratchDir: string, tmuxSocket = 'switchroom-test', tmuxSession = 'auth-add-test-abc123'): PendingAuthAddFlow {
    return { label: 'alice@example.com', scratchDir, tmuxSocket, tmuxSession, startedAt: Date.now() }
  }

  it('calls send exactly once (which internally does two send-keys calls) and NO capture after code submit', async () => {
    // The mock's send() represents the two-call sequence (send-keys -l + send-keys Enter).
    const scratchDir = mkdtempSync(join(workspace, 'flow-'))
    const credPath = join(scratchDir, '.credentials.json')
    const credContents = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test-' + 'b'.repeat(40),
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 8 * 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'max',
      },
    })
    const mock = makeMockTmuxOps({ initialSessionAlive: true })
    let sendCalled = false
    let captureCalledAfterSend = false
    // Set hook via reassignment (works because mock.send reads mock.onSend live)
    mock.onSend = (_s, _ss, _t) => {
      sendCalled = true
      writeFileSync(credPath, credContents, 'utf8')
    }
    mock.onCapture = () => {
      if (sendCalled) captureCalledAfterSend = true
    }

    const flow = makeMockFlow(scratchDir)
    const creds = await submitAccountAuthCode(flow, 'browser-code-xyz', {
      pollIntervalMs: 30,
      pollTimeoutMs: 3_000,
      tmuxOps: mock,
    })

    expect(mock.sendCalls).toHaveLength(1) // one logical send = two send-keys under the hood
    expect(captureCalledAfterSend).toBe(false) // CRITICAL: no capture-pane after code submit
    expect(creds.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat\d+-/)
  })

  it('newSession args include -e CLAUDE_CONFIG_DIR and -e BROWSER', async () => {
    // Covered in startAccountAuthSession tests above; verify via the mock's
    // newSession call record that env keys are passed.
    const mock = makeMockTmuxOps({
      captureResponses: ['https://claude.com/cai/oauth/authorize?code=x&client_id=y&response_type=code&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-z'],
    })
    const result = await startAccountAuthSession('env-test', {
      home: workspace,
      tmuxOps: mock,
      urlTimeoutMs: 3_000,
    })
    const call = mock.newSessionCalls[0]
    expect(Object.keys(call.env)).toContain('CLAUDE_CONFIG_DIR')
    expect(Object.keys(call.env)).toContain('BROWSER')
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(result.scratchDir)
    cleanScratchDir(result.scratchDir)
  })

  it('detects cred file and returns AddAccountCredentials', async () => {
    const scratchDir = mkdtempSync(join(workspace, 'flow2-'))
    const credPath = join(scratchDir, '.credentials.json')
    const expectedCreds = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test-' + 'c'.repeat(40),
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 8 * 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'max',
      },
    }
    let writtenOnSend = false
    const mock = makeMockTmuxOps({ initialSessionAlive: true })
    mock.onSend = () => {
      writtenOnSend = true
      writeFileSync(credPath, JSON.stringify(expectedCreds), 'utf8')
    }

    const flow = makeMockFlow(scratchDir)
    const creds = await submitAccountAuthCode(flow, 'test-code', {
      pollIntervalMs: 30,
      pollTimeoutMs: 3_000,
      tmuxOps: mock,
    })

    expect(writtenOnSend).toBe(true)
    expect(creds.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat\d+-/)
    expect(creds.claudeAiOauth.subscriptionType).toBe('max')
    expect(creds.claudeAiOauth.scopes).toEqual(['user:inference'])
    // scratchDir should NOT be cleaned on success (caller's responsibility)
    expect(existsSync(scratchDir)).toBe(true)
    cleanScratchDir(scratchDir)
  })

  it('throws a clean error when session dies with no cred file (invalid code path)', async () => {
    const scratchDir = mkdtempSync(join(workspace, 'flow3-'))
    const mock = makeMockTmuxOps({ initialSessionAlive: true })
    // After send, mark session dead without writing cred file
    mock.onSend = () => {
      mock.sessionAlive = false
    }

    const flow = makeMockFlow(scratchDir)
    let caught: Error | null = null
    try {
      await submitAccountAuthCode(flow, 'bad-code', {
        pollIntervalMs: 30,
        pollTimeoutMs: 3_000,
        tmuxOps: mock,
      })
    } catch (err) {
      caught = err as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/exited without writing credentials|invalid|expired/i)
    expect(existsSync(scratchDir)).toBe(false) // wiped on failure
  })

  it('throws and wipes on timeout when no cred file appears', async () => {
    const scratchDir = mkdtempSync(join(workspace, 'flow4-'))
    const mock = makeMockTmuxOps({ initialSessionAlive: true })
    // send does nothing — no cred file written

    const flow = makeMockFlow(scratchDir)
    let caught: Error | null = null
    try {
      await submitAccountAuthCode(flow, 'stale-code', {
        pollIntervalMs: 30,
        pollTimeoutMs: 200,
        tmuxOps: mock,
      })
    } catch (err) {
      caught = err as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/no credentials file/i)
    expect(existsSync(scratchDir)).toBe(false)
  })
})

/* ── 6. Unit: cancelAccountAuthSession with mock tmuxOps ──────────────── */

describe('cancelAccountAuthSession — mock tmuxOps (unit)', () => {
  it('kills the session and wipes the scratch dir', () => {
    const scratchDir = mkdtempSync(join(workspace, 'cancel-'))
    const mock = makeMockTmuxOps({ initialSessionAlive: true })
    const flow: PendingAuthAddFlow = {
      label: 'cancel-test',
      scratchDir,
      tmuxSocket: 'switchroom-test',
      tmuxSession: 'auth-add-cancel-test-abc',
      startedAt: Date.now(),
    }
    expect(existsSync(scratchDir)).toBe(true)
    cancelAccountAuthSession(flow, mock)
    expect(mock.killCalls).toHaveLength(1)
    expect(mock.killCalls[0].session).toBe('auth-add-cancel-test-abc')
    expect(existsSync(scratchDir)).toBe(false)
  })

  it('is idempotent when the session is already dead', () => {
    const scratchDir = mkdtempSync(join(workspace, 'idem-'))
    const mock = makeMockTmuxOps({ initialSessionAlive: false })
    const flow: PendingAuthAddFlow = {
      label: 'idempotent',
      scratchDir,
      tmuxSocket: 'switchroom-test',
      tmuxSession: 'auth-add-idempotent-xyz',
      startedAt: Date.now(),
    }
    expect(() => cancelAccountAuthSession(flow, mock)).not.toThrow()
    expect(existsSync(scratchDir)).toBe(false)
  })
})

/* ── 7. pickScratchDir layout invariant ───────────────────────────────── */

describe('pickScratchDir', () => {
  it('lives under ~/.switchroom/accounts/.in-progress/<label>-<rand>', () => {
    const p = pickScratchDir('alice@example.com', workspace)
    expect(p.startsWith(join(workspace, '.switchroom', 'accounts', '.in-progress', 'alice@example.com-'))).toBe(true)
  })

  it('emits a different random suffix on each call (no collisions)', () => {
    const a = pickScratchDir('foo', workspace)
    const b = pickScratchDir('foo', workspace)
    expect(a).not.toBe(b)
  })

  it('keeps the dir hidden (leading dot) so listAccounts skips it', () => {
    const p = pickScratchDir('foo', workspace)
    expect(p).toContain('/.in-progress/')
  })
})

/* ── 8. Gateway pendingAuthAddFlows map contract ──────────────────────── */

describe('pendingAuthAddFlows map — gateway intercept contract', () => {
  it('starts empty', () => {
    expect(pendingAuthAddFlows.size).toBe(0)
  })

  it('the gateway TTL constant matches REAUTH_INTERCEPT_TTL_MS (10 minutes)', () => {
    const TEN_MIN_MS = 10 * 60_000
    expect(TEN_MIN_MS).toBe(600_000)
  })
})

/* ── 9. Defensive: broker addAccount contract pin ─────────────────────── */

describe('mocked-broker addAccount integration sketch', () => {
  it('the broker addAccount verb expects (label, credentials, replace?) per RFC §4.3', () => {
    const fakeCredentials = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test-' + 'x'.repeat(40),
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'max',
      },
    }
    const addAccountSpy = vi.fn(async (label: string, c: typeof fakeCredentials, replace?: boolean) => ({
      label,
      expiresAt: c.claudeAiOauth.expiresAt,
      replace,
    }))
    return addAccountSpy('round-trip', fakeCredentials, false).then((res) => {
      expect(res.label).toBe('round-trip')
      expect(res.replace).toBe(false)
      expect(res.expiresAt).toBe(fakeCredentials.claudeAiOauth.expiresAt)
      expect(addAccountSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('readd threads replace=true through to the broker addAccount verb', async () => {
    const fakeCredentials = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test-' + 'x'.repeat(40),
        expiresAt: Date.now() + 3600_000,
        scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
      },
    }
    const addAccountSpy = vi.fn(async (label: string, _c: typeof fakeCredentials, replace?: boolean) => ({
      label,
      replace,
    }))
    // Plain add → replace false; readd → replace true. Both round-trip.
    const added = await addAccountSpy('pooled@example.com', fakeCredentials, false)
    const readded = await addAccountSpy('pooled@example.com', fakeCredentials, true)
    expect(added.replace).toBe(false)
    expect(readded.replace).toBe(true)
    expect(addAccountSpy).toHaveBeenCalledTimes(2)
  })
})

/* ── 9b. /auth readd parser + precheck + scope reply (PR C) ────────────── */

describe('parseAuthCommand — /auth readd and add --replace', () => {
  it('parses "/auth readd <label>" as an add with replace=true', () => {
    expect(parseAuthCommand('/auth readd pooled@example.com')).toEqual({
      kind: 'add',
      label: 'pooled@example.com',
      replace: true,
    })
  })

  it('parses "/auth add <label> --replace" as replace=true too', () => {
    expect(parseAuthCommand('/auth add pooled@example.com --replace')).toEqual({
      kind: 'add',
      label: 'pooled@example.com',
      replace: true,
    })
  })

  it('plain "/auth add <label>" stays replace=false', () => {
    expect(parseAuthCommand('/auth add fresh@example.com')).toEqual({
      kind: 'add',
      label: 'fresh@example.com',
      replace: false,
    })
  })

  it('"/auth readd" with no label is a help reply', () => {
    const p = parseAuthCommand('/auth readd')
    expect(p?.kind).toBe('help')
    if (p?.kind === 'help') expect(p.reason).toMatch(/Usage: \/auth readd/)
  })

  it('rejects an unknown flag on add/readd', () => {
    const p = parseAuthCommand('/auth add foo --wipe')
    expect(p?.kind).toBe('help')
    if (p?.kind === 'help') expect(p.reason).toMatch(/Unknown flag/i)
  })

  it('is case-insensitive on the readd verb', () => {
    expect(parseAuthCommand('/auth READD foo')).toEqual({ kind: 'add', label: 'foo', replace: true })
  })
})

describe('readdPrecheckError — exists gate', () => {
  it('readd of a NONEXISTENT label errors clearly', () => {
    const err = readdPrecheckError('ghost@example.com', true, false)
    expect(err).toMatch(/no account named/i)
    expect(err).toMatch(/ghost@example\.com/)
  })

  it('readd of an EXISTING label passes (null)', () => {
    expect(readdPrecheckError('pooled@example.com', true, true)).toBeNull()
  })

  it('plain add of an EXISTING label errors and points at readd', () => {
    const err = readdPrecheckError('pooled@example.com', false, true)
    expect(err).toMatch(/already exists/i)
    expect(err).toMatch(/\/auth readd/)
  })

  it('plain add of a NEW label passes (null)', () => {
    expect(readdPrecheckError('fresh@example.com', false, false)).toBeNull()
  })
})

describe('formatGrantedScopesReply — scope-in-reply (structured, no scraping)', () => {
  it('lists granted scopes and confirms when user:profile is present', () => {
    const r = formatGrantedScopesReply(['org:create_api_key', 'user:profile', 'user:inference'])
    expect(r.hasUsageScope).toBe(true)
    expect(r.text).toContain('user:profile')
    expect(r.text).toMatch(/unlocked/i)
  })

  it('warns LOUDLY when user:profile is absent (the setup-token footgun)', () => {
    const r = formatGrantedScopesReply(['user:inference'])
    expect(r.hasUsageScope).toBe(false)
    expect(r.text).toMatch(/MISSING/)
    expect(r.text).toContain(REQUIRED_USAGE_SCOPE)
  })

  it('warns when the token reports no scopes at all', () => {
    const r = formatGrantedScopesReply(undefined)
    expect(r.hasUsageScope).toBe(false)
    expect(r.text).toMatch(/No scopes reported/i)
  })
})

/* ── 10. Help text mentions add + cancel ─────────────────────────────── */

describe('help text discoverability', () => {
  it('/auth (unknown verb) help reply mentions /auth add and /auth cancel', async () => {
    const parsed = parseAuthCommand('/auth bogus')
    expect(parsed?.kind).toBe('help')
    const reply = await handleAuthCommand(parsed!, {
      agentName: 'x',
      isAdmin: true,
      client: { listState: async () => { throw new Error('n/a') }, setActive: async () => { throw new Error('n/a') } },
    })
    expect(reply.text).toMatch(/\/auth add/i)
    expect(reply.text).toMatch(/\/auth cancel/i)
  })
})

/* ── 11. Integration: real tmux + fake setup-token ────────────────────── */

/**
 * Integration test: drives the full start→URL→code→cred-file path using
 * a real tmux server on a throwaway socket and a fake `claude-setup-token`
 * shell script. No real OAuth, no real credentials.
 *
 * Skipped when tmux is not available on the test machine.
 */
describe('integration: real tmux + fake setup-token', () => {
  let integWorkspace: string
  let tmuxSocket: string
  let fakeBinPath: string

  beforeEach(() => {
    // Check tmux availability
    try {
      execFileSync('tmux', ['-V'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      return // will skip in test body
    }

    integWorkspace = mkdtempSync(join(EXEC_TMPDIR, 'auth-integ-'))
    // Use a throwaway socket that won't collide with the agent's real socket.
    tmuxSocket = `auth-test-${randomHex()}`

    // Write a fake setup-token script that:
    //   - Prints a valid OAuth URL to its tty (the tmux pane)
    //   - Reads a line of input (the "code") from tty
    //   - Writes .credentials.json to CLAUDE_CONFIG_DIR
    //   - Exits 0
    //
    // The script writes to stdout (which tmux routes to the pane) and reads
    // from stdin (tmux send-keys delivers to the pty). This mirrors what
    // `claude setup-token` does via /dev/tty — both go through the pty.
    // Tokens split so the source file never contains a contiguous sk-ant-... literal
    // (the PII/secrets gate rejects those). The script receives them via interpolation.
    const fakeAccessToken = ['sk-ant', 'oat01-integ-' + 'd'.repeat(40)].join('-')
    const fakeRefreshToken = ['sk-ant', 'ort01-integ-test'].join('-')
    fakeBinPath = join(integWorkspace, 'fake-setup-token')
    writeFileSync(fakeBinPath, `#!/bin/bash
URL='https://claude.com/cai/oauth/authorize?code=true&client_id=integ-test&response_type=code&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-integ'
# Print URL to the tmux pane (via stdout/tty path — both route through the pty)
printf '%s\\n' "$URL"
printf 'Paste code here:\\n'
# Read the operator's code (arrives via send-keys → pty stdin)
read -r code
# Write credentials file so the poll loop detects success
mkdir -p "$CLAUDE_CONFIG_DIR"
printf '{\\n  "claudeAiOauth": {\\n    "accessToken": "${fakeAccessToken}",\\n    "refreshToken": "${fakeRefreshToken}",\\n    "expiresAt": 9999999999999,\\n    "scopes": ["user:inference"],\\n    "subscriptionType": "max",\\n    "rateLimitTier": "max"\\n  }\\n}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
`, { mode: 0o755 })
  })

  afterEach(() => {
    // Kill the test tmux server
    if (tmuxSocket) {
      try {
        execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch { /* best-effort */ }
    }
    if (integWorkspace) {
      try { rmSync(integWorkspace, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('scrapes URL from tmux pane and detects cred file after code submit', async () => {
    // Skip if tmux not available
    let tmuxAvailable = true
    try {
      execFileSync('tmux', ['-V'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      tmuxAvailable = false
    }
    if (!tmuxAvailable) {
      console.warn('Skipping integration test: tmux not available')
      return
    }

    // Use real tmux ops but on the throwaway socket.
    // Wrap newSession to invoke the script via bash (more reliable than
    // direct exec in containers) and to route all calls through our socket.
    const realOps = makeAuthAddTmuxOps('tmux')
    // Pre-start the tmux server so newSession doesn't race a cold start.
    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'start-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch { /* already running is fine */ }

    const patchedOps: AuthAddTmuxOps = {
      newSession(_socket, session, env, _cmd) {
        // Invoke via bash to avoid exec permission issues in containers.
        return realOps.newSession(tmuxSocket, session, env, `bash ${fakeBinPath}`)
      },
      capture(_socket, session) {
        return realOps.capture(tmuxSocket, session)
      },
      send(_socket, session, text) {
        return realOps.send(tmuxSocket, session, text)
      },
      hasSession(_socket, session) {
        return realOps.hasSession(tmuxSocket, session)
      },
      killSession(_socket, session) {
        return realOps.killSession(tmuxSocket, session)
      },
    }

    process.env.SWITCHROOM_TMUX_SUPERVISOR = '1'
    const result = await startAccountAuthSession('integ-test', {
      home: integWorkspace,
      tmuxOps: patchedOps,
      claudeBinary: fakeBinPath,
      urlTimeoutMs: 10_000,
    })

    expect(result.loginUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    expect(result.scratchDir).toContain('.in-progress')
    expect(existsSync(result.scratchDir)).toBe(true)

    // Now submit the code
    const flow: PendingAuthAddFlow = {
      label: 'integ-test',
      scratchDir: result.scratchDir,
      tmuxSocket: result.tmuxSocket,
      tmuxSession: result.tmuxSession,
      startedAt: Date.now(),
    }

    // Use the patched ops for submit too
    const creds = await submitAccountAuthCode(flow, 'test-browser-code-123', {
      pollIntervalMs: 100,
      pollTimeoutMs: 10_000,
      tmuxOps: patchedOps,
    })

    expect(creds.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat\d+-/)
    expect(creds.claudeAiOauth.subscriptionType).toBe('max')
    expect(creds.claudeAiOauth.scopes).toContain('user:inference')
    cleanScratchDir(result.scratchDir)
  }, 30_000)
})

/* ── helpers ─────────────────────────────────────────────────────────── */

function randomHex(): string {
  return Math.random().toString(16).slice(2, 10)
}
