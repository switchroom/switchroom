/**
 * Tests for the restart-watchdog decision logic + systemd output parsing.
 * Issue #92 + #30 task 4 — surface unexpected systemd-driven agent
 * restarts as `agent-restarted-unexpectedly` operator events.
 *
 * The pure decision function `decideWatchdogTick` is the hot path here.
 * The polling integration (timers, execFileSync) is exercised via the
 * `startRestartWatchdog` smoke test with injected callbacks.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  parseSystemdShowOutput,
  decideWatchdogTick,
  startRestartWatchdog,
  type SystemdShowResult,
} from '../gateway/restart-watchdog.js'

// ─── parseSystemdShowOutput ───────────────────────────────────────────────────

describe('parseSystemdShowOutput', () => {
  it('parses the canonical two-line output', () => {
    const raw = 'NRestarts=3\nActiveEnterTimestampMonotonic=12345678\n'
    expect(parseSystemdShowOutput(raw)).toEqual({
      nRestarts: 3,
      activeEnterTimestampMonotonic: 12345678,
    })
  })

  it('handles CRLF line endings', () => {
    const raw = 'NRestarts=0\r\nActiveEnterTimestampMonotonic=999\r\n'
    expect(parseSystemdShowOutput(raw)).toEqual({
      nRestarts: 0,
      activeEnterTimestampMonotonic: 999,
    })
  })

  it('ignores unrelated keys interleaved by systemctl', () => {
    const raw = [
      'Description=switchroom-gymbro',
      'NRestarts=2',
      'ActiveState=active',
      'ActiveEnterTimestampMonotonic=42',
      'SubState=running',
    ].join('\n')
    expect(parseSystemdShowOutput(raw)?.nRestarts).toBe(2)
    expect(parseSystemdShowOutput(raw)?.activeEnterTimestampMonotonic).toBe(42)
  })

  it('returns null when NRestarts is missing', () => {
    expect(parseSystemdShowOutput('ActiveEnterTimestampMonotonic=1\n')).toBeNull()
  })

  it('returns null when ActiveEnterTimestampMonotonic is missing', () => {
    expect(parseSystemdShowOutput('NRestarts=1\n')).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(parseSystemdShowOutput('')).toBeNull()
  })

  it('returns null when values are unparseable', () => {
    expect(parseSystemdShowOutput('NRestarts=foo\nActiveEnterTimestampMonotonic=42\n')).toBeNull()
    expect(parseSystemdShowOutput('NRestarts=-1\nActiveEnterTimestampMonotonic=42\n')).toBeNull()
  })
})

// ─── decideWatchdogTick ───────────────────────────────────────────────────────

function snap(nRestarts: number, activeEnter = 1000): SystemdShowResult {
  return { nRestarts, activeEnterTimestampMonotonic: activeEnter }
}

describe('decideWatchdogTick', () => {
  it('first tick after boot just records the baseline (no emit)', () => {
    const decision = decideWatchdogTick({
      current: snap(5),
      previous: null,
      recentPlannedRestart: false,
    })
    expect(decision.emit).toBe(false)
    expect(decision.nextSnapshot).toEqual(snap(5))
  })

  it('no change in NRestarts → no emit', () => {
    const decision = decideWatchdogTick({
      current: snap(3),
      previous: snap(3),
      recentPlannedRestart: false,
    })
    expect(decision.emit).toBe(false)
  })

  it('NRestarts increased + no planned-restart marker → emit', () => {
    const decision = decideWatchdogTick({
      current: snap(4),
      previous: snap(3),
      recentPlannedRestart: false,
    })
    expect(decision.emit).toBe(true)
    expect(decision.detail).toContain('unexpectedly')
    expect(decision.nextSnapshot).toEqual(snap(4))
  })

  it('NRestarts increased + planned-restart marker present → no emit, but advances baseline', () => {
    const decision = decideWatchdogTick({
      current: snap(4),
      previous: snap(3),
      recentPlannedRestart: true,
    })
    expect(decision.emit).toBe(false)
    expect(decision.detail).toContain('planned restart')
    // The baseline MUST advance even on suppressed emits — otherwise the
    // next tick (post-marker-clear) would re-emit the same delta.
    expect(decision.nextSnapshot).toEqual(snap(4))
  })

  it('multi-restart delta > 1 → emit with count in detail', () => {
    const decision = decideWatchdogTick({
      current: snap(7),
      previous: snap(3),
      recentPlannedRestart: false,
    })
    expect(decision.emit).toBe(true)
    expect(decision.detail).toContain('4 times')
  })

  it('NRestarts went DOWN (unit reloaded) → no emit', () => {
    // Counter resets on `daemon-reload`. Don't crash; just rebaseline.
    const decision = decideWatchdogTick({
      current: snap(0),
      previous: snap(5),
      recentPlannedRestart: false,
    })
    expect(decision.emit).toBe(false)
    expect(decision.nextSnapshot).toEqual(snap(0))
  })
})

// ─── startRestartWatchdog (smoke test) ───────────────────────────────────────

describe('startRestartWatchdog', () => {
  it('disabled when pollIntervalMs is 0', () => {
    const emit = vi.fn()
    const handle = startRestartWatchdog({
      agentName: 'gymbro',
      pollIntervalMs: 0,
      execShow: () => 'NRestarts=0\nActiveEnterTimestampMonotonic=0\n',
      isPlannedRestartFresh: () => false,
      emit,
    })
    expect(emit).not.toHaveBeenCalled()
    handle.stop()
  })

  it('first tick establishes baseline; second tick fires on delta', async () => {
    let nRestarts = 0
    const emit = vi.fn()
    const handle = startRestartWatchdog({
      agentName: 'gymbro',
      pollIntervalMs: 5,  // tight interval for the test
      execShow: () => `NRestarts=${nRestarts}\nActiveEnterTimestampMonotonic=1\n`,
      isPlannedRestartFresh: () => false,
      emit,
    })
    // First tick (synchronous in startRestartWatchdog) sets baseline at 0.
    expect(emit).not.toHaveBeenCalled()

    // Bump and wait for the next interval.
    nRestarts = 1
    await new Promise((r) => setTimeout(r, 30))

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toContain('unexpectedly')

    handle.stop()
  })

  it('skips ticks where execShow throws (no emit, no crash)', async () => {
    const emit = vi.fn()
    const handle = startRestartWatchdog({
      agentName: 'gymbro',
      pollIntervalMs: 5,
      execShow: () => {
        throw new Error('systemctl not found')
      },
      isPlannedRestartFresh: () => false,
      emit,
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(emit).not.toHaveBeenCalled()
    handle.stop()
  })

  it('skips ticks where systemctl returns garbage (parse fails)', async () => {
    const emit = vi.fn()
    const handle = startRestartWatchdog({
      agentName: 'gymbro',
      pollIntervalMs: 5,
      execShow: () => 'this is not key=value output',
      isPlannedRestartFresh: () => false,
      emit,
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(emit).not.toHaveBeenCalled()
    handle.stop()
  })

  it('does not emit when the planned-restart marker is fresh', async () => {
    let nRestarts = 0
    const emit = vi.fn()
    const handle = startRestartWatchdog({
      agentName: 'gymbro',
      pollIntervalMs: 5,
      execShow: () => `NRestarts=${nRestarts}\nActiveEnterTimestampMonotonic=1\n`,
      isPlannedRestartFresh: () => true,
      emit,
    })
    nRestarts = 1
    await new Promise((r) => setTimeout(r, 30))
    expect(emit).not.toHaveBeenCalled()
    handle.stop()
  })
})
