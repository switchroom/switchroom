/**
 * stale-pin-sweep-wiring.ts — binds the pure stale-pin drain
 * (`stale-pin-sweep.ts`) to the gateway's world, without putting any of that
 * glue inside gateway.ts.
 *
 * The sweeper itself is deliberately dependency-free so its rate gates, its
 * circuit-breaker and its "never trust an `ok:true`" invariant are provable in
 * isolation. Everything it needs from the outside is a function. Assembling
 * those functions is mechanical, but it is ~70 lines of policy (which pins are
 * protected, what counts as pin rights, which env var unlocks the supergroup
 * loop) that belongs next to the drain rather than in the gateway's already
 * over-long module scope (switchroom#2996 anti-inflation ratchet).
 *
 * gateway.ts therefore supplies only the raw Bot API seam + the two live state
 * readers; the policy lives here and is unit-testable.
 */

import {
  createStalePinSweeper,
  unexpiredStoreRepinIds,
  type StalePinSweeper,
  type SweepStoreFsSeam,
} from './stale-pin-sweep.js'
import type { PersistedStatusPin } from './status-pin-store.js'
import type { StatusPinClaim } from './status-pin-retarget.js'

/**
 * The minimal Telegram surface the drain needs, expressed so the gateway hands
 * over only its bot handle and its retry wrapper. Building the seam HERE (not
 * in gateway.ts) keeps the four raw pin/unpin calls next to the comments that
 * justify them.
 */
export interface StalePinSweepBotSeam {
  /**
   * Live grammY-shaped handle. A getter, because `lockedBot` is assigned late
   * (inside `initGatewayBot`) and the sweep may outlive a rebind.
   *
   * Named `handle`, not `bot`: gateway.ts is statically scanned for
   * module-scope identifiers named `bot`/`lockedBot`
   * (`gateway-bot-construction-deferral.test.ts`, #2996 P0b), and a property
   * KEY called `bot` at module scope trips that guard even though the value is
   * a deferred arrow.
   */
  handle: () => {
    api: {
      getChat: (chatId: string) => Promise<unknown>
      pinChatMessage: (
        chatId: string,
        messageId: number,
        opts: { disable_notification: boolean },
      ) => Promise<unknown>
      unpinChatMessage: (chatId: string, messageId: number) => Promise<unknown>
      unpinAllForumTopicMessages: (chatId: string, threadId: number) => Promise<unknown>
    }
  }
  /** The gateway's retry/telemetry envelope (`robustApiCall`). */
  call: <T>(fn: () => Promise<T>, meta: { chat_id: string; verb: string }) => Promise<T>
}

