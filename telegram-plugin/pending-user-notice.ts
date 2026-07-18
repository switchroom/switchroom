/**
 * pending-user-notice.ts — deterministic turn-outcome gate for the
 * non-operator user failure notice (#3293 review finding 1).
 *
 * THE PROBLEM this closes: `emitGatewayOperatorEvent` fires whenever
 * session-tail sees an api_error line, with no knowledge of whether the turn
 * ultimately RECOVERS (e.g. the LiteLLM fallback 401s but a retry / another
 * deployment serves the turn). Sending the "couldn't complete that — it's on
 * our side" notice at error time would tell users a turn failed that actually
 * completed. The 5-min per-kind operator-event cooldown debounces retry SPAM
 * but cannot know the turn's outcome.
 *
 * THE MECHANISM: the notice is never sent at error time. It is SCHEDULED here,
 * and resolved at the gateway's single turn-end funnel (`endCurrentTurnAtomic`):
 *   - turn ended WITH a delivered reply  → the turn recovered → DROP the notice
 *   - turn ended WITHOUT a delivered reply → the turn genuinely died → SEND it
 * Operator cards are NOT gated — they stay immediate (the operator must see
 * the infra fault even when the turn recovers).
 *
 * CONSERVATIVE TTL: if no turn end resolves a scheduled notice within
 * {@link PENDING_USER_NOTICE_TTL_MS} (error arrived between turns, or the turn
 * record was lost), the notice is silently discarded — a missed notice costs a
 * user some confusion; a FALSE "couldn't complete" on a served turn costs
 * trust. Bias to silence.
 *
 * Pure module: no IPC, no bot, no FS. Injectable `now` throughout.
 */

export interface PendingUserNotice {
  /** Non-operator allowlist chats that should receive the notice. */
  chatIds: string[]
  /** The plain-language notice text (renderUserFacingFailureNotice()). */
  text: string
  agent: string
  /** The operator-event kind that produced it (log/debug context only). */
  kind: string
  /** When the notice was scheduled (ms epoch). */
  atMs: number
  /**
   * TOPIC KEY (#3294) — `statusKey(chatId, threadId)` of the turn that was live
   * when the error surfaced, or `undefined` when no turn was attributable (the
   * error arrived between turns, or after a silence poke nulled the live turn).
   *
   * Why it exists: the api_error operator event is agent-level (its wire
   * `chatId` is always empty), so the gate USED to collapse per-agent and let
   * ANY turn end resolve the notice. Under the PR-4e keyed-liveness flag
   * (concurrent per-topic turns) that is a bug: turn B's reply-less end would
   * flush turn A's pending notice while A may still recover — a FALSE "couldn't
   * complete" claim. Keying the notice by the live turn's topic means only a
   * turn end on the SAME topic resolves it (see {@link
   * PendingUserNoticeGate.resolveTurnEnd}).
   *
   * A notice with an UNDEFINED key keeps the legacy agent-wide resolution (any
   * turn end resolves it), so single-turn gateways — the current norm, where
   * there is only ever one topic — are byte-identical to the pre-#3294 gate.
   */
  key?: string
}

/** How long a scheduled notice may wait for a resolving turn end. */
export const PENDING_USER_NOTICE_TTL_MS = 10 * 60_000

export class PendingUserNoticeGate {
  private pending: PendingUserNotice[] = []

  /**
   * Schedule a notice for turn-end resolution. Collapses per (agent, topic key)
   * — a burst of error lines within one turn holds ONE pending notice for that
   * topic, not a stack. Distinct concurrent topics (keyed liveness) each keep
   * their own pending notice, so one topic's burst never overwrites another's.
   * (For a single-turn gateway every notice shares the one topic — or an
   * undefined key — so the collapse is identical to the pre-#3294 per-agent one.)
   */
  schedule(notice: PendingUserNotice): void {
    this.prune(notice.atMs)
    this.pending = this.pending.filter(
      (p) => !(p.agent === notice.agent && p.key === notice.key),
    )
    this.pending.push(notice)
  }

  /**
   * Resolve at the end of the turn whose topic is `turnKey`. `turnDeliveredReply`
   * is the turn's outcome signal (the gateway passes `finalAnswerDelivered ||
   * replyCalled`).
   *
   * A pending notice is RESOLVED by this turn end iff it belongs to the ending
   * turn's topic (`p.key === turnKey`) OR it is unattributed (`p.key ===
   * undefined` — legacy agent-wide resolution, kept so single-turn gateways are
   * unchanged). Notices scheduled for a DIFFERENT live topic stay pending until
   * their own topic's turn ends (or the TTL expires) — this is the #3294 fix:
   * turn B's end no longer flushes turn A's pending notice.
   *
   * Of the resolved notices:
   *   - `turnDeliveredReply === true`  → the turn recovered; the resolved
   *     notices are dropped and `[]` is returned.
   *   - `turnDeliveredReply === false` → the turn died reply-less; the resolved,
   *     un-expired notices are returned EXACTLY ONCE for the caller to send.
   * Either way the resolved notices leave the ledger (a notice never survives
   * the end of the turn it is keyed to).
   */
  resolveTurnEnd(
    turnKey: string | undefined,
    turnDeliveredReply: boolean,
    now: number = Date.now(),
  ): PendingUserNotice[] {
    this.prune(now)
    const resolved: PendingUserNotice[] = []
    const remaining: PendingUserNotice[] = []
    for (const p of this.pending) {
      if (p.key === turnKey || p.key === undefined) resolved.push(p)
      else remaining.push(p)
    }
    this.pending = remaining
    return turnDeliveredReply ? [] : resolved
  }

  /** True when at least one un-expired notice is pending (does not mutate). */
  hasPending(now: number = Date.now()): boolean {
    return this.pending.some((p) => now - p.atMs < PENDING_USER_NOTICE_TTL_MS)
  }

  private prune(now: number): void {
    this.pending = this.pending.filter((p) => now - p.atMs < PENDING_USER_NOTICE_TTL_MS)
  }

  /** Test-only: forget everything. */
  reset(): void {
    this.pending = []
  }
}

/** The process-wide gate the gateway consults. */
export const pendingUserNoticeGate = new PendingUserNoticeGate()
