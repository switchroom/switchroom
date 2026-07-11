/**
 * Telegram-native OAuth loopback relay coverage (issue #2582).
 *
 * Pins the deterministic contracts that make Google/Microsoft account
 * add/re-auth completable entirely over Telegram — no SSH, no keyboard:
 *
 *   1. Redirect-URL parser: valid / no-scheme / missing-state / missing-code /
 *      wrong-host / wrong-port / provider-error.
 *   2. Consent-URL extraction + parse: state + loopback port pulled out;
 *      non-loopback redirect rejected.
 *   3. startLoopbackFlow surfaces the consent URL scraped from CLI stdout.
 *   4. A valid paste completes the (mocked) exchange and resolves ok.
 *   5. A wrong-state paste is REJECTED and the flow stays pending (retryable).
 *   6. A second paste after completion is rejected (single-use).
 *   7. Verb parser: `/auth google add` / `/auth microsoft add` + flags.
 *
 * Outcome-asserting (not code-path-touching): each test checks the ok/reason
 * the relay returns, and that pending state is or isn't cleared.
 */

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'

import {
  parseLoopbackRedirect,
  extractConsentUrl,
  parseConsentUrl,
  startLoopbackFlow,
  submitLoopbackRedirect,
  scrubSensitive,
  shouldConsumeLoopbackPaste,
  trackFlowExit,
  cancelLoopbackFlow,
  MAX_PASTE_ATTEMPTS,
  type RelayChild,
  type PendingLoopbackFlow,
} from '../gateway/auth-loopback-relay.js'
import { parseAuthCommand } from '../gateway/auth-command.js'

// A fake child process satisfying the narrow RelayChild seam. Emits stdout /
// stderr / exit on demand so tests drive the relay with no real CLI.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

function makeChild(): FakeChild {
  const c = new FakeChild()
  // The relay reads child.stdout / child.stderr as ReadableStream; the
  // EventEmitter satisfies the `.on('data', …)` usage.
  return c
}

