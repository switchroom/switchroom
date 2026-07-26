/**
 * The Bot API surface the status-pin driver needs, bound to the gateway's
 * retry policy (#3634 — extracted from gateway.ts, which is under a line
 * ratchet).
 *
 * `lockedBot` in gateway.ts is declared `let lockedBot!: Bot<Context>`: the
 * definite-assignment `!` is an ASSERTION, not a guarantee, and it hid from
 * tsc that anything running at module-eval time dereferences `undefined`. The
 * boot orphan-pin sweep did exactly that for months — every unpin it issued
 * failed with the opaque `undefined is not an object (evaluating
 * 'lockedBot.api')`, so no orphaned pin was ever cleaned up and finished
 * activity cards stayed pinned forever.
 *
 * The ordering fix is the `gatewayBotReady` latch (see boot-pin-sweep.ts).
 * `assertBotReady` is the backstop: any FUTURE pre-ready caller gets a NAMED,
 * greppable error instead of something that reads like a Telegram failure.
 */

import type { PinBotApi } from '../status-pin-driver.js'

export class BotNotReadyError extends Error {
  constructor(what: string) {
    super(
      `STATUS_PIN_BOT_NOT_READY: ${what} used before initGatewayBot() assigned ` +
        `lockedBot — await gatewayBotReady.ready first`,
    )
    this.name = 'BotNotReadyError'
  }
}

export function assertBotReady<T>(bot: T | undefined | null, what: string): T {
  if (bot == null) throw new BotNotReadyError(what)
  return bot
}

/** Minimal shape of the wrapped bot this module needs. */
export interface PinCapableBot {
  api: {
    pinChatMessage: (
      chatId: string | number,
      messageId: number,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>
    unpinChatMessage: (
      chatId: string | number,
      messageId: number,
    ) => Promise<unknown>
  }
}

/**
 * Build the pin API. `getBot` is read LAZILY on every call (the gateway's
 * `lockedBot` is assigned late), and `robust` is the gateway's
 * `robustApiCall` so pins/unpins ride the send gate and retry policy exactly
 * as before this extraction.
 */
export function createStatusPinApi(
  getBot: () => PinCapableBot | undefined,
  robust: (fn: () => Promise<unknown>, opts: Record<string, unknown>) => Promise<unknown>,
): PinBotApi {
  const bot = (what: string) => assertBotReady(getBot(), what)
  return {
    pinChatMessage: (chat_id, message_id, opts) =>
      robust(() => bot('status-pin.pin').api.pinChatMessage(chat_id, message_id, opts), {
        chat_id: String(chat_id),
        verb: 'status-pin.pin',
      }),
    unpinChatMessage: (chat_id, message_id) =>
      robust(() => bot('status-pin.unpin').api.unpinChatMessage(chat_id, message_id), {
        chat_id: String(chat_id),
        verb: 'status-pin.unpin',
      }),
  }
}
