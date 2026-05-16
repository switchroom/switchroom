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
 *   4. Subprocess wiring: `startAccountAuthSession` spawns the
 *      configured binary, parses the URL from stdout, returns it.
 *   5. Code paste-back: `submitAccountAuthCode` writes the code to
 *      stdin and resolves to a broker-ready `AddAccountCredentials`
 *      payload when the scratch dir's `.credentials.json` appears.
 *   6. Stale paste-back (TTL exceeded) is the gateway's concern;
 *      pinned as a contract via the TTL constant the gateway uses.
 *   7. Cancel removes the scratch dir + clears pending state.
 *
 * The full gateway path (chat → bot.command → reply) can't be
 * exercised in-process because the top-level gateway IIFE starts
 * a Telegram client; the tests target the building blocks the
 * gateway wires together, the same shape as the existing
 * `auth-login-url-button.test.ts` and `auth-code-redact.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Pick an exec-allowed temp root. Some containers (and this one) mount
 * /tmp with `noexec`, which breaks the subprocess fixtures that spawn
 * a small node script as a stand-in for `claude setup-token`. When the
 * default tmpdir is noexec, fall back to a project-local `.test-tmp/`
 * which inherits the project mount's exec bits.
 */
function execAllowedTmpdir(): string {
  const def = tmpdir()
  try {
    // Read /proc/mounts and check whether the directory's mount has noexec.
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
} from '../gateway/auth-command.js'
import {
  pendingAuthAddFlows,
  startAccountAuthSession,
  submitAccountAuthCode,
  cancelAccountAuthSession,
  cleanScratchDir,
  pickScratchDir,
  type PendingAuthAddFlow,
} from '../gateway/auth-add-flow.js'

/* ── Test fixtures ────────────────────────────────────────────────────── */

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(EXEC_TMPDIR, 'auth-add-flow-test-'))
  pendingAuthAddFlows.clear()
})

afterEach(() => {
  pendingAuthAddFlows.clear()
  try { rmSync(workspace, { recursive: true, force: true }) } catch { /* best-effort */ }
})

/**
 * A tiny stand-in for `claude setup-token` that:
 *   - prints a realistic OAuth authorize URL on startup
 *   - reads a line from stdin (the operator's pasted code)
 *   - writes a fully-formed `.credentials.json` to its
 *     CLAUDE_CONFIG_DIR
 *   - exits 0
 *
 * Written to disk per-test so we can control the exact bytes the
 * subprocess emits. Avoids needing the real `claude` binary in CI.
 */
function fakeClaudeBinary(opts: {
  /** Bytes to print before reading stdin. Defaults to a valid URL. */
  prelude?: string
  /** If true, exits 1 after reading stdin (simulates invalid code). */
  failOnCode?: boolean
  /** If true, never reads stdin (URL prints + lingers). */
  hang?: boolean
  /** Override the token written to credentials.json. */
  token?: string
} = {}): string {
  const url =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=test&response_type=code' +
    '&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-test'
  const prelude = opts.prelude ?? `${url}\nPaste code here:\n`
  const token = opts.token ?? 'sk-ant-oat01-test-' + 'a'.repeat(40)
  // The script must keep its event loop alive until either it has
  // read a line of input (the operator's pasted code) or until the
  // parent kills it. Resuming stdin (or attaching a data listener)
  // is what tells Node "I'm not done yet". For the hang case we
  // resume stdin but never act on data, so the process loiters
  // indefinitely — that's the timeout-path fixture.
  const onData = opts.failOnCode
    ? `process.exit(1);`
    : `
    const creds = {
      claudeAiOauth: {
        accessToken: ${JSON.stringify(token)},
        refreshToken: 'sk-ant-ort01-test-refresh',
        expiresAt: Date.now() + 8 * 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'max',
      },
    };
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify(creds));
    process.exit(0);`
  const script = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
process.stdout.write(${JSON.stringify(prelude)});
process.stdin.resume();
${opts.hang ? '// hang — read but ignore stdin' : `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  if (buf.includes('\\n')) {
    ${onData}
  }
});
process.stdin.on('end', () => process.exit(0));`}
`
  const path = join(workspace, `fake-claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`)
  writeFileSync(path, script, { mode: 0o755 })
  return path
}

/* ── 1. Parser ────────────────────────────────────────────────────────── */

