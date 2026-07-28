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
      getChatMember: (chatId: string, userId: number) => Promise<unknown>
    }
    botInfo?: { id?: number }
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
  store: { path: string; fs: SweepStoreFsSeam }
  /** Per-deployment override of `SUPERGROUP_REPIN_UNATTENDED`; undefined =
   *  take the standing policy. */
  allowSupergroupRepinLoop?: boolean
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
    pinSilent: (chatId, messageId) =>
      call(
        () =>
          // allow-raw-pin: the RE-PIN half of the only sequence that actually
          // pops a stack entry (a bare unpin on a stale entry is a silent
          // no-op). An orphan pin has no claim to reconcile through.
          // allow-raw-bot-api: already inside the gateway's robustApiCall envelope.
          bot().api.pinChatMessage(chatId, messageId, { disable_notification: true }),
        { chat_id: chatId, verb: 'stale-pin-sweep.repin' },
      ),
    unpin: (chatId, messageId) =>
      call(
        // allow-raw-pin: the UNPIN half of the pop. Its result is deliberately
        // ignored — ok:true proves nothing; progress is read back from getChat.
        // allow-raw-bot-api: already inside the gateway's robustApiCall envelope.
        () => bot().api.unpinChatMessage(chatId, messageId),
        { chat_id: chatId, verb: 'stale-pin-sweep.unpin' },
      ),
    unpinAllForumTopicMessages: (chatId, threadId) =>
      call(() => bot().api.unpinAllForumTopicMessages(chatId, threadId), {
        chat_id: chatId,
        verb: 'stale-pin-sweep.unpin-all-topic',
      }),
    // Rights are checked before ANY write in a group. Telegram is HONEST about
    // missing pin rights (400 "not enough rights to manage pinned messages"),
    // but the precheck keeps a rights-less bot from emitting doomed traffic.
    canPinInChat: async (chatId) => {
      const self = bot().botInfo?.id
      if (self == null) return false
      const member = (await call(() => bot().api.getChatMember(chatId, self), {
        chat_id: chatId,
        verb: 'stale-pin-sweep.get-chat-member',
      })) as { status?: string; can_pin_messages?: boolean } | undefined
      return member?.status === 'administrator' && member.can_pin_messages === true
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
    sleep: w.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now,
    store: w.store,
    // Passed through UNCOERCED: undefined means "take the standing policy"
    // (SUPERGROUP_REPIN_UNATTENDED), which is not the same as an explicit false.
    allowSupergroupRepinLoop: w.allowSupergroupRepinLoop,
    log,
  })
}