const STATE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'
const PORT = 43117
const GOOGLE_CONSENT = `https://accounts.google.com/o/oauth2/auth?client_id=x.apps.googleusercontent.com&redirect_uri=${encodeURIComponent(
  `http://127.0.0.1:${PORT}`,
)}&response_type=code&scope=drive&state=${STATE}`

// ─── Redirect-URL parser ─────────────────────────────────────────────────────

describe('parseLoopbackRedirect', () => {
  it('accepts a full loopback redirect with code + state', () => {
    const r = parseLoopbackRedirect(
      `http://127.0.0.1:${PORT}/?code=4/abc-DEF_ghi&state=${STATE}`,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.port).toBe(PORT)
      expect(r.state).toBe(STATE)
      expect(r.code).toBe('4/abc-DEF_ghi')
    }
  })

  it('tolerates a missing scheme and surrounding whitespace', () => {
    const r = parseLoopbackRedirect(`  127.0.0.1:${PORT}/?code=xyz&state=${STATE}  `)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.host).toBe('127.0.0.1')
  })

  it('rejects a non-loopback host', () => {
    const r = parseLoopbackRedirect(`http://evil.example/?code=xyz&state=${STATE}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/127\.0\.0\.1/)
  })

  it('rejects a missing state parameter', () => {
    const r = parseLoopbackRedirect(`http://127.0.0.1:${PORT}/?code=xyz`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/state/)
  })

  it('rejects a missing code parameter', () => {
    const r = parseLoopbackRedirect(`http://127.0.0.1:${PORT}/?state=${STATE}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/code/)
  })

  it('surfaces a provider error param', () => {
    const r = parseLoopbackRedirect(`http://127.0.0.1:${PORT}/?error=access_denied`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/access_denied/)
  })

  it('rejects a missing port', () => {
    const r = parseLoopbackRedirect(`http://127.0.0.1/?code=xyz&state=${STATE}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/port/)
  })
})

// ─── Consent-URL extraction + parse ──────────────────────────────────────────

describe('extractConsentUrl + parseConsentUrl', () => {
  it('pulls the Google consent URL out of noisy CLI stdout', () => {
    const stdout = `Opening your browser to authorize this agent...\n  ${GOOGLE_CONSENT}\n\nWaiting for browser callback...`
    const url = extractConsentUrl(stdout, 'google')
    expect(url).toBe(GOOGLE_CONSENT)
    const parsed = parseConsentUrl(url!)
    expect(parsed.state).toBe(STATE)
    expect(parsed.port).toBe(PORT)
  })

  it('extracts a Microsoft consent URL', () => {
    const ms = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=${encodeURIComponent(
      'http://127.0.0.1:5000',
    )}&state=deadbeefdeadbeefdeadbeefdeadbeef&client_id=y`
    const url = extractConsentUrl(`visit:\n  ${ms}\n`, 'microsoft')
    expect(url).toBe(ms)
    expect(parseConsentUrl(url!).port).toBe(5000)
  })

  it('returns null when no consent URL is present yet', () => {
    expect(extractConsentUrl('Connecting Google account...', 'google')).toBeNull()
  })

  it('rejects a non-loopback redirect_uri', () => {
    const bad = `https://accounts.google.com/o/oauth2/auth?redirect_uri=${encodeURIComponent(
      'https://evil.example/cb',
    )}&state=${STATE}`
    expect(() => parseConsentUrl(bad)).toThrow(/loopback/)
  })
})

// ─── Flow lifecycle ──────────────────────────────────────────────────────────

describe('startLoopbackFlow', () => {
  it('resolves with the consent URL scraped from stdout', async () => {
    const child = makeChild()
    const p = startLoopbackFlow('google', 'user@example.com', {
      spawnImpl: () => child as unknown as RelayChild,
      urlTimeoutMs: 1000,
    })
    // Emit the consent URL as the CLI would.
    child.stdout.emit('data', Buffer.from(`  ${GOOGLE_CONSENT}\n`))
    const res = await p
    expect(res.consentUrl).toBe(GOOGLE_CONSENT)
    expect(res.state).toBe(STATE)
    expect(res.port).toBe(PORT)
  })

  it('rejects and kills the child if it exits before a URL', async () => {
    const child = makeChild()
    const p = startLoopbackFlow('google', 'user@example.com', {
      spawnImpl: () => child as unknown as RelayChild,
      urlTimeoutMs: 1000,
    })
    child.emit('exit', 1)
    await expect(p).rejects.toThrow(/before printing a consent URL/)
    expect(child.killed).toBe(true)
  })
})

// Build a pending flow around a fake child for submit tests.
function makePendingFlow(child: FakeChild): PendingLoopbackFlow {
  return {
    provider: 'google',
    email: 'user@example.com',
    state: STATE,
    port: PORT,
    consentUrl: GOOGLE_CONSENT,
    child: child as unknown as RelayChild,
    startedAt: Date.now(),
    submitting: false,
    attempts: 0,
  }
}

describe('submitLoopbackRedirect', () => {
  it('completes the mocked exchange on a valid paste (child exits 0)', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    let fetched: string | null = null
    const fetchImpl = (async (url: string) => {
      fetched = url
      // The real listener closes the socket after accepting the code, then the
      // CLI registers the account and exits 0. Simulate the exit.
      setTimeout(() => child.emit('exit', 0), 0)
      return new Response('ok')
    }) as unknown as typeof fetch

    const res = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=4/secret-CODE&state=${STATE}`,
      { fetchImpl, completionTimeoutMs: 1000 },
    )
    expect(res.ok).toBe(true)
    // The code reached the loopback listener, on the right port.
    expect(fetched).toContain(`127.0.0.1:${PORT}`)
    expect(fetched).toContain('code=4%2Fsecret-CODE')
    expect(flow.submitting).toBe(true)
  })

  it('rejects a wrong-state paste and keeps the flow pending (retryable)', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return new Response('ok')
    }) as unknown as typeof fetch

    const res = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=xyz&state=WRONGSTATE`,
      { fetchImpl },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.retryable).toBe(true)
      expect(res.reason).toMatch(/state/i)
    }
    // Never contacted the listener; flow is still usable.
    expect(fetchCalls).toBe(0)
    expect(flow.submitting).toBe(false)
  })

  it('rejects a bad paste as retryable without touching the listener', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    const res = await submitLoopbackRedirect(flow, 'not a url at all', {
      fetchImpl: (async () => {
        throw new Error('should not be called')
      }) as unknown as typeof fetch,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.retryable).toBe(true)
    expect(flow.submitting).toBe(false)
  })

  it('rejects a second paste after completion (single-use)', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    const fetchImpl = (async () => {
      setTimeout(() => child.emit('exit', 0), 0)
      return new Response('ok')
    }) as unknown as typeof fetch
    const first = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=abc&state=${STATE}`,
      { fetchImpl, completionTimeoutMs: 1000 },
    )
    expect(first.ok).toBe(true)
    // Second valid paste on the spent flow.
    const second = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=abc&state=${STATE}`,
      { fetchImpl, completionTimeoutMs: 1000 },
    )
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.retryable).toBe(false)
      expect(second.reason).toMatch(/completed/i)
    }
  })
})

