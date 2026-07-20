/**
 * Per-chat-and-thread marker of the most recent gateway-synthesized
 * `subagent_handback` enqueue (fix/backstop-duplicate-reply).
 *
 * A BACKGROUND sub-agent completion is a GATEWAY-SYNTHESIZED event, not model
 * output: when a background worker terminates the gateway wakes the agent with a
 * `subagent_handback` inbound. Recording WHEN one was enqueued, per chat/thread,
 * is the ONE deterministic signal that distinguishes the two late-reply cases
 * that both resolve a flush-delivered ENDED turn via the latest-ended tier — the
 * case the owner-resolution tier alone cannot separate (a DM late reply has no
 * live/origin/quoted attribution, so both land on latest-ended):
 *
 *   - CASE A — the flushed turn's OWN reworded reply landing late. NO
 *     `subagent_handback` was enqueued for this chat/thread after the turn ended,
 *     so the reply is that turn's own answer → the supersede path collapses the
 *     provisional flush REGARDLESS of the model's rewording (closes the #3429
 *     reworded-duplicate regression: agent:marko 2026-07-20, turns
 *     #1177/#1182/#1201 double-sent).
 *   - CASE B — a background handback attributed to that ended turn. A
 *     `subagent_handback` WAS enqueued after the turn ended and within the
 *     supersede TTL, so the late reply might BE it → keep the #3429 content gate
 *     and send fresh (two messages), never silently edit/delete the flushed
 *     answer.
 *
 * ## Why thread-keyed (F2, dup-audit 2026-07-21)
 *
 * The supersede registry this marker gates is keyed on `chatId|threadId`
 * (`flushed-turn-supersede.ts` `makeKey`). Keying the marker on `chatId` ALONE
 * was inconsistent: in a forum supergroup a background handback in topic A
 * stamped the chat-wide marker, and a genuine CASE-A reworded own-reply in ANY
 * other topic within the 60 s TTL then computed `handbackCouldOwnReply = true` →
 * kept the content gate → shipped a second visible bubble instead of collapsing.
 * The blast radius was every topic in the chat for 60 s per handback. Keying on
 * `chatId + threadId` — the SAME lane the supersede registry uses — confines a
 * handback's gate-hold to the topic it actually landed in, so an unrelated
 * topic's CASE-A collapse is untouched. A DM (no thread) collapses to the
 * chat-only key, so single-lane behaviour is unchanged.
 *
 * One entry per chat/thread (overwritten on each enqueue), so bounded by
 * chat×topic count. No clock reads beyond the caller-supplied `now`; the gateway
 * wires the actual enqueue site and the supersede-path read. Deterministic —
 * keyed on a gateway-emitted event, never on model discipline (Ken's
 * controls-in-code rule).
 */
/**
 * ## The enforced invariant (F1, dup-audit 2026-07-21)
 *
 * The whole content-gate bypass rests on this premise: *a decoupled late reply
 * (turn == null) carrying content that is NOT the flushed turn's own answer,
 * resolving an ENDED flushed turn as its owner, can ONLY be a gateway-synthesized
 * completion — and every such completion stamps this marker.* If that premise
 * holds, then marker-ABSENCE in the window proves the late reply IS the flushed
 * turn's own (possibly reworded) answer, so bypassing the content gate is safe
 * (closes the marko duplicate). If a NEW synthesized-inbound source were ever
 * able to land as a decoupled late reply with foreign content WITHOUT stamping,
 * it would silently edit over a delivered answer (the #3429 failure).
 *
 * We make the premise an ENFORCED invariant rather than an architectural
 * coincidence by routing the stamp decision through this ONE predicate at the ONE
 * chokepoint every inbound funnels through (`pendingInboundBuffer.push` — live
 * synthesis, boot-replay, and every future source alike). The membership of the
 * decoupled-completion class is defined HERE and nowhere else:
 *
 *   - `subagent_handback` — the only source today that wakes the agent to emit a
 *     reply with NO live gateway turn of its own (a background worker completion),
 *     so its reply resolves a DIFFERENT, already-ended turn via the latest-ended
 *     tier. It is the F1 vector.
 *   - Every OTHER synthesized source (cron, resume_*, reaction, vault_*, …) lands
 *     as its OWN live inbound turn, so its reply resolves the `live` tier for its
 *     own turnId and structurally cannot supersede a different ended turn's flush
 *     record (`decideSupersede` requires `record.turnId === liveTurnId`). Those
 *     must NOT stamp — stamping them would needlessly hold the content gate open
 *     for an unrelated own-reply in the window (a safe but avoidable visible dup).
 *
 * This predicate is therefore the SINGLE point of extension: any future feature
 * that synthesizes an inbound which can land as a DECOUPLED late reply (no live
 * turn) MUST add its `meta.source` here — and because the chokepoint consults
 * this predicate, doing so is the whole wiring. A source that forgets to opt in
 * cannot reach the bypass unnoticed: the negative outcome guard
 * (`send-reply-golden.test.ts`) pins that a decoupled foreign-content reply on a
 * non-live tier never silently edits over the flushed answer.
 */
export function stampsHandbackMarker(source: string | null | undefined): boolean {
  return source === 'subagent_handback'
}

export class SubagentHandbackMarker {
  private readonly lastAtByLane = new Map<string, number>()

  /** Compose the lane key consistently with the supersede registry's
   *  `makeKey(chatId, threadId)`: a bare chat id for the no-thread (DM) case,
   *  `chatId|threadId` for a forum topic. Keeping these two keyings identical is
   *  what makes the marker gate exactly the lane the supersede acts on. */
  private lane(chatId: string, threadId: number | undefined): string {
    return threadId == null ? chatId : `${chatId}|${threadId}`
  }

  /** Record that a `subagent_handback` was enqueued for `chatId`/`threadId` at
   *  `now` (ms). */
  record(chatId: string, threadId: number | undefined, now: number): void {
    this.lastAtByLane.set(this.lane(chatId, threadId), now)
  }

  /** Wall-clock ms of the most recent handback enqueue for `chatId`/`threadId`,
   *  or null. */
  lastAt(chatId: string, threadId: number | undefined): number | null {
    return this.lastAtByLane.get(this.lane(chatId, threadId)) ?? null
  }
}