export interface StalePinSweepWiring {
  telegram: StalePinSweepBotSeam
  /** Live in-memory status-pin claims (the single claim registry). */
  claims: () => Iterable<StatusPinClaim>
  /** Durable pin rows, read LIVE. Returns [] when persistence is off. Never
   *  throws — a read failure is logged by the caller and treated as []. */
  loadPinRows: () => PersistedStatusPin[]
  /** Mutex-won AND bot-constructed. False ⇒ the drain must not write. */
  eligible: () => boolean
  /**
   * The SHARED per-process pin-rights negative cache (status-pin.ts
   * `PinRightsCache`), unifying the sweep and the live status-pin path on which
   * chats are rights-less. Only `isBlocked`/`block` are used here; the live
   * path owns `clear` (on a successful explicit pin) and boot owns the reset.
   * Optional — undefined ⇒ the sweep relies purely on its reactive classifier.
   */
  rightsCache?: { isBlocked: (chatId: string) => boolean; block: (chatId: string) => boolean }
  store: { path: string; fs: SweepStoreFsSeam }
  /** Per-deployment override of `UNPIN_ALL_FORUM_TOPIC_ENABLED`; undefined =
   *  take the standing policy (the wholesale topic drain stays OFF). */
  allowUnpinAllForumTopic?: boolean
  log?: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Pins that must SURVIVE a drain of `chatId`: the live in-memory claims for
 * that chat, unioned with the deliberately-retained durable rows (an unexpired
 * `tool:` pin survives `statusPinBootCleanup` by design and must survive this
 * too).
 *
 * Read from BOTH sources because neither alone is complete at both call sites:
 * during the boot sweep the in-memory maps are still empty, and during a later
 * first-inbound sweep the store may lag a claim taken this session.
 */
export function protectedPinIds(args: {
  chatId: string
  claims: Iterable<StatusPinClaim>
  loadPinRows: () => PersistedStatusPin[]
  now: number
  log: (line: string) => void
}): number[] {
  const ids: number[] = []
  for (const claim of args.claims) {
    if (claim.chatId === args.chatId) ids.push(claim.messageId)
  }
  try {
    ids.push(...unexpiredStoreRepinIds(args.loadPinRows(), args.chatId, args.now))
  } catch (err) {
    args.log(
      `telegram gateway: stale-pin-sweep: store repin scan failed ` +
        `(chat=${args.chatId}): ${(err as Error).message}\n`,
    )
  }
  return ids
}

/**
 * The message ids the gateway is ON RECORD as having pinned in one
 * `(chat, thread)` target — the only ids the group drain is allowed to unpin.
 *
 * Matched on the FULL target key, not the chat alone: the pin stack is
 * chat-wide, but the obligation is per topic, and unpinning another topic's
 * recorded pin while sweeping this one would clear a card that is still live.
 */
export function recordedPinIdsFor(
  rows: readonly PersistedStatusPin[],
  chatId: string,
  threadId?: number,
): number[] {
  const out: number[] = []
  for (const r of rows) {
    if (r.chatId !== chatId) continue
    if ((r.threadId ?? undefined) !== threadId) continue
    if (typeof r.messageId === 'number' && !out.includes(r.messageId)) out.push(r.messageId)
  }
  return out
}

/** Assemble the gateway's stale-pin sweeper. */
export function createGatewayStalePinSweeper(w: StalePinSweepWiring): StalePinSweeper {
  const log = w.log ?? ((line: string) => process.stderr.write(line))
  const now = w.now ?? Date.now
  const { handle: bot, call } = w.telegram
  return createStalePinSweeper({
    getTopPinnedMessageId: async (chatId) => {
      const chat = (await call(() => bot().api.getChat(chatId), {
        chat_id: chatId,
        verb: 'stale-pin-sweep.get-chat',
      })) as { pinned_message?: { message_id?: number } } | undefined
      return chat?.pinned_message?.message_id ?? null
    },
    // The RE-PIN half of the only sequence that actually pops a stack entry (a
    // bare unpin on a stale entry is a silent no-op). An orphan pin has no
    // claim to reconcile through, so the unified path cannot express it.
    pinSilent: (chatId, messageId) =>
      call(
        // allow-raw-pin: orphan repin — see above. allow-raw-bot-api: already
        // inside the gateway's robustApiCall envelope.
        () => bot().api.pinChatMessage(chatId, messageId, { disable_notification: true }),
        { chat_id: chatId, verb: 'stale-pin-sweep.repin' },
      ),
    // The UNPIN half of the pop. Its result is deliberately ignored — ok:true
    // proves nothing; progress is read back from getChat.
    unpin: (chatId, messageId) =>
      call(
        // allow-raw-pin: orphan unpin — see above. allow-raw-bot-api: already
        // inside the gateway's robustApiCall envelope.
        () => bot().api.unpinChatMessage(chatId, messageId),
        { chat_id: chatId, verb: 'stale-pin-sweep.unpin' },
      ),
    unpinAllForumTopicMessages: (chatId, threadId) =>
      call(() => bot().api.unpinAllForumTopicMessages(chatId, threadId), {
        chat_id: chatId,
        verb: 'stale-pin-sweep.unpin-all-topic',
      }),
    // No proactive rights precheck. The old `getChatMember` precheck read
    // `bot().botInfo?.id`, but the sweep runs against the chat-lock-wrapped bot
    // (`wrapBot({ api: bot.api })`), which carries only `.api` — `.botInfo` was
    // always undefined, so `self` was always null and every group precheck
    // returned false, forfeiting every group cursor without a single unpin. The
    // sweep now relies SOLELY on its reactive classifier: it attempts the unpin
    // and classifies Telegram's honest `400 "not enough rights"` via
    // `isPinRightsError`. Telegram is authoritative about pin rights; a precheck
    // could only ever be redundant with (and, wired against the wrong bot,
    // wrong about) that answer.
    recordedPinIds: (chatId, threadId) => {
      try {
        return recordedPinIdsFor(w.loadPinRows(), chatId, threadId)
      } catch (err) {
        log(
          `telegram gateway: stale-pin-sweep: recorded-pin scan failed ` +
            `(chat=${chatId}): ${(err as Error).message}\n`,
        )
        return []
      }
    },
    protectedMessageIds: (chatId) =>
      protectedPinIds({
        chatId,
        claims: w.claims(),
        loadPinRows: w.loadPinRows,
        now: now(),
        log,
      }),
    eligible: w.eligible,
    rightsBlocked: w.rightsCache ? (chatId) => w.rightsCache!.isBlocked(chatId) : undefined,
    recordRightsBlock: w.rightsCache
      ? (chatId) => {
          w.rightsCache!.block(chatId)
        }
      : undefined,
    sleep: w.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now,
    store: w.store,
    // Passed through UNCOERCED: undefined means "take the standing policy"
    // (UNPIN_ALL_FORUM_TOPIC_ENABLED), not the same as an explicit false.
    allowUnpinAllForumTopic: w.allowUnpinAllForumTopic,
    log,
  })
}