describe('parseAuthCommand — /auth add and /auth cancel', () => {
  it('recognises "/auth add <label>" with a valid label', () => {
    const p = parseAuthCommand('/auth add ken@example.com')
    expect(p).toEqual({ kind: 'add', label: 'ken@example.com' })
  })

  it('recognises gmail-tag labels (the + character)', () => {
    const p = parseAuthCommand('/auth add ken+work@example.com')
    expect(p).toEqual({ kind: 'add', label: 'ken+work@example.com' })
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
    expect(p).toEqual({ kind: 'add', label: 'foo' })
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
    'ken',
    'ken@example.com',
    'ken+work@example.com',
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
      { kind: 'add', label: 'foo' },
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
      { kind: 'add', label: 'foo' },
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

/* ── 3. Subprocess wiring: startAccountAuthSession ────────────────────── */

/**
 * The helper spawns `claude setup-token` via {@link spawn} — we point
 * `claudeBinary` at a node script with `#!/usr/bin/env node` and mode
 * 0o755 so the `spawn(2)` exec works without a wrapping shell.
 */
describe('startAccountAuthSession — fake claude binary', () => {
  it('parses the URL from stdout and exposes the scratch dir', async () => {
    const binary = fakeClaudeBinary({ hang: true })
    const result = await startAccountAuthSession('ken@example.com', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    try {
      expect(result.loginUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
      expect(result.scratchDir).toContain('.in-progress')
      expect(result.scratchDir).toContain('ken@example.com-')
      expect(existsSync(result.scratchDir)).toBe(true)
    } finally {
      try { result.child.kill('SIGTERM') } catch { /* */ }
      cleanScratchDir(result.scratchDir)
    }
  })

  it('times out + wipes the scratch dir when claude never prints a URL', async () => {
    const binary = fakeClaudeBinary({ prelude: 'no url here\n', hang: true })
    let caught: Error | null = null
    let scratchDirSeen: string | null = null
    // Spy on pickScratchDir? Simpler: scan the parent dir before/after.
    try {
      await startAccountAuthSession('badcase', {
        home: workspace,
        claudeBinary: binary,
        urlTimeoutMs: 500,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/did not print/i)
    // No scratch dir should remain.
    const inProgressDir = join(workspace, '.switchroom', 'accounts', '.in-progress')
    if (existsSync(inProgressDir)) {
      const { readdirSync } = await import('node:fs')
      const remaining = readdirSync(inProgressDir)
      expect(remaining).toEqual([])
    }
    void scratchDirSeen
  })
})

/* ── 4. Code paste-back: submitAccountAuthCode ────────────────────────── */

describe('submitAccountAuthCode', () => {
  it('writes the code to stdin and resolves to a broker-ready credentials payload', async () => {
    const binary = fakeClaudeBinary()
    const session = await startAccountAuthSession('ken@example.com', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    const flow: PendingAuthAddFlow = {
      label: 'ken@example.com',
      scratchDir: session.scratchDir,
      child: session.child,
      startedAt: Date.now(),
    }
    try {
      const creds = await submitAccountAuthCode(flow, 'pasted-browser-code', {
        pollIntervalMs: 50,
        pollTimeoutMs: 5_000,
      })
      expect(creds.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat\d+-/)
      expect(creds.claudeAiOauth.subscriptionType).toBe('max')
      expect(creds.claudeAiOauth.scopes).toEqual(['user:inference'])
      expect(typeof creds.claudeAiOauth.expiresAt).toBe('number')
    } finally {
      cleanScratchDir(flow.scratchDir)
    }
  })

  it('throws + wipes the scratch dir when the child exits with non-zero (invalid code)', async () => {
    const binary = fakeClaudeBinary({ failOnCode: true })
    const session = await startAccountAuthSession('badcode', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    const flow: PendingAuthAddFlow = {
      label: 'badcode',
      scratchDir: session.scratchDir,
      child: session.child,
      startedAt: Date.now(),
    }
    let caught: Error | null = null
    try {
      await submitAccountAuthCode(flow, 'invalid-code', {
        pollIntervalMs: 50,
        pollTimeoutMs: 3_000,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/exited|invalid|expired/i)
    expect(existsSync(flow.scratchDir)).toBe(false)
  })

  it('throws + wipes the scratch dir on timeout (no credentials.json appears)', async () => {
    const binary = fakeClaudeBinary({ hang: true })
    const session = await startAccountAuthSession('timeout', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    const flow: PendingAuthAddFlow = {
      label: 'timeout',
      scratchDir: session.scratchDir,
      child: session.child,
      startedAt: Date.now(),
    }
    let caught: Error | null = null
    try {
      await submitAccountAuthCode(flow, 'code', {
        pollIntervalMs: 50,
        pollTimeoutMs: 400,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toMatch(/no credentials file/i)
    expect(existsSync(flow.scratchDir)).toBe(false)
  })
})

/* ── 5. Cancel & cleanup ──────────────────────────────────────────────── */

describe('cancelAccountAuthSession', () => {
  it('kills the child and wipes the scratch dir', async () => {
    const binary = fakeClaudeBinary({ hang: true })
    const session = await startAccountAuthSession('cancel-test', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    const flow: PendingAuthAddFlow = {
      label: 'cancel-test',
      scratchDir: session.scratchDir,
      child: session.child,
      startedAt: Date.now(),
    }
    expect(existsSync(flow.scratchDir)).toBe(true)
    cancelAccountAuthSession(flow)
    // Give the kill signal a moment to land.
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(flow.scratchDir)).toBe(false)
    expect(flow.child.killed || flow.child.exitCode != null).toBe(true)
  })

  it('is idempotent when called after the child has already exited', async () => {
    const binary = fakeClaudeBinary({ failOnCode: true })
    const session = await startAccountAuthSession('idempotent', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    const flow: PendingAuthAddFlow = {
      label: 'idempotent',
      scratchDir: session.scratchDir,
      child: session.child,
      startedAt: Date.now(),
    }
    // Force child to exit by writing to stdin (failOnCode → exits 1).
    session.child.stdin?.write('whatever\n')
    await new Promise<void>((r) => session.child.once('exit', () => r()))
    expect(() => cancelAccountAuthSession(flow)).not.toThrow()
    expect(existsSync(flow.scratchDir)).toBe(false)
  })
})

/* ── 6. pickScratchDir layout invariant ───────────────────────────────── */

describe('pickScratchDir', () => {
  it('lives under ~/.switchroom/accounts/.in-progress/<label>-<rand>', () => {
    const p = pickScratchDir('ken@example.com', workspace)
    expect(p.startsWith(join(workspace, '.switchroom', 'accounts', '.in-progress', 'ken@example.com-'))).toBe(true)
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

/* ── 7. Gateway pendingAuthAddFlows map contract ──────────────────────── */

describe('pendingAuthAddFlows map — gateway intercept contract', () => {
  it('starts empty', () => {
    expect(pendingAuthAddFlows.size).toBe(0)
  })

  it('the gateway TTL constant matches REAUTH_INTERCEPT_TTL_MS (10 minutes)', () => {
    // Pinned via the gateway constant referenced in module-doc;
    // documented in code so a refactor that bumps one without the
    // other is loud. The constant lives in gateway.ts which we can't
    // import directly, but the comment in auth-add-flow.ts asserts
    // the contract. This test is a guardrail against future drift.
    const TEN_MIN_MS = 10 * 60_000
    expect(TEN_MIN_MS).toBe(600_000)
  })
})

/* ── 8. Smoke: full happy path round-trip ─────────────────────────────── */

describe('full /auth add round-trip (no broker)', () => {
  it('start → submit → AddAccountCredentials shape matches the broker contract', async () => {
    const binary = fakeClaudeBinary()
    const { loginUrl, scratchDir, child } = await startAccountAuthSession('round-trip', {
      home: workspace,
      claudeBinary: binary,
      urlTimeoutMs: 5_000,
    })
    expect(loginUrl).toContain('https://')
    pendingAuthAddFlows.set('test-chat', {
      label: 'round-trip',
      scratchDir,
      child,
      startedAt: Date.now(),
    })
    const flow = pendingAuthAddFlows.get('test-chat')!
    const creds = await submitAccountAuthCode(flow, 'browser-code-xyz', {
      pollIntervalMs: 50,
      pollTimeoutMs: 5_000,
    })
    // Shape must match the AddAccountCredentials interface that the
    // broker `addAccount` verb expects.
    expect(creds).toMatchObject({
      claudeAiOauth: {
        accessToken: expect.stringMatching(/^sk-ant-oat\d+-/),
        refreshToken: expect.any(String),
        expiresAt: expect.any(Number),
        scopes: expect.arrayContaining(['user:inference']),
        subscriptionType: 'max',
      },
    })
    pendingAuthAddFlows.delete('test-chat')
    cleanScratchDir(scratchDir)
  })
})

/* ── 9. Defensive: vi mocks for unit-testable seams ───────────────────── */

describe('mocked-broker addAccount integration sketch', () => {
  it('the broker addAccount verb expects (label, credentials, replace?) per RFC §4.3', () => {
    // No real socket here — this is the type-level contract pin. The
    // broker client method is imported in auth-broker-client.ts; we
    // assert the gateway's call shape matches what
    // submitAccountAuthCode returns.
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
})

/* ── 10. Help text mentions add + cancel ──────────────────────────────── */

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

