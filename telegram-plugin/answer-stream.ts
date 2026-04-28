import { isSilentFlushMarker } from './turn-flush-safety.js'

/**
 * Answer-lane incremental streaming for long Telegram replies.
 *
 * This module implements the "narrative" liveness layer described in
 * `reference/know-what-my-agent-is-doing.md`:
 *
 *   ambient     → 👀 ack reaction
 *   structured  → progress card (existing, via stream-reply-handler.ts lane:'progress')
 *   narrative   → THIS — incremental answer text appearing below the card as it arrives
 *
 * Design constraints honored:
 *   1. Separate message ID from the progress card — never overwritten.
 *   2. sendMessageDraft for DMs (detected by chatType='private'); regular
 *      sendMessage+editMessageText for groups/channels. Runtime fallback
 *      when draft API rejects (DRAFT_METHOD_UNAVAILABLE_RE / DRAFT_CHAT_UNSUPPORTED_RE).
 *   3. minInitialChars (~400) — don't open the answer lane until enough text
 *      has arrived. Short replies bypass the lane entirely.
 *   4. Turn-end materializes as a fresh sendMessage (push notification) NOT
 *      an edit-finalize — mirrors OpenClaw's materialize() pattern.
 *   5. Supersession protection — when a new turn starts while a prior
 *      answer-lane edit is in flight, the late edit is identified as stale
 *      and orphaned (via generation counter), not applied to the new message.
 *
 * Key differences from the OpenClaw draft-stream.ts:
 *   - No grammy Bot dependency at this layer — callers inject typed send/edit
 *     callbacks so this module is fully testable without a real bot.
 *   - No finalizable-draft-lifecycle SDK — we implement the loop directly.
 *   - materialize() always sends a fresh message regardless of transport,
 *     to guarantee a push notification on turn completion.
 */

export const MIN_INITIAL_CHARS = 400
export const DEFAULT_THROTTLE_MS = 1000
const TELEGRAM_MAX_CHARS = 4096

// Error patterns matching OpenClaw's shouldFallbackFromDraftTransport.
// Exported for tests.
export const DRAFT_METHOD_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported)/i
export const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i

/**
 * Returns true when a sendMessageDraft rejection means "this API is not
 * available" rather than a transient network error.
 */
export function shouldFallbackFromDraftTransport(err: unknown): boolean {
  const text =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === 'object' && err != null && 'description' in err
          ? typeof (err as { description: unknown }).description === 'string'
            ? (err as { description: string }).description
            : ''
          : ''
  if (!/sendMessageDraft/i.test(text)) return false
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text)
}

/** Called when a late sendMessage/edit resolves after a new turn has started. */
export type OnSupersededCallback = (params: {
  messageId: number
  textSnapshot: string
}) => void

export interface AnswerStreamConfig {
  /** chatId for all API calls */
  chatId: string
  /** True if this is a DM — tries sendMessageDraft first */
  isPrivateChat: boolean
  /** Optional forum thread */
  threadId?: number
  /** Minimum chars before opening the answer lane. Default: MIN_INITIAL_CHARS */
  minInitialChars?: number
  /** Throttle window in ms. Default: DEFAULT_THROTTLE_MS */
  throttleMs?: number
  /** Optional quote-reply target for the initial sendMessage */
  replyToMessageId?: number

  // ── Transport callbacks ────────────────────────────────────────────────
  /**
   * sendMessageDraft(chatId, draftId, text, params?). Optional — when absent,
   * the answer stream falls back immediately to sendMessage+editMessageText.
   */
  sendMessageDraft?: (
    chatId: string,
    draftId: number,
    text: string,
    params?: { message_thread_id?: number },
  ) => Promise<unknown>
  sendMessage: (
    chatId: string,
    text: string,
    params?: {
      parse_mode?: 'HTML'
      message_thread_id?: number
      link_preview_options?: { is_disabled: boolean }
      reply_parameters?: { message_id: number }
    },
  ) => Promise<{ message_id: number }>
  editMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    params?: {
      parse_mode?: 'HTML'
      message_thread_id?: number
      link_preview_options?: { is_disabled: boolean }
    },
  ) => Promise<unknown>
  deleteMessage?: (chatId: string, messageId: number) => Promise<unknown>

  /** Called when a late edit/send resolves but this stream has been superseded. */
  onSuperseded?: OnSupersededCallback
  log?: (msg: string) => void
  warn?: (msg: string) => void
  /**
   * Optional metric callback. Fires after each successful send/edit and on
   * materialize. Injected by the gateway so tests can mock it with vi.fn().
   * Acceptance #203: answer_lane_update / answer_lane_materialized events.
   */
  onMetric?: (ev:
    | { kind: 'answer_lane_update'; chatId: string; messageId: number | undefined; charCount: number; transport: 'draft' | 'message' | 'edit' }
    | { kind: 'answer_lane_materialized'; chatId: string; messageId: number | undefined }
  ) => void
}

