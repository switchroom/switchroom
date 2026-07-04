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
 *     createStreamController.
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
import { RICH_MESSAGE_MAX_CHARS } from './format.js'
import { chatKey, chatKeyWithSuffix } from './gateway/chat-key.js'

/**
 * Builds the inline status-accent header line for `reply` / `stream_reply`.
 *
 * Returns a string to prepend to the message body, including a trailing
 * blank line so the header is visually separated. Returns an empty string
 * when accent is undefined or unrecognised (silent ignore) so calls without
 * `accent` produce identical output to today.
 *
 * The header is GFM markdown — every outbound goes through the rich-message
 * path (#2669), so `_italic_` / `**bold**` render correctly.
 */
export function buildAccentHeader(accent: string | undefined): string {
  switch (accent) {
    case 'in-progress':
      return '🔵 _In progress…_\n\n'
    case 'done':
      return '✅ **Done**\n\n'
    case 'issue':
      return '⚠️ **Issue**\n\n'
    default:
      return ''
  }
}

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
  /**
   * Optional turn identifier used to multiplex concurrent turns on the
   * same chat+thread+lane. Without this, two concurrent turns emitting
   * on the same lane (e.g. both on lane:'progress') collapse into a
   * single draft stream and their Telegram messages flap between each
   * other. The progress-card driver passes its unique per-turn key here
   * so each active turn gets its own draft stream + pinned card. Other
   * lane callers may leave this undefined to preserve legacy behavior.
   */
  turnKey?: string
  /**
   * Inline keyboard markup. When set, every send and edit for this stream
   * includes it so Telegram doesn't strip an attached keyboard on text
   * updates. Used by the progress-card driver to persist the Steer button.
   */
  reply_markup?: unknown
  /**
   * When true, Telegram prevents the message from being forwarded or saved.
   * Applied on the initial send only (editMessageText ignores it).
   */
  protect_content?: boolean
  /**
   * When true, the INITIAL `sendMessage` is silent (no device ping).
   * Edits never ping regardless. Used by mid-turn stream_reply calls
   * under the #1122 conversational-pacing redesign. Default false.
   */
  disable_notification?: boolean
  /**
   * Optional surgical quote text. When set along with `reply_to`, the initial
   * send includes `reply_parameters: { message_id, quote: { text, position: 0 } }`
   * so Telegram highlights the specific quoted sentence rather than the whole
   * referenced message. Ignored when `reply_to` is absent.
   */
  quote_text?: string
  /**
   * Optional status accent prepended as a leading header line (issue #320
   * fallback for missing Telegram quote-bar color API).
   *
   * - `'in-progress'` → `🔵 _In progress…_\n\n`
   * - `'done'`        → `✅ **Done**\n\n`
   * - `'issue'`       → `⚠️ **Issue**\n\n`
   *
   * Unrecognised values are silently ignored. Omit for plain reply (default
   * behavior — identical to today's output).
   */
  accent?: string
}

