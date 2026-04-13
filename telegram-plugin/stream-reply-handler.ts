/**
 * `stream_reply` MCP tool handler — extracted from server.ts.
 *
 * The server.ts case block was ~110 lines of state-machine + I/O mixed
 * together. This module pulls the logic into a pure-ish function with
 * injected deps so it can be exercised by an integration test against
 * the mock bot harness.
 *
 * Contract:
 *   - First call for a chat+thread: creates a stream via
 *     createStreamController, optionally prepending a handoff prefix.
 *   - Subsequent calls: reuse the existing stream, push the new text.
 *   - `done=true`: finalize, delete the map entry, fire status-reaction
 *     completion, and (if history enabled) record the final message.
 *   - Returns the message id + terminal status text that server.ts
 *     wraps into an MCP content response.
 */

import type { DraftStreamHandle } from './draft-stream.js'
import {
  createStreamController,
  type StreamBotApi,
  type RetryPolicy,
} from './stream-controller.js'

export interface StreamReplyArgs {
  chat_id: string
  text: string
  done?: boolean
  message_thread_id?: string
  format?: string
  /**
   * Optional named lane. Each lane gets its own Telegram message per
   * chat+thread — useful for surfacing "thinking" alongside the main
   * "answer" stream. Lane names are caller-defined. Omit for the
   * default (unnamed) lane, which preserves legacy behavior.
   */
  lane?: string
}

export interface StreamReplyState {
  activeDraftStreams: Map<string, DraftStreamHandle>
  /**
   * Tracks the parseMode each active stream was created with, keyed the
   * same way as `activeDraftStreams`. Used by `handleStreamReply` to
   * detect when a subsequent call's resolved parseMode differs from the
   * one baked into the existing stream controller — in that case the
   * stale stream is finalized + discarded and a fresh one is created
   * with the new parseMode (see bug 1: PTY-tail creates an activity-lane
   * stream with parseMode=undefined; a later explicit stream_reply on
   * the same key with format:'html' would otherwise inherit undefined
   * and send literal markdown).
   *
   * Optional for backwards compatibility with external callers that
   * construct a StreamReplyState without it.
   */
  activeDraftParseModes?: Map<string, 'HTML' | 'MarkdownV2' | undefined>
  /**
   * Chats whose PTY preview is claimed by an in-flight reply/stream_reply
   * handler. PTY-tail partials for these keys are dropped to avoid
   * duplicate messages. Historically only the `reply` tool added to this
   * set; `stream_reply` did not, so a PTY partial firing after a
   * finalized stream would create a duplicate message with the raw TUI
   * text (see regression in telegram-plugin.log where msg 559 was
   * followed by a duplicate msg 560 via path=pty_preview). stream_reply
   * now claims the slot on the first call so later PTY partials are
   * suppressed for the rest of the turn.
   *
   * Optional for backwards compatibility with callers that don't yet
   * thread this state through — without it the bug reopens silently.
   */
  suppressPtyPreview?: Set<string>
}

export interface StreamReplyDeps {
  bot: { api: StreamBotApi }
  retry?: RetryPolicy
  /** Markdown → HTML renderer (used when format === 'html'). */
  markdownToHtml: (text: string) => string
  /** MarkdownV2 escaper (used when format === 'markdownv2'). */
  escapeMarkdownV2: (text: string) => string
  /** Whitespace repair applied to the raw caller text. */
  repairEscapedWhitespace: (text: string) => string
  /** Resolves the handoff prefix for a first-chunk stream. Empty string if none. */
  takeHandoffPrefix: (format: 'html' | 'markdownv2' | 'text') => string
  /** Validates the chat id against the access list. Throws on deny. */
  assertAllowedChat: (chatId: string) => void
  /** Resolves the effective thread id (explicit, last-inbound, or undefined). */
  resolveThreadId: (chatId: string, explicit?: string) => number | undefined
  /** Config: disable link previews. Default true. */
  disableLinkPreview: boolean
  /** Config: fallback parse mode when args.format is omitted ('html' | 'markdownv2' | 'text'). */
  defaultFormat: string
  /** Observability: per-call event. */
  logStreamingEvent: (ev: {
    kind: 'stream_reply_called'
    chatId: string
    charCount: number
    done: boolean
    streamExisted: boolean
  } | {
    kind: 'draft_send'
    chatId: string
    messageId: number
    charCount: number
  } | {
    kind: 'draft_edit'
    chatId: string
    messageId: number
    charCount: number
    sameAsLast: boolean
  }) => void
  /** Called on done=true to transition the status reaction controller. */
  endStatusReaction: (chatId: string, threadId: number | undefined, verdict: 'done') => void
  /** Whether to persist outbound history. */
  historyEnabled: boolean
  /** History row writer. Only called when historyEnabled && done && messageId != null. */
  recordOutbound: (row: {
    chat_id: string
    thread_id: number | null
    message_ids: number[]
    texts: string[]
  }) => void
  /** Error-path stderr. */
  writeError: (line: string) => void
  throttleMs?: number
}

