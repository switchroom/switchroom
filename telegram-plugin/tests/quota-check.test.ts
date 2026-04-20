import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fetchQuota,
  formatQuotaBlock,
  formatQuotaLine,
  parseQuotaHeaders,
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
