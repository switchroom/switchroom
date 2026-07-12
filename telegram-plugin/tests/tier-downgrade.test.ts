/**
 * Unit tests for the MODEL-TIER downgrade failover (second recovery tier).
 *
 * The pure `decideTierDowngrade` owns the decision the gateway consults inside
 * the `all-blocked` branch of doFireFleetAutoFallback — i.e. AFTER account-swap
 * has been tried and found no account still serving the walled premium model.
 * The deliverable outcomes it must guarantee:
 *
 *   - overload + the session is NOT on a premium model (override null, or the
 *     override resolves to the configured default) → NO downgrade ('skip'); the
 *     account-swap path already handled it or there is no lower tier to fall to.
 *   - overload + a premium model walled across ALL accounts → 'downgrade' to the
 *     configured default (the carrier target), with the loop-guard counter
 *     incremented.
 *   - loop guard: a SECOND consecutive downgrade-resume failure (a fresh
 *     attempts record already at the cap) → 'exhausted' (name-the-turn-as-lost),
 *     never a re-downgrade.
 *   - a stale attempts record (older than staleMs) starts a FRESH chain so a
 *     later INDEPENDENT interruption can downgrade again.
 *
 * The counter file (`.tier-downgrade-attempts`) round-trips via the FS helpers;
 * it is DELIBERATELY a distinct name from `.session-model-boot-attempts` (which
 * start.sh rm -f's every boot), so it survives the downgrade restart.
 *
 * Pure decision → fake clock, no process restart, no real FS for the decision
 * cases; the file helpers use an isolated mkdtemp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decideTierDowngrade,
  parseTierDowngradeAttempts,
  serializeTierDowngradeAttempts,
  readTierDowngradeAttempts,
  writeTierDowngradeAttempts,
  clearTierDowngradeAttempts,
  TIER_DOWNGRADE_ATTEMPTS_FILE,
  DEFAULT_MAX_TIER_DOWNGRADES,
  DEFAULT_TIER_DOWNGRADE_STALE_MS,
  type TierDowngradeAttempts,
} from '../tier-downgrade.js'

// The gateway passes resolveMainModel; here a near-identity resolver (maps the
// unset/`default` sentinel to the switchroom default, exactly like the real one)
// is enough to exercise the canonicalization guard.
const resolve = (t: string): string =>
  t === '' || t === 'default' ? 'claude-sonnet-5' : t

const NOW = 1_800_000_000_000

describe('decideTierDowngrade — precedence + downgrade target', () => {
  it("NO downgrade when the session is on the configured default (override null)", () => {
    // Overload + account-swap all-blocked, but nothing premium is active — the
    // account-swap path owns this and there is no lower tier. => skip.
    const d = decideTierDowngrade({
      sessionOverride: null,
      configuredDefault: 'opus',
      resolve,
      attempts: null,
      now: NOW,
    })
    expect(d).toEqual({ action: 'skip', reason: 'on-default' })
  })

  it("NO downgrade when the override resolves to the configured default (alias vs id)", () => {
    // A premium-looking override that is actually the default in another spelling
    // must never read as a premium tier (that would loop). Same resolver both
    // sides → on-default.
    const d = decideTierDowngrade({
      sessionOverride: 'default',
      configuredDefault: 'claude-sonnet-5',
      resolve,
      attempts: null,
      now: NOW,
    })
    expect(d).toEqual({ action: 'skip', reason: 'on-default' })
  })

  it('NO downgrade (and no blind fall) when the configured default is unreadable', () => {
    const d = decideTierDowngrade({
      sessionOverride: 'fable',
      configuredDefault: null,
      resolve,
      attempts: null,
      now: NOW,
    })
    expect(d).toEqual({ action: 'skip', reason: 'unresolved' })
  })

  it('DOWNGRADES a walled premium model to the configured default + arms the counter', () => {
    const d = decideTierDowngrade({
      sessionOverride: 'fable',
      configuredDefault: 'opus',
      resolve,
      attempts: null,
      now: NOW,
    })
    expect(d).toEqual({
      action: 'downgrade',
      toModel: 'opus',
      fromModel: 'fable',
      nextAttempts: { count: 1, premiumModel: 'fable', ts: NOW },
    })
  })

  it('downgrade target is GENERAL — any premium model → the agent default (not hardcoded fable→opus)', () => {
    const d = decideTierDowngrade({
      sessionOverride: 'sr-x-ai/grok-4',
      configuredDefault: 'claude-sonnet-5',
      resolve,
      attempts: null,
      now: NOW,
    })
    expect(d.action).toBe('downgrade')
    if (d.action === 'downgrade') {
      expect(d.toModel).toBe('claude-sonnet-5')
      expect(d.fromModel).toBe('sr-x-ai/grok-4')
    }
  })
})

describe('decideTierDowngrade — loop guard (names the turn as lost, no loop)', () => {
  it("SECOND consecutive downgrade-resume failure → 'exhausted', no re-downgrade", () => {
    // The first downgrade wrote count=1. Its resume died again with the premium
    // model still walled and active → the budget (default 1) is spent.
    const attempts: TierDowngradeAttempts = { count: 1, premiumModel: 'fable', ts: NOW - 5_000 }
    const d = decideTierDowngrade({
      sessionOverride: 'fable',
      configuredDefault: 'opus',
      resolve,
      attempts,
      now: NOW,
    })
    expect(d).toEqual({ action: 'exhausted', premiumModel: 'fable' })
  })

  it('a STALE attempts record starts a fresh chain (later independent interruption)', () => {
    const attempts: TierDowngradeAttempts = {
      count: DEFAULT_MAX_TIER_DOWNGRADES,
      premiumModel: 'fable',
      ts: NOW - DEFAULT_TIER_DOWNGRADE_STALE_MS - 1, // just past the window
    }
    const d = decideTierDowngrade({
      sessionOverride: 'fable',
      configuredDefault: 'opus',
      resolve,
      attempts,
      now: NOW,
    })
    expect(d.action).toBe('downgrade')
    if (d.action === 'downgrade') expect(d.nextAttempts.count).toBe(1)
  })

  it('honours a custom maxDowngrades cap', () => {
    const attempts: TierDowngradeAttempts = { count: 1, premiumModel: 'fable', ts: NOW }
    const d = decideTierDowngrade({
      sessionOverride: 'fable',
      configuredDefault: 'opus',
      resolve,
      attempts,
      now: NOW,
      maxDowngrades: 2,
    })
    expect(d.action).toBe('downgrade')
    if (d.action === 'downgrade') expect(d.nextAttempts.count).toBe(2)
  })
})

describe('.tier-downgrade-attempts counter file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchroom-tier-downgrade-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a DISTINCT filename from the retired .session-model-boot-attempts', () => {
    // The historical loop-guard file is rm -f'd by start.sh every boot, so it
    // cannot survive a restart — this guard must use its own name.
    expect(TIER_DOWNGRADE_ATTEMPTS_FILE).toBe('.tier-downgrade-attempts')
    expect(TIER_DOWNGRADE_ATTEMPTS_FILE).not.toBe('.session-model-boot-attempts')
  })

  it('write → read round-trips', () => {
    const rec: TierDowngradeAttempts = { count: 1, premiumModel: 'fable', ts: NOW }
    writeTierDowngradeAttempts(dir, rec)
    expect(existsSync(join(dir, TIER_DOWNGRADE_ATTEMPTS_FILE))).toBe(true)
    expect(readTierDowngradeAttempts(dir)).toEqual(rec)
    // one line + trailing newline, matching the session-model carrier shape.
    const onDisk = readFileSync(join(dir, TIER_DOWNGRADE_ATTEMPTS_FILE), 'utf8')
    expect(onDisk.endsWith('\n')).toBe(true)
    expect(onDisk.trimEnd().split('\n')).toHaveLength(1)
  })

  it('read of an absent file → null', () => {
    expect(readTierDowngradeAttempts(dir)).toBeNull()
  })

  it('corrupt / bad-shape content → null (never trusted)', () => {
    writeFileSync(join(dir, TIER_DOWNGRADE_ATTEMPTS_FILE), '{not json\n')
    expect(readTierDowngradeAttempts(dir)).toBeNull()
    writeFileSync(
      join(dir, TIER_DOWNGRADE_ATTEMPTS_FILE),
      JSON.stringify({ count: 'x', premiumModel: 'fable', ts: NOW }) + '\n',
    )
    expect(readTierDowngradeAttempts(dir)).toBeNull()
    expect(parseTierDowngradeAttempts('{"count":-1,"premiumModel":"f","ts":1}')).toBeNull()
  })

  it('clear removes the file (best-effort, idempotent)', () => {
    writeTierDowngradeAttempts(dir, { count: 1, premiumModel: 'fable', ts: NOW })
    clearTierDowngradeAttempts(dir)
    expect(existsSync(join(dir, TIER_DOWNGRADE_ATTEMPTS_FILE))).toBe(false)
    // idempotent — no throw on a second clear
    expect(() => clearTierDowngradeAttempts(dir)).not.toThrow()
  })

  it('serialize is stable field order', () => {
    expect(serializeTierDowngradeAttempts({ count: 2, premiumModel: 'sr-glm-5', ts: 7 })).toBe(
      '{"count":2,"premiumModel":"sr-glm-5","ts":7}\n',
    )
  })
})
