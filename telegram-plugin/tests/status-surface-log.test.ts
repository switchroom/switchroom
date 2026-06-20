import { describe, it, expect } from 'vitest'
import { formatTurnLifecycle, detectStatusSurfaceDegraded } from '../gateway/status-surface-log.js'
import type { StatusSurfaceTurnView } from '../gateway/status-surface-log.js'

/**
 * Tests for status-surface-log.ts (issue #2461).
 *
 * Verifies that:
 *   - `formatTurnLifecycle` uses `labeledToolCount` (not `toolCallCount`) for
 *     the `tools=` lifecycle log field — so the log reflects the accurate
 *     surfaced count, not the raw tool_use count that includes surface tools.
 *   - `detectStatusSurfaceDegraded` uses `labeledToolCount` to determine
 *     whether to check for the feed-never-opened degraded state.
 */

function makeTurn(overrides: Partial<StatusSurfaceTurnView> = {}): StatusSurfaceTurnView {
  return {
    turnId: 'turn-abc',
    sessionChatId: '123456',
    sessionThreadId: undefined,
    startedAt: 1000,
    toolCallCount: 10,      // raw tool_use count — includes surface tools
    labeledToolCount: 5,    // surfaced count — only non-surface, non-suppressed
    activityMessageId: null,
    activityEverOpened: false,
    activityDrainFailures: 0,
    replyCalled: false,
    finalAnswerDelivered: false,
    ...overrides,
  }
}

describe('formatTurnLifecycle — tools= field uses labeledToolCount (#2461)', () => {
  it('set action: tools= reports labeledToolCount, not toolCallCount', () => {
    const t = makeTurn({ toolCallCount: 10, labeledToolCount: 5 })
    const line = formatTurnLifecycle('set', 'enqueue', t, 1000)
    expect(line).toContain('tools=5')
    // The raw toolCallCount (10) must NOT appear in the tools= field.
    expect(line).not.toMatch(/tools=10/)
  })

  it('clear action: tools= also uses labeledToolCount', () => {
    const t = makeTurn({ toolCallCount: 7, labeledToolCount: 3 })
    const line = formatTurnLifecycle('clear', 'turn_end', t, 2000)
    expect(line).toContain('tools=3')
    expect(line).not.toMatch(/tools=7/)
  })

  it('clear action: age_ms is computed from startedAt', () => {
    const t = makeTurn({ startedAt: 1000 })
    const line = formatTurnLifecycle('clear', 'turn_end', t, 3500)
    expect(line).toContain('age_ms=2500')
  })

  it('set action: age_ms is always 0', () => {
    const t = makeTurn({ startedAt: 1000 })
    const line = formatTurnLifecycle('set', 'enqueue', t, 9999)
    expect(line).toContain('age_ms=0')
  })

  it('includes turnId, chat, thread, feedOpened, drainFailures, replyCalled, finalAnswer', () => {
    const t = makeTurn({
      turnId: 'turn-xyz',
      sessionChatId: '777',
      sessionThreadId: 42,
      activityMessageId: 99,
      activityEverOpened: true,
      activityDrainFailures: 2,
      replyCalled: true,
      finalAnswerDelivered: true,
    })
    const line = formatTurnLifecycle('clear', 'turn_end', t, 2000)
    expect(line).toContain('turnId=turn-xyz')
    expect(line).toContain('chat=777')
    expect(line).toContain('thread=42')
    expect(line).toContain('activityMsgId=99')
    expect(line).toContain('feedOpened=true')
    expect(line).toContain('drainFailures=2')
    expect(line).toContain('replyCalled=true')
    expect(line).toContain('finalAnswer=true')
  })

  it('thread=- when sessionThreadId is undefined', () => {
    const t = makeTurn({ sessionThreadId: undefined })
    const line = formatTurnLifecycle('set', 'enqueue', t, 1000)
    expect(line).toContain('thread=-')
  })

  it('labeledToolCount=0 reports tools=0', () => {
    const t = makeTurn({ labeledToolCount: 0, toolCallCount: 3 })
    const line = formatTurnLifecycle('set', 'enqueue', t, 1000)
    expect(line).toContain('tools=0')
  })
})

describe('detectStatusSurfaceDegraded — uses labeledToolCount (#2461)', () => {
  it('returns null when labeledToolCount=0 (no surfaced tool work this turn)', () => {
    // Even if the raw toolCallCount is non-zero (surface-only tools like
    // reply/react fired), labeledToolCount=0 means nothing to surface → null.
    const t = makeTurn({ labeledToolCount: 0, toolCallCount: 5 })
    expect(detectStatusSurfaceDegraded(t)).toBeNull()
  })

  it('returns null when feed opened fine (activityEverOpened=true)', () => {
    const t = makeTurn({ labeledToolCount: 3, activityEverOpened: true, activityDrainFailures: 2 })
    expect(detectStatusSurfaceDegraded(t)).toBeNull()
  })

  it('returns null when no drain failures (feed never tried to open — not degraded)', () => {
    const t = makeTurn({ labeledToolCount: 3, activityEverOpened: false, activityDrainFailures: 0 })
    expect(detectStatusSurfaceDegraded(t)).toBeNull()
  })

  it('returns degraded when labeledToolCount>0, feed never opened, and drain failures>0', () => {
    const t = makeTurn({
      labeledToolCount: 4,
      toolCallCount: 6,
      activityEverOpened: false,
      activityDrainFailures: 3,
    })
    const result = detectStatusSurfaceDegraded(t)
    expect(result).not.toBeNull()
    expect(result!.reason).toBe('feed-never-opened')
    // detail uses labeledToolCount, not toolCallCount
    expect(result!.detail).toContain('tools=4')
    expect(result!.detail).not.toMatch(/tools=6/)
    expect(result!.detail).toContain('drainFailures=3')
  })
})
