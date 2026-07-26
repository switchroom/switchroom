/**
 * Gateway wiring for the boot-time orphaned activity-card reaper (Known Gap 1,
 * `reference/rfcs/deterministic-turn-liveness.md`).
 *
 * Extracted from gateway.ts (#3634) — the pure routine already lived in
 * activity-card-store.ts; this is the seam binding that used to sit inline
 * under the gateway's line ratchet. Behaviour is unchanged; the only reason it
 * moved is that gateway.ts may not grow.
 *
 * Finalizes ANY card left open by a prior (crashed/restarted) session with ONE
 * honest edit — never a new message, so no ping. The guarantee is
 * AT-MOST-ONCE: the pure routine deletes each record before attempting its
 * edit and does not retry, so a failed edit forfeits that orphan rather than
 * risk a double-finalize on a later boot (see activity-card-store.ts for the
 * full tradeoff). A benign-400 (card already gone) is reported as `vanished`,
 * not `finalized`.
 *
 * MUST run ONLY after this gateway wins the startup mutex (the store is a
 * shared per-agent file; a losing double-boot would finalize a card the
 * still-alive holder's in-flight turn still legitimately owns) — identical
 * ordering constraint to `statusPinBootCleanup` — and, since #3634, only after
 * `gatewayBotReady` resolves: every call below dereferences the gateway's
 * late-assigned `lockedBot`, and firing this at module-eval time is exactly
 * what made the boot sweep a no-op for months.
 *
 * Deliberately does NOT attempt to resume climbing the old card: the resumed
 * turn (if any) opens its own fresh card. Honest finalization, not resumption.
 *
 * After the finalizing edit it also unpins the card, but ONLY for a record
 * whose persisted `pinned` flag is true — i.e. the card was actually
 * pin-eligible on open. That unpin is DEFENSE-IN-DEPTH, not the primary path:
 * `statusPinBootCleanup` already unpins orphaned status pins from its own
 * durable store. The record's `pinned` flag must therefore reflect the ACTUAL
 * pin outcome, not an unconditional `true`, or this would attempt an unpin on
 * a card that was never pinned.
 */

export interface OrphanCardRecord {
  chatId: string
  threadId?: number | null
  activityMessageId: number
  startedAt: number
}

export interface ActivityCardBootReaperWiring {
  enabled: boolean
  path: string
  fs: unknown
  /** The gateway's late-assigned wrapped bot. Read lazily, never captured. */
  getBot: () => {
    api: {
      editMessageText: (
        chatId: string,
        messageId: number,
        text: unknown,
        opts: Record<string, unknown>,
      ) => Promise<unknown>
      unpinChatMessage: (chatId: string, messageId: number) => Promise<unknown>
    }
  }
  /** The gateway's retry/send-gate wrapper. Named for the repo's
   *  check-bot-api-wrapping guard: every Bot API call below is inside it. */
  robustApiCall: (
    fn: () => Promise<unknown>,
    opts: Record<string, unknown>,
  ) => Promise<unknown>
  /** `richMessage(restartOrphanCardFinalizeText(startedAt))` */
  finalizeBody: (startedAt: number) => unknown
  run: (args: {
    path: string
    fs: unknown
    finalizeCard: (r: OrphanCardRecord) => Promise<unknown>
    unpinCard: (r: OrphanCardRecord) => Promise<unknown>
  }) => Promise<{
    finalized: number
    vanished: number
    unpinned: number
    total: number
  }>
  log?: (line: string) => void
}

const threadOpt = (r: OrphanCardRecord) =>
  r.threadId != null ? { threadId: r.threadId } : {}

export async function runActivityCardBootReaperWiring(
  w: ActivityCardBootReaperWiring,
): Promise<void> {
  if (!w.enabled) return
  const log = w.log ?? ((l: string) => process.stderr.write(l))
  const { finalized, vanished, unpinned, total } = await w.run({
    path: w.path,
    fs: w.fs,
    finalizeCard: (record) =>
      w.robustApiCall(
        () =>
          w
            .getBot()
            .api.editMessageText(
              record.chatId,
              record.activityMessageId,
              w.finalizeBody(record.startedAt),
              {},
            ),
        {
          chat_id: record.chatId,
          ...threadOpt(record),
          verb: 'activity-card.boot-reap-finalize',
        },
      ),
    unpinCard: (record) =>
      w.robustApiCall(
        () => w.getBot().api.unpinChatMessage(record.chatId, record.activityMessageId),
        {
          chat_id: record.chatId,
          ...threadOpt(record),
          verb: 'activity-card.boot-reap-unpin',
        },
      ),
  })
  if (total > 0) {
    log(
      `telegram gateway: activity-card: finalized ${finalized}/${total} ` +
        `(vanished ${vanished}/${total}), unpinned ${unpinned}/${total} ` +
        `orphaned card(s) from a prior session (at-most-once)\n`,
    )
  }
}