export interface AnswerStreamHandle {
  /**
   * Push a new full-text snapshot. Throttled to ~1 send/edit per throttleMs.
   * No-op if minInitialChars hasn't been reached yet.
   */
  update(text: string): void
  /**
   * Finalize: send the accumulated text as a fresh sendMessage for push
   * notification. Returns the final message_id, or undefined if nothing was
   * buffered. Idempotent after first call.
   */
  materialize(): Promise<number | undefined>
  /**
   * Force-start a new generation: resets internal state so the next update
   * creates a new message instead of editing. Use when a new turn starts
   * while this stream is still in flight.
   */
  forceNewMessage(): void
  /** Current message_id if one has been sent, else undefined. */
  messageId(): number | undefined
  /** Stop the stream — cancels pending throttled edits. */
  stop(): void
  /**
   * Stop the stream AND delete any preliminary message that was already sent.
   * Used when the reply/stream_reply tool takes over as the authoritative
   * answer surface: the answer-lane preview must be retracted so the user
   * sees only one message (the canonical stream_reply output) rather than a
   * raw-markdown duplicate followed by the properly-formatted reply.
   *
   * Best-effort: if deleteMessage is not wired or the API call fails, the
   * preliminary message is left in place (same behaviour as before the fix).
   * Resolves after the delete attempt (or immediately when no message exists).
   */
  retract(): Promise<void>
}

// Module-level draft-id counter. Shared globally so concurrent answer streams
// don't collide on draft ids — mirrors OpenClaw's getDraftStreamState().
let _nextDraftId = 1
function allocateDraftId(): number {
  const id = _nextDraftId
  _nextDraftId = _nextDraftId >= 2_147_483_647 ? 1 : _nextDraftId + 1
  return id
}

