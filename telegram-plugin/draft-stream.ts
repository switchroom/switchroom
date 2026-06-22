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
 * always lands within ~1s (or ~400ms in DMs), with at most one outstanding
 * API call.
 *
 * In our model-driven architecture (no inference hooks), the controller
 * is driven by the model calling stream_reply(text, done) multiple times
 * during a long task. First call → sendMessage. Subsequent calls →
 * throttled editMessageText. done=true → flush, finalize.
 *
 * The draft transport (sendMessageDraft) has been permanently retired —
 * all streams use sendMessage + editMessageText (the in-place engine).
 * See PR fix/retire-draft-transport for the removal rationale.
 */

const TELEGRAM_MAX_CHARS = 4096

// Throttle defaults for the in-place engine.
//   DM chats: 400 ms — slightly more responsive than groups while staying
//     well under Telegram's practical ~1 edit/sec/message ceiling. This
//     replaces the legacy 300 ms draft default: drafts were ephemeral and
//     didn't share the editMessageText rate cap, but in-place edits do, so
//     300 ms would routinely hit the limit. 400 ms keeps DM streaming
//     noticeably snappier than the group default without rate-limit pressure.
//   Group/forum chats: 1000 ms — must respect Telegram's
//     "1 edit/sec/message" practical ceiling.
// Both defaults can be overridden per-stream via `config.throttleMs` (which
// is itself wired from `channels.telegram.stream_throttle_ms` in the agent
// yaml, via the SWITCHROOM_TG_STREAM_THROTTLE_MS env var the gateway reads).
const DEFAULT_DM_THROTTLE_MS = 400
const DEFAULT_GROUP_THROTTLE_MS = 1000
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
  /** Throttle window in ms. Floored at 250. Default 400 for DMs, 1000 for groups. */
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
  /**
   * True if the current chat is a private DM. Used to select the throttle
   * default (400 ms for DMs vs 1000 ms for groups) when `throttleMs` is
   * not explicitly provided. Has no effect when `throttleMs` is set.
   */
  isPrivateChat?: boolean
  /**
   * The Telegram chat id string — used for diagnostic traces.
   */
  chatId?: string
  /** Optional logger for debugging. Receives one string per event. */
  log?: (msg: string) => void
  /** Optional warning logger. Used for fallback notices. */
  warn?: (msg: string) => void
  /**
   * If set, the stream is initialized as if a previous send had landed
   * with this `message_id` — the FIRST update() call invokes `edit`
   * against this id rather than `send`. Used by callers (notably the
   * gateway's progress-card emit) that know the anchor message id from
   * an external source (e.g. the pin manager) and want to guarantee a
   * subsequent emit edits in place rather than creating a fresh
   * sendMessage. This closes the "done=true → activeDraftStreams entry
   * deleted → next emit creates fresh sendMessage" duplicate-message
   * class (issue #626). The not-found fallback at the edit site
   * (re-send on `MESSAGE_ID_INVALID`) gracefully handles a stale id —
   * the bad edit fails once, then a fresh send fires.
   */
  initialMessageId?: number | null
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
 * All streaming uses the sendMessage + editMessageText in-place engine.
 */
