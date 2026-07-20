/**
 * Unit tests for the progress-based hang-restart discriminator (Stage B).
 *
 * The crux: a mid-tool framework fallback with a STALE turn-active marker
 * escalates to a real restart, but a fallback whose marker mtime keeps
 * advancing (a healthy long tool / sub-agent) must NOT be restarted.
 *
 * FAILS on current head: `../gateway/hang-restart-decision.js` does not exist
 * there — the discriminator + cooldown are the contribution under test.
 */

import { describe, it, expect } from 'vitest'
import {
  decideHangRestart,
  hangStalenessMs,
  hangRestartCooldownMs,
  isHangRestartCooldownActive,
  DEFAULT_HANG_STALENESS_MS,
  DEFAULT_HANG_RESTART_COOLDOWN_MS,
} from '../gateway/hang-restart-decision.js'

const STALE = 300_000

describe('decideHangRestart — the crux discriminator', () => {
  it('(1) tool mid-call + zero marker progress past the ceiling ⇒ restart requested', () => {
    const d = decideHangRestart({
      midToolCall: true,
      markerAgeMs: 600_000, // 10 min since last observable progress
      stalenessThresholdMs: STALE,
      cooldownActive: false,
    })
    expect(d.restart).toBe(true)
    expect(d.reason).toBe('mid-tool-marker-stale')
  })

  it('(2) a turn whose marker mtime keeps advancing is NOT restarted', () => {
    const d = decideHangRestart({
      midToolCall: true,
      markerAgeMs: 4_000, // marker touched 4s ago — a long tool / sub-agent is working
      stalenessThresholdMs: STALE,
      cooldownActive: false,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('marker-advancing')
  })

  it('a marker exactly at the staleness ceiling is stale ⇒ restart', () => {
    const d = decideHangRestart({
      midToolCall: true,
      markerAgeMs: STALE,
      stalenessThresholdMs: STALE,
      cooldownActive: false,
    })
    expect(d.restart).toBe(true)
  })

  it('an absent marker (no progress signal at all) is treated as stale ⇒ restart', () => {
    const d = decideHangRestart({
      midToolCall: true,
      markerAgeMs: null,
      stalenessThresholdMs: STALE,
      cooldownActive: false,
    })
    expect(d.restart).toBe(true)
  })

  it('a fallback that is NOT mid-tool never restarts (ordinary teardown owns it)', () => {
    const d = decideHangRestart({
      midToolCall: false,
      markerAgeMs: null,
      stalenessThresholdMs: STALE,
      cooldownActive: false,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('not-mid-tool')
  })

  it('cooldown suppresses a restart even when stale (storm guard)', () => {
    const d = decideHangRestart({
      midToolCall: true,
      markerAgeMs: 900_000,
      stalenessThresholdMs: STALE,
      cooldownActive: true,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('cooldown-active')
  })
})

describe('config + cooldown helpers', () => {
  it('hangStalenessMs keys off TURN_HANG_SECS (seconds → ms), default 300s', () => {
    expect(hangStalenessMs({})).toBe(DEFAULT_HANG_STALENESS_MS)
    expect(hangStalenessMs({ TURN_HANG_SECS: '120' })).toBe(120_000)
    expect(hangStalenessMs({ TURN_HANG_SECS: 'nope' })).toBe(DEFAULT_HANG_STALENESS_MS)
    expect(hangStalenessMs({ TURN_HANG_SECS: '0' })).toBe(DEFAULT_HANG_STALENESS_MS)
  })

  it('hangRestartCooldownMs defaults to 10 min, honours a valid override', () => {
    expect(hangRestartCooldownMs({})).toBe(DEFAULT_HANG_RESTART_COOLDOWN_MS)
    expect(hangRestartCooldownMs({ SWITCHROOM_HANG_RESTART_COOLDOWN_MS: '60000' })).toBe(60_000)
    expect(hangRestartCooldownMs({ SWITCHROOM_HANG_RESTART_COOLDOWN_MS: '-1' })).toBe(DEFAULT_HANG_RESTART_COOLDOWN_MS)
  })

  it('isHangRestartCooldownActive: null last-fire = inactive; within window = active', () => {
    expect(isHangRestartCooldownActive(null, 1_000_000, 600_000)).toBe(false)
    expect(isHangRestartCooldownActive(1_000_000, 1_300_000, 600_000)).toBe(true) // 5 min ago < 10 min
    expect(isHangRestartCooldownActive(1_000_000, 1_700_000, 600_000)).toBe(false) // 11.6 min ago
  })
})
