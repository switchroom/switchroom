import { describe, it, expect } from 'vitest'
import {
  decideRedeliver,
  frameRedelivery,
  REDELIVERY_PREFIX,
  type RedeliverDecisionInput,
} from '../gateway/redelivery-decision.js'

/**
 * Pins the crash-survival redelivery decision predicate. The load-bearing
 * property is the DURABLE TEXT-IDENTITY oracle: an interim `progress_update`
 * earlier in the same turn must NOT suppress a genuinely-undelivered final
 * answer (the exact MISS = permanent-silence bug this fix closes), while an
 * already-delivered final answer MUST be suppressed.
 */

const base: RedeliverDecisionInput = {
  capturedText: 'The deploy finished — all three services are green.',
  trailingIsText: true,
  hasDeliveredText: false,
  alreadyRedelivered: false,
  ageMs: 60_000,
  maxAgeMs: 10_800_000, // 3h
}

describe('decideRedeliver — text-identity oracle', () => {
  it('REDELIVERS an undelivered final answer even when an interim message was sent (the MISS bug)', () => {
    // The MISS scenario: a progress_update landed a role=assistant row earlier
    // in the turn, so a chat+time-window oracle would say "delivered" and skip.
    // The text-identity oracle keys on the ANSWER text — which was never sent —
    // so hasDeliveredText is false and redelivery fires.
    const d = decideRedeliver({ ...base, hasDeliveredText: false })
    expect(d.redeliver).toBe(true)
    expect(d.framedText).toContain(base.capturedText)
    expect(d.framedText?.startsWith(REDELIVERY_PREFIX)).toBe(true)
  })

  it('SUPPRESSES when the final answer text was already delivered', () => {
    const d = decideRedeliver({ ...base, hasDeliveredText: true })
    expect(d.redeliver).toBe(false)
    expect(d.skipReason).toBe('already-delivered')
  })
})

describe('decideRedeliver — other skip reasons', () => {
  it('skips empty / whitespace text', () => {
    expect(decideRedeliver({ ...base, capturedText: '   ' }).skipReason).toBe('empty-text')
  })

  it('skips when trailing content is a dangling tool_use (mid-stream, not an answer)', () => {
    expect(decideRedeliver({ ...base, trailingIsText: false }).skipReason).toBe('trailing-not-text')
  })

  it('skips an already-redelivered turn (at-most-once ledger)', () => {
    expect(decideRedeliver({ ...base, alreadyRedelivered: true }).skipReason).toBe('already-redelivered')
  })

  it('skips a stale turn beyond maxAgeMs', () => {
    expect(decideRedeliver({ ...base, ageMs: 4 * 3_600_000 }).skipReason).toBe('stale')
  })

  it('precedence: empty-text wins over delivered/redelivered/stale', () => {
    const d = decideRedeliver({
      ...base,
      capturedText: '',
      hasDeliveredText: true,
      alreadyRedelivered: true,
      ageMs: 999_999_999,
    })
    expect(d.skipReason).toBe('empty-text')
  })

  it('precedence: already-redelivered is checked before the age failsafe', () => {
    const d = decideRedeliver({ ...base, alreadyRedelivered: true, ageMs: 999_999_999 })
    expect(d.skipReason).toBe('already-redelivered')
  })
})

describe('frameRedelivery', () => {
  it('frames as a recovered draft, never a clean final answer', () => {
    const framed = frameRedelivery('  hello world  ')
    expect(framed).toBe(`${REDELIVERY_PREFIX}\n\nhello world`)
  })
})
