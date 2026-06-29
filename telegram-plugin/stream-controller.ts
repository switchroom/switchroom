/**
 * Thin integration layer between `createDraftStream` and grammy's `bot.api`.
 *
 * Deduplicates the send/edit closure wiring that previously lived inline in
 * two places in server.ts:
 *   - the `stream_reply` MCP case block (model-driven streaming)
 *   - `handlePtyPartial` (PTY-tail TUI extractor → live preview)
 *
 * Both paths do the same thing: given a chat/thread, create a draft stream
 * whose `send` closure first calls `bot.api.sendRichMessage` and whose
 * `edit` closure calls `bot.api.editMessageText({ markdown })`, both wrapped
 * in the shared retry/429/not-modified policy (`robustApiCall`). Because
 * send and edit share the same opts, the "edit-rich-if-sent-rich" invariant
 * holds automatically (#2669). A `format:'text'` literal stream bypasses the
 * rich parser entirely (plain `sendMessage` / plain-string `editMessageText`).
 *
 * This module exists primarily so that wiring can be exercised by
 * integration tests against a mock bot.api, without having to mock the
 * entire server.ts top-level initialization.
 */

import { createDraftStream, type DraftStreamHandle } from './draft-stream.js'
import { richMessage, isParseEntitiesError } from './rich-send.js'

/**
 * Minimal bot.api surface the controller needs. Real callers pass grammy's
 * `bot.api`; tests pass a mock with these methods.
 */
export interface StreamBotApi {
  sendMessage(
    chat_id: string,
    text: string,
    opts: StreamSendOpts,
  ): Promise<{ message_id: number }>
  sendRichMessage(
    chat_id: string,
    rich_message: { markdown: string },
    opts: StreamSendOpts,
  ): Promise<{ message_id: number }>
  editMessageText(
    chat_id: string,
    message_id: number,
    text: string | { markdown: string },
    opts: StreamSendOpts,
  ): Promise<unknown>
}

export interface StreamSendOpts {
  message_thread_id?: number
  link_preview_options?: { is_disabled: boolean }
  /**
   * Telegram's reply_parameters, used for quote-replying to an earlier
   * message. Only meaningful on the initial `sendMessage` — `editMessageText`
   * cannot add a quote reference to an existing message, so the controller
   * strips this from edit opts internally.
   */
  reply_parameters?: { message_id: number; quote?: { text: string; position: number } }
  /**
   * Inline keyboard markup. Included in both sendMessage and editMessageText
   * so that inline buttons persist through text edits. Without this,
   * editMessageText strips any previously attached keyboard.
   */
  reply_markup?: unknown
  /**
   * When true, Telegram prevents the message from being forwarded or saved.
   * Only meaningful on the initial `sendMessage` — `editMessageText` does not
   * accept this parameter, so the controller omits it from edit opts.
   */
  protect_content?: boolean
  /**
   * When true, the initial `sendMessage` is silent (no device ping).
   * Has no effect on `editMessageText` — Telegram never pings on edits.
   * Used by mid-turn `stream_reply` calls under the #1122 conversational
   * pacing redesign so only the final answer pings.
   */
  disable_notification?: boolean
}

export type RetryPolicy = <T>(
  fn: () => Promise<T>,
  opts?: { threadId?: number; chat_id?: string },
) => Promise<T>

export interface StreamControllerConfig {
  bot: { api: StreamBotApi }
  chatId: string
  threadId?: number
  /**
   * When true, this stream is a literal `format:'text'` send: the body
   * bypasses the rich-markdown parser entirely (plain `sendMessage` /
   * plain-string `editMessageText`). Default (false/undefined) → the
   * rich-markdown path via `sendRichMessage` / `editMessageText({ markdown })`.
   */
  literalText?: boolean
  disableLinkPreview?: boolean
  /**
   * Optional quote-reply target. When set, the initial send attaches
   * `reply_parameters: { message_id: replyToMessageId }` so the first
   * streamed message quote-threads under the referenced message. Edits
   * don't include it (Telegram rejects reply_parameters on edit).
   */
  replyToMessageId?: number
  /**
   * Optional quote text for surgical quoting. When set along with
   * `replyToMessageId`, the initial send includes
   * `reply_parameters: { message_id, quote: { text, position: 0 } }`.
   */
  quoteText?: string
  /**
   * When true, Telegram prevents the message from being forwarded or saved.
   * Applied on the initial `sendMessage` only — editMessageText does not
   * accept protect_content.
   */
  protectContent?: boolean
  /**
   * When true, the initial `sendMessage` is silent (no device ping).
   * editMessageText never pings regardless. Default false. #1122.
   */
  disableNotification?: boolean
  /**
   * Inline keyboard markup attached to every send and edit. Without this,
   * editMessageText strips any previously attached keyboard. The progress-
   * card driver passes the Steer button here so it persists through edits.
   */
  replyMarkup?: unknown
  throttleMs?: number
  /** Pre-send idle debounce. See DraftStreamConfig.idleMs. */
  idleMs?: number
  /**
   * Retry wrapper around bot.api calls. Defaults to calling `fn` directly
   * (no retry) so tests that don't care about policy can omit it. In
   * production, pass server.ts's `robustApiCall`.
   */
  retry?: RetryPolicy
  /** Observers — fire after each successful send/edit. Optional. */
  onSend?: (messageId: number, chars: number) => void
  onEdit?: (messageId: number, chars: number) => void
  /**
   * Optional diagnostic logger. Receives the draft-stream's internal
   * status lines (edit-failed, not-modified, re-sending, finalize).
   * When omitted, those lines are dropped — which is what the plugin
   * did for its entire history, silently hiding transient edit errors.
   * Pass a stderr writer in production to surface them.
   */
  log?: (msg: string) => void
  /**
   * Optional warning logger. Used for fallback notices.
   */
  warn?: (msg: string) => void
  /**
   * True when the chat is a private DM. Passed to createDraftStream so
   * the throttle default (400 ms for DMs vs 1000 ms for groups) is applied
   * correctly when no explicit throttleMs is set.
   */
  isPrivateChat?: boolean
  /**
   * If set, the controller is initialized as if a previous send had
   * landed with this `message_id`. The first `update()` invokes
   * `editMessageText` against this id rather than `sendMessage`.
   * Threads through to `createDraftStream`'s `initialMessageId`. Used
   * by callers that know the anchor message id from an external source
   * (e.g. the gateway's pin manager) to guarantee subsequent emits
   * edit in place rather than create a fresh sendMessage. Closes the
   * "done=true → activeDraftStreams entry deleted → next emit creates
   * fresh sendMessage" duplicate-message class (issue #626).
   */
  initialMessageId?: number | null
}

