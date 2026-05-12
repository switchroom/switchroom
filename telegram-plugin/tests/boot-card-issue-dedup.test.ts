/**
 * Unit tests for the boot-issue dedup module (`boot-issue-cache.ts`).
 *
 * Covers the four canonical lifecycles a probe can move through across
 * consecutive boots:
 *
 *   1. novel    — first boot a fingerprint is seen → not snoozed, not resolved
 *   2. repeated — fingerprint matches prior boot → counter increments
 *   3. snoozed  — same fingerprint past snoozeBoots / snoozeMs → hidden
 *   4. resolved — was degraded/fail last boot, ok this boot → resolved=true
 *
 * Plus persistence guardrails (corrupt cache, schema mismatch, GC).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  fingerprintProbe,
  diffProbes,
  loadCache,
  applyAndSave,
  DEFAULT_SNOOZE_BOOTS,
  type BootIssueCacheFile,
} from '../gateway/boot-issue-cache.js'
import type { ProbeMap } from '../gateway/boot-card.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'boot-issue-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('fingerprintProbe — per-probe fold policy', () => {
  it('skills folds across dangling count and named entries', () => {
    const a = fingerprintProbe('skills', {
      status: 'degraded', label: 'Skills',
      detail: '3/12 dangling: alpha, beta, gamma',
    })
    const b = fingerprintProbe('skills', {
      status: 'degraded', label: 'Skills',
      detail: '5/12 dangling: alpha, beta, gamma, delta, epsilon',
    })
    expect(a).toBe(b)
  })

  it('account folds by status_kind (signed-out vs token-expiring vs token-expired)', () => {
    const signedOut1 = fingerprintProbe('account', { status: 'degraded', label: 'Account', detail: 'not signed in' })
    const signedOut2 = fingerprintProbe('account', { status: 'degraded', label: 'Account', detail: 'Not Signed In' })
    expect(signedOut1).toBe(signedOut2)

    const exp1 = fingerprintProbe('account', { status: 'degraded', label: 'Account', detail: 'a@b · Pro · token 4d' })
    const exp2 = fingerprintProbe('account', { status: 'degraded', label: 'Account', detail: 'a@b · Pro · token 6d' })
    expect(exp1).toBe(exp2)
    expect(exp1).not.toBe(signedOut1)
  })

  it('agent folds by raw systemd state string', () => {
    const a = fingerprintProbe('agent', { status: 'fail', label: 'Agent', detail: 'service failed' })
    const b = fingerprintProbe('agent', { status: 'fail', label: 'Agent', detail: 'service failed' })
    expect(a).toBe(b)
    const c = fingerprintProbe('agent', { status: 'degraded', label: 'Agent', detail: 'service activating' })
    expect(a).not.toBe(c)
  })

  it('broker / kernel / hindsight use literal detail (normalized)', () => {
    const broker1 = fingerprintProbe('broker', { status: 'fail', label: 'Broker', detail: 'socket missing' })
    const broker2 = fingerprintProbe('broker', { status: 'fail', label: 'Broker', detail: 'socket missing' })
    expect(broker1).toBe(broker2)
    const broker3 = fingerprintProbe('broker', { status: 'fail', label: 'Broker', detail: 'connection refused' })
    expect(broker1).not.toBe(broker3)
  })

  it('ok results all share a single per-probe fingerprint', () => {
    const a = fingerprintProbe('skills', { status: 'ok', label: 'Skills', detail: '12 resolved' })
    const b = fingerprintProbe('skills', { status: 'ok', label: 'Skills', detail: '8 resolved' })
    expect(a).toBe(b)
    expect(a).toBe('skills:ok')
  })
})

describe('diffProbes — lifecycle: novel → repeated → snoozed → resolved', () => {
  it('novel: first sighting → not snoozed, not resolved, counter=1', () => {
    const probes: ProbeMap = { broker: { status: 'fail', label: 'Broker', detail: 'socket missing' } }
    const diff = diffProbes(probes, { schema: 1, probes: {} }, { now: () => 1000 })
    expect(diff.broker?.snoozed).toBe(false)
    expect(diff.broker?.resolved).toBe(false)
    expect(diff.broker?.firstSighting).toBe(true)
    expect(diff.broker?.nextEntry?.consecutiveBoots).toBe(1)
  })

  it('repeated: same fingerprint → counter increments, still surfaced (not snoozed) below threshold', () => {
    const probes: ProbeMap = { broker: { status: 'fail', label: 'Broker', detail: 'socket missing' } }
    const cache: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: {
          fingerprint: 'broker:fail:socket missing',
          consecutiveBoots: 3,
          firstSeenMs: 1000,
          lastSeenMs: 2000,
        },
      },
    }
    const diff = diffProbes(probes, cache, { now: () => 3000, snoozeBoots: 10, snoozeMs: 1_000_000 })
    expect(diff.broker?.snoozed).toBe(false)
    expect(diff.broker?.nextEntry?.consecutiveBoots).toBe(4)
  })

  it('snoozed: same fingerprint past snoozeBoots → snoozed=true', () => {
    const probes: ProbeMap = { broker: { status: 'fail', label: 'Broker', detail: 'socket missing' } }
    const cache: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: {
          fingerprint: 'broker:fail:socket missing',
          consecutiveBoots: DEFAULT_SNOOZE_BOOTS, // next boot triggers snooze
          firstSeenMs: 1000,
          lastSeenMs: 2000,
        },
      },
    }
    const diff = diffProbes(probes, cache, { now: () => 3000, snoozeMs: 1_000_000_000 })
    expect(diff.broker?.snoozed).toBe(true)
    expect(diff.broker?.nextEntry?.consecutiveBoots).toBe(DEFAULT_SNOOZE_BOOTS + 1)
  })

  it('snoozed: same fingerprint past snoozeMs → snoozed=true even if below boot count', () => {
    const probes: ProbeMap = { broker: { status: 'fail', label: 'Broker', detail: 'socket missing' } }
    const cache: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: {
          fingerprint: 'broker:fail:socket missing',
          consecutiveBoots: 2,
          firstSeenMs: 1000,
          lastSeenMs: 1500,
        },
      },
    }
    const diff = diffProbes(probes, cache, {
      now: () => 1000 + 4 * 24 * 60 * 60 * 1000, // 4 days later
      snoozeMs: 3 * 24 * 60 * 60 * 1000, // 3-day window
      snoozeBoots: 100,
    })
    expect(diff.broker?.snoozed).toBe(true)
  })

  it('resolved: was degraded last boot, now ok → resolved=true, nextEntry=null', () => {
    const probes: ProbeMap = { broker: { status: 'ok', label: 'Broker', detail: 'reachable' } }
    const cache: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: {
          fingerprint: 'broker:fail:socket missing',
          consecutiveBoots: 2,
          firstSeenMs: 1000,
          lastSeenMs: 2000,
        },
      },
    }
    const diff = diffProbes(probes, cache, { now: () => 3000 })
    expect(diff.broker?.resolved).toBe(true)
    expect(diff.broker?.snoozed).toBe(false)
    expect(diff.broker?.nextEntry).toBeNull()
  })

  it('fingerprint change resets counter — new failure mode shows even if old one was snoozed', () => {
    const probes: ProbeMap = { broker: { status: 'fail', label: 'Broker', detail: 'connection refused' } }
    const cache: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: {
          fingerprint: 'broker:fail:socket missing',
          consecutiveBoots: 50,
          firstSeenMs: 1000,
          lastSeenMs: 2000,
        },
      },
    }
    const diff = diffProbes(probes, cache, { now: () => 3000 })
    expect(diff.broker?.snoozed).toBe(false)
    expect(diff.broker?.nextEntry?.consecutiveBoots).toBe(1)
    expect(diff.broker?.firstSighting).toBe(true)
  })
})

describe('loadCache / applyAndSave — persistence', () => {
  it('round-trips a diff: save then load yields the same probe entries', () => {
    const path = join(tmp, 'cache.json')
    const probes: ProbeMap = { broker: { status: 'fail', label: 'Broker', detail: 'socket missing' } }
    const empty: BootIssueCacheFile = { schema: 1, probes: {} }
    const diff = diffProbes(probes, empty, { now: () => 1000 })
    applyAndSave(path, empty, diff)
    expect(existsSync(path)).toBe(true)
    const loaded = loadCache(path, () => 1000) // same clock as the diff
    expect(loaded.probes.broker?.fingerprint).toBe(diff.broker?.fingerprint)
  })

  it('resolved probe removes its entry from the cache (nextEntry=null)', () => {
    const path = join(tmp, 'cache.json')
    const seed: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: { fingerprint: 'broker:fail:x', consecutiveBoots: 2, firstSeenMs: 1, lastSeenMs: 2 },
      },
    }
    writeFileSync(path, JSON.stringify(seed))
    const loaded = loadCache(path, () => 1000)
    expect(loaded.probes.broker).toBeDefined()
    const probes: ProbeMap = { broker: { status: 'ok', label: 'Broker', detail: 'reachable' } }
    const diff = diffProbes(probes, loaded, { now: () => 1000 })
    applyAndSave(path, loaded, diff)
    const reloaded = loadCache(path, () => 1000)
    expect(reloaded.probes.broker).toBeUndefined()
  })

  it('corrupt cache file is renamed aside and an empty cache is returned', () => {
    const path = join(tmp, 'cache.json')
    writeFileSync(path, 'not-json-{{{')
    const loaded = loadCache(path, () => 12345)
    expect(loaded.probes).toEqual({})
    // The corrupt file is preserved for forensics.
    expect(existsSync(`${path}.corrupt-12345`)).toBe(true)
  })

  it('schema mismatch is treated like empty', () => {
    const path = join(tmp, 'cache.json')
    writeFileSync(path, JSON.stringify({ schema: 99, probes: {} }))
    const loaded = loadCache(path)
    expect(loaded.probes).toEqual({})
  })

  it('GC drops entries older than 30 days on load', () => {
    const path = join(tmp, 'cache.json')
    const seed: BootIssueCacheFile = {
      schema: 1,
      probes: {
        broker: { fingerprint: 'x', consecutiveBoots: 1, firstSeenMs: 0, lastSeenMs: 0 },
      },
    }
    writeFileSync(path, JSON.stringify(seed))
    // Now = far enough that 0-mtime entry exceeds 30d.
    const loaded = loadCache(path, () => 60 * 24 * 60 * 60 * 1000)
    expect(loaded.probes.broker).toBeUndefined()
  })
})
