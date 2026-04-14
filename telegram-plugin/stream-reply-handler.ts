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
  /**
   * Explicit quote-reply target. When set, the initial streamed message
   * quote-threads under this message_id. Overrides the default auto-quote
   * behavior and ignores `quote`.
   */
  reply_to?: string
  /**
   * Opt out of the default quote-reply behavior. The handler's default
   * (when `reply_to` is unset) is to look up the latest inbound user
   * message via `getLatestInboundMessageId` and quote-reply to it. Pass
   * `false` to send a bare (non-quoted) streamed message.
   *
   * The default is `undefined` (treated as true) so callers that pre-date
   * this feature keep working. Only the progress-card / activity-lane
   * internal callers routinely opt out, since those aren't user-visible
   * conversation replies.
   */
  quote?: boolean
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
  /**
   * Resolves the default quote-reply target: the message_id of the latest
   * inbound user message in this chat+thread, or null if none (empty
   * history, or history disabled). Called only when the caller didn't
   * pass `reply_to` and didn't opt out via `quote:false`. Optional —
   * omit to disable the auto-quote default (legacy behavior).
   */
  getLatestInboundMessageId?: (chatId: string, threadId: number | null) => number | null
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
  /**
   * When true, the progress-card driver is emitting a live checklist on
   * the `progress` lane and owns mid-turn display. In that mode, a
   * caller-initiated `stream_reply` on the default (unnamed) lane with
   * `done=false` is suppressed — the card already shows what's happening,
   * and a parallel default-lane message is visible noise (a duplicate
   * surface for the same turn). The final `done=true` call still posts
   * as the answer message.
   *
   * Named-lane calls (lane: 'progress', 'thinking', etc.) are always
   * honored — this flag only gates the default lane. Omit or leave false
   * to preserve legacy behavior.
   */
  progressCardActive?: boolean
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

  // Access check runs BEFORE the progress-card short-circuit: a denied
  // chat id must throw regardless of streaming mode. Previously the
  // suppression path silently "succeeded" for unauthorized chats.
  deps.assertAllowedChat(chat_id)
  const threadId = deps.resolveThreadId(chat_id, args.message_thread_id)

  // In checklist mode the progress card is the mid-turn surface. A
  // caller-initiated default-lane stream_reply(done=false) creates a
  // second surface that either duplicates the card's narrative or
  // races it. We reject it with a clear error so the caller learns
  // in-context rather than through silent suppression + a missing
  // message later. Internal callers (the progress-card driver itself)
  // pass lane:'progress' and are allowed through.
  const isDefaultLane = args.lane == null || args.lane.length === 0
  if (deps.progressCardActive === true && isDefaultLane && !done) {
    // Claim the PTY-preview slot so any PTY partial that fires after
    // this rejected call doesn't leak a raw-TUI draft. The claim is
    // keyed lane-less because the PTY handler uses lane-less keys.
    state.suppressPtyPreview?.add(streamKey(chat_id, threadId))
    deps.logStreamingEvent({
      kind: 'stream_reply_called',
      chatId: chat_id,
      charCount: rawText.length,
      done: false,
      streamExisted: state.activeDraftStreams.has(
        streamKey(chat_id, threadId, args.lane),
      ),
    })
    throw new Error(
      'stream_reply(done=false) is not supported in checklist mode. ' +
        'The progress card already renders mid-turn status (Plan → Run → Done ' +
        'with live tool bullets). Call stream_reply exactly once per turn ' +
        'with done=true and your complete final answer.',
    )
  }

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

  // Over-limit pre-check. Throws BEFORE touching stream state so that
  // (a) a first call over 4096 fails cleanly instead of creating a
  // half-initialized stream, and (b) a mid-stream update over 4096
  // fails loudly instead of setting the internal `stopped=true` flag
  // and silently dropping all subsequent text. Either way the caller
  // sees isError:true and can fall back to `reply`, which chunks.
  // Check the rendered text (post-markdown-to-HTML) because that's
  // what actually goes to Telegram's 4096-char wire limit.
  if (effectiveText.length > 4096) {
    throw new Error(
      `stream_reply rejected: text exceeds Telegram's 4096-char limit ` +
        `(length=${effectiveText.length}, format=${format}). stream_reply does not ` +
        `auto-chunk — split the text or use \`reply\`, which chunks.`,
    )
  }

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
      } catch (err) {
        // Best-effort: the in-flight edit may 429 or race. Surface to
        // stderr so the orphaned message id isn't invisible.
        deps.writeError(
          `telegram channel: stream_reply parseMode-rotation finalize failed: ${err}\n`,
        )
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
    // Resolve the effective quote-reply target. Explicit `reply_to` wins;
    // otherwise (unless the caller opted out with `quote:false`) fall back
    // to the latest inbound user message in this chat+thread. Resolved
    // only on stream creation — subsequent `stream_reply` calls for the
    // same turn edit the existing message, which Telegram doesn't allow
    // us to add a quote reference to retroactively.
    let replyToMessageId: number | undefined
    if (args.reply_to != null) {
      replyToMessageId = Number(args.reply_to)
    } else if (args.quote !== false && deps.getLatestInboundMessageId != null) {
      try {
        const latest = deps.getLatestInboundMessageId(chat_id, threadId ?? null)
        if (latest != null) replyToMessageId = latest
      } catch (err) {
        deps.writeError(
          `telegram channel: stream_reply quote-lookup failed: ${err}\n`,
        )
      }
    }

    stream = createStreamController({
      bot: deps.bot,
      chatId: chat_id,
      threadId,
      parseMode,
      disableLinkPreview: deps.disableLinkPreview,
      throttleMs: deps.throttleMs ?? 600,
      retry: deps.retry,
      ...(replyToMessageId != null ? { replyToMessageId } : {}),
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
      // Route draft-stream diagnostics through the handler's stderr
      // writer so transient failures are observable. Filter routine
      // success chatter (sent/edited/finalized) — those are already
      // captured by the structured onSend/onEdit observers — and only
      // surface warnings/errors (stopped, edit failed, not-found
      // recovery).
      log: (msg) => {
        if (
          msg.startsWith('stream → sent')
          || msg.startsWith('stream → edited')
          || msg.startsWith('stream → not modified')
          || msg.startsWith('stream finalized')
        ) return
        deps.writeError(`telegram channel: stream_reply ${msg}\n`)
      },
    })
    state.activeDraftStreams.set(sKey, stream)
    state.activeDraftParseModes?.set(sKey, parseMode)
  }

  await stream.update(effectiveText)

  if (done) {
    await stream.finalize()
    state.activeDraftStreams.delete(sKey)
    state.activeDraftParseModes?.delete(sKey)
    // Intentionally NOT firing the terminal 👍 here. A turn can call
    // stream_reply(done=true) mid-flight and then do more tool work or
    // send additional replies. The 👍 now fires only from turn_end in
    // server.ts, which is the true agent-idle boundary.

    // Hard-fail surface: if the stream finalized without ever assigning
    // a message id, the initial send never landed (4096+ chars hits
    // draft-stream's length guard and silently stops). Throw so the MCP
    // caller sees isError:true instead of a misleading "finalized
    // (id: pending)". The caller can fall back to `reply`, which chunks.
    if (stream.getMessageId() == null) {
      throw new Error(
        `stream_reply finalized without sending any message (length=${rawText.length}, ` +
          `max=4096). Telegram's per-message limit is 4096 chars and stream_reply does not ` +
          `auto-chunk. Split the text or use \`reply\` (which chunks).`,
      )
    }

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
