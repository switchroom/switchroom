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
 *   For the SECOND-and-later represent the cutoff is `lastRepresentedAt` (the
 *   time of the PREVIOUS represent), NOT `openedAt` — exactly where a reply that
 *   landed BETWEEN fires must suppress the re-ask, while a reply that predates
 *   the last represent (e.g. the original plain-text answer) does not count,
 *   because it is not evidence the most recent represent was answered.
 *
 *   For the FIRST represent (`lastRepresentedAt` undefined) the cutoff is
 *   `openedAt` (#2788 Gap B). Previously the first represent was an unconditional
 *   no-op, leaving a narrow window: if a genuine reply was already delivered
 *   since the obligation was RAISED but its routing didn't resolve back to the
 *   origin (so the ledger's normal close path missed it), the first represent
 *   emitted a false "you never answered". Deduping against outbound history from
 *   `openedAt` closes that window WITHOUT breaking the genuine "agent wrote a
 *   plain-text answer and never called the reply tool" case: that case records NO
 *   outbound row, so `hasOutboundDeliveredSince` reports false and the single
 *   re-ask still fires.
 */

/** The obligation fields the represent guard inspects. */
export interface RepresentGuardObligation {
  readonly originTurnId: string
  readonly chatId: string
  readonly threadId?: number
  /** Wall-clock ms this obligation was RAISED — the FIRST-represent cutoff (#2788). */
  readonly openedAt?: number
  /** Wall-clock ms this obligation was most recently re-presented, if ever. */
  readonly lastRepresentedAt?: number
}

export interface RepresentGuardDeps {
  /** True when history is available to query (else the guard never suppresses). */
  historyEnabled: boolean
  /**
   * Has a genuine assistant reply been delivered to this chat (optionally scoped
   * to thread) at or after `sinceMs`? Wraps history.hasOutboundDeliveredSince.
   *
   * For the represent guard the gateway binds this with a LOW minChars (#2474
   * follow-up): ANY real reply to the turn — even a terse "Yes — done." — means
   * the user was answered and the duplicate represent must be suppressed. The
   * 200-char "substantive" proxy is the ESCALATE branch's concern, not this one;
   * applying it here left short-but-real replies failing to suppress the duplicate
   * (the #2472 gap). The underlying query only counts recordOutbound rows, so
   * typing indicators / progress-card edits are never miscounted as a reply.
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
  // First represent (#2788 Gap B): dedup against outbound history from `openedAt`.
  // A genuine reply already delivered since the obligation was raised means the
  // user WAS answered — suppress the false "you never answered". The genuine
  // plain-text-no-reply case records no outbound row, so the predicate reports
  // false there and the single re-ask still fires. If `openedAt` is unknown we
  // cannot dedup safely, so fall back to the prior no-op (never suppress).
  if (o.lastRepresentedAt == null) {
    if (o.openedAt == null) return false
    return deps.hasOutboundDeliveredSince(o.chatId, o.openedAt, o.threadId)
  }
  return deps.hasOutboundDeliveredSince(o.chatId, o.lastRepresentedAt, o.threadId)
}
