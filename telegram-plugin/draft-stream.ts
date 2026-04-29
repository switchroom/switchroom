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
 * during a long task. First call → sendMessage (or sendMessageDraft in DMs).
 * Subsequent calls → throttled editMessageText (or sendMessageDraft). done=true
 * → flush, materialize as a fresh sendMessage (push notification), clear draft.
 *
 * Transport selection:
 *   - previewTransport: "auto" (default) — use draft in DMs only
 *   - previewTransport: "draft"           — always use draft (if API available)
 *   - previewTransport: "message"         — always use sendMessage/editMessageText
 *
 * Forum topics (message_thread_id set) force message transport because
 * sendMessageDraft does not support threads. The caller (stream-controller.ts)
 * handles this by passing previewTransport: "message" for threaded chats.
 */

import {
  shouldFallbackFromDraftTransport,
  allocateDraftId,
} from './draft-transport.js'

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

/**
 * Optional sendMessageDraft callback. When present and the transport is
 * "draft", this is called instead of sendMessage/editMessageText.
 * Signature mirrors Telegram's sendMessageDraft Bot API method.
 */
export type StreamDraftFn = (
  chatId: string,
  draftId: number,
  text: string,
  params?: { message_thread_id?: number },
) => Promise<unknown>

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
   *
   * NOTE: This debounce only applies to message transport. Draft transport
   * fires immediately on the first update because drafts are ephemeral —
   * the throttle/flush loop already collapses bursts into 1 API call/sec
   * via throttleMs.
   */
  idleMs?: number
  /**
   * Transport selector.
   * - "auto" (default): use draft transport when isPrivateChat=true AND
   *   sendMessageDraft is provided; otherwise use message transport.
   * - "draft": always prefer draft (falls back to message if sendMessageDraft absent).
   * - "message": always use sendMessage/editMessageText.
   */
  previewTransport?: 'auto' | 'message' | 'draft'
  /**
   * True if the current chat is a private DM. Used by "auto" transport to
   * decide whether to activate draft. Has no effect when previewTransport
   * is "draft" or "message".
   */
  isPrivateChat?: boolean
  /**
   * sendMessageDraft callback. When absent, the stream falls back to
   * sendMessage/editMessageText regardless of previewTransport.
   */
  sendMessageDraft?: StreamDraftFn
  /**
   * The Telegram chat id string — required when sendMessageDraft is provided,
   * so the draft can be cleared on finalize.
   */
  chatId?: string
  /** Optional logger for debugging. Receives one string per event. */
  log?: (msg: string) => void
  /** Optional warning logger. Used for transport fallback notices. */
  warn?: (msg: string) => void
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
 *
 * When sendMessageDraft is provided (and transport allows it), intermediate
 * updates use the draft API instead of sendMessage/editMessageText. On
 * finalize(), a real sendMessage is sent for push notification, then the
 * draft is cleared best-effort.
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
  const warn = config.warn
  const draftApi = config.sendMessageDraft
  const chatId = config.chatId ?? ''

  // Resolve transport
  const requestedTransport = config.previewTransport ?? 'auto'
  const prefersDraft =
    requestedTransport === 'draft'
      ? true
      : requestedTransport === 'message'
        ? false
        : (config.isPrivateChat === true) // 'auto': DM only

  // Footgun guard: caller asked for "auto" + provided sendMessageDraft but
  // forgot isPrivateChat. They almost certainly wanted draft in DMs but will
  // silently get message transport everywhere. Warn so the bug is visible.
  if (
    requestedTransport === 'auto'
    && draftApi != null
    && config.isPrivateChat === undefined
  ) {
    warn?.('draft-stream: previewTransport="auto" with sendMessageDraft but isPrivateChat undefined — defaulting to message transport')
  }

  // Use draft transport only if we have the API
  let usesDraftTransport = prefersDraft && draftApi != null
  let draftId: number | undefined = usesDraftTransport ? allocateDraftId() : undefined

  if (prefersDraft && !usesDraftTransport) {
    warn?.('draft-stream: sendMessageDraft unavailable; falling back to sendMessage/editMessageText')
  }

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

  async function sendViaDraft(textToSend: string): Promise<boolean> {
    if (!draftApi || draftId == null) return false
    try {
      await draftApi(chatId, draftId, textToSend)
      log?.(`stream → draft (id: ${draftId}, ${textToSend.length} chars)`)
      return true
    } catch (err) {
      if (shouldFallbackFromDraftTransport(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        warn?.(`draft-stream: sendMessageDraft rejected — falling back to sendMessage/editMessageText (${msg})`)
        usesDraftTransport = false
        draftId = undefined
        return false
      }
      throw err
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
      if (usesDraftTransport) {
        const ok = await sendViaDraft(textToSend)
        if (!ok) {
          // Draft failed with a permanent error → fell back to message transport.
          // Replay this text via message transport.
          await sendViaMessage(textToSend)
        }
      } else {
        await sendViaMessage(textToSend)
      }
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
      log?.(`stream → sent (id: ${messageId}, ${textToSend.length} chars)`)
    } else {
      await edit(messageId, textToSend)
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
      // send has landed (messageId != null OR draft has fired), this path
      // is skipped and the regular throttle kicks in.
      if (idleMs > 0 && messageId == null && !usesDraftTransport && inFlight == null) {
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

      // Draft transport: materialize as a real sendMessage for push notification,
      // then clear the draft best-effort.
      if (usesDraftTransport && draftApi != null) {
        const textToMaterialize = lastSentText
        if (textToMaterialize) {
          try {
            messageId = await send(textToMaterialize)
            log?.(`stream → materialized (id: ${messageId}, ${textToMaterialize.length} chars)`)
          } catch (err) {
            warn?.(`draft-stream: materialize sendMessage failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          // Clear draft best-effort (cosmetic — Telegram input area cleanup)
          if (draftId != null) {
            try {
              await draftApi(chatId, draftId, '')
            } catch {
              // Best-effort — ignore failures
            }
          }
        }
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
