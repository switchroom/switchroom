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
import { SEND_GATE_SHED } from '../send-gate.js'

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

export class SendGateShedError extends Error {
  constructor(verb: string) {
    super(`STATUS_PIN_SEND_SHED: ${verb} was shed by the send gate and never reached Telegram`)
    this.name = 'SendGateShedError'
  }
}

/**
 * The pin state machine reads "the call did not throw" as "the pin/unpin
 * PAINTED": `reconcilePin` claims the message on a resolved pin and treats a
 * resolved unpin as landed (no orphan row, no retry). So a send that was
 * DROPPED but resolved success-shaped would corrupt that state — exactly the
 * bug shape review caught on #3631, where a dropped edit resolving ok made the
 * gate record a never-painted payload as on-screen and froze the card.
 *
 * Today that cannot happen: a pin/unpin is a SEND (no `messageId`/`editPayload`
 * opts), and untagged sends admit as `UNTAGGED_SEND_CLASS = 'critical'`
 * (send-gate.ts:119) — critical is never shed and never TTL-expired; it either
 * runs or throws a structured `FLOOD_WAIT_ACTIVE`. But that safety rests on a
 * DEFAULT in another module. This converts it into an enforced invariant: if a
 * pin/unpin ever resolves the gate's `SEND_GATE_SHED` sentinel, it becomes a
 * throw, so the driver reports `failed`, the store re-homes an orphan row and
 * the boot sweep finishes the job.
 *
 * Sentinel ONLY — `undefined` is deliberately NOT treated as a failure: the
 * gate also resolves `undefined` for a benign no-op drop, and conflating the
 * two is the ambiguity the sentinel was introduced to remove
 * (send-gate.ts:129-140).
 */
function assertLanded(result: unknown, verb: string): unknown {
  if (result === SEND_GATE_SHED) throw new SendGateShedError(verb)
  return result
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
      }).then((r) => assertLanded(r, 'status-pin.pin')),
    unpinChatMessage: (chat_id, message_id) =>
      robust(() => bot('status-pin.unpin').api.unpinChatMessage(chat_id, message_id), {
        chat_id: String(chat_id),
        verb: 'status-pin.unpin',
      }).then((r) => assertLanded(r, 'status-pin.unpin')),
  }
}
