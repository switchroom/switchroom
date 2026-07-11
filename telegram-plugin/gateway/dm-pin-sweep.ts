/**
 * DM pin sweep (#3026) — durable clearing of stale bot-authored pins in
 * user DM chats.
 *
 * Why this exists (two independent gaps the probe-based boot sweep can't
 * close for DMs):
 *
 *   1. The boot pin sweep (`shouldSweepChatAtBoot`) deliberately SKIPS
 *      positive (DM) chat IDs — the Bot API returns `400 chat not found`
 *      for a user who never messaged the bot. So DM chats were never
 *      boot-swept at all, and stale pins from a prior session lingered
 *      across restarts (observed fleet-wide 2026-07-11).
 *
 *   2. Even when a DM chat IS reachable, `getChat()` exposes ONLY the
 *      NEWEST pinned message. Telegram DMs STACK pins and the Bot API has
 *      no list-pins method, so older orphan pins are invisible to a
 *      probe-based (unpin-one-by-message-id) sweep forever.
 *
 * The durable fix, DM-only: call `unpinAllChatMessages` ONCE per DM chat
 * per gateway boot (clearing the whole stack — safe in a DM, where
 * virtually every pin is bot-authored), then immediately RE-PIN the live
 * tracked cards from the in-memory pin claims (silent, `disable_notification`)
 * so a genuinely in-flight status/worker pin survives the sweep.
 *
 * Groups/supergroups (negative IDs) are NOT touched here — an unpin-all
 * there would nuke human pins. They keep the existing probe-based path.
 *
 * This module is the PURE half (chat-id classification, store→DM-chat-id
 * collection, and a dependency-injected sweeper with the once-per-boot
 * guard). The gateway binds the live Bot API + in-memory claim map.
 */

/**
 * True iff `chatId` is a user DM chat: a positive integer. Group and
 * supergroup IDs are negative; zero / non-numeric / non-integer are
 * malformed and never DMs.
 */
export function isDmChatId(chatId: string): boolean {
  const n = Number(chatId)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0
}

/**
 * Collect the DISTINCT DM chat IDs that appear in ANY of the persisted pin
 * stores — the set of DM chats the gateway has a record of having pinned
 * something in during a prior session. These are the DM chats worth
 * sweeping at boot (an unpin-all is wasted on a DM we never pinned in).
 *
 * Pure over its input records; callers pass the loaded store snapshots
 * (status pins, activity cards, queued/busy-ack cards). Non-DM chat IDs
 * are filtered out.
 */
export function collectDmChatIdsFromStores(input: {
  statusPins?: readonly { chatId: string }[]
  activityCards?: readonly { chatId: string }[]
  queuedCards?: readonly { chatId: string }[]
}): string[] {
  const out = new Set<string>()
  const add = (rows?: readonly { chatId: string }[]): void => {
    if (rows == null) return
    for (const r of rows) if (isDmChatId(r.chatId)) out.add(r.chatId)
  }
  add(input.statusPins)
  add(input.activityCards)
  add(input.queuedCards)
  return [...out]
}

export interface DmPinSweeperDeps {
  /** Clear EVERY pinned message in a chat. Bound to the gateway's
   *  robust/retry API wrapper so a 429 flood-wait is retried, then
   *  degrades (rejects) rather than crashing — the sweeper absorbs it. */
  unpinAll: (chatId: string) => Promise<unknown>
  /** Silently re-pin an EXISTING message (disable_notification). Bound to
   *  the gateway's robust/retry API wrapper. */
  pinSilent: (chatId: string, messageId: number) => Promise<unknown>
  /** Live tracked pin message ids for a chat — the in-memory status-pin
   *  claims still owned by an in-flight turn/worker. These are re-pinned
   *  after the unpin-all so an active pin isn't collateral. Empty at boot
   *  (fresh process, no live claims yet); non-empty on a first-inbound
   *  sweep landing mid-turn. */
  liveTrackedMessageIds: (chatId: string) => number[]
  /** Gate: sweep ONLY when the gateway won the startup mutex. The stores
   *  and the chat's pins are shared per-agent state; a LOSING double-boot
   *  must never unpin the live holder's legitimate pins. */
  eligible: () => boolean
  /** Optional structured log sink. */
  log?: (line: string) => void
}

export interface DmPinSweeper {
  /**
   * Sweep a single DM chat: unpin-all then re-pin live tracked cards.
   * At most ONCE per chat per sweeper lifetime (one gateway boot). No-op
   * for non-DM chats, when not eligible, or when already swept. Never
   * throws — a failed unpin-all/re-pin degrades and is logged.
   */
  sweep(chatId: string): Promise<void>
  /** True if this chat has already been swept this boot (test/observability). */
  hasSwept(chatId: string): boolean
}

export function createDmPinSweeper(deps: DmPinSweeperDeps): DmPinSweeper {
  const swept = new Set<string>()
  return {
    hasSwept: (chatId) => swept.has(chatId),
    async sweep(chatId: string): Promise<void> {
      if (!isDmChatId(chatId)) return
      if (!deps.eligible()) return
      if (swept.has(chatId)) return
      // Claim the once-guard BEFORE the first await so two concurrent
      // triggers (boot + first-inbound landing in the same tick) can't
      // both fire the unpin-all.
      swept.add(chatId)

      // Snapshot live claims BEFORE the unpin-all so we know exactly which
      // messages to restore.
      const liveIds = deps.liveTrackedMessageIds(chatId)

      try {
        await deps.unpinAll(chatId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.log?.(
          `telegram gateway: dm-pin-sweep: unpin-all failed (chat=${chatId}): ${msg}\n`,
        )
        // Degrade: the stack may still hold stale pins, but we don't
        // crash and we don't retry this boot. Fall through to re-pin the
        // live claims (harmless if the unpin didn't land).
      }

      for (const messageId of liveIds) {
        try {
          await deps.pinSilent(chatId, messageId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          deps.log?.(
            `telegram gateway: dm-pin-sweep: re-pin failed ` +
              `(chat=${chatId} msg=${messageId}): ${msg}\n`,
          )
        }
      }

      if (liveIds.length > 0) {
        deps.log?.(
          `telegram gateway: dm-pin-sweep: cleared stacked pins in DM ${chatId}, ` +
            `re-pinned ${liveIds.length} live card(s)\n`,
        )
      }
    },
  }
}
