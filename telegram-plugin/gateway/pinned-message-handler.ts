/**
 * `message:pinned_message` service-message cleanup (switchroom#2996 P6 cluster F).
 *
 * Suppresses the "pinned a message" service message Telegram inserts when OUR
 * silent status-pin fires. The pin call passes `disable_notification: true`,
 * which kills the PUSH notification but NOT the in-chat service message — so we
 * delete that service message as it lands, but ONLY for pins we own (tracked in
 * `statusPinClaims`). Manual/operator pins are never silent and are never
 * touched. Only silent status pins reach here as an OUR-pin match, so the
 * ownership check is the guard.
 *
 * The registration line stays in gateway.ts (order is a load-bearing invariant
 * pinned by gateway-handler-registration-wiring.test.ts) and delegates here.
 *
 * DI note (check-bot-api-wrapping): the actual `lockedBot.api.deleteMessage`
 * call is NOT made here — it is injected as `deleteServiceMessage`, bound in
 * gateway.ts inside a `robustApiCall(...)` wrapper. This keeps the raw
 * `lockedBot.api.*` callsite in gateway.ts (already inside the retry policy)
 * and leaves this module with no raw Bot API site to allowlist.
 */

import type { Context, Filter } from 'grammy'
import { pinnedMessageIsOurs, type TrackedStatusPin } from './status-pin-store.js'
import type { StatusPinClaim } from './status-pin-retarget.js'

export interface PinnedMessageHandlerDeps {
  /** Live pinKey→claim registry of pins we own. ONE record per key (#3809):
   *  the chat id is a field of the claim, not a parallel map that can diverge. */
  statusPinClaims: ReadonlyMap<string, StatusPinClaim>
  /**
   * Delete the pin service message. Bound in gateway.ts through
   * `robustApiCall(() => lockedBot.api.deleteMessage(...))` so the raw Bot API
   * call stays inside the retry policy. Rethrows on failure (the caller logs).
   */
  deleteServiceMessage: (chatId: string, messageId: number) => Promise<void>
  /** stderr log sink. */
  log: (line: string) => void
}

export async function handlePinnedMessage(
  ctx: Filter<Context, 'message:pinned_message'>,
  deps: PinnedMessageHandlerDeps,
): Promise<void> {
  const pinnedId = ctx.msg.pinned_message?.message_id
  if (pinnedId == null) return
  const chatId = String(ctx.chat.id)
  const serviceMsgId = ctx.msg.message_id

  // Chat-scoped ownership (see pinnedMessageIsOurs): the match requires BOTH
  // the messageId AND that the tracked entry lives in THIS chat, so a pin id
  // colliding across chats can't delete a foreign (e.g. operator-manual) pin
  // notice. Each claim carries its own chat id (#3809), so the match can never
  // silently degrade to messageId-only because a companion map went missing.
  const trackedPins = (): TrackedStatusPin[] =>
    [...deps.statusPinClaims.values()].map((c) => ({
      chatId: c.chatId,
      messageId: c.messageId,
    }))
  const isOurs = () => pinnedMessageIsOurs(trackedPins(), chatId, pinnedId)

  if (!isOurs()) {
    // Tolerate the reconcile-store race: wait briefly, then re-check once.
    await new Promise(resolve => setTimeout(resolve, 250))
    if (!isOurs()) return
  }

  try {
    await deps.deleteServiceMessage(chatId, serviceMsgId)
  } catch (err) {
    // Best-effort: a failure to delete the service message is cosmetic only —
    // the "pinned a message" line just stays. The most likely cause in a
    // supergroup/forum is the bot lacking can_delete_messages admin right, so
    // surface a concise one-liner (robustApiCall rethrows this case without
    // logging a reason) rather than swallowing silently — an operator sees WHY.
    const msg = err instanceof Error ? err.message : String(err)
    deps.log(
      `telegram gateway: status-pin: could not delete pin service message ` +
        `(chat=${chatId} msg=${serviceMsgId}) — likely missing can_delete_messages ` +
        `admin right in this chat: ${msg}\n`,
    )
  }
}
