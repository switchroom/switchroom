/**
 * Thin integration layer between `createDraftStream` and grammy's `bot.api`.
 *
 * Deduplicates the send/edit closure wiring that previously lived inline in
 * two places in server.ts:
 *   - the `stream_reply` MCP case block (model-driven streaming)
 *   - `handlePtyPartial` (PTY-tail TUI extractor → live preview)
 *
 * Both paths do the same thing: given a chat/thread/parseMode, create a
 * draft stream whose `send` closure calls `bot.api.sendMessage` and whose
 * `edit` closure calls `bot.api.editMessageText`, both wrapped in the
 * shared retry/429/not-modified policy (`robustApiCall`).
 *
 * This module exists primarily so that wiring can be exercised by
 * integration tests against a mock bot.api, without having to mock the
 * entire server.ts top-level initialization.
 */

import { createDraftStream, type DraftStreamHandle, type StreamDraftFn } from './draft-stream.js'

/**
 * Minimal bot.api surface the controller needs. Real callers pass grammy's
 * `bot.api`; tests pass a mock with just these two methods.
 */
export interface StreamBotApi {
  sendMessage(
    chat_id: string,
    text: string,
    opts: StreamSendOpts,
  ): Promise<{ message_id: number }>
  editMessageText(
    chat_id: string,
    message_id: number,
    text: string,
    opts: StreamSendOpts,
  ): Promise<unknown>
}

export interface StreamSendOpts {
  parse_mode?: 'HTML' | 'MarkdownV2'
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
}

export type RetryPolicy = <T>(
  fn: () => Promise<T>,
  opts?: { threadId?: number; chat_id?: string },
) => Promise<T>

export interface StreamControllerConfig {
  bot: { api: StreamBotApi }
  chatId: string
  threadId?: number
  parseMode?: 'HTML' | 'MarkdownV2'
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
   * Optional warning logger. Used for transport fallback notices.
   */
  warn?: (msg: string) => void
  /**
   * Transport selector passed to createDraftStream.
   * - "auto" (default): use draft transport for DMs only
   * - "draft": always prefer draft (if sendMessageDraft is available)
   * - "message": always use sendMessage/editMessageText
   *
   * The gateway forces "message" for forum topics (threads), since
   * sendMessageDraft does not support threaded chats.
   */
  previewTransport?: 'auto' | 'message' | 'draft'
  /**
   * True when the chat is a private DM. Passed to createDraftStream so
   * "auto" transport knows whether to activate draft.
   */
  isPrivateChat?: boolean
  /**
   * sendMessageDraft callback. When provided (and transport allows it),
   * intermediate stream updates use the draft API. On finalize(), a real
   * sendMessage is posted for push notification and the draft is cleared.
   */
  sendMessageDraft?: StreamDraftFn
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
    parseMode,
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
    previewTransport,
    isPrivateChat,
    sendMessageDraft,
  } = cfg

  // Base opts shared by send + edit. The initial send adds reply_parameters
  // and protect_content on top (see below); edits must NOT carry those —
  // Telegram's editMessageText rejects them.
  const baseOpts: StreamSendOpts = {
    ...(parseMode ? { parse_mode: parseMode } : {}),
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
  }

  return createDraftStream(
    async (text) => {
      const sent = await retry(
        () => bot.api.sendMessage(chatId, text, sendOpts),
        { threadId, chat_id: chatId },
      )
      onSend?.(sent.message_id, text.length)
      return sent.message_id
    },
    async (id, text) => {
      await retry(
        () => bot.api.editMessageText(chatId, id, text, baseOpts),
        { threadId, chat_id: chatId },
      )
      onEdit?.(id, text.length)
    },
    {
      ...(throttleMs != null ? { throttleMs } : {}),
      ...(idleMs != null ? { idleMs } : {}),
      ...(log != null ? { log } : {}),
      ...(warn != null ? { warn } : {}),
      ...(previewTransport != null ? { previewTransport } : {}),
      ...(isPrivateChat != null ? { isPrivateChat } : {}),
      ...(sendMessageDraft != null ? { sendMessageDraft } : {}),
      chatId,
    },
  )
}
