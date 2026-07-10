/**
 * PTY-tail partial handler — extracted from server.ts for testability.
 *
 * The handler's job: given a freshly-extracted text snapshot from the
 * TUI, decide whether to push it through a draft stream, buffer it
 * (no chat id known yet), or drop it (suppressed / duplicate).
 *
 * Why extract:
 *   - the core decision logic was untestable without mocking all of
 *     server.ts's top-level init
 *   - the state machine (suppressed, buffered, dedup, first-partial,
 *     create-vs-reuse) is the same shape that causes the
 *     "duplicate message" / "stale preview" class of production bugs
 *   - a small, pure-ish module with an integration test is easier to
 *     reason about than 75 lines of closure inside server.ts
 *
 * Side effects are intentional and flow through injected state +
 * callbacks — no imports of bot / logger / formatter at module scope.
 */

import type { DraftStreamHandle } from './draft-stream.js'
import {
  createStreamController,
  type StreamBotApi,
  type RetryPolicy,
} from './stream-controller.js'

/** Classification returned by the handler — useful for tests + logging. */
export type PtyPartialAction =
  | 'buffered' // no chat id known; text stored in pendingPtyPartial
  | 'suppressed' // chat is claimed by a reply handler; dropped
  | 'dedup-skip' // same text as the previous partial; no-op
  | 'update-existing' // pushed into an already-live stream
  | 'update-new' // created a new stream and pushed into it
  | 'error-suppressed' // raw API-error TUI line; dropped (issue #2922 Bug 3)

export interface PtyHandlerState {
  /**
   * The chat currently being processed, or null before session-tail has
   * read the enqueue event.
   */
  currentSessionChatId: string | null
  currentSessionThreadId?: number
  /**
   * Single-slot buffer for a partial that arrived before chatId was known.
   * When enqueue lands, server.ts calls the handler again with the buffered
   * text now that the chat is resolved.
   */
  pendingPtyPartial: { text: string } | null
  /** Active streams, keyed by `chat_id:thread_id`. */
  activeDraftStreams: Map<string, DraftStreamHandle>
  /**
   * Chats whose PTY preview is claimed by an in-flight reply handler.
   * Partials for these chats are dropped to avoid duplicates.
   */
  suppressPtyPreview: Set<string>
  /** Last text we actually pushed per chat — used for dedup. */
  lastPtyPreviewByChat: Map<string, string>
}

export interface PtyHandlerDeps {
  bot: { api: StreamBotApi }
  retry?: RetryPolicy
  /** Optional structured event hook, called once per invocation. */
  logEvent?: (ev: {
    kind: 'pty_partial_received'
    chatId: string | null
    suppressed: boolean
    hasStream: boolean
    charCount: number
    bufferedWithoutChatId: boolean
  }) => void
  /** Called once per stream creation (maps to logOutbound in server.ts). */
  onStreamSend?: (chatId: string, messageId: number, charCount: number) => void
  /** Called on every successful stream edit. */
  onStreamEdit?: (chatId: string, messageId: number, charCount: number) => void
  /** Called on first partial seen for a chat (previously a stderr line). */
  onFirstPartial?: (chatId: string, charCount: number) => void
  /**
   * Optional stderr writer for draft-stream diagnostic lines (edit-failed,
   * not-modified, re-sending, finalize). Without this, those are dropped —
   * previously making transient edit failures invisible in PTY-tail live-
   * preview mode.
   */
  writeError?: (line: string) => void
}

/**
 * Detect a raw API-error line scraped from Claude Code's TUI — issue #2922
 * Bug 3. When the model 429s / errors, the CLI renders an `API Error: … ·
 * b'{"type":"error",…}'` line into the terminal; the PTY tail would otherwise
 * scrape it as the assistant reply and relay the raw bytes verbatim to chat.
 * These lines are suppressed here so the model-unavailable operator-event
 * pipeline owns the user-facing rendering (a clean ⚠️ card), not the raw tail.
 *
 * Kept deliberately tight (anchored error markers, not any mention of "error")
 * so genuine assistant text that happens to discuss errors is NOT swallowed.
 */
export function looksLikeRawApiError(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  const lower = text.toLowerCase()
  return (
    lower.includes('api error:')
    || lower.includes('"type":"error"')
    || lower.includes("'type': 'error'")
    || lower.includes('rate_limit_error')
    || lower.includes('overloaded_error')
    || lower.includes('"is_error":true')
    // The CLI's Python-style raw-body render: · b'{...}'
    || / b'\{/.test(text)
  )
}

function streamKey(chatId: string, threadId?: number): string {
  // Canonical chat-key derivation lives in gateway/chat-key.ts — keep this
  // expression in lockstep (treats 0/null/undefined the same). See #1564.
  const t = threadId == null || threadId === 0 ? '_' : String(threadId)
  return `${chatId}:${t}`
}

/**
 * Core decision + state-mutation for a PTY-extracted text snapshot.
 *
 * Returns the action taken. All state mutation happens through the
 * supplied `state` object so callers can inspect before/after.
 *
 * NOTE on `looksLikeRawApiError` suppression (#2922 Bug 3): this is
 * *preview-only* scope. PTY partials are the live-streaming terminal tail,
 * never the authoritative reply (that flows through the operator-event /
 * reply pipelines). So the worst case of an over-eager match here is a
 * missing streaming flicker for one snapshot — NOT a dropped user answer.
 * That asymmetry is why the matcher can stay aggressive on raw error shapes.
 */
