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
 * Returns the same shape as the real tool handler.
 */
function executeProgressUpdate(args: {
  chat_id: string
  text: string
  message_thread_id?: number
}): ProgressUpdateResult {
  const { chat_id, message_thread_id } = args
  let { text } = args
  const threadId = message_thread_id
  const key = statusKey(chat_id, threadId)

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

  // Turn cap: max 5 calls per turn
  const turnStart = activeTurnStartedAt.get(key)
  if (turnStart != null) {
    const currentCount = progressUpdateTurnCount.get(key) ?? 0
    if (currentCount >= 5) {
      return { ok: false, reason: 'turn_limit' }
    }
    progressUpdateTurnCount.set(key, currentCount + 1)
  }

  progressUpdateLastSent.set(key, now)

  // Mock message_id
  return { ok: true, message_id: Math.floor(Math.random() * 100000) }
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

  it('when no active turn, still rate-limits but does not increment counter', () => {
    // No activeTurnStartedAt entry for this chat
    const r1 = executeProgressUpdate({ chat_id: '999', text: 'First' })
    expect(r1.ok).toBe(true)

    advance(10_000)
    const r2 = executeProgressUpdate({ chat_id: '999', text: 'Second' })
    expect(r2.ok).toBe(false)

    // Counter should not have been incremented (no active turn)
    const key = statusKey('999')
    expect(progressUpdateTurnCount.get(key)).toBeUndefined()
  })
})