// ─── Consume gate (PR #3100 review finding 1) ───────────────────────────────

describe('shouldConsumeLoopbackPaste', () => {
  it('does NOT consume unrelated chatter mentioning localhost', () => {
    expect(shouldConsumeLoopbackPaste("what's listening on localhost?")).toBe(false)
    expect(shouldConsumeLoopbackPaste('is 127.0.0.1 reachable from the container?')).toBe(false)
    expect(shouldConsumeLoopbackPaste('curl http://localhost:3000/health please')).toBe(false)
  })

  it('consumes a valid loopback redirect carrying a code', () => {
    expect(
      shouldConsumeLoopbackPaste(`http://127.0.0.1:${PORT}/?code=abc&state=${STATE}`),
    ).toBe(true)
    // Scheme-less + whitespace variant too.
    expect(
      shouldConsumeLoopbackPaste(`  127.0.0.1:${PORT}/?code=abc&state=${STATE}  `),
    ).toBe(true)
  })

  it('consumes a loopback redirect carrying a provider error param', () => {
    expect(
      shouldConsumeLoopbackPaste(`http://127.0.0.1:${PORT}/?error=access_denied`),
    ).toBe(true)
  })

  it('does not consume a non-loopback URL with a code', () => {
    expect(
      shouldConsumeLoopbackPaste(`https://evil.example/?code=abc&state=${STATE}`),
    ).toBe(false)
  })
})

// ─── Pre-paste child exit (PR #3100 review finding 4) ───────────────────────

describe('submitLoopbackRedirect — child exited before paste', () => {
  it('fails fast (non-retryable) instead of hanging out the timeout', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    trackFlowExit(flow)
    child.emit('exit', 1) // CLI died before the operator pasted
    const started = Date.now()
    const res = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=abc&state=${STATE}`,
      {
        fetchImpl: (async () => {
          throw new Error('listener is gone — must not be called')
        }) as unknown as typeof fetch,
        completionTimeoutMs: 5_000,
      },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.retryable).toBe(false)
      expect(res.reason).toMatch(/exited/i)
    }
    // Fast fail, not a completion-timeout wait.
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

// ─── Bounded paste attempts (PR #3100 review finding 5) ─────────────────────

describe('submitLoopbackRedirect — bounded attempts', () => {
  it(`ends the flow (non-retryable) after ${MAX_PASTE_ATTEMPTS} rejected pastes`, async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    const fetchImpl = (async () => {
      throw new Error('must never be called on rejected pastes')
    }) as unknown as typeof fetch

    for (let i = 1; i < MAX_PASTE_ATTEMPTS; i++) {
      const r = await submitLoopbackRedirect(flow, 'garbage paste', { fetchImpl })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.retryable).toBe(true)
    }
    // The Nth rejection ends the flow.
    const last = await submitLoopbackRedirect(flow, 'garbage paste', { fetchImpl })
    expect(last.ok).toBe(false)
    if (!last.ok) {
      expect(last.retryable).toBe(false)
      expect(last.reason).toMatch(/ending this flow/i)
    }
    expect(flow.attempts).toBe(MAX_PASTE_ATTEMPTS)
  })

  it('attempts-exhausted child is killed by cancelLoopbackFlow (no listener leak)', async () => {
    // The gateway's non-retryable branch calls cancelLoopbackFlow before
    // deleting the entry — pin that the cancel actually kills a child that
    // is still alive on the attempts-exhausted path (re-review finding).
    const child = makeChild()
    const flow = makePendingFlow(child)
    const fetchImpl = (async () => {
      throw new Error('never called')
    }) as unknown as typeof fetch
    let last: Awaited<ReturnType<typeof submitLoopbackRedirect>> | undefined
    for (let i = 0; i < MAX_PASTE_ATTEMPTS; i++) {
      last = await submitLoopbackRedirect(flow, 'garbage', { fetchImpl })
    }
    expect(last!.ok).toBe(false)
    if (!last!.ok) expect(last!.retryable).toBe(false)
    expect(child.killed).toBe(false) // still alive — the leak the gateway must close
    cancelLoopbackFlow(flow)
    expect(child.killed).toBe(true)
  })

  it('a valid paste after some rejections still succeeds', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    const badFetch = (async () => {
      throw new Error('not called')
    }) as unknown as typeof fetch
    await submitLoopbackRedirect(flow, 'garbage', { fetchImpl: badFetch })
    await submitLoopbackRedirect(flow, 'more garbage', { fetchImpl: badFetch })
    const goodFetch = (async () => {
      setTimeout(() => child.emit('exit', 0), 0)
      return new Response('ok')
    }) as unknown as typeof fetch
    const res = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=abc&state=${STATE}`,
      { fetchImpl: goodFetch, completionTimeoutMs: 1000 },
    )
    expect(res.ok).toBe(true)
  })
})

