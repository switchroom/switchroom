import { isSilentFlushMarker } from './turn-flush-safety.js'
import {
  DRAFT_METHOD_UNAVAILABLE_RE as _DRAFT_METHOD_UNAVAILABLE_RE,
  DRAFT_CHAT_UNSUPPORTED_RE as _DRAFT_CHAT_UNSUPPORTED_RE,
  shouldFallbackFromDraftTransport as _shouldFallbackFromDraftTransport,
  allocateDraftId as _allocateDraftId,
  __resetDraftIdForTests as _resetDraftIdForTests,
} from './draft-transport.js'

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
 *   3. minInitialChars (~50) — don't open the answer lane until enough text
 *      has arrived. Lowered 400 → 50 in #553 PR 3 so short replies
 *      ("yes", "done", "the answer is 42") become visible on the first
 *      text event instead of waiting for `stream_reply` materialize.
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
 *
 * Draft-transport helpers (regex constants, shouldFallbackFromDraftTransport,
 * allocateDraftId) live in draft-transport.ts and are re-exported here so
 * existing callers that import from this module continue to work.
 */

export const MIN_INITIAL_CHARS = 50
export const DEFAULT_THROTTLE_MS = 1000
const TELEGRAM_MAX_CHARS = 4096

// Re-export shared constants so existing callers / tests keep working.
export const DRAFT_METHOD_UNAVAILABLE_RE = _DRAFT_METHOD_UNAVAILABLE_RE
export const DRAFT_CHAT_UNSUPPORTED_RE = _DRAFT_CHAT_UNSUPPORTED_RE
export { _shouldFallbackFromDraftTransport as shouldFallbackFromDraftTransport }

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
    params?: { message_thread_id?: number; parse_mode?: 'HTML' },
  ) => Promise<unknown>
  sendMessage: (
    chatId: string,
    text: string,
    params?: {
      parse_mode?: 'HTML'
      message_thread_id?: number
      link_preview_options?: { is_disabled: boolean }
      reply_parameters?: { message_id: number }
      /**
       * Distinguishes a streaming open (`'stream'` — silent edits-in-place
       * preview, default) from the turn-end materialize (`'materialize'` —
       * the user-facing final answer that should ping the device exactly
       * once, matching beat-5 of the conversational-pacing contract).
       *
       * Used by the gateway wrapper in `gateway.ts` to set
       * `disable_notification: true` for 'stream' purpose only —
       * materialize lets the platform default (notify) through. Without
       * this distinction, either every send pings (the original #1672
       * bug, two device pings per multi-step turn — see
       * `over-ping-safety-net.ts`) or none does (the over-correction
       * where text-only short turns silently land and the user has no
       * notification to know the answer arrived).
       */
      purpose?: 'stream' | 'materialize'
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
    | { kind: 'answer_lane_materialized'; chatId: string; messageId: number | undefined; suppressed?: boolean }
  ) => void

  /**
   * #646 — dedup hooks. Injected by the gateway so answer-stream materialize
   * participates in the same dedup window as turn-flush and reply/stream_reply.
   *
   * checkDedup(text): returns true if the text was already sent recently for
   *   this chat (caller already knows chatId/threadId via closure). When true,
   *   materialize skips the send and returns undefined.
   *
   * recordDedup(text): called after a successful materialize send so subsequent
   *   turn-flush or reply tool calls with the same content get suppressed.
   *
   * Both callbacks are optional — when absent, the old behaviour is preserved.
   */
  checkDedup?: (text: string) => boolean
  recordDedup?: (text: string) => void

  /**
   * #648 — write answer-stream materializations to the SQLite history buffer
   * so `mcp__switchroom-telegram__get_recent_messages` surfaces them. Without
   * this, materialized messages were visible in Telegram but invisible to
   * MCP forensics — that's the gap that let #646 slip past triage.
   *
   * Optional — when absent, behaviour is unchanged (no buffer write).
   */
  recordOutbound?: (args: { messageId: number; text: string }) => void
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

// Draft-id allocation now lives in draft-transport.ts (shared with
// draft-stream.ts). Re-alias locally so the rest of this file is unchanged.
const allocateDraftId = _allocateDraftId

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
    checkDedup,
    recordDedup,
    recordOutbound,
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

  /**
   * Clear the in-progress sendMessageDraft (#1704). When the answer
   * stream was using draft transport (DMs), Telegram leaves the draft
   * sitting in the user's compose area until something replaces or
   * clears it. On Telegram Desktop this blocks the user from typing —
   * the compose field is occupied by the bot's draft preview.
   *
   * Every terminal path on the stream (materialize / stop / retract)
   * must clear the draft. Best-effort: a failed clear is logged but
   * not re-thrown — the worst case is a transient stale draft that
   * Telegram's own 30 s draft expiry eventually mops up.
   *
   * #1792 — accepts an explicit `targetDraftId` so `forceNewMessage`
   * can clear the OLD id before bumping the closure's `draftId`. The
   * default reads the live closure, which is what stop() / retract()
   * want — clear whatever's current at the time the call lands.
   */
  async function clearDraftBestEffort(
    targetDraftId: number | undefined = draftId,
  ): Promise<void> {
    if (!usesDraftTransport || draftApi == null || targetDraftId == null) return
    try {
      const params: { message_thread_id?: number } = {}
      if (threadId != null) params.message_thread_id = threadId
      await draftApi(
        chatId,
        targetDraftId,
        '',
        Object.keys(params).length > 0 ? params : undefined,
      )
    } catch {
      // Best-effort cleanup
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
      if (_shouldFallbackFromDraftTransport(err)) {
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
      // First send — capture message_id; check generation for supersession.
      // purpose: 'stream' tells the gateway wrapper this is the visible
      // preview opener — silent (no device ping). The turn-end materialize
      // path uses 'materialize' to allow the platform-default ping.
      const sendParams: Parameters<typeof sendMessage>[2] = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        purpose: 'stream',
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
      await clearDraftBestEffort()

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

      // #646 — dedup check: was this content already sent via turn-flush
      // (or another path) within the dedup TTL? If so, skip the send to
      // avoid a duplicate push notification. We still emit the metric
      // (with suppressed=true) so observability tooling can track the
      // rate of suppressed materializations.
      if (checkDedup != null && checkDedup(textToSend)) {
        log?.(
          `telegram gateway: answer-stream: materialize-dedup-suppressed chatId=${chatId} — turn-flush already sent this content`,
        )
        onMetric?.({ kind: 'answer_lane_materialized', chatId, messageId: undefined, suppressed: true })
        return undefined
      }

      // Always send a fresh message for push notification.
      // purpose: 'materialize' tells the gateway wrapper to allow the
      // platform-default device ping through (vs the 'stream' opener
      // which is forced silent). materialize() is the turn-end final-
      // answer surface — beat 5 of the conversational-pacing contract
      // — and MUST ping so the user knows the answer landed.
      const sendParams: Parameters<typeof sendMessage>[2] = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        purpose: 'materialize',
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
          // #646 — record in dedup cache so a late-arriving turn-flush
          // (or a second materialize on reconnect) with identical content
          // gets suppressed. Mirrors the record call in gateway.ts
          // turn-flush at line ~3795.
          recordDedup?.(textToSend)
          // #648 — mirror turn-flush's recordOutbound so this send shows up
          // in get_recent_messages / SQLite history.
          recordOutbound?.({ messageId: sentId, text: textToSend })
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
        // #1792: clear the OLD draftId BEFORE rotating. Otherwise the
        // stale content stays in the user's compose box until the 30 s
        // Telegram draft expiry — the typical caller (gateway.ts mid-
        // turn rapid-steer path: `forceNewMessage(); stop();`) cleans
        // up the prior turn's stream, so the prior draft's content is
        // semantically retracted. Fire-and-forget — forceNewMessage is
        // sync; the worst-case failure mode is the same 30 s expiry
        // we'd have had without the call.
        const staleDraftId = draftId
        if (staleDraftId != null) {
          void clearDraftBestEffort(staleDraftId)
        }
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
      // #1704: clear the compose-box draft. stop() is sync — fire and
      // forget. A dropped clear falls back on Telegram's own 30 s
      // draft expiry; the worst case is a transient stale preview.
      // (#1792: the stale-id-after-rotation hazard is owned by
      // forceNewMessage itself now — it clears its own draftId before
      // rotating. stop() just clears whatever's current; clearing an
      // already-cleared or never-used id is a harmless no-op.)
      void clearDraftBestEffort()
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
      // #1704: clear the compose-box draft when this stream was using
      // draft transport. Without this, Telegram Desktop leaves the
      // draft sitting in the user's input area and blocks them from
      // typing until the 30 s draft expiry. Awaited so a follow-up
      // sendMessage on the same chat doesn't race a stale draft edit.
      // (See #1792 note in stop() — forceNewMessage owns its own stale
      // id cleanup; retract just clears whatever's current.)
      await clearDraftBestEffort()
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
/** Reset the shared draft-id counter for tests. Delegates to draft-transport.ts. */
export function __resetDraftIdForTests(): void {
  _resetDraftIdForTests()
}
