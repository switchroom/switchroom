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

import { createDraftStream, type DraftStreamHandle } from './draft-stream.js'

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
  } = cfg

  const sendOpts: StreamSendOpts = {
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
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
        () => bot.api.editMessageText(chatId, id, text, sendOpts),
        { threadId, chat_id: chatId },
      )
      onEdit?.(id, text.length)
    },
    {
      ...(throttleMs != null ? { throttleMs } : {}),
      ...(idleMs != null ? { idleMs } : {}),
      ...(log != null ? { log } : {}),
    },
  )
}