export interface StreamReplyResult {
  messageId: number | null
  status: 'updated' | 'finalized'
}

function streamKey(chatId: string, threadId?: number, lane?: string): string {
  const base = `${chatId}:${threadId ?? '_'}`
  return lane != null && lane.length > 0 ? `${base}:${lane}` : base
}

export async function handleStreamReply(
  args: StreamReplyArgs,
  state: StreamReplyState,
  deps: StreamReplyDeps,
): Promise<StreamReplyResult> {
  const chat_id = args.chat_id
  const rawText = deps.repairEscapedWhitespace(args.text)
  const done = Boolean(args.done)
  const format = args.format ?? deps.defaultFormat

  let parseMode: 'HTML' | 'MarkdownV2' | undefined
  let effectiveText: string
  if (format === 'html') {
    parseMode = 'HTML'
    effectiveText = deps.markdownToHtml(rawText)
  } else if (format === 'markdownv2') {
    parseMode = 'MarkdownV2'
    effectiveText = deps.escapeMarkdownV2(rawText)
  } else {
    parseMode = undefined
    effectiveText = rawText
  }

  deps.assertAllowedChat(chat_id)
  const threadId = deps.resolveThreadId(chat_id, args.message_thread_id)

  const sKey = streamKey(chat_id, threadId, args.lane)
  // Claim the PTY-preview slot so any PTY-tail partial that fires mid-
  // or post-turn for this chat+thread is dropped. Keyed WITHOUT lane
  // because the PTY handler uses the lane-less key and we need to
  // suppress its default lane regardless of which lane stream_reply
  // targets. Cleared on turn_end by server.ts.
  state.suppressPtyPreview?.add(streamKey(chat_id, threadId))
  let stream = state.activeDraftStreams.get(sKey)

  // Bug 1 fix: parseMode is baked into the stream controller at creation
  // time. If a prior call created the stream with a different parseMode
  // (e.g. PTY-tail auto-stream using 'text' → undefined, followed by an
  // explicit stream_reply with format:'html'), reusing it would send
  // literal markdown. Finalize + discard the stale stream so the block
  // below creates a fresh one with the correct parseMode.
  if (stream != null && state.activeDraftParseModes != null) {
    const existingParseMode = state.activeDraftParseModes.get(sKey)
    if (existingParseMode !== parseMode) {
      try {
        await stream.finalize()
      } catch {
        /* best-effort: the in-flight edit may 429 or race, but we must
         * not block the caller's new message on it. */
      }
      state.activeDraftStreams.delete(sKey)
      state.activeDraftParseModes.delete(sKey)
      stream = undefined
    }
  }

  const streamExisted = stream != null

  deps.logStreamingEvent({
    kind: 'stream_reply_called',
    chatId: chat_id,
    charCount: effectiveText.length,
    done,
    streamExisted,
  })

  // First chunk of a session: consume any pending handoff prefix.
  if (!stream) {
    const prefix = deps.takeHandoffPrefix(
      format === 'html' ? 'html' : format === 'markdownv2' ? 'markdownv2' : 'text',
    )
    if (prefix.length > 0) effectiveText = prefix + effectiveText
  }

  if (!stream) {
    stream = createStreamController({
      bot: deps.bot,
      chatId: chat_id,
      threadId,
      parseMode,
      disableLinkPreview: deps.disableLinkPreview,
      throttleMs: deps.throttleMs ?? 600,
      retry: deps.retry,
      onSend: (messageId, charCount) =>
        deps.logStreamingEvent({ kind: 'draft_send', chatId: chat_id, messageId, charCount }),
      onEdit: (messageId, charCount) =>
        deps.logStreamingEvent({
          kind: 'draft_edit',
          chatId: chat_id,
          messageId,
          charCount,
          sameAsLast: false,
        }),
    })
    state.activeDraftStreams.set(sKey, stream)
    state.activeDraftParseModes?.set(sKey, parseMode)
  }

  await stream.update(effectiveText)

  if (done) {
    await stream.finalize()
    state.activeDraftStreams.delete(sKey)
    state.activeDraftParseModes?.delete(sKey)
    deps.endStatusReaction(chat_id, threadId, 'done')

    if (deps.historyEnabled) {
      const finalId = stream.getMessageId()
      if (finalId != null) {
        try {
          deps.recordOutbound({
            chat_id,
            thread_id: threadId ?? null,
            message_ids: [finalId],
            texts: [rawText],
          })
        } catch (err) {
          deps.writeError(
            `telegram channel: history recordOutbound (stream_reply) failed: ${err}\n`,
          )
        }
      }
    }
  }

  return {
    messageId: stream.getMessageId(),
    status: done ? 'finalized' : 'updated',
  }
}
