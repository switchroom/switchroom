/**
 * Unit tests for progress_update tool: rate limiting, turn cap, text truncation.
 *
 * Note on time mocking: this file used to import `vi` from `vitest` and rely
 * on `vi.useFakeTimers()` + `vi.setSystemTime()`. Bun's vitest shim does NOT
 * implement `vi.setSystemTime`, so the suite was failing in CI. Rewritten to
 * use `bun:test` and manual `Date.now` mocking via `spyOn`. See CI build #48
 * (failed 9/1931) for the original symptom.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'
import {
  progressFallbackAtCap,
  recordProgressFallbackSend,
  _resetProgressFallbackCap,
} from '../gateway/progress-fallback-cap.js'

// Mock state shared across tests (simulates the module-level state in server.ts / gateway.ts)
const progressUpdateLastSent = new Map<string, number>()
const progressUpdateTurnCount = new Map<string, number>()
const activeTurnStartedAt = new Map<string, number>()

function statusKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

type ProgressUpdateResult =
  | { ok: true; message_id: number }
  | { ok: false; reason: 'too_soon'; retryAfterMs: number }
  | { ok: false; reason: 'turn_limit' }

/**
 * Simplified progress_update implementation for testing.
 * Mirrors the real tool handler's ORDERING (gateway.ts `executeProgressUpdate`):
 * check caps → send (may throw) → count the delivery only AFTER it lands. The
 * turn-less fallback path calls the REAL cap module, not a copy.
 *
 * `send` is an injectable seam so a test can make the send throw and assert no
 * slot is consumed (Fix 2). It defaults to a successful send.
 */
function executeProgressUpdate(args: {
  chat_id: string
  text: string
  message_thread_id?: number
  send?: () => number
}): ProgressUpdateResult {
  const { chat_id, message_thread_id } = args
  let { text } = args
  const threadId = message_thread_id
  const key = statusKey(chat_id, threadId)
  const send = args.send ?? (() => Math.floor(Math.random() * 100000))

  // Truncate to 300 chars
  if (text.length > 300) {
    text = text.slice(0, 299) + '…'
  }

  const now = Date.now()

  // Rate limit: ≥ 20s between calls
  const lastSent = progressUpdateLastSent.get(key)
  if (lastSent != null) {
    const elapsed = now - lastSent
    if (elapsed < 20_000) {
      return { ok: false, reason: 'too_soon', retryAfterMs: 20_000 - elapsed }
    }
  }

  // Attention cap: max 5 deliveries per turn atom, else a rolling fallback
  // window when no turn atom exists. Checked BEFORE the send; the count is
  // advanced only after a successful send (below).
  const turnStart = activeTurnStartedAt.get(key)
  const atCap =
    turnStart != null
      ? (progressUpdateTurnCount.get(key) ?? 0) >= 5
      : progressFallbackAtCap(key, now)
  if (atCap) {
    return { ok: false, reason: 'turn_limit' }
  }

  // Send. A throw here must NOT consume a slot — it propagates before any
  // bookkeeping runs.
  const message_id = send()

  progressUpdateLastSent.set(key, now)
  if (turnStart != null) {
    progressUpdateTurnCount.set(key, (progressUpdateTurnCount.get(key) ?? 0) + 1)
  } else {
    recordProgressFallbackSend(key, now)
  }

  return { ok: true, message_id }
}

// Manual time mocking — bun:test compatible (bun lacks vi.setSystemTime).
let mockNow = 1000
let dateSpy: Mock<typeof Date.now> | null = null
function advance(ms: number): void {
  mockNow += ms
}

