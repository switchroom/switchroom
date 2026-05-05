import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fetchQuota,
  formatQuotaBlock,
  formatQuotaLine,
  parseQuotaHeaders,
  readAccountAccessToken,
  fetchAccountQuota,
  getCachedAccountQuota,
  prefetchAccountQuotaIfStale,
  clearAccountQuotaCache,
  ACCOUNT_QUOTA_CACHE_TTL_MS,
} from '../quota-check.js'

function makeTempClaudeDir(token: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'quota-check-test-'))
  if (token != null) {
    writeFileSync(join(dir, '.oauth-token'), token, { mode: 0o600 })
  }
  return dir
}

function headers(entries: Record<string, string>): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(entries)) h.set(k, v)
  return h
}

describe('parseQuotaHeaders', () => {
  it('extracts both windows plus the representative claim', () => {
    const resetFiveH = Math.floor(Date.now() / 1000) + 3600
    const resetSevenD = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
    const h = headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.29',
      'anthropic-ratelimit-unified-5h-reset': String(resetFiveH),
      'anthropic-ratelimit-unified-7d-utilization': '0.33',
      'anthropic-ratelimit-unified-7d-reset': String(resetSevenD),
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-overage-status': 'allowed',
    })
    const r = parseQuotaHeaders(h)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.round(r.data.fiveHourUtilizationPct)).toBe(29)
    expect(Math.round(r.data.sevenDayUtilizationPct)).toBe(33)
    expect(r.data.representativeClaim).toBe('five_hour')
    expect(r.data.fiveHourResetAt?.getTime()).toBe(resetFiveH * 1000)
    expect(r.data.sevenDayResetAt?.getTime()).toBe(resetSevenD * 1000)
  })

  it('returns not-ok when no unified headers are present', () => {
    const r = parseQuotaHeaders(headers({ 'content-type': 'application/json' }))
    expect(r.ok).toBe(false)
  })

  it('treats a single window as sufficient (7d missing)', () => {
    const r = parseQuotaHeaders(headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.round(r.data.fiveHourUtilizationPct)).toBe(50)
    expect(r.data.sevenDayUtilizationPct).toBe(0)
  })
})

describe('formatQuotaLine', () => {
  it('renders compact percentages', () => {
    const line = formatQuotaLine({
      fiveHourUtilizationPct: 29,
      sevenDayUtilizationPct: 33,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
    })
    expect(line).toBe('29% / 5h · 33% / 7d')
  })
})

describe('formatQuotaBlock', () => {
  it('renders Telegram HTML block with reset countdowns', () => {
    const now = new Date('2026-04-21T12:00:00Z')
    const block = formatQuotaBlock(
      {
        fiveHourUtilizationPct: 29,
        sevenDayUtilizationPct: 33,
        fiveHourResetAt: new Date('2026-04-21T14:30:00Z'), // +2h 30m
        sevenDayResetAt: new Date('2026-04-24T12:00:00Z'), // +3d
        representativeClaim: 'five_hour',
        overageStatus: 'allowed',
        overageDisabledReason: null,
      },
      now,
    )
    expect(block).toContain('<b>Claude plan quota</b>')
    expect(block).toContain('<b>5h window</b>  29% · resets in 2h 30m')
    expect(block).toContain('<b>7d window</b>  33% · resets in 3d')
    expect(block).toContain('Binding window: five hour')
    // overage=allowed should not be surfaced
    expect(block).not.toContain('Overage:')
  })

  it('surfaces overage status when not allowed', () => {
    const block = formatQuotaBlock({
      fiveHourUtilizationPct: 110,
      sevenDayUtilizationPct: 95,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: 'disabled',
      overageDisabledReason: 'spend_cap_reached',
    })
    expect(block).toContain('Overage: disabled (spend_cap_reached)')
  })
})