/**
 * Build a draft stream that writes to Telegram via `bot.api`.
 *
 * The returned handle is the standard `DraftStreamHandle` contract:
 * `update(text)`, `finalize()`, `getMessageId()`, `isFinal()`.
 */
export function createStreamController(cfg: StreamControllerConfig): DraftStreamHandle {
  const {
    bot,
    chatId,
    threadId,
    literalText = false,
    disableLinkPreview = true,
    throttleMs,
    idleMs,
    retry = <T>(fn: () => Promise<T>) => fn(),
    onSend,
    onEdit,
    log,
    warn,
    replyToMessageId,
    quoteText,
    protectContent,
    replyMarkup,
    isPrivateChat,
    initialMessageId,
  } = cfg

  // Base opts shared by send + edit. The initial send adds reply_parameters
  // and protect_content on top (see below); edits must NOT carry those —
  // Telegram's editMessageText rejects them. Both send and edit share these
  // opts, so a rich send is always followed by a rich edit (#2669 invariant).
  const baseOpts: StreamSendOpts = {
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
    ...(replyMarkup != null ? { reply_markup: replyMarkup } : {}),
  }
  const sendOpts: StreamSendOpts = {
    ...baseOpts,
    ...(replyToMessageId != null
      ? {
          reply_parameters: {
            message_id: replyToMessageId,
            ...(quoteText != null ? { quote: { text: quoteText, position: 0 } } : {}),
          },
        }
      : {}),
    ...(protectContent === true ? { protect_content: true } : {}),
    ...(cfg.disableNotification === true ? { disable_notification: true } : {}),
  }

  // Send the body via the rich-markdown path, unless this is a literal
  // `format:'text'` stream (plain sendMessage, no rich wrapper).
  // sendRichMessage does NOT accept link_preview_options (rich messages
  // control previews via entity detection), so strip it for the rich path.
  const doSend = (text: string, opts: StreamSendOpts) => {
    if (literalText) return bot.api.sendMessage(chatId, text, opts)
    const richOpts = { ...opts }
    delete richOpts.link_preview_options
    return bot.api.sendRichMessage(chatId, richMessage(text), richOpts)
  }
  const doEdit = (id: number, text: string, opts: StreamSendOpts) =>
    bot.api.editMessageText(chatId, id, literalText ? text : richMessage(text), opts)

  return createDraftStream(
    async (text) => {
      try {
        const sent = await retry(
          () => doSend(text, sendOpts),
          { threadId, chat_id: chatId },
        )
        onSend?.(sent.message_id, text.length)
        return sent.message_id
      } catch (err) {
        if (!literalText && isParseEntitiesError(err)) {
          // First send rejected because the markdown couldn't be parsed.
          // There is no message_id to edit (the send 400'd before any
          // message was created), so a single fresh send as PLAIN text
          // (no rich wrapper, so the parser never runs) is the correct
          // recovery — see issue #657. The raw markdown source is itself
          // readable, so we send it verbatim.
          warn?.(
            `stream-controller: send parse-entities rejected — retrying once as plain text (${err instanceof Error ? err.message : String(err)})`,
          )
          const sent = await retry(
            () => bot.api.sendMessage(chatId, text, sendOpts),
            { threadId, chat_id: chatId },
          )
          onSend?.(sent.message_id, text.length)
          return sent.message_id
        }
        throw err
      }
    },
    async (id, text) => {
      try {
        await retry(
          () => doEdit(id, text, baseOpts),
          { threadId, chat_id: chatId },
        )
        onEdit?.(id, text.length)
      } catch (err) {
        if (!literalText && isParseEntitiesError(err)) {
          // Edit rejected because the markdown couldn't be parsed — DO NOT
          // send a fresh message. The whole point of issue #657 is that the
          // previous implementation sent a duplicate message every time a
          // parse rejection fired. Retry the edit on the SAME message_id as
          // PLAIN text (no rich wrapper, so the parser never runs). The raw
          // markdown source is itself readable, so we send it verbatim.
          warn?.(
            `stream-controller: edit parse-entities rejected — retrying same id=${id} as plain text (${err instanceof Error ? err.message : String(err)})`,
          )
          await retry(
            () => bot.api.editMessageText(chatId, id, text, baseOpts),
            { threadId, chat_id: chatId },
          )
          onEdit?.(id, text.length)
          return
        }
        throw err
      }
    },
    {
      ...(throttleMs != null ? { throttleMs } : {}),
      ...(idleMs != null ? { idleMs } : {}),
      ...(log != null ? { log } : {}),
      ...(warn != null ? { warn } : {}),
      ...(isPrivateChat != null ? { isPrivateChat } : {}),
      ...(initialMessageId != null ? { initialMessageId } : {}),
      chatId,
    },
  )
}