export interface StreamReplyState {
  activeDraftStreams: Map<string, DraftStreamHandle>
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
  /** Whitespace repair applied to the raw caller text. */
  repairEscapedWhitespace: (text: string) => string
  /**
   * Promote lone prose paragraph breaks into GFM hard breaks so the rich
   * path doesn't collapse them. Optional for backward compat; when omitted,
   * the raw (repaired) text is sent unchanged.
   */
  normalizeParagraphBreaks?: (text: string) => string
  /**
   * Punctuation/bullet normalization (fleet-wide consistent formatting):
   * em/en dashes → comma/hyphen, leading unicode bullets → `- `. Applied on
   * code-masked text right after normalizeParagraphBreaks. Optional for
   * backward compat; omitted → no normalization.
   */
  normalizePunctuation?: (text: string) => string
  /**
   * Over-bold tripwire: strips `**bold**` markers when a message is clearly
   * over-bolded (>30% bold, or whole paragraphs/lists fully bolded). Applied
   * after normalizePunctuation. Optional for backward compat.
   */
  stripExcessBold?: (text: string) => string
  /**
   * Insert a visible blank-line spacer into each prose `\n\n` gap so the rich
   * GFM renderer shows a real empty line between paragraphs (the rich engine
   * otherwise renders `\n\n` tight — the post-#2669 paragraph-spacing
   * regression). Applied only on the rich path (never on `format:'text'`).
   * Optional for backward compat; omitted → no spacers added.
   */
  addParagraphSpacers?: (text: string) => string
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
  /** Config: fallback format when args.format is omitted. Anything other
   *  than the literal `'text'` is treated as the rich-markdown path (#2669). */
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
  /**
   * Optional: turn-complete hook. Historically wired by the gateway to
   * `progressDriver.forceCompleteTurn(...)` so a `stream_reply(done=true)` on
   * the default (unnamed) lane acted as an authoritative turn-complete signal
   * equal to session-tail `turn_end`. The pinned progress card was retired
   * (#1122/#1126) and `progressDriver` is permanently null, so the gateway now
   * passes a no-op wrapper for this dep — the hook is inert until a future
   * consumer re-attaches it. Skipped when args.lane is 'progress'. Safe to
   * leave unset.
   */
  forceCompleteTurn?: (chatId: string, threadId: number | undefined) => void
  /**
   * Optional: outbound-delivery counter hook. Historically wired to
   * `progressDriver.recordOutboundDelivered(...)`, called BEFORE
   * `forceCompleteTurn` so the driver's per-turn outbound counter was non-zero
   * when the terminal render fired (issue #310). With the progress card retired
   * (#1122/#1126, null driver) the gateway passes a no-op wrapper — inert until
   * re-attached. Only called on the default (unnamed) lane when `done=true` and
   * the stream produced a non-null messageId. Safe to leave unset.
   */
  recordOutboundDelivered?: (chatId: string, threadId: number | undefined) => void
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
   * Idempotency hook for the duplicate-message class (issue #626).
   *
   * On every call where the handler would CREATE a new stream (no entry
   * in `state.activeDraftStreams[sKey]`), this callback is consulted to
   * see whether an external authority already knows the anchor message
   * id for this lane+turn. If it returns a number, the new stream is
   * initialized as if a previous send had landed with that id — the
   * very next update fires `editMessageText` instead of `sendMessage`.
   *
   * Wired by the gateway to `pinMgr.pinnedMessageId(turnKey, agentId)`
   * for the progress card. Without this hook, a `done=true` finalize
   * deletes `activeDraftStreams[sKey]`, and the next emit on the same
   * turn creates a fresh sendMessage — visible to the user as a second
   * "status message" landing instead of an edit. The not-found
   * fallback in draft-stream gracefully handles a stale id.
   *
   * Safe to omit. Optional. Returns null/undefined to fall through to
   * the standard "first call sends" behavior.
   */
  lookupExistingMessageId?: (key: {
    chatId: string
    threadId: number | undefined
    lane: string | undefined
    turnKey: string | undefined
  }) => number | null | undefined
  /**
   * True when the current chat is a private DM. Passed to the stream
   * controller so the DM throttle default (400 ms) is applied instead of
   * the group default (1000 ms) when no explicit throttleMs is set.
   */
  isPrivateChat?: boolean
  /**
   * True when the current chat is a forum topic.
   */
  isForumTopic?: boolean
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

function streamKey(
  chatId: string,
  threadId?: number,
  lane?: string,
  turnKey?: string,
): string {
  // Adopt the canonical chatKey() / chatKeyWithSuffix() primitives from
  // gateway/chat-key.ts (PR2 of supergroup mode — kills the previously
  // inlined copy of the key expression). The brand erases to string at
  // runtime, so callers using `streamKey` as a `Map<string, T>` key
  // continue to work unchanged.
  const base = lane != null && lane.length > 0
    ? chatKeyWithSuffix(chatId, threadId ?? null, lane)
    : chatKey(chatId, threadId ?? null)
  return turnKey != null && turnKey.length > 0 ? `${base}:${turnKey}` : base
}

export async function handleStreamReply(
  args: StreamReplyArgs,
  state: StreamReplyState,
  deps: StreamReplyDeps,
): Promise<StreamReplyResult> {
  const chat_id = args.chat_id
  let rawText = deps.normalizeParagraphBreaks
    ? deps.normalizeParagraphBreaks(deps.repairEscapedWhitespace(args.text))
    : deps.repairEscapedWhitespace(args.text)
  // Fleet-wide consistent formatting: dash/bullet normalization + over-bold
  // tripwire, same order as the reply/edit paths (after paragraph
  // normalization, before spacers). Both run on code-masked text internally.
  if (deps.normalizePunctuation) rawText = deps.normalizePunctuation(rawText)
  if (deps.stripExcessBold) rawText = deps.stripExcessBold(rawText)
  const done = Boolean(args.done)
  const format = args.format ?? deps.defaultFormat
  if (done) {
    process.stderr.write(`telegram channel: stream_reply: invoked done=true chatId=${chat_id} lane=${args.lane ?? 'default'} charCount=${rawText.length}\n`)
  }

  // Access check runs BEFORE any other branch: a denied chat id must
  // throw regardless of streaming mode. Previously the suppression path
  // silently "succeeded" for unauthorized chats.
  deps.assertAllowedChat(chat_id)
  const threadId = deps.resolveThreadId(chat_id, args.message_thread_id)

  // Note: caller-initiated stream_reply(done=false) used to be rejected
  // when the progress card was active. The card and the answer message
  // live on different lanes (progress vs default) and render different
  // content (tool structure vs model prose), so they don't actually
  // collide — the rejection forced single-shot final replies and broke
  // the progressive-streaming contract documented in
  // profiles/default/CLAUDE.md. See #481.

  // Single rich-markdown path (#2669). The only fork is the literal
  // `format:'text'` send (plain string, no markdown parsing); everything
  // else ships the raw GFM markdown via the rich-message path. No
  // markdown→HTML / MarkdownV2 rendering happens here anymore — the raw
  // text IS the wire payload.
  const literalText = format === 'text'
  // Paragraph-spacing fix (rich-message regression after #2669): inject a
  // visible blank-line spacer into prose `\n\n` gaps on the rich path so
  // multi-paragraph answers don't render jammed together. The literal
  // (`format:'text'`) path must stay byte-exact, so it is left untouched.
  let effectiveText: string =
    !literalText && deps.addParagraphSpacers ? deps.addParagraphSpacers(rawText) : rawText

  // Inline status-accent header (issue #320 fallback). Prepended so it
  // leads the body. Since stream_reply callers pass the full text snapshot
  // each call, the header is prepended on every call that supplies
  // `accent` — keeping the rendered message consistent across edits.
  // Callers that don't want the header on a subsequent edit simply omit
  // `accent`. Unrecognised values are silently ignored (empty string).
  if (args.accent != null) {
    const accentHeader = buildAccentHeader(args.accent)
    if (accentHeader.length > 0) {
      effectiveText = accentHeader + effectiveText
    }
  }

  // Over-limit pre-check. Throws BEFORE touching stream state so that
  // (a) a first call over the cap fails cleanly instead of creating a
  // half-initialized stream, and (b) a mid-stream update over the cap
  // fails loudly instead of setting the internal `stopped=true` flag
  // and silently dropping all subsequent text. Either way the caller
  // sees isError:true and can fall back to `reply`, which chunks.
  if (effectiveText.length > RICH_MESSAGE_MAX_CHARS) {
    throw new Error(
      `stream_reply rejected: text exceeds Telegram's ${RICH_MESSAGE_MAX_CHARS}-char rich-message limit ` +
        `(length=${effectiveText.length}, format=${format}). stream_reply does not ` +
        `auto-chunk — split the text or use \`reply\`, which chunks.`,
    )
  }

  const sKey = streamKey(chat_id, threadId, args.lane, args.turnKey)
  // Claim the PTY-preview slot so any PTY-tail partial that fires mid-
  // or post-turn for this chat+thread is dropped. Keyed WITHOUT lane
  // because the PTY handler uses the lane-less key and we need to
  // suppress its default lane regardless of which lane stream_reply
  // targets. Cleared on turn_end by server.ts.
  state.suppressPtyPreview?.add(streamKey(chat_id, threadId))
  let stream = state.activeDraftStreams.get(sKey)
  // #2669: there is now a single rendering mode (rich markdown), so the
  // legacy parseMode-rotation that finalized + recreated a stream whose
  // baked parseMode no longer matched is gone — every stream renders the
  // same way and can be reused as-is.

  const streamExisted = stream != null

  deps.logStreamingEvent({
    kind: 'stream_reply_called',
    chatId: chat_id,
    charCount: effectiveText.length,
    done,
    streamExisted,
  })

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

    // Idempotency hook (#626): if an external authority (e.g. the
    // gateway's pin manager) already knows the anchor message id for
    // this lane+turn, initialize the stream with it so the next update
    // edits in place rather than creating a fresh sendMessage. This
    // closes the "done=true → activeDraftStreams entry deleted → next
    // emit creates fresh sendMessage" path that produced multiple
    // status messages per turn.
    let initialMessageId: number | undefined
    if (deps.lookupExistingMessageId != null) {
      try {
        const looked = deps.lookupExistingMessageId({
          chatId: chat_id,
          threadId,
          lane: args.lane,
          turnKey: args.turnKey,
        })
        if (typeof looked === 'number' && Number.isFinite(looked)) {
          initialMessageId = looked
        }
      } catch (err) {
        deps.writeError(
          `telegram channel: stream_reply lookupExistingMessageId failed: ${err}\n`,
        )
      }
    }

    stream = createStreamController({
      bot: deps.bot,
      chatId: chat_id,
      threadId,
      literalText,
      disableLinkPreview: deps.disableLinkPreview,
      // Pass undefined when caller didn't override, so draft-stream's
      // DM/group throttle defaults apply (400 ms DMs, 1000 ms groups).
      ...(deps.throttleMs != null ? { throttleMs: deps.throttleMs } : {}),
      retry: deps.retry,
      ...(replyToMessageId != null ? { replyToMessageId } : {}),
      ...(args.quote_text != null && replyToMessageId != null ? { quoteText: args.quote_text } : {}),
      ...(args.protect_content === true ? { protectContent: true } : {}),
      ...(args.disable_notification === true ? { disableNotification: true } : {}),
      ...(args.reply_markup != null ? { replyMarkup: args.reply_markup } : {}),
      isPrivateChat: deps.isPrivateChat === true,
      ...(initialMessageId != null ? { initialMessageId } : {}),
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
          || msg.startsWith('stream → materialized')
        ) return
        deps.writeError(`telegram channel: stream_reply ${msg}\n`)
      },
      warn: (msg) => {
        deps.writeError(`telegram channel: stream_reply ${msg}\n`)
      },
    })
    state.activeDraftStreams.set(sKey, stream)
  }

  await stream.update(effectiveText)

  if (done) {
    await stream.finalize()
    state.activeDraftStreams.delete(sKey)
    // #1713: stream_reply done=true is a NON-EVENT for the status
    // reaction. The reaction reflects current turn activity, not
    // delivery state — only the `turn_end` IPC handler finalizes (👍).
    // Stream completion is "I'm done speaking", not "turn over"; the
    // model may continue with post-stream tool work. This is a
    // deliberate revert of the Bug Z fix (PR #602 follow-up) — see
    // the #1713 issue body for the rationale.

    // Hard-fail surface: if the stream finalized without ever assigning
    // a message id, the initial send never landed (over-cap text hits
    // draft-stream's length guard and silently stops). Throw so the MCP
    // caller sees isError:true instead of a misleading "finalized
    // (id: pending)". The caller can fall back to `reply`, which chunks.
    if (stream.getMessageId() == null) {
      throw new Error(
        `stream_reply finalized without sending any message (length=${rawText.length}, ` +
          `max=${RICH_MESSAGE_MAX_CHARS}). Telegram's rich-message limit is ${RICH_MESSAGE_MAX_CHARS} chars and ` +
          `stream_reply does not auto-chunk. Split the text or use \`reply\` (which chunks).`,
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

  const finalMessageId = stream.getMessageId()
  if (done) {
    process.stderr.write(`telegram channel: stream_reply: finalized done=true chatId=${chat_id} lane=${args.lane ?? 'default'} messageId=${finalMessageId ?? 'null'}\n`)
    const isDefaultLaneForCompletion = args.lane == null || args.lane.length === 0
    // Issue #310: record delivery BEFORE forceCompleteTurn so the
    // progress-card driver's outboundDeliveredCount is non-zero when the
    // terminal render fires. forceCompleteTurn synchronously flushes the
    // card; if we recorded after that flush, outboundDeliveredCount would
    // still be 0 at render time → ⚠️ false positive even though the
    // message landed. Only record when a messageId is confirmed — a null
    // id means the send never succeeded and the ⚠️ branch is correct.
    if (
      deps.recordOutboundDelivered != null
      && finalMessageId != null
      && isDefaultLaneForCompletion
    ) {
      try {
        deps.recordOutboundDelivered(chat_id, threadId)
      } catch (err) {
        deps.writeError(`telegram channel: stream_reply: recordOutboundDelivered hook threw: ${err}\n`)
      }
    }
    // Fire the authoritative turn-complete signal to the progress-card
    // driver so any in-flight card for this chat is closed out alongside
    // the final answer landing. Only for the default (unnamed) lane —
    // the progress lane is the driver's own emit path and routing
    // completion through it would re-enter the driver from within its
    // own flush. Idempotent on the driver side: first caller wins.
    if (deps.forceCompleteTurn != null && isDefaultLaneForCompletion) {
      try {
        deps.forceCompleteTurn(chat_id, threadId)
      } catch (err) {
        deps.writeError(`telegram channel: stream_reply: forceCompleteTurn hook threw: ${err}\n`)
      }
    }
  }
  return {
    messageId: finalMessageId,
    status: done ? 'finalized' : 'updated',
  }
}
