/**
 * The recently-seen-turn registry scan, extracted from `gateway.ts` as a pure
 * function so its ENDED-ness contract is unit-testable (#3725; gateway.ts is not
 * importable in tests — the repo's `decideTurnFlush` / `resolveReplyOwnerTurnId`
 * pattern).
 *
 * ## Why `endedOnly` exists (#3725)
 *
 * `recentTurnsById` is populated at turn **start** (`rememberRecentTurn` fires
 * from the `enqueue` lifecycle event in `stream-render.ts`), and the atom is
 * built with `endedAt: null`; `endedAt` is stamped later, in `turn-end.ts`. So
 * the registry's tail entry for a chat is the most-recently-STARTED turn, which
 * may still be RUNNING. The registry is also chat-wide and thread-agnostic, so
 * on a forum a turn running in ANOTHER topic sits at the tail.
 *
 * That distinction is load-bearing because the two consumers want different
 * things:
 *
 *   - **Routing** (`resolveAnswerThreadWithLog`) wants the chat's most recent
 *     turn whether or not it has ended — it only picks a topic to deliver into,
 *     and a still-running turn's topic is a perfectly good (indeed better)
 *     answer than falling back to General. `endedOnly: false`.
 *   - **Owner resolution** (`resolveReplyOwnerTurn` → the `latest-ended`
 *     supersede tier) wants a genuinely ENDED turn: that tier carries
 *     DESTRUCTIVE authority (it drives message deletion) and is bounded by the
 *     supersede TTL measured from `endedAt`. A turn with `endedAt == null` has
 *     no age, so it could not be TTL-bounded at all — it was an unbounded
 *     anchor for the corroborated content-gate bypass (#3725). A still-running
 *     turn must be resolved by the `live` tier, never by this fallback.
 *     `endedOnly: true`.
 */

/** The registry-atom shape this scan needs (structural — `CurrentTurn` in the
 *  gateway satisfies it without importing the gateway's type). */
export interface LatestTurnLookupAtom {
  /** The chat the turn belongs to. */
  sessionChatId: string
  /** Wall-clock ms the turn ENDED, or null while it is still running. */
  endedAt: number | null
}

/**
 * The last turn for `chatId` in registry insertion order — i.e. the most recent
 * one. With `endedOnly: true` the scan skips turns that have not ended yet, so
 * the result is the most-recently-ended turn (which may NOT be the tail entry).
 * Returns null when the chat has no matching turn.
 */
export function latestTurnForChat<T extends LatestTurnLookupAtom>(
  turns: Iterable<T>,
  chatId: string,
  opts: { endedOnly: boolean },
): T | null {
  let latest: T | null = null
  for (const t of turns) {
    if (t.sessionChatId !== chatId) continue
    if (opts.endedOnly && t.endedAt == null) continue
    latest = t
  }
  return latest
}