export function handlePtyPartialPure(
  text: string,
  state: PtyHandlerState,
  deps: PtyHandlerDeps,
): PtyPartialAction {
  if (state.currentSessionChatId == null) {
    state.pendingPtyPartial = { text }
    deps.logEvent?.({
      kind: 'pty_partial_received',
      chatId: null,
      suppressed: false,
      hasStream: false,
      charCount: text.length,
      bufferedWithoutChatId: true,
    })
    return 'buffered'
  }

  const chatId = state.currentSessionChatId
  const threadId = state.currentSessionThreadId
  const sKey = streamKey(chatId, threadId)
  const suppressed = state.suppressPtyPreview.has(sKey)
  const hadStream = state.activeDraftStreams.has(sKey)

  deps.logEvent?.({
    kind: 'pty_partial_received',
    chatId,
    suppressed,
    hasStream: hadStream,
    charCount: text.length,
    bufferedWithoutChatId: false,
  })

  if (suppressed) return 'suppressed'

  // Drop raw API-error TUI lines so they never leak to chat as the reply —
  // the model-unavailable card (operator-event pipeline) renders these
  // instead. See issue #2922 Bug 3.
  if (looksLikeRawApiError(text)) return 'error-suppressed'

  if (state.lastPtyPreviewByChat.get(sKey) === text) return 'dedup-skip'

  const isFirst = !state.lastPtyPreviewByChat.has(sKey)
  state.lastPtyPreviewByChat.set(sKey, text)
  if (isFirst) deps.onFirstPartial?.(chatId, text.length)

  let stream = state.activeDraftStreams.get(sKey)
  const created = !stream
  if (!stream) {
    stream = createStreamController({
      bot: deps.bot,
      chatId,
      threadId,
      // PTY-tail previews are raw terminal/TUI output, not authored
      // markdown — send them literally so control glyphs and box-drawing
      // characters aren't misinterpreted as markdown syntax (#2669).
      literalText: true,
      disableLinkPreview: true,
      throttleMs: 600,
      retry: deps.retry,
      onSend: (messageId, charCount) => deps.onStreamSend?.(chatId, messageId, charCount),
      onEdit: (messageId, charCount) => deps.onStreamEdit?.(chatId, messageId, charCount),
      ...(deps.writeError != null
        ? {
            log: (msg: string) => {
              // Filter routine success chatter; only surface warnings
              // and recovery paths to stderr.
              if (
                msg.startsWith('stream → sent')
                || msg.startsWith('stream → edited')
                || msg.startsWith('stream → not modified')
                || msg.startsWith('stream finalized')
              ) return
              deps.writeError!(`telegram channel: pty_preview ${msg}\n`)
            },
          }
        : {}),
    })
    state.activeDraftStreams.set(sKey, stream)
  }

  void stream.update(text).catch(() => { /* swallow — logged elsewhere */ })

  return created ? 'update-new' : 'update-existing'
}

/**
 * Convenience factory that bundles state + deps into a stable closure.
 * server.ts can call `handler.onPartial(text)` and
 * `handler.onSessionEnqueue(chatId, threadId)` without re-passing deps.
 */
export function createPtyPartialHandler(
  state: PtyHandlerState,
  deps: PtyHandlerDeps,
) {
  return {
    onPartial(text: string): PtyPartialAction {
      return handlePtyPartialPure(text, state, deps)
    },
    /**
     * Called when session-tail resolves the enqueue event and hands us a
     * chat id. Flushes any buffered pre-chat partial through the handler
     * now that the chat is known.
     */
    onSessionEnqueue(chatId: string, threadId?: number): PtyPartialAction | null {
      state.currentSessionChatId = chatId
      state.currentSessionThreadId = threadId
      const pending = state.pendingPtyPartial
      if (pending != null) {
        state.pendingPtyPartial = null
        return handlePtyPartialPure(pending.text, state, deps)
      }
      return null
    },
    /**
     * Called on turn_end — clears session state and the dedup cache.
     *
     * NOTE: we intentionally do NOT clear `suppressPtyPreview` here.
     * PTY partials can arrive after turn_end (delayed xterm flush,
     * orphaned-reply paths). Releasing the claim at turn_end would
     * let those late partials slip through as a fresh draft_send with
     * raw TUI text — the user sees the same content sent twice, the
     * second copy unformatted. The claim is dropped instead on the
     * next inbound user message (see handleInbound in server.ts).
     */
    onTurnEnd(): void {
      const key = state.currentSessionChatId != null
        ? streamKey(state.currentSessionChatId, state.currentSessionThreadId)
        : null
      if (key != null) {
        state.lastPtyPreviewByChat.delete(key)
      }
      state.currentSessionChatId = null
      state.currentSessionThreadId = undefined
      state.pendingPtyPartial = null
    },
    /**
     * Called when a new inbound user message arrives for a chat+thread.
     * This is the true "new cycle" boundary — release any PTY-preview
     * claim held over from the prior turn so the fresh turn's live
     * preview can fire. Mirrors the non-steering branch in
     * handleInbound.
     */
    onInboundNewCycle(chatId: string, threadId?: number): void {
      state.suppressPtyPreview.delete(streamKey(chatId, threadId))
    },
  }
}