// ─── In-flight submit guard (PR #3100 review finding 2, module contract) ────

describe('submitLoopbackRedirect — submitting flag', () => {
  it('a flow with submitting=true rejects non-retryably without contacting the listener', async () => {
    const child = makeChild()
    const flow = makePendingFlow(child)
    flow.submitting = true // first submit in flight
    let fetchCalls = 0
    const res = await submitLoopbackRedirect(
      flow,
      `http://127.0.0.1:${PORT}/?code=abc&state=${STATE}`,
      {
        fetchImpl: (async () => {
          fetchCalls++
          return new Response('ok')
        }) as unknown as typeof fetch,
      },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.retryable).toBe(false)
    expect(fetchCalls).toBe(0)
  })
})

// ─── Secret scrubbing ────────────────────────────────────────────────────────

describe('scrubSensitive', () => {
  it('redacts codes, tokens, and loopback URLs', () => {
    const s = scrubSensitive(
      `error at http://127.0.0.1:9000/?code=4/secret&state=x with access_token=tok123`,
    )
    expect(s).not.toContain('4/secret')
    expect(s).not.toContain('tok123')
    expect(s).not.toContain('127.0.0.1:9000')
  })
})

// ─── Verb parser ─────────────────────────────────────────────────────────────

describe('parseAuthCommand — provider verbs (#2582)', () => {
  it('parses /auth google add <email>', () => {
    const p = parseAuthCommand('/auth google add user@example.com')
    expect(p).toEqual({
      kind: 'provider-add',
      provider: 'google',
      email: 'user@example.com',
      replace: false,
      write: false,
      orgMode: false,
    })
  })

  it('parses google flags --replace --write', () => {
    const p = parseAuthCommand('/auth google add user@example.com --replace --write')
    expect(p).toMatchObject({ kind: 'provider-add', replace: true, write: true })
  })

  it('parses /auth microsoft add with --org-mode', () => {
    const p = parseAuthCommand('/auth microsoft add user@corp.com --org-mode')
    expect(p).toMatchObject({
      kind: 'provider-add',
      provider: 'microsoft',
      orgMode: true,
    })
  })

  it('rejects an unknown flag with help', () => {
    const p = parseAuthCommand('/auth google add user@example.com --nope')
    expect(p).toMatchObject({ kind: 'help' })
  })

  it('parses provider cancel', () => {
    expect(parseAuthCommand('/auth google cancel')).toEqual({
      kind: 'provider-cancel',
      provider: 'google',
    })
  })

  it('help on missing email', () => {
    expect(parseAuthCommand('/auth microsoft add')).toMatchObject({ kind: 'help' })
  })

  it('does not treat --write as a Microsoft flag', () => {
    const p = parseAuthCommand('/auth microsoft add user@corp.com --write')
    expect(p).toMatchObject({ kind: 'help' })
  })
})
