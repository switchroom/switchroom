/**
 * Integration test for the `progress_update` attention-cap RESERVATION path
 * (`gateway/progress-fallback-cap.ts` `reserveProgressSlot` /
 * `sendWithProgressCap`).
 *
 * These are the REAL functions the gateway's `executeProgressUpdate` calls —
 * not a mirror re-implementation. `executeProgressUpdate` wires
 * `sendWithProgressCap({ key, now, turnStart, turnCount }, () => robustApiCall(...))`
 * and returns `turn_limit` on `{ capped: true }`, so an ordering regression
 * INSIDE the reserve/release/cap logic is caught here. (The surrounding
 * executeProgressUpdate — truncation, the 20s floor, secret scrub — is covered
 * by `progress-update.test.ts`; isolating the whole async function would drag in
 * the entire gateway module, so the counter-ordering + cap logic is the seam
 * bound directly.)
 *
 * What it proves:
 *   (a) the turn-less fallback path caps at 5 and refuses the 6th;
 *   (b) a thrown send consumes NO slot on either path (release-on-throw);
 *   (c) N truly-concurrent same-key sends never exceed the cap (Low 1 — the
 *       reservation happens BEFORE the await, so a concurrent caller sees it).
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  reserveProgressSlot,
  sendWithProgressCap,
  _resetProgressFallbackCap,
  PROGRESS_TURN_MAX,
} from '../gateway/progress-fallback-cap.js'

const KEY = 'chat123:_'

/** A send that resolves on the next microtask (models the real async send). */
function asyncSend<T>(value: T, counter?: { n: number }): () => Promise<T> {
  return async () => {
    await Promise.resolve()
    if (counter) counter.n += 1
    return value
  }
}

