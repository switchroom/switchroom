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
   * Parallel to activeDraftStreams: parseMode baked into each controller.
   * Lets `handleStreamReply` detect and rotate streams whose parseMode no
   * longer matches the caller's resolved format (bug 1). Optional for
   * backwards compatibility.
   */
  activeDraftParseModes?: Map<string, 'HTML' | 'MarkdownV2' | undefined>
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
  /** Markdown → HTML renderer applied to the text before stream.update. */
  renderText: (text: string) => string
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
}

function streamKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

/**
 * Core decision + state-mutation for a PTY-extracted text snapshot.
 *
 * Returns the action taken. All state mutation happens through the
 * supplied `state` object so callers can inspect before/after.
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
      parseMode: 'HTML',
      disableLinkPreview: true,
      throttleMs: 600,
      retry: deps.retry,
      onSend: (messageId, charCount) => deps.onStreamSend?.(chatId, messageId, charCount),
      onEdit: (messageId, charCount) => deps.onStreamEdit?.(chatId, messageId, charCount),
    })
    state.activeDraftStreams.set(sKey, stream)
    state.activeDraftParseModes?.set(sKey, 'HTML')
  }

  const rendered = deps.renderText(text)
  void stream.update(rendered).catch(() => { /* swallow — logged elsewhere */ })

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