describe('fetchQuota', () => {
  it('returns reason when OAuth token is missing', async () => {
    const dir = makeTempClaudeDir(null)
    try {
      const r = await fetchQuota({ claudeConfigDir: dir })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toMatch(/no OAuth token/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns reason when token rejected with 401', async () => {
    const dir = makeTempClaudeDir('fake-token')
    try {
      const fakeFetch = async () => new Response('', { status: 401 })
      const r = await fetchQuota({ claudeConfigDir: dir, fetchImpl: fakeFetch as typeof fetch })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toMatch(/auth rejected/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses headers on a successful response', async () => {
    const dir = makeTempClaudeDir('fake-token')
    try {
      const fakeFetch = async () =>
        new Response('{}', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.42',
            'anthropic-ratelimit-unified-7d-utilization': '0.17',
            'anthropic-ratelimit-unified-representative-claim': 'seven_day',
          },
        })
      const r = await fetchQuota({ claudeConfigDir: dir, fetchImpl: fakeFetch as typeof fetch })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(Math.round(r.data.fiveHourUtilizationPct)).toBe(42)
      expect(Math.round(r.data.sevenDayUtilizationPct)).toBe(17)
      expect(r.data.representativeClaim).toBe('seven_day')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses headers even when the probe is rate-limited (429)', async () => {
    const dir = makeTempClaudeDir('fake-token')
    try {
      const fakeFetch = async () =>
        new Response('{"error":"rate_limit"}', {
          status: 429,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '1.0',
            'anthropic-ratelimit-unified-7d-utilization': '0.9',
          },
        })
      const r = await fetchQuota({ claudeConfigDir: dir, fetchImpl: fakeFetch as typeof fetch })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(Math.round(r.data.fiveHourUtilizationPct)).toBe(100)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── Account-level helpers ────────────────────────────────────────────

/** Build a fake $HOME with `~/.switchroom/accounts/<label>/credentials.json`. */
function makeAccountHome(
  accounts: Record<string, { accessToken?: string }>,
): string {
  const home = mkdtempSync(join(tmpdir(), 'quota-acct-test-'))
  for (const [label, creds] of Object.entries(accounts)) {
    const dir = join(home, '.switchroom', 'accounts', label)
    mkdirSync(dir, { recursive: true })
    if (creds.accessToken !== undefined) {
      writeFileSync(
        join(dir, 'credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: creds.accessToken } }),
      )
    }
  }
  return home
}

describe('readAccountAccessToken', () => {
  it('returns the access token from credentials.json', () => {
    const home = makeAccountHome({
      'pixsoul@gmail.com': { accessToken: 'sk-ant-oat01-fake' },
    })
    try {
      expect(readAccountAccessToken('pixsoul@gmail.com', home)).toBe(
        'sk-ant-oat01-fake',
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when the account dir is missing', () => {
    const home = makeAccountHome({})
    try {
      expect(readAccountAccessToken('absent', home)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when accessToken is empty', () => {
    const home = makeAccountHome({
      'empty@example.com': { accessToken: '' },
    })
    try {
      expect(readAccountAccessToken('empty@example.com', home)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when credentials.json is malformed', () => {
    const home = mkdtempSync(join(tmpdir(), 'quota-acct-bad-'))
    const dir = join(home, '.switchroom', 'accounts', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'credentials.json'), '{not json')
    try {
      expect(readAccountAccessToken('broken', home)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('fetchAccountQuota — cache + token resolution', () => {
  beforeEach(() => {
    clearAccountQuotaCache()
  })

  it('fetches once, returns cached on subsequent calls within TTL', async () => {
    const home = makeAccountHome({
      'work@example.com': { accessToken: 'tok' },
    })
    let callCount = 0
    const fakeFetch = async () => {
      callCount++
      return new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.42',
          'anthropic-ratelimit-unified-7d-utilization': '0.17',
        },
      })
    }
    try {
      const r1 = await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: fakeFetch as typeof fetch,
      })
      const r2 = await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: fakeFetch as typeof fetch,
      })
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      expect(callCount).toBe(1) // cache hit on the second call
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('force=true bypasses the cache', async () => {
    const home = makeAccountHome({
      'work@example.com': { accessToken: 'tok' },
    })
    let callCount = 0
    const fakeFetch = async () => {
      callCount++
      return new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.5',
          'anthropic-ratelimit-unified-7d-utilization': '0.5',
        },
      })
    }
    try {
      await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: fakeFetch as typeof fetch,
      })
      await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: fakeFetch as typeof fetch,
        force: true,
      })
      expect(callCount).toBe(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('caches missing-credentials failures so the API is not pinged', async () => {
    const home = makeAccountHome({})
    let callCount = 0
    const fakeFetch = async () => {
      callCount++
      return new Response('{}')
    }
    const r1 = await fetchAccountQuota('absent', {
      home,
      fetchImpl: fakeFetch as typeof fetch,
    })
    const r2 = await fetchAccountQuota('absent', {
      home,
      fetchImpl: fakeFetch as typeof fetch,
    })
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(callCount).toBe(0) // never reached fetch — token resolution failed first
  })

  it('cache miss after TTL triggers a fresh fetch', async () => {
    const home = makeAccountHome({
      'work@example.com': { accessToken: 'tok' },
    })
    let callCount = 0
    const fakeFetch = async () => {
      callCount++
      return new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.3',
          'anthropic-ratelimit-unified-7d-utilization': '0.3',
        },
      })
    }
    let nowVal = 1_000_000
    const now = () => nowVal
    try {
      await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: fakeFetch as typeof fetch,
        now,
      })
      // Step time past the TTL.
      nowVal += ACCOUNT_QUOTA_CACHE_TTL_MS + 1
      await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: fakeFetch as typeof fetch,
        now,
      })
      expect(callCount).toBe(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('getCachedAccountQuota + prefetchAccountQuotaIfStale', () => {
  beforeEach(() => {
    clearAccountQuotaCache()
  })

  it('returns null on a cold cache, populates after a fetch', async () => {
    const home = makeAccountHome({
      'work@example.com': { accessToken: 'tok' },
    })
    try {
      expect(getCachedAccountQuota('work@example.com')).toBeNull()
      await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: (async () =>
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.42',
              'anthropic-ratelimit-unified-7d-utilization': '0.17',
            },
          })) as typeof fetch,
      })
      const cached = getCachedAccountQuota('work@example.com')
      expect(cached?.ok).toBe(true)
      if (cached?.ok) {
        expect(Math.round(cached.data.fiveHourUtilizationPct)).toBe(42)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("returns stale entries verbatim — staleness is the prefetch path's concern, not the read path's (v0.6.11)", async () => {
    // The dashboard renders sync. Pre-v0.6.11 this function treated
    // stale cache as a miss → the boot-warmed cache vanished after
    // 30s and the operator saw empty quota rows on the first /auth
    // tap of any session past that window. Now stale-but-present
    // entries are returned; the background prefetch keeps the cache
    // fresh across renders.
    const home = makeAccountHome({
      'work@example.com': { accessToken: 'tok' },
    })
    try {
      const nowVal = 1_000_000
      await fetchAccountQuota('work@example.com', {
        home,
        fetchImpl: (async () =>
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.42',
              'anthropic-ratelimit-unified-7d-utilization': '0.17',
            },
          })) as typeof fetch,
        now: () => nowVal,
      })
      // Within TTL — cached.
      const fresh = getCachedAccountQuota('work@example.com', nowVal)
      expect(fresh).not.toBeNull()
      // Past TTL — STILL returned, identical to the within-TTL read.
      const after = nowVal + ACCOUNT_QUOTA_CACHE_TTL_MS + 1
      const stale = getCachedAccountQuota('work@example.com', after)
      expect(stale).not.toBeNull()
      expect(stale).toEqual(fresh)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when the label has never been probed', async () => {
    // The only "no data" path: the cache map has no entry. After
    // the first probe the entry persists for the lifetime of the
    // gateway process, regardless of staleness.
    expect(getCachedAccountQuota('never-probed@example.com')).toBeNull()
  })

  it('prefetchAccountQuotaIfStale is a noop when cache is fresh', async () => {
    const home = makeAccountHome({
      'work@example.com': { accessToken: 'tok' },
    })
    let callCount = 0
    const fakeFetch = (async () => {
      callCount++
      return new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.42',
          'anthropic-ratelimit-unified-7d-utilization': '0.17',
        },
      })
    }) as typeof fetch
    try {
      await fetchAccountQuota('work@example.com', { home, fetchImpl: fakeFetch })
      expect(callCount).toBe(1)
      // Fresh cache — prefetch should not fire.
      prefetchAccountQuotaIfStale('work@example.com', { home, fetchImpl: fakeFetch })
      // Yield once to let any spurious microtasks settle.
      await Promise.resolve()
      expect(callCount).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('fetchQuota — accessToken parameter', () => {
  it('accepts a direct accessToken instead of a config dir', async () => {
    const fakeFetch = async (_url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)
        ?.authorization
      expect(auth).toBe('Bearer direct-token')
      return new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.5',
          'anthropic-ratelimit-unified-7d-utilization': '0.5',
        },
      })
    }
    const r = await fetchQuota({
      accessToken: 'direct-token',
      fetchImpl: fakeFetch as typeof fetch,
    })
    expect(r.ok).toBe(true)
  })

  it('rejects when both accessToken and claudeConfigDir are passed', async () => {
    const r = await fetchQuota({
      accessToken: 'tok',
      claudeConfigDir: '/tmp/whatever',
    })
    expect(r.ok).toBe(false)
  })

  it('rejects when neither is passed', async () => {
    const r = await fetchQuota({})
    expect(r.ok).toBe(false)
  })
})