describe('progress cap reservation (real gateway path)', () => {
  beforeEach(() => {
    _resetProgressFallbackCap()
  })

  // (a) turn-less path caps at PROGRESS_TURN_MAX, refuses the next.
  it('turn-less path allows exactly PROGRESS_TURN_MAX then caps (a)', async () => {
    const turnCount = new Map<string, number>()
    const now = 1_000
    for (let i = 0; i < PROGRESS_TURN_MAX; i++) {
      const r = await sendWithProgressCap(
        { key: KEY, now, turnStart: undefined, turnCount },
        asyncSend({ message_id: i }),
      )
      expect(r.capped).toBe(false)
    }
    const over = await sendWithProgressCap(
      { key: KEY, now, turnStart: undefined, turnCount },
      asyncSend({ message_id: 99 }),
    )
    expect(over.capped).toBe(true)
  })

  // (a') turn-scoped path caps too, and does not touch the fallback window.
  it('turn-scoped path caps at PROGRESS_TURN_MAX (a)', async () => {
    const turnCount = new Map<string, number>()
    const deps = { key: KEY, now: 1_000, turnStart: 1_000, turnCount }
    for (let i = 0; i < PROGRESS_TURN_MAX; i++) {
      const r = await sendWithProgressCap(deps, asyncSend({ message_id: i }))
      expect(r.capped).toBe(false)
    }
    expect(turnCount.get(KEY)).toBe(PROGRESS_TURN_MAX)
    const over = await sendWithProgressCap(deps, asyncSend({ message_id: 99 }))
    expect(over.capped).toBe(true)
    // Still exactly at the cap — the refused call did not increment.
    expect(turnCount.get(KEY)).toBe(PROGRESS_TURN_MAX)
  })

  // (b) a thrown send releases the turn-counter slot.
  it('a thrown send consumes no turn-counter slot (b)', async () => {
    const turnCount = new Map<string, number>([[KEY, 0]])
    const deps = { key: KEY, now: 1_000, turnStart: 1_000, turnCount }
    await expect(
      sendWithProgressCap(deps, async () => {
        throw new Error('telegram 500')
      }),
    ).rejects.toThrow('telegram 500')
    // Slot released → counter back to 0.
    expect(turnCount.get(KEY)).toBe(0)
    // Full budget still available afterwards.
    for (let i = 0; i < PROGRESS_TURN_MAX; i++) {
      const r = await sendWithProgressCap(deps, asyncSend({ message_id: i }))
      expect(r.capped).toBe(false)
    }
    expect(turnCount.get(KEY)).toBe(PROGRESS_TURN_MAX)
  })

  // (b) a thrown send releases the fallback-window slot.
  it('a thrown send consumes no fallback-window slot (b)', async () => {
    const turnCount = new Map<string, number>()
    const now = 1_000
    // PROGRESS_TURN_MAX throwing sends on the turn-less path.
    for (let i = 0; i < PROGRESS_TURN_MAX; i++) {
      await expect(
        sendWithProgressCap(
          { key: KEY, now, turnStart: undefined, turnCount },
          async () => {
            throw new Error('telegram 500')
          },
        ),
      ).rejects.toThrow('telegram 500')
    }
    // Window is still empty — every throw released its slot, so a full budget
    // of real deliveries is allowed, and only the (MAX+1)th is capped.
    for (let i = 0; i < PROGRESS_TURN_MAX; i++) {
      const r = await sendWithProgressCap(
        { key: KEY, now, turnStart: undefined, turnCount },
        asyncSend({ message_id: i }),
      )
      expect(r.capped).toBe(false)
    }
    const over = await sendWithProgressCap(
      { key: KEY, now, turnStart: undefined, turnCount },
      asyncSend({ message_id: 99 }),
    )
    expect(over.capped).toBe(true)
  })

  // (c) N concurrent same-key sends never exceed the cap — fallback path.
  // Pre-Low-1 (check atCap → await → record) this delivered all N, because the
  // record only ran after the await, so every concurrent caller read count 0.
  it('concurrent same-key sends never exceed the cap — fallback path (c)', async () => {
    const turnCount = new Map<string, number>()
    const now = 1_000
    const delivered = { n: 0 }
    const N = 25
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        sendWithProgressCap(
          { key: KEY, now, turnStart: undefined, turnCount },
          asyncSend({ message_id: 1 }, delivered),
        ),
      ),
    )
    const proceeded = results.filter((r) => !r.capped).length
    expect(proceeded).toBe(PROGRESS_TURN_MAX)
    expect(delivered.n).toBe(PROGRESS_TURN_MAX)
  })

  // (c) N concurrent same-key sends never exceed the cap — turn-counter path.
  it('concurrent same-key sends never exceed the cap — turn path (c)', async () => {
    const turnCount = new Map<string, number>([[KEY, 0]])
    const delivered = { n: 0 }
    const N = 25
    const deps = { key: KEY, now: 1_000, turnStart: 1_000, turnCount }
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        sendWithProgressCap(deps, asyncSend({ message_id: 1 }, delivered)),
      ),
    )
    const proceeded = results.filter((r) => !r.capped).length
    expect(proceeded).toBe(PROGRESS_TURN_MAX)
    expect(delivered.n).toBe(PROGRESS_TURN_MAX)
    // The counter settled exactly at the cap — no overshoot, no leaked slot.
    expect(turnCount.get(KEY)).toBe(PROGRESS_TURN_MAX)
  })

  // Non-concurrent behaviour is identical to before: a successful reserve keeps
  // the slot, so reserveProgressSlot alone (no send) accounts the delivery.
  it('reserveProgressSlot keeps the slot on success, releases on demand', () => {
    const turnCount = new Map<string, number>([[KEY, 0]])
    const deps = { key: KEY, now: 1_000, turnStart: 1_000, turnCount }
    const first = reserveProgressSlot(deps)
    expect(first).not.toBeNull()
    expect(turnCount.get(KEY)).toBe(1)
    // Releasing hands the slot back; a second release is a no-op.
    first!.release()
    expect(turnCount.get(KEY)).toBe(0)
    first!.release()
    expect(turnCount.get(KEY)).toBe(0)
  })
})
