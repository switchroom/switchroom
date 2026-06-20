/**
 * represent-guard.ts — the duplicate-represent guard for the obligation sweep,
 * extracted from obligationSweep so the "satisfied-but-misdetected obligation
 * must NOT re-fire" decision (#2472) is EXECUTABLE in a pure unit test.
 *
 * The bug (#2472): obligation_represent re-fired for the same origin_turn_id even
 * after the agent had already answered represent_count=1 with a reply tool call,
 * producing a second near-identical message. The reply landed but its routing did
 * not resolve back to the origin, so the ledger's normal close path missed it —
 * and the represent branch (unlike the escalate branch) had no belt-and-braces
 * outbound-history check before re-firing.
 *
 * This helper is the decision the sweep's represent branch now consults. PURE —
 * no Telegram, no SQLite; the gateway injects `hasOutboundDeliveredSince` as a
 * predicate. The single load-bearing subtlety lives here in one testable place:
 *
 *   The cutoff is `lastRepresentedAt` (the time of the PREVIOUS represent), NOT
 *   `openedAt`. On the FIRST represent (`lastRepresentedAt` undefined) the guard
 *   is a no-op, so the genuine "agent wrote a plain-text answer and never called
 *   the reply tool" case still re-presents ONCE. Only the SECOND-and-later
 *   represent is gated — exactly where a reply that landed BETWEEN fires must
 *   suppress the re-ask. A reply that predates the last represent (e.g. the
 *   original plain-text answer) does not count, because it is not evidence the
 *   most recent represent was answered.
 */

/** The obligation fields the represent guard inspects. */
export interface RepresentGuardObligation {
  readonly originTurnId: string
  readonly chatId: string
  readonly threadId?: number
  /** Wall-clock ms this obligation was most recently re-presented, if ever. */
  readonly lastRepresentedAt?: number
}

export interface RepresentGuardDeps {
  /** True when history is available to query (else the guard never suppresses). */
  historyEnabled: boolean
  /**
   * Has a SUBSTANTIVE assistant reply been delivered to this chat (optionally
   * scoped to thread) at or after `sinceMs`? Wraps history.hasOutboundDeliveredSince.
   */
  hasOutboundDeliveredSince: (chatId: string, sinceMs: number, threadId?: number) => boolean
}

/**
 * Decide whether a represent for `o` should be SUPPRESSED because the agent has
 * already delivered a reply since the obligation was last re-presented.
 *
 * Returns true ⇒ the obligation is satisfied-but-misdetected; the caller closes
 * it silently and does NOT re-fire. Returns false ⇒ proceed with the represent
 * (first represent always proceeds; a represent with no reply since the last one
 * proceeds; an unavailable history proceeds — never suppress on doubt).
 */
export function shouldSuppressRepresent(
  o: RepresentGuardObligation,
  deps: RepresentGuardDeps,
): boolean {
  if (!deps.historyEnabled) return false
  // First represent: nothing to compare against — let the single re-ask fire so
  // the genuine plain-text-no-reply case is preserved.
  if (o.lastRepresentedAt == null) return false
  return deps.hasOutboundDeliveredSince(o.chatId, o.lastRepresentedAt, o.threadId)
}
