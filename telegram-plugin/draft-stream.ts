/**
 * Edit-in-place streaming for Telegram messages.
 *
 * Ports the throttle/flush pattern from openclaw's
 * src/channels/draft-stream-loop.ts. The loop holds a single `pendingText`
 * snapshot (NOT a queue — only the latest matters) plus a single in-flight
 * promise. update(text) either fires immediately if the throttle window
 * is open, or schedules a setTimeout for the remaining ms. When the
 * in-flight call resolves, if pendingText changed during flight it loops
 * once more without waiting.
 *
 * This is what makes the experience feel responsive without burning
 * Telegram's 1-edit-per-second-per-message rate limit. The latest delta
 * always lands within ~1s, with at most one outstanding API call.
 *
 * In our model-driven architecture (no inference hooks), the controller
 * is driven by the model calling stream_reply(text, done) multiple times
 * during a long task. First call → sendMessage. Subsequent calls →
 * throttled editMessageText. done=true → flush, lock, no more edits.
 */

const TELEGRAM_MAX_CHARS = 4096
const DEFAULT_THROTTLE_MS = 1000
const MIN_THROTTLE_MS = 250

/**
 * Send the first message in a stream. Receives the rendered text plus a
 * thread_id (forum topic) and returns the new Telegram message_id.
 */
export type StreamSendFn = (text: string) => Promise<number>

/**
 * Edit an existing stream message. Receives the message_id and rendered text.
 */
export type StreamEditFn = (messageId: number, text: string) => Promise<void>

export interface DraftStreamConfig {
  /** Throttle window in ms. Floored at 250. Default 1000. */
  throttleMs?: number
  /**
   * Maximum total characters before hard-stopping the stream. Default 4096
   * (Telegram's limit). When exceeded, future updates are ignored — the
   * caller should fall back to a fresh sendMessage.
   */
  maxChars?: number
  /**
   * Optional debounce window applied BEFORE the first send of a stream.
   * When > 0, the first update() defers the send by idleMs, restarting
   * the timer on each additional update that arrives during the window.
   * Useful when the caller bursts several update() calls at turn start
   * and you'd rather collapse them into a single send than pay the
   * latency of an immediate first-fire + follow-up edit.
   *
   * Default 0 (no pre-send debounce — first update fires immediately).
   * Only affects the first send; subsequent edits use throttleMs.
   */
  idleMs?: number
  /** Optional logger for debugging. Receives one string per event. */
  log?: (msg: string) => void
}

export interface DraftStreamHandle {
  /**
   * Push a new full-text snapshot. The loop holds only the latest. Returns
   * a promise that resolves once this update has either (a) been sent or
   * (b) been superseded by a later update.
   */
  update(text: string): Promise<void>

  /**
   * Mark the stream as final. Flushes any pending text and rejects all
   * future update() calls. Returns a promise that resolves once the final
   * edit has landed (or the initial send if no edits ever fired).
   */
  finalize(): Promise<void>

  /** Returns the captured Telegram message_id, or null if nothing has sent yet. */
  getMessageId(): number | null

  /** True if finalize() has been called. */
  isFinal(): boolean
}

/**
 * Create a draft stream bound to a specific Telegram chat+thread.
 *
 * The first update() call invokes `send` to create the message. All
 * subsequent calls invoke `edit` against the captured message_id.
 */