export function createAnswerStream(config: AnswerStreamConfig): AnswerStreamHandle {
  const {
    chatId,
    isPrivateChat,
    threadId,
    minInitialChars = MIN_INITIAL_CHARS,
    throttleMs = DEFAULT_THROTTLE_MS,
    replyToMessageId,
    sendMessageDraft: draftApi,
    sendMessage,
    editMessageText,
    onSuperseded,
    log,
    warn,
    onMetric,
  } = config

  const effectiveThrottle = Math.max(250, throttleMs)

  // Draft transport is only used in DMs and only when the API method is available.
  const preferDraft = isPrivateChat && draftApi != null
  let usesDraftTransport = preferDraft
  let draftId = preferDraft ? allocateDraftId() : undefined

  // Stream state
  let streamMsgId: number | undefined
  let pendingText: string | null = null
  let lastSentText = ''
  let lastSentAt = 0
  let inFlight: Promise<void> | null = null
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let materialized = false
  /** Generation counter for supersession detection. */
  let generation = 0

  function cancelScheduled(): void {
    if (scheduledTimer != null) {
      clearTimeout(scheduledTimer)
      scheduledTimer = null
    }
  }

  async function sendDraft(text: string): Promise<boolean> {
    if (!draftApi || draftId == null) return false
    try {
      const params: { message_thread_id?: number } = {}
      if (threadId != null) params.message_thread_id = threadId
      await draftApi(chatId, draftId, text, Object.keys(params).length > 0 ? params : undefined)
      onMetric?.({ kind: 'answer_lane_update', chatId, messageId: streamMsgId, charCount: text.length, transport: 'draft' })
      return true
    } catch (err) {
      if (shouldFallbackFromDraftTransport(err)) {
        warn?.(
          `answer-stream: sendMessageDraft rejected — falling back to sendMessage/editMessageText (${err instanceof Error ? err.message : String(err)})`,
        )
        usesDraftTransport = false
        draftId = undefined
        return false
      }
      throw err
    }
  }

  async function sendOrEdit(text: string, gen: number): Promise<void> {
    if (stopped) return
    const trimmed = text.trimEnd()
    if (!trimmed || trimmed.length > TELEGRAM_MAX_CHARS) return
    if (trimmed === lastSentText) return

    const prevText = lastSentText
    lastSentText = trimmed

    try {
      if (usesDraftTransport) {
        const ok = await sendDraft(trimmed)
        if (!ok) {
          // Draft failed with a permanent error → fell back to message transport
          // Retry the same text via message transport
          await sendOrEditViaMessage(trimmed, gen, prevText)
        }
        return
      }
      await sendOrEditViaMessage(trimmed, gen, prevText)
    } catch (err) {
      // Log but don't crash — transient errors are common
      warn?.(`answer-stream: send/edit failed: ${err instanceof Error ? err.message : String(err)}`)
      // Restore so next iteration retries
      lastSentText = prevText
    }
  }

  async function sendOrEditViaMessage(trimmed: string, gen: number, prevText: string): Promise<void> {
    if (typeof streamMsgId === 'number') {
      // Edit existing message
      const editParams: Parameters<typeof editMessageText>[3] = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }
      if (threadId != null) editParams.message_thread_id = threadId
      try {
        await editMessageText(chatId, streamMsgId, trimmed, editParams)
        onMetric?.({ kind: 'answer_lane_update', chatId, messageId: streamMsgId, charCount: trimmed.length, transport: 'edit' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/message is not modified/i.test(msg)) {
          // Not an error — identical text
          return
        }
        if (/message to edit not found|MESSAGE_ID_INVALID/i.test(msg)) {
          // Message deleted — re-send from scratch next cycle
          log?.(`answer-stream: message not found (id=${streamMsgId}), will re-send`)
          streamMsgId = undefined
          lastSentText = prevText
          return
        }
        throw err
      }
    } else {
      // First send — capture message_id; check generation for supersession
      const sendParams: Parameters<typeof sendMessage>[2] = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }
      if (threadId != null) sendParams.message_thread_id = threadId
      if (replyToMessageId != null) sendParams.reply_parameters = { message_id: replyToMessageId }
      const sent = await sendMessage(chatId, trimmed, sendParams)
      const sentId = sent?.message_id
      if (typeof sentId !== 'number' || !Number.isFinite(sentId)) {
        warn?.('answer-stream: sendMessage returned no message_id')
        return
      }
      if (gen !== generation) {
        // Superseded — this send resolved after forceNewMessage() was called
        onSuperseded?.({ messageId: sentId, textSnapshot: trimmed })
        log?.(`answer-stream: superseded send (messageId=${sentId}, gen=${gen} vs ${generation})`)
        return
      }
      streamMsgId = sentId
      log?.(`answer-stream: sent (id=${sentId})`)
      onMetric?.({ kind: 'answer_lane_update', chatId, messageId: streamMsgId, charCount: trimmed.length, transport: 'message' })
    }
  }

  async function flushLoop(): Promise<void> {
    while (pendingText != null && !stopped) {
      const text = pendingText
      pendingText = null
      const gen = generation
      await sendOrEdit(text, gen)
      lastSentAt = Date.now()
    }
  }

  function schedule(): void {
    if (scheduledTimer != null || stopped) return
    const sinceLast = Date.now() - lastSentAt
    const delay = Math.max(0, effectiveThrottle - sinceLast)
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null
      if (inFlight) return
      inFlight = flushLoop().finally(() => {
        inFlight = null
      })
    }, delay)
  }

  return {
    update(text: string): void {
      if (stopped || materialized) return
      const trimmed = text.trimEnd()
      if (!trimmed) return

      // minInitialChars gate: don't open the lane yet
      if (streamMsgId == null && !usesDraftTransport && trimmed.length < minInitialChars) return

      pendingText = trimmed

      if (inFlight == null) {
        const sinceLast = Date.now() - lastSentAt
        if (sinceLast >= effectiveThrottle) {
          inFlight = flushLoop().finally(() => {
            inFlight = null
          })
        } else {
          schedule()
        }
      } else {
        // Chain off current in-flight to drain the new pendingText
        inFlight.then(() => {
          if (stopped || pendingText == null) return
          if (inFlight != null) return
          const sinceLast = Date.now() - lastSentAt
          if (sinceLast >= effectiveThrottle) {
            inFlight = flushLoop().finally(() => {
              inFlight = null
            })
          } else {
            schedule()
          }
        }).catch(() => {})
      }
    },

    async materialize(): Promise<number | undefined> {
      if (materialized) return streamMsgId
      materialized = true
      stopped = true
      cancelScheduled()

      // Wait for any in-flight edit to settle
      if (inFlight) {
        try { await inFlight } catch { /* ignore */ }
      }

      // Clear draft so Telegram input area doesn't show stale text
      if (usesDraftTransport && draftApi != null && draftId != null) {
        try {
          const clearParams: { message_thread_id?: number } = {}
          if (threadId != null) clearParams.message_thread_id = threadId
          await draftApi(
            chatId,
            draftId,
            '',
            Object.keys(clearParams).length > 0 ? clearParams : undefined,
          )
        } catch {
          // Best-effort cleanup
        }
      }

      // The text we want to materialize. Prefer pendingText (most recent
      // snapshot from the model) over lastSentText (what last reached the
      // wire). They usually match, but if a buffered update was scheduled
      // and not yet sent when materialize() was called, pendingText holds
      // the freshest content.
      const textToSend = (pendingText || lastSentText).trimEnd()
      if (!textToSend) {
        log?.('answer-stream: materialize — nothing to send')
        return undefined
      }

      // Telegram caps a single message at 4096 chars. The streaming path
      // already guards on this in sendOrEdit; materialize must too, or
      // long answers silently drop the final push notification (Telegram
      // returns 400, the catch swallows). Per the JTBD anti-pattern
      // "silent failure of any kind", warn and bail explicitly so the
      // operator can correlate.
      if (textToSend.length > TELEGRAM_MAX_CHARS) {
        warn?.(
          `answer-stream: materialize — text exceeds ${TELEGRAM_MAX_CHARS} chars (got ${textToSend.length}); skipping. ` +
          `The reply path should have already delivered chunked output; this is a defensive guard.`,
        )
        return undefined
      }

      // Silent-marker guard: if the whole body is NO_REPLY / HEARTBEAT_OK
      // (exact-match, with trailing-punctuation tolerance), suppress outbound
      // and log — mirrors the suppression in server.ts and turn-flush-safety.ts.
      if (isSilentFlushMarker(textToSend)) {
        // Normalise the same way isSilentFlushMarker does so log searches for
        // `marker=NO_REPLY` match both `NO_REPLY` and `NO_REPLY.` inputs.
        let marker = textToSend.trim().toUpperCase()
        if (marker.length > 0 && /\W$/.test(marker)) marker = marker.slice(0, -1)
        log?.(
          `telegram gateway: answer-stream: silent-marker-suppressed marker=${marker} chatId=${chatId}`,
        )
        return undefined
      }

      // Always send a fresh message for push notification
      const sendParams: Parameters<typeof sendMessage>[2] = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }
      if (threadId != null) sendParams.message_thread_id = threadId
      // Don't quote-reply on materialize — the draft stream already established
      // the reply context visually. A second reply_parameters would create a
      // nested quote that looks wrong.

      try {
        const sent = await sendMessage(chatId, textToSend, sendParams)
        const sentId = sent?.message_id
        if (typeof sentId === 'number' && Number.isFinite(sentId)) {
          streamMsgId = sentId
          log?.(`answer-stream: materialized (id=${sentId})`)
          onMetric?.({ kind: 'answer_lane_materialized', chatId, messageId: streamMsgId })
          return sentId
        }
      } catch (err) {
        warn?.(`answer-stream: materialize send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return undefined
    },

    forceNewMessage(): void {
      cancelScheduled()
      generation += 1
      streamMsgId = undefined
      lastSentText = ''
      lastSentAt = 0
      pendingText = null
      stopped = false
      materialized = false
      if (usesDraftTransport) {
        draftId = allocateDraftId()
      }
      log?.(`answer-stream: forceNewMessage (gen=${generation})`)
    },

    messageId(): number | undefined {
      return streamMsgId
    },

    stop(): void {
      stopped = true
      cancelScheduled()
    },

    async retract(): Promise<void> {
      // Stop immediately so no further edits or sends go out.
      stopped = true
      cancelScheduled()
      // Wait for any in-flight operation to settle so we don't race a
      // concurrent sendMessage that would leave a dangling message.
      if (inFlight) {
        try { await inFlight } catch { /* ignore */ }
      }
      // Delete the preliminary message if one was sent and deleteMessage
      // is wired. Best-effort: failures are logged but not re-thrown.
      const msgId = streamMsgId
      if (msgId != null && config.deleteMessage != null) {
        try {
          await config.deleteMessage(chatId, msgId)
          log?.(`answer-stream: retracted preliminary message (id=${msgId})`)
        } catch (err) {
          warn?.(
            `answer-stream: retract deleteMessage failed (id=${msgId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    },
  }
}

/** Reset the draft-id counter for tests. */
export function __resetDraftIdForTests(): void {
  _nextDraftId = 1
}