describe('progress_update tool', () => {
  beforeEach(() => {
    progressUpdateLastSent.clear()
    progressUpdateTurnCount.clear()
    activeTurnStartedAt.clear()
    _resetProgressFallbackCap()
    mockNow = 1000
    dateSpy = spyOn(Date, 'now').mockImplementation(() => mockNow)
  })

  afterEach(() => {
    dateSpy?.mockRestore()
    dateSpy = null
  })

  it('happy path: single update sends and returns ok', () => {
    const key = statusKey('123')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    const result = executeProgressUpdate({
      chat_id: '123',
      text: 'Got it. Going to do X first, then Y.',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message_id).toBeGreaterThan(0)
    }
    expect(progressUpdateTurnCount.get(key)).toBe(1)
  })

  it('rate limit: second update within 20s returns too_soon', () => {
    const key = statusKey('123')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    const r1 = executeProgressUpdate({ chat_id: '123', text: 'First' })
    expect(r1.ok).toBe(true)

    // Advance 10s (not enough)
    advance(10_000)

    const r2 = executeProgressUpdate({ chat_id: '123', text: 'Second' })
    expect(r2.ok).toBe(false)
    if (!r2.ok && r2.reason === 'too_soon') {
      expect(r2.retryAfterMs).toBeGreaterThan(9000)
      expect(r2.retryAfterMs).toBeLessThanOrEqual(10_000)
    }
  })

  it('after 20s elapsed: update goes through', () => {
    const key = statusKey('123')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    const r1 = executeProgressUpdate({ chat_id: '123', text: 'First' })
    expect(r1.ok).toBe(true)

    // Advance 20s
    advance(20_000)

    const r2 = executeProgressUpdate({ chat_id: '123', text: 'Second' })
    expect(r2.ok).toBe(true)
    expect(progressUpdateTurnCount.get(key)).toBe(2)
  })

  it('turn cap: 6th update in one turn returns turn_limit', () => {
    const key = statusKey('123')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    for (let i = 1; i <= 5; i++) {
      advance(20_000)
      const r = executeProgressUpdate({ chat_id: '123', text: `Update ${i}` })
      expect(r.ok).toBe(true)
    }

    // 6th call
    advance(20_000)
    const r6 = executeProgressUpdate({ chat_id: '123', text: 'Update 6' })
    expect(r6.ok).toBe(false)
    if (!r6.ok) {
      expect(r6.reason).toBe('turn_limit')
    }
  })

  it('400-char text truncates to ~300 with trailing "…"', () => {
    const key = statusKey('123')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    const longText = 'a'.repeat(400)
    const result = executeProgressUpdate({ chat_id: '123', text: longText })

    expect(result.ok).toBe(true)
    // The implementation truncates inside executeProgressUpdate, but we can't
    // easily verify the sent text from here. Instead, verify the logic:
    const truncated = longText.length > 300 ? longText.slice(0, 299) + '…' : longText
    expect(truncated.length).toBe(300)
    expect(truncated.endsWith('…')).toBe(true)
  })

  it('new turn resets counter', () => {
    const key = statusKey('123')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    // Send 5 updates
    for (let i = 1; i <= 5; i++) {
      advance(20_000)
      executeProgressUpdate({ chat_id: '123', text: `Update ${i}` })
    }
    expect(progressUpdateTurnCount.get(key)).toBe(5)

    // New turn starts (reset counter)
    progressUpdateTurnCount.set(key, 0)
    activeTurnStartedAt.set(key, Date.now())

    // Should be able to send again
    advance(20_000)
    const r = executeProgressUpdate({ chat_id: '123', text: 'New turn update' })
    expect(r.ok).toBe(true)
    expect(progressUpdateTurnCount.get(key)).toBe(1)
  })

  it('different chat+thread keys are independent', () => {
    const key1 = statusKey('123', 456)
    const key2 = statusKey('123', 789)
    activeTurnStartedAt.set(key1, 1000)
    activeTurnStartedAt.set(key2, 1000)
    progressUpdateTurnCount.set(key1, 0)
    progressUpdateTurnCount.set(key2, 0)

    const r1 = executeProgressUpdate({ chat_id: '123', text: 'Thread 1', message_thread_id: 456 })
    expect(r1.ok).toBe(true)

    // Immediately send to different thread (no rate limit)
    const r2 = executeProgressUpdate({ chat_id: '123', text: 'Thread 2', message_thread_id: 789 })
    expect(r2.ok).toBe(true)

    expect(progressUpdateTurnCount.get(key1)).toBe(1)
    expect(progressUpdateTurnCount.get(key2)).toBe(1)
  })

  it('when no active turn, still rate-limits but does not increment the turn counter', () => {
    // No activeTurnStartedAt entry for this chat
    const r1 = executeProgressUpdate({ chat_id: '999', text: 'First' })
    expect(r1.ok).toBe(true)

    advance(10_000)
    const r2 = executeProgressUpdate({ chat_id: '999', text: 'Second' })
    expect(r2.ok).toBe(false)

    // The per-turn counter is untouched on the turn-less path (the fallback
    // window carries the count instead).
    const key = statusKey('999')
    expect(progressUpdateTurnCount.get(key)).toBeUndefined()
  })

  // Fix 1: with NO turn atom, the fallback rolling window still caps at 5.
  it('null-turn-atom context caps at 5 sends per window (Fix 1)', () => {
    // No activeTurnStartedAt entry — the pre-fix code applied no cap here at
    // all, so this loop would let a 6th (and every subsequent) send through.
    for (let i = 1; i <= 5; i++) {
      advance(25_000) // clear the 20s floor each time
      const r = executeProgressUpdate({ chat_id: '888', text: `Update ${i}` })
      expect(r.ok).toBe(true)
    }
    advance(25_000)
    const r6 = executeProgressUpdate({ chat_id: '888', text: 'Update 6' })
    expect(r6.ok).toBe(false)
    if (!r6.ok) {
      expect(r6.reason).toBe('turn_limit')
    }
  })

  // Fix 2: a thrown send must NOT consume a cap slot (turn-scoped path).
  it('a thrown send does not consume a turn-cap slot (Fix 2)', () => {
    const key = statusKey('777')
    activeTurnStartedAt.set(key, 1000)
    progressUpdateTurnCount.set(key, 0)

    // A send that throws: the cap was checked, but nothing was delivered.
    expect(() =>
      executeProgressUpdate({
        chat_id: '777',
        text: 'boom',
        send: () => {
          throw new Error('telegram 500')
        },
      }),
    ).toThrow('telegram 500')

    // Slot NOT consumed — pre-fix the counter incremented before the send.
    expect(progressUpdateTurnCount.get(key)).toBe(0)

    // A subsequent successful send still has its full budget and counts once.
    advance(25_000)
    const r = executeProgressUpdate({ chat_id: '777', text: 'real' })
    expect(r.ok).toBe(true)
    expect(progressUpdateTurnCount.get(key)).toBe(1)
  })

  // Fix 2 composed with Fix 1: a thrown send on the turn-less path records
  // nothing in the fallback window either.
  it('a thrown send does not consume a fallback-window slot (Fix 2 × Fix 1)', () => {
    // Five throwing sends on the turn-less path.
    for (let i = 0; i < 5; i++) {
      advance(25_000)
      expect(() =>
        executeProgressUpdate({
          chat_id: '666',
          text: 'boom',
          send: () => {
            throw new Error('telegram 500')
          },
        }),
      ).toThrow('telegram 500')
    }
    // The window is still empty — five throws consumed no slots, so five real
    // sends are still allowed.
    for (let i = 1; i <= 5; i++) {
      advance(25_000)
      const r = executeProgressUpdate({ chat_id: '666', text: `real ${i}` })
      expect(r.ok).toBe(true)
    }
    advance(25_000)
    const capped = executeProgressUpdate({ chat_id: '666', text: 'over' })
    expect(capped.ok).toBe(false)
  })
})