export function createDraftStream(
  send: StreamSendFn,
  edit: StreamEditFn,
  config: DraftStreamConfig = {},
): DraftStreamHandle {
  const throttleMs = Math.max(MIN_THROTTLE_MS, config.throttleMs ?? DEFAULT_THROTTLE_MS)
  const maxChars = config.maxChars ?? TELEGRAM_MAX_CHARS
  const idleMs = Math.max(0, config.idleMs ?? 0)
  const log = config.log

  let messageId: number | null = null
  let pendingText: string | null = null
  let lastSentText: string | null = null
  let lastSentAt = 0
  let inFlight: Promise<void> | null = null
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null
  let final = false
  let stopped = false

  // Tracks pending update() calls so caller can `await` the next flush
  const waiters: Array<() => void> = []

  function notifyWaiters(): void {
    const w = waiters.splice(0)
    for (const fn of w) {
      try {
        fn()
      } catch { /* ignore waiter errors */ }
    }
  }

  async function flush(): Promise<void> {
    if (stopped) {
      notifyWaiters()
      return
    }
    if (pendingText == null) {
      notifyWaiters()
      return
    }
    const textToSend = pendingText
    pendingText = null

    if (textToSend === lastSentText) {
      // Nothing actually changed — skip the API call but free waiters
      notifyWaiters()
      return
    }

    if (textToSend.length > maxChars) {
      log?.(`stream stopped: text exceeds ${maxChars} chars`)
      stopped = true
      notifyWaiters()
      return
    }

    try {
      if (messageId == null) {
        messageId = await send(textToSend)
        log?.(`stream → sent (id: ${messageId}, ${textToSend.length} chars)`)
      } else {
        await edit(messageId, textToSend)
        log?.(`stream → edited (id: ${messageId}, ${textToSend.length} chars)`)
      }
      lastSentText = textToSend
      lastSentAt = Date.now()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      // "message is not modified" — the new text equals the current
      // server-side text. Treat as success.
      if (/not modified/i.test(msg)) {
        lastSentText = textToSend
        lastSentAt = Date.now()
        log?.(`stream → not modified (id: ${messageId})`)
      } else if (
        /message to edit not found/i.test(msg)
        || /message_id_invalid/i.test(msg)
        || /MESSAGE_ID_INVALID/.test(msg)
      ) {
        // The preview was deleted by the user (or Telegram) between send
        // and edit. Clear the captured id + lastSentText and requeue the
        // text so the next loop iteration re-sends from scratch.
        log?.(`stream → message not found (id: ${messageId}), re-sending`)
        messageId = null
        lastSentText = null
        if (pendingText == null) pendingText = textToSend
      } else {
        log?.(`stream → edit failed: ${msg}`)
        // Don't throw; the loop will try again on the next update.
      }
    }

    notifyWaiters()
  }

  async function flushLoop(): Promise<void> {
    // Drain any updates that arrived during the in-flight call.
    while (pendingText != null && !stopped) {
      await flush()
    }
  }

  function schedule(): void {
    if (scheduledTimer != null) return
    if (stopped) return
    const sinceLast = Date.now() - lastSentAt
    const delay = Math.max(0, throttleMs - sinceLast)
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null
      if (inFlight) {
        // The in-flight loop will pick up pendingText after it resolves.
        return
      }
      inFlight = flushLoop().finally(() => {
        inFlight = null
      })
    }, delay)
  }

  return {
    update(text: string): Promise<void> {
      if (final || stopped) return Promise.resolve()
      pendingText = text
      const waitPromise = new Promise<void>(resolve => {
        waiters.push(resolve)
      })

      // Pre-send idle debounce: for the FIRST send of a stream, optionally
      // defer by idleMs so a burst of update() calls collapses into one
      // send. Each incoming update resets the timer. Once the initial
      // send has landed (messageId != null), this path is skipped and the
      // regular throttle kicks in.
      if (idleMs > 0 && messageId == null && inFlight == null) {
        if (scheduledTimer != null) clearTimeout(scheduledTimer)
        scheduledTimer = setTimeout(() => {
          scheduledTimer = null
          inFlight = flushLoop().finally(() => { inFlight = null })
        }, idleMs)
        return waitPromise
      }

      // If nothing in flight and the throttle window is open, fire now.
      if (inFlight == null && Date.now() - lastSentAt >= throttleMs) {
        inFlight = flushLoop().finally(() => {
          inFlight = null
        })
      } else if (inFlight == null) {
        schedule()
      }
      // (If inFlight != null, the existing flushLoop will pick up
      // pendingText after its current call resolves.)
      return waitPromise
    },

    async finalize(): Promise<void> {
      if (final) return
      final = true
      // Drain any pending updates
      if (scheduledTimer != null) {
        clearTimeout(scheduledTimer)
        scheduledTimer = null
      }
      if (inFlight) {
        await inFlight
      }
      if (pendingText != null && !stopped) {
        await flush()
      }
      log?.(`stream finalized (id: ${messageId})`)
    },

    getMessageId(): number | null {
      return messageId
    },

    isFinal(): boolean {
      return final
    },
  }
}
