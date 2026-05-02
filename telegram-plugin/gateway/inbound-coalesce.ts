/**
 * Inbound message coalescer — buffers consecutive messages from the same
 * (chat, user) pair so the gateway dispatches them as one Claude turn
 * instead of N rapid-fire turns. Pulled out of `gateway.ts` (#553 Phase 3)
 * so the real-gateway test harness can exercise the same coalescing
 * timing the production gateway uses, instead of a parallel reimplementation.
 *
 * Behaviour pinned (tests cover all four):
 *   - First message: schedule a flush after `gapMs`.
 *   - Subsequent message before flush: append to the buffer, reset the
 *     timer (sliding window, not fixed-window — typical "user keeps
 *     typing → keep waiting").
 *   - Flush invokes `onFlush(key, joined)` exactly once with the
 *     accumulated text joined by `'\n'`.
 *   - `gapMs <= 0` disables coalescing (caller gets back a synchronous
 *     "flush immediately" path via the `bypass` field).
 *
 * Out of scope: the user-perceived "👀 reaction within 800ms" deadline
 * (#545 F2) — that's a separate problem rooted in the gateway calling
 * `firstPaintTurn` from inside the coalesced flush instead of on raw
 * arrival. The real-gateway harness asserts the deadline and the F2 fix
 * will move first-paint out of the coalesce flush. This module just owns
 * the "wait for the user to stop typing" buffer.
 *
 * Generic over `T` so the harness can pass `{ text: string }` while the
 * production gateway passes its full `CoalesceEntry` (ctx + attachments
 * + downloadImage closure). The buffer doesn't care.
 */

export interface InboundCoalescerOptions<T> {
  /**
   * Sliding window in ms. Each new message resets the timer. Set to
   * `<= 0` to disable coalescing entirely (`enqueue` returns
   * `{ bypass: true }` and the caller should flush immediately).
   *
   * Pass a function (`() => number`) instead of a number when the
   * window is config-driven and the operator can change it at runtime
   * — gateway.ts reads it per-call from the access file so a
   * `/access set-coalesce 500` takes effect on the next message
   * without restarting the gateway.
   */
  gapMs: number | (() => number)
  /**
   * Called when the buffered window expires. Receives the buffer key
   * and the merged payload (last-write-wins for non-text fields,
   * concatenated text via `merge`).
   */
  onFlush: (key: string, merged: T) => void
  /**
   * Build a merged payload from the accumulated entries. Lets callers
   * decide how to combine non-text fields (e.g. "use the latest
   * downloadImage closure", "concat all texts with '\n'").
   */
  merge: (entries: T[]) => T
  /**
   * Timer factory. Defaults to `setTimeout`. Override in tests for
   * deterministic time control under fake timers.
   */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  /**
   * Timer canceller. Defaults to `clearTimeout`.
   */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface BufferEntry<T> {
  payloads: T[]
  timer: ReturnType<typeof setTimeout>
}

export interface InboundCoalescer<T> {
  /**
   * Buffer a payload under `key`. Returns `{ bypass: true }` when
   * coalescing is disabled — caller should flush immediately and skip
   * the buffer entirely.
   */
  enqueue(key: string, payload: T): { bypass: boolean }
  /**
   * Inspect buffer state — for diagnostics + tests. Don't mutate.
   */
  peek(key: string): { count: number } | null
  /** Total number of buffered entries — for /status surface. */
  size(): number
  /**
   * Cancel any pending timers and drop all buffered entries. Tests
   * use this; production code shouldn't unless the gateway is shutting
   * down.
   */
  reset(): void
}

export function createInboundCoalescer<T>(opts: InboundCoalescerOptions<T>): InboundCoalescer<T> {
  const buffer = new Map<string, BufferEntry<T>>()
  const setTimer = opts.setTimer ?? setTimeout
  const clearTimer = opts.clearTimer ?? clearTimeout

  function flush(key: string): void {
    const entry = buffer.get(key)
    if (!entry) return
    buffer.delete(key)
    opts.onFlush(key, opts.merge(entry.payloads))
  }

  function resolveGap(): number {
    return typeof opts.gapMs === 'function' ? opts.gapMs() : opts.gapMs
  }

  return {
    enqueue(key, payload) {
      const gapMs = resolveGap()
      if (gapMs <= 0) return { bypass: true }
      const existing = buffer.get(key)
      if (existing) {
        clearTimer(existing.timer)
        existing.payloads.push(payload)
        existing.timer = setTimer(() => flush(key), gapMs)
      } else {
        buffer.set(key, {
          payloads: [payload],
          timer: setTimer(() => flush(key), gapMs),
        })
      }
      return { bypass: false }
    },
    peek(key) {
      const e = buffer.get(key)
      return e ? { count: e.payloads.length } : null
    },
    size() {
      return buffer.size
    },
    reset() {
      for (const entry of buffer.values()) clearTimer(entry.timer)
      buffer.clear()
    },
  }
}

/**
 * Build a coalesce key from `(chatId, userId)`. Identity-stable across
 * messages from the same sender in the same chat, distinct across
 * different senders so a user-driven reply isn't merged with a sibling
 * message from someone else in a group chat.
 */
export function inboundCoalesceKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`
}
