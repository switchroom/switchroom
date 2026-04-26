/**
 * Unit tests for the quota probe cache.
 *
 * The cache exists to break the rate-limit cascade caused by 4 agents
 * × frequent boot card posts × Anthropic /api/oauth/usage rate limit
 * (observed as 🟡 "rate limited" in production boot cards on 2026-04-26).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { readQuotaCache, writeQuotaCache, DEFAULT_TTL_MS } from '../gateway/quota-cache.js'
import type { ProbeResult } from '../gateway/boot-probes.js'

let tmp: string
let cachePath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'quota-cache-test-'))
  cachePath = join(tmp, 'quota-cache.json')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const okResult: ProbeResult = {
  status: 'ok',
  label: 'Quota',
  detail: 'Sonnet 23% · resets in 2h 15m',
}

const failResult: ProbeResult = {
  status: 'fail',
  label: 'Quota',
  detail: 'request failed: ECONNREFUSED',
}

const rateLimitedResult: ProbeResult = {
  status: 'degraded',
  label: 'Quota',
  detail: 'rate limited',
}

const degradedSchemaUnknown: ProbeResult = {
  status: 'degraded',
  label: 'Quota',
  detail: 'schema unknown — saving raw response',
}

// ── Read paths ─────────────────────────────────────────────────────────────

describe('readQuotaCache', () => {
  it('returns null when the cache file does not exist', () => {
    expect(readQuotaCache({ path: cachePath })).toBeNull()
  })

  it('returns null when the cache file is invalid JSON', () => {
    writeFileSync(cachePath, 'not valid json')
    expect(readQuotaCache({ path: cachePath })).toBeNull()
  })

  it('returns the cached result when fresh', () => {
    const now = 1_700_000_000_000
    writeQuotaCache(okResult, { path: cachePath, now })
    const result = readQuotaCache({ path: cachePath, now: now + 1000 })
    expect(result).toEqual(okResult)
  })

  it('returns null when the cache is past its TTL', () => {
    const now = 1_700_000_000_000
    writeQuotaCache(okResult, { path: cachePath, now })
    const result = readQuotaCache({ path: cachePath, now: now + DEFAULT_TTL_MS + 1 })
    expect(result).toBeNull()
  })

  it('returns null when the clock went backwards', () => {
    const now = 1_700_000_000_000
    writeQuotaCache(okResult, { path: cachePath, now })
    const result = readQuotaCache({ path: cachePath, now: now - 60_000 })
    expect(result).toBeNull()
  })

  it('returns null when capturedAt is unparseable', () => {
    writeFileSync(cachePath, JSON.stringify({
      capturedAt: 'not-a-date',
      ttlMs: 60_000,
      result: okResult,
    }))
    expect(readQuotaCache({ path: cachePath })).toBeNull()
  })

  it('honors a custom ttlMs from the entry, not the global default', () => {
    const now = 1_700_000_000_000
    const shortTtl = 1000
    writeQuotaCache(okResult, { path: cachePath, ttlMs: shortTtl, now })
    expect(readQuotaCache({ path: cachePath, now: now + 500 })).toEqual(okResult)
    expect(readQuotaCache({ path: cachePath, now: now + 1500 })).toBeNull()
  })
})

// ── Write paths ─────────────────────────────────────────────────────────────

describe('writeQuotaCache', () => {
  it('writes a fresh entry to disk', () => {
    writeQuotaCache(okResult, { path: cachePath })
    expect(existsSync(cachePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(parsed.result).toEqual(okResult)
    expect(parsed.ttlMs).toBe(DEFAULT_TTL_MS)
    expect(parsed.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('does NOT cache a fail result (so next boot retries)', () => {
    writeQuotaCache(failResult, { path: cachePath })
    expect(existsSync(cachePath)).toBe(false)
  })

  it('does NOT cache a rate-limited result (so next boot retries)', () => {
    writeQuotaCache(rateLimitedResult, { path: cachePath })
    expect(existsSync(cachePath)).toBe(false)
  })

  it('caches a degraded "schema unknown" result (it is informational, not transient)', () => {
    writeQuotaCache(degradedSchemaUnknown, { path: cachePath })
    expect(existsSync(cachePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(parsed.result).toEqual(degradedSchemaUnknown)
  })

  it('overwrites an existing entry', () => {
    writeQuotaCache(okResult, { path: cachePath, now: 1_700_000_000_000 })
    const newer: ProbeResult = { status: 'ok', label: 'Quota', detail: 'Sonnet 50%' }
    writeQuotaCache(newer, { path: cachePath, now: 1_700_000_001_000 })
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(parsed.result).toEqual(newer)
  })

  it('writes mode 0600 (owner-only — file may contain quota detail)', () => {
    writeQuotaCache(okResult, { path: cachePath })
    const { statSync } = require('fs')
    const mode = statSync(cachePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('swallows IO errors (cache is best-effort)', () => {
    // Try to write to a path whose parent doesn't exist AND can't be made
    const bogusPath = '/proc/1/quota-cache.json'  // /proc/1 is read-only
    expect(() => writeQuotaCache(okResult, { path: bogusPath })).not.toThrow()
  })
})

// ── Round-trip ─────────────────────────────────────────────────────────────

describe('readQuotaCache + writeQuotaCache round-trip', () => {
  it('successfully roundtrips an ok result within TTL', () => {
    const now = 1_700_000_000_000
    writeQuotaCache(okResult, { path: cachePath, now })
    expect(readQuotaCache({ path: cachePath, now: now + 60_000 })).toEqual(okResult)
  })

  it('a rate-limited result is not cached, so reads return null', () => {
    writeQuotaCache(rateLimitedResult, { path: cachePath })
    expect(readQuotaCache({ path: cachePath })).toBeNull()
  })
})
