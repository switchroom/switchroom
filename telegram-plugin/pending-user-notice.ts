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
}

/** How long a scheduled notice may wait for a resolving turn end. */
export const PENDING_USER_NOTICE_TTL_MS = 10 * 60_000

export class PendingUserNoticeGate {
  private pending: PendingUserNotice[] = []

  /**
   * Schedule a notice for turn-end resolution. Collapses per agent — a burst
   * of error lines within one turn holds ONE pending notice, not a stack.
   */
  schedule(notice: PendingUserNotice): void {
    this.prune(notice.atMs)
    this.pending = this.pending.filter((p) => p.agent !== notice.agent)
    this.pending.push(notice)
  }

  /**
   * Resolve at turn end. `turnDeliveredReply` is the turn's outcome signal
   * (the gateway passes `finalAnswerDelivered || replyCalled`):
   *   - true  → the turn recovered; every pending notice is dropped, [] returned.
   *   - false → the turn died without a reply; the un-expired pending notices
   *     are returned EXACTLY ONCE for the caller to send.
   * Either way the ledger is cleared (a notice never survives its turn end).
   */
  resolveTurnEnd(turnDeliveredReply: boolean, now: number = Date.now()): PendingUserNotice[] {
    this.prune(now)
    const out = turnDeliveredReply ? [] : [...this.pending]
    this.pending = []
    return out
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