export function createDraftStream(
  send: StreamSendFn,
  edit: StreamEditFn,
  config: DraftStreamConfig = {},
): DraftStreamHandle {
  // Select throttle default: DMs get 400 ms (more responsive), groups get 1000 ms.
  // An explicit `config.throttleMs` (from the operator yaml or the caller) always wins.
  const _defaultThrottle = config.isPrivateChat === true
    ? DEFAULT_DM_THROTTLE_MS
    : DEFAULT_GROUP_THROTTLE_MS
  const throttleMs = Math.max(MIN_THROTTLE_MS, config.throttleMs ?? _defaultThrottle)
  const maxChars = config.maxChars ?? TELEGRAM_MAX_CHARS
  const idleMs = Math.max(0, config.idleMs ?? 0)
  const log = config.log
  const warn = config.warn
  const chatId = config.chatId ?? ''

  // Stream-start trace — always-on, structured for grep + aggregation.
  if (process.env.SWITCHROOM_STREAM_TRACES !== '0') {
    process.stderr.write(
      `gw-trace stream-start transport=message ` +
        `dm=${config.isPrivateChat === undefined ? 'undef' : String(config.isPrivateChat)} ` +
        `throttleMs=${throttleMs} ` +
        `chatId=${chatId || '-'}\n`,
    )
  }

  let messageId: number | null = config.initialMessageId ?? null
  let pendingText: string | null = null
  let lastSentText: string | null = null
  let lastSentAt = 0
  let inFlight: Promise<void> | null = null
  // Observability — per-stream fire counters for the stream-end trace.
  const streamStartedAt = Date.now()
  let firstFireAtMs: number | null = null
  let editFires = 0
  let sendFires = 0
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

    // Hard-stop check
    if (textToSend.length > maxChars) {
      log?.(`stream stopped: text exceeds ${maxChars} chars`)
      stopped = true
      notifyWaiters()
      return
    }

    try {
      await sendViaMessage(textToSend)
      lastSentText = textToSend
      lastSentAt = Date.now()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if (/\bmessage is not modified\b/i.test(msg)) {
        lastSentText = textToSend
        lastSentAt = Date.now()
        log?.(`stream → not modified (id: ${messageId})`)
      } else if (
        /\bmessage to edit not found\b/i.test(msg)
        || /\bMESSAGE_ID_INVALID\b/i.test(msg)
      ) {
        log?.(`stream → message not found (id: ${messageId}), re-sending`)
        messageId = null
        lastSentText = null
        if (pendingText == null) pendingText = textToSend
      } else {
        log?.(`stream → edit failed: ${msg}`)
      }
    }

    notifyWaiters()
  }

  async function sendViaMessage(textToSend: string): Promise<void> {
    if (messageId == null) {
      messageId = await send(textToSend)
      if (firstFireAtMs == null) firstFireAtMs = Date.now() - streamStartedAt
      sendFires++
      log?.(`stream → sent (id: ${messageId}, ${textToSend.length} chars)`)
    } else {
      await edit(messageId, textToSend)
      if (firstFireAtMs == null) firstFireAtMs = Date.now() - streamStartedAt
      editFires++
      log?.(`stream → edited (id: ${messageId}, ${textToSend.length} chars)`)
    }
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
      // send has landed (messageId != null), this path is skipped and
      // the regular throttle kicks in.
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
      } else {
        // inFlight is set — the current flushLoop is running. Previous
        // versions of this code relied on flushLoop's while(pendingText
        // != null) to pick up the new text, but there's a race: if
        // update() fires AFTER the while's final (null) check but
        // BEFORE the flushLoop promise settles, the new pendingText
        // lands in a shell with no one looking at it, and the waiter
        // hangs forever. Chain a follow-up flush off the current
        // flushLoop so the new text is guaranteed to be drained.
        inFlight.then(() => {
          if (stopped || pendingText == null) return
          if (inFlight != null) return // a new flushLoop already started
          if (Date.now() - lastSentAt >= throttleMs) {
            inFlight = flushLoop().finally(() => { inFlight = null })
          } else {
            schedule()
          }
        })
      }
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

      // Stream-end trace — pairs with stream-start.
      if (process.env.SWITCHROOM_STREAM_TRACES !== '0') {
        const durationMs = Date.now() - streamStartedAt
        process.stderr.write(
          `gw-trace stream-end transport=message ` +
            `sends=${sendFires} edits=${editFires} ` +
            `firstFireMs=${firstFireAtMs ?? -1} durationMs=${durationMs} ` +
            `chars=${(lastSentText ?? '').length} ` +
            `chatId=${chatId || '-'}\n`,
        )
      }
    },

    getMessageId(): number | null {
      return messageId
    },

    isFinal(): boolean {
      return final
    },
  }
}
