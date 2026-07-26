/**
 * status-pin-api.ts — the Bot API surface the status-pin driver calls, bound to
 * the gateway's retry policy + send gate (#3664).
 *
 * Extracted out of `gateway.ts` (which is under a line ratchet,
 * `scripts/check-gateway-line-ratchet.mjs`) so the two invariants below can be
 * enforced in code and proven in isolation, instead of resting on defaults that
 * live in other modules.
 *
 * INVARIANT 1 — the bot must exist (`assertBotReady`).
 * `lockedBot` in gateway.ts is declared `let lockedBot!: Bot<Context>`. The
 * definite-assignment `!` is an ASSERTION, not a guarantee: it told `tsc` to
 * stop checking, which is exactly why the boot orphan sweep dereferencing an
 * unset `lockedBot` at module-eval time compiled clean and shipped. Every unpin
 * it issued failed with the opaque
 * `undefined is not an object (evaluating 'lockedBot.api')`, which read like a
 * Telegram fault for a month. The ordering FIX is the two-condition gate in
 * `boot-sweep-gate.ts`; this is the BACKSTOP, so any future pre-ready caller
 * gets a named, greppable `STATUS_PIN_BOT_NOT_READY` instead.
 *
 * INVARIANT 2 — a shed send must not look like a landed one (`assertLanded`).
 * See the docblock on `assertLanded`.
 */

import type { PinBotApi } from '../status-pin-driver.js'
import { SEND_GATE_SHED } from '../send-gate.js'

/** Thrown when the pin API is used before `lockedBot` has been assigned. */
export class BotNotReadyError extends Error {
  constructor(what: string) {
    super(
      `STATUS_PIN_BOT_NOT_READY: ${what} used before initGatewayBot() assigned ` +
        `lockedBot — the boot sweep must run behind the boot-sweep gate`,
    )
    this.name = 'BotNotReadyError'
  }
}

/** Narrow `bot` to non-null or throw {@link BotNotReadyError}. */
export function assertBotReady<T>(bot: T | undefined | null, what: string): T {
  if (bot == null) throw new BotNotReadyError(what)
  return bot
}

/** Thrown when the outbound send gate SHED a pin/unpin — it never reached Telegram. */
export class SendGateShedError extends Error {
  constructor(verb: string) {
    super(`STATUS_PIN_SEND_SHED: ${verb} was shed by the send gate and never reached Telegram`)
    this.name = 'SendGateShedError'
  }
}

/**
 * Convert a send-gate SHED into a throw.
 *
 * The pin state machine reads "the call did not throw" as "the pin/unpin
 * LANDED": `reconcilePin` claims the message on a resolved pin, and treats a
 * resolved unpin as confirmed — dropping the in-memory claim AND (via the null
 * branch of `reconcileAndPersistStatusPin`) the durable `status-pins.json` row.
 * A send that was DROPPED but resolved success-shaped therefore reopens #3664
 * Defect B through a second door: the still-pinned message loses its last
 * record and no reaper or boot sweep can ever find it again.
 *
 * `robustApiCall` does not throw on a shed — it RESOLVES the gate's
 * `SEND_GATE_SHED` sentinel (send-gate.ts). Today a status-pin call
 * cannot be shed, because it is an untagged SEND and untagged sends admit as
 * `UNTAGGED_SEND_CLASS`, which is `'critical'` and is never shed.
 * But that is a DEFAULT IN ANOTHER MODULE: tagging `status-pin.unpin` with a
 * `priorityClass`, or changing that default, would silently reopen the defect
 * with no test failing. This turns the default into an enforced invariant.
 *
 * Sentinel ONLY. A plain `undefined` is deliberately NOT a failure: the gate
 * also resolves `undefined` for a benign no-op drop (identical payload already
 * on screen) and the retry policy resolves `undefined` for swallowed benign
 * 400s. Conflating those with a shed is the exact ambiguity `SEND_GATE_SHED`
 * was introduced to remove (see its docblock in send-gate.ts).
 *
 * Known residual: a `useful`-classed send whose queue TTL EXPIRES also resolves
 * `undefined` (`send-gate.ts`, `outcome.result === 'expired'`) and so is not
 * caught here. That is unreachable for status pins — they are untagged, hence
 * `critical`, which is never TTL-dropped — and closing it would mean treating
 * every benign `undefined` as a failure, which is strictly worse. If a status
 * pin is ever deliberately tagged `useful`, this needs a distinguishable
 * expiry sentinel too.
 */
export function assertLanded(result: unknown, verb: string): unknown {
  if (result === SEND_GATE_SHED) throw new SendGateShedError(verb)
  return result
}

/** Minimal shape of the wrapped gateway bot this module needs. */
export interface PinCapableBot {
  api: {
    pinChatMessage: (
      chatId: string | number,
      messageId: number,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>
    unpinChatMessage: (chatId: string | number, messageId: number) => Promise<unknown>
  }
}

/**
 * The gateway's `robustApiCall` seam (retry policy + send gate), erased to the
 * shape this module needs so `gateway.ts` can pass it with a single cast.
 */
export type RobustApiSeam = (
  fn: () => Promise<unknown>,
  opts: Record<string, unknown>,
) => Promise<unknown>

/**
 * Build the pin API.
 *
 * `getBot` is read LAZILY on every call — `lockedBot` is assigned late, inside
 * `initGatewayBot()` — and asserted non-null (INVARIANT 1). `robust` is the
 * gateway's `robustApiCall`, so pins/unpins ride the send gate and retry policy
 * exactly as before this extraction, with the shed sentinel converted to a
 * throw on the way out (INVARIANT 2).
 */
export function createStatusPinApi(
  getBot: () => PinCapableBot | undefined,
  robust: RobustApiSeam,
): PinBotApi {
  const call = (verb: string, fn: (bot: PinCapableBot) => Promise<unknown>, chatId: string) =>
    robust(() => fn(assertBotReady(getBot(), verb)), { chat_id: chatId, verb }).then((r) =>
      assertLanded(r, verb),
    )
  return {
    pinChatMessage: (chat_id, message_id, opts) =>
      call(
        'status-pin.pin',
        // allow-raw-bot-api: `call` runs this inside the injected `robust` seam (robustApiCall).
        (bot) => bot.api.pinChatMessage(chat_id, message_id, opts),
        String(chat_id),
      ),
    unpinChatMessage: (chat_id, message_id) =>
      call(
        'status-pin.unpin',
        // allow-raw-bot-api: as above — wrapped by the injected `robust` seam.
        (bot) => bot.api.unpinChatMessage(chat_id, message_id),
        String(chat_id),
      ),
  }
}
