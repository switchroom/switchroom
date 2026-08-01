/**
 * Reply owner-turn resolution WIRING (#2996 anti-inflation extraction; #4173).
 *
 * The pure precedence/acceptance rules live in `../reply-owner-resolve.ts`;
 * gateway.ts holds the stateful lookups (recent-turn registry, quoted-message
 * reverse index). This module is the seam between them: it composes the four
 * lookups into the `ReplyOwnerCandidates` set — INCLUDING the turn-completion
 * window bounds (#4173) — exactly once, so the supersede path, the content-gate
 * bypass, and the tier resolution can never disagree on the candidate set.
 *
 * 2026-07 double-reply-on-DM fix (Part 1): this composition uses the SAME full
 * chain the thread-router uses, so the supersede resolver can never again
 * diverge from routing (the exact bug: supersede omitted the quoted-message and
 * latest-ended recoveries, so a DM late reply — no live turn, no
 * `origin_turn_id` — resolved to a null owner and its flush message was never
 * superseded → duplicate).
 *
 * Precedence (first non-null wins), delegated to the pure
 * `resolveReplyOwnerTurnId` so the exact precedence is unit-tested:
 *   1. the live `currentTurn` passed in (null once the flush nulled the atom);
 *   2. `findTurnByOriginId(origin_turn_id)` — the model echo;
 *   3. `findTurnByQuotedMessageId(chat_id, reply_to)` — framework-owned quote;
 *   4. `findLatestTurnForChat(chat_id, {endedOnly:true})` — last ENDED turn.
 * Returns the turn atom for the winning id (so callers can read its
 * `answerDelivered` latch), or null when every lookup missed.
 */

import {
  resolveReplyOwnerTier,
  resolveReplyOwnerTurnId,
  type ReplyOwnerCandidates,
  type ReplyOwnerTier,
} from '../reply-owner-resolve.js'
import {
  SUPERSEDE_OPEN_WINDOW_CAP_MS,
  SUPERSEDE_COMPLETED_GRACE_MS,
} from '../flushed-turn-supersede.js'

/**
 * #4173/#4175 — the two turn-completion-window bounds, env-overridable as the
 * operator kill-switch for the window mechanism (clamp the open cap / grace to
 * taste; e.g. `SWITCHROOM_SUPERSEDE_OPEN_CAP_MS=60000` restores something
 * close to the pre-#4166 60 s behaviour). Resolved HERE once — the pure
 * modules stay env-free — and consumed by BOTH window surfaces (the gateway's
 * `FlushedTurnSupersedeRegistry` ctor and the latest-ended owner-tier
 * candidates below) so they can never disagree.
 */
export const SUPERSEDE_OPEN_CAP_MS = (() => {
  const raw = Number(process.env.SWITCHROOM_SUPERSEDE_OPEN_CAP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : SUPERSEDE_OPEN_WINDOW_CAP_MS
})()
export const SUPERSEDE_GRACE_MS = (() => {
  const raw = Number(process.env.SWITCHROOM_SUPERSEDE_GRACE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : SUPERSEDE_COMPLETED_GRACE_MS
})()

/** The minimal turn-atom shape this wiring reads. Structural on purpose so the
 *  module never imports gateway.ts (no cycle); gateway's `CurrentTurn`
 *  satisfies it. */
export interface OwnerTurnLike {
  turnId: string
  endedAt: number | null
  realEndObservedAt: number | null
}

/**
 * Compose the owner-resolution result from the gateway's four lookups.
 * Generic over the concrete turn atom type so gateway.ts gets its own
 * `CurrentTurn` back without a cast.
 */
export function resolveReplyOwnerTurnWith<T extends OwnerTurnLike>(
  lookups: {
    findTurnByOriginId(originTurnId: string | null | undefined): T | null
    findTurnByQuotedMessageId(chatId: string, replyTo: unknown): T | null
    findLatestTurnForChat(chatId: string, opts: { endedOnly: boolean }): T | null
    now(): number
  },
  liveTurn: T | null,
  chatId: string,
  args: Record<string, unknown>,
): { turn: T | null; tier: ReplyOwnerTier; candidates: ReplyOwnerCandidates } {
  const origin = lookups.findTurnByOriginId(args.origin_turn_id as string | undefined)
  const quoted = lookups.findTurnByQuotedMessageId(chatId, args.reply_to)
  const latestEnded = lookups.findLatestTurnForChat(chatId, { endedOnly: true })
  const byId = new Map<string, T>()
  // Populate lowest-precedence first so a higher tier's turn wins the id slot
  // when two lookups resolve the same turn (they carry the same turnId anyway).
  for (const t of [latestEnded, quoted, origin, liveTurn]) {
    if (t != null) byId.set(t.turnId, t)
  }
  // F2 — bound the DESTRUCTIVE latest-ended tier to the turn-completion window
  // (#4173) so a stale latest-ended turn can't inherit deletion authority over
  // a newer turn's flush record. #3725: the lookup above is `endedOnly`, so
  // `endedAt` is non-null here and the age is ALWAYS a real number — a
  // not-yet-ended turn is no longer a candidate at all, and an explicit null
  // age fails CLOSED downstream (as does an omitted one, since #4175).
  const latestEndedAgeMs =
    latestEnded?.endedAt != null ? lookups.now() - latestEnded.endedAt : null
  // #4173 — the completion signal: null while the flush-ended turn's REAL
  // turn_end has not been observed (window OPEN — acceptance falls to the
  // crash-backstop cap in `latestEndedTtlMs`); ms-since-real-end once observed
  // (window COMPLETED — only the replay grace remains). For a normally-ended
  // turn `realEndObservedAt === endedAt`, so the tier keeps its tight bound.
  const latestEndedRealEndAgeMs =
    latestEnded == null
      ? null
      : latestEnded.realEndObservedAt != null
        ? lookups.now() - latestEnded.realEndObservedAt
        : null
  const candidates: ReplyOwnerCandidates = {
    liveTurnId: liveTurn?.turnId ?? null,
    originTurnId: origin?.turnId ?? null,
    quotedTurnId: quoted?.turnId ?? null,
    latestEndedTurnId: latestEnded?.turnId ?? null,
    latestEndedAgeMs,
    latestEndedTtlMs: SUPERSEDE_OPEN_CAP_MS,
    latestEndedRealEndAgeMs,
    latestEndedCompletedGraceMs: SUPERSEDE_GRACE_MS,
  }
  // #3429 — the winning tier AND the candidate set it came from travel with the
  // turn. Tier alone no longer decides the content-gate bypass: the
  // model-steerable `origin`/`quoted` tiers must be CORROBORATED against the
  // framework-derived `latestEndedTurnId` (`decideContentGateBypass`). All three
  // derive from these SAME candidates, so they can never disagree.
  const tier = resolveReplyOwnerTier(candidates)
  const winnerId = resolveReplyOwnerTurnId(candidates)
  return { turn: winnerId != null ? (byId.get(winnerId) ?? null) : null, tier, candidates }
}
