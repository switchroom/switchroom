import { describe, it, expect } from 'vitest'
import {
  formatTurnLifecycle,
  detectStatusSurfaceDegraded,
  type StatusSurfaceTurnView,
} from './status-surface-log.js'

function turn(overrides: Partial<StatusSurfaceTurnView> = {}): StatusSurfaceTurnView {
  return {
    turnId: '-100123:_#1780000000000',
    sessionChatId: '-100123',
    sessionThreadId: undefined,
    startedAt: 1_780_000_000_000,
    toolCallCount: 0,
    activityMessageId: null,
    activityEverOpened: false,
    activityDrainFailures: 0,
    replyCalled: false,
    finalAnswerDelivered: false,
    ...overrides,
  }
}

describe('formatTurnLifecycle', () => {
  it('renders a set line with no age and a "-" thread for General', () => {
    const line = formatTurnLifecycle('set', 'enqueue', turn(), 1_780_000_005_000)
    expect(line).toContain('turn-lifecycle set reason=enqueue')
    expect(line).toContain('turnId=-100123:_#1780000000000')
    expect(line).toContain('chat=-100123')
    expect(line).toContain('thread=-')
    expect(line).toContain('age_ms=0') // set never reports age
  })

  it('renders a clear line with the turn age and live state', () => {
    const line = formatTurnLifecycle(
      'clear',
      'turn_end',
      turn({ sessionThreadId: 3, toolCallCount: 5, activityMessageId: 42, activityEverOpened: true, replyCalled: true, finalAnswerDelivered: true }),
      1_780_000_300_000, // +300s
    )
    expect(line).toContain('turn-lifecycle clear reason=turn_end')
    expect(line).toContain('thread=3')
    expect(line).toContain('tools=5')
    expect(line).toContain('activityMsgId=42')
    expect(line).toContain('feedOpened=true')
    expect(line).toContain('replyCalled=true')
    expect(line).toContain('finalAnswer=true')
    expect(line).toContain('age_ms=300000')
  })

  it('never emits a negative age even if startedAt is in the future (clock skew)', () => {
    const line = formatTurnLifecycle('clear', 'turn_end', turn({ startedAt: 2_000_000_000_000 }), 1_780_000_000_000)
    expect(line).toContain('age_ms=0')
  })

  it('carries no prefix or trailing newline — the caller owns transport', () => {
    const line = formatTurnLifecycle('set', 'enqueue', turn(), 0)
    expect(line.startsWith('telegram gateway:')).toBe(false)
    expect(line.endsWith('\n')).toBe(false)
  })
})

describe('detectStatusSurfaceDegraded', () => {
  it('flags a turn that did tool work but never opened the feed due to send failures (the resume-400 signature)', () => {
    const d = detectStatusSurfaceDegraded(
      turn({ toolCallCount: 3, activityEverOpened: false, activityDrainFailures: 10 }),
    )
    expect(d).not.toBeNull()
    expect(d!.reason).toBe('feed-never-opened')
    expect(d!.detail).toContain('drainFailures=10')
  })

  it('does NOT flag a healthy turn where the feed opened, even if later cleared (activityMessageId nulled)', () => {
    // clearActivitySummary nulls activityMessageId async on the healthy path;
    // the sticky activityEverOpened keeps this from false-positiving.
    expect(
      detectStatusSurfaceDegraded(
        turn({ toolCallCount: 4, activityMessageId: null, activityEverOpened: true, activityDrainFailures: 0 }),
      ),
    ).toBeNull()
  })

  it('does NOT flag a turn that never attempted a feed send (e.g. ack-first suppression)', () => {
    expect(
      detectStatusSurfaceDegraded(
        turn({ toolCallCount: 2, activityEverOpened: false, activityDrainFailures: 0 }),
      ),
    ).toBeNull()
  })

  it('does NOT flag a turn with no tool work (nothing to surface)', () => {
    expect(
      detectStatusSurfaceDegraded(
        turn({ toolCallCount: 0, activityEverOpened: false, activityDrainFailures: 3 }),
      ),
    ).toBeNull()
  })
})
