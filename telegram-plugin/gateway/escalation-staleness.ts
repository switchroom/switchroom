/**
 * escalation-staleness.ts — the two guards that stand an obligation ESCALATION
 * down when the agent has, in fact, already answered.
 *
 * The escalate branch of the obligation sweep sends a user-visible
 * "⚠️ I may have missed an earlier message" nudge. That nudge is only correct
 * when the agent genuinely never answered. Two mechanisms in the pre-fix code
 * let it fire on top of an answer the user had already received:
 *
 *   1. THREAD SCOPING. The staleness check was keyed on the obligation's
 *      `threadId`. The reply router routinely resolves an answer to a DIFFERENT
 *      topic than the obligation's (it logs this explicitly, e.g.
 *      `EXPLICIT_OVERRIDDEN(model→4,routed→635)`), so the delivered answer lives
 *      under another `thread_id` and a thread-keyed query can never see it.
 *      Confirmed on marko 2026-08-13: obligation `<chat>:4#5462`
 *      (thread 4) was answered by message 5494 (295 chars) delivered to thread 3
 *      at 04:02:51.987 — and the nag still fired 14.2s later at 04:03:06.140.
 *      Fix: `answeredSinceOpen` asks CHAT scope, falling back from the thread
 *      scope, so an answer delivered anywhere in the chat counts.
 *
 *   2. NO SETTLE. The check is a point-in-time read of history, but the answer
 *      is frequently still IN FLIGHT at the instant the sweep decides: the reply
 *      tool has been invoked (or is about to be) and its history row does not
 *      exist yet. Confirmed on marko 2026-08-10 06:36 (reply tool invoked at
 *      :07.917, escalation decided at :08.047, answer 5215 delivered at :09.281 —
 *      1.23s AFTER the decision) and 2026-08-10 07:52 (decision :34.400, answer
 *      5232 delivered :37.209 — 2.81s after). A backward-looking widening of the
 *      cutoff cannot fix this: the cutoff is already `openedAt`, minutes in the
 *      past, so a delivered row would have matched. The row simply is not there
 *      yet. Fix: `createEscalationSettleGate` requires the staleness check to
 *      have read "not answered" ACROSS a settle window before the nudge is
 *      allowed out — the escalation is deferred once, re-checked on a later
 *      sweep, and only sent if the answer still has not landed.
 *
 * Both guards are deliberately bounded: the settle gate delays a genuine
 * escalation by the settle window and no more, and the chat-scoped check keeps
 * the caller's substantive-length floor, so an escalation for a genuinely
 * unanswered message still fires.
 */

/**
 * Escalation settle window, in milliseconds.
 *
 * Derived from the observed decision→delivery lag on the confirmed false
 * escalations where the answer was in flight at decision time:
 *
 *   - marko 2026-08-10 06:36:08.047 decision → 06:36:09.281 delivery = 1,234 ms
 *   - marko 2026-08-10 07:52:34.400 decision → 07:52:37.209 delivery = 2,809 ms
 *
 * The window must (a) exceed the WORST observed lag with real margin — a send
 * can additionally sit behind the per-chat send-gate pacing — and (b) span at
 * least one 5,000 ms sweep tick, or no re-check ever runs and the gate is a pure
 * delay. 3 × 2,809 = 8,427 ms, rounded up to the nearest 500 ms → 8,500 ms,
 * which satisfies both.
 *
 * The upper bound is the genuinely-unanswered case that MUST still escalate:
 * marko 2026-08-12 09:08:14.524 decision → the agent's real answer (5357) at
 * 09:08:56 = 41,331 ms. 8,500 ms sits 4.9× below that, so a settle re-check
 * cannot swallow it.
 *
 * Kill switch: 0 disables the gate (pre-fix, escalate on the first decision).
 */
export const OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT = 8_500

/**
 * Resolve the settle window from the environment.
 *
 * Lives here rather than beside the other obligation constants in gateway.ts:
 * that file is under the anti-inflation line ratchet (#2996 P0.5) with zero
 * headroom, and the ratchet's whole point is that new logic lands in a module.
 * `SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS=0` is the kill switch (pre-fix
 * behaviour: escalate on the first decision); a non-numeric or negative value
 * falls back to the default rather than silently disabling the guard.
 */
export function resolveEscalateSettleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS
  if (raw == null || raw === '') return OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT
}

export interface EscalationStalenessDeps {
  /** History available? When false the check reports "not answered" (safe: never suppresses). */
  historyEnabled: boolean
  /**
   * The history predicate. `threadId === undefined` means CHAT scope (any
   * thread); an explicit number/null scopes to that thread.
   */
  hasOutboundDeliveredSince: (
    chatId: string,
    sinceMs: number,
    threadId?: number | null,
  ) => boolean
}

export interface EscalationStalenessObligation {
  chatId: string
  openedAt: number
  threadId?: number | null
}

/**
 * True when a substantive outbound was delivered to the obligation's CHAT since
 * it was opened — i.e. the agent answered and the nudge would be redundant.
 *
 * Scope is the chat, not the thread. A thread-scoped hit is a strict subset of a
 * chat-scoped hit, so this is the thread check plus the cross-topic fallback the
 * router's `EXPLICIT_OVERRIDDEN(model→N,routed→M)` reroutes demand.
 *
 * The widening is deliberate but is NOT unbounded: it is still floored by the
 * caller's substantive-length threshold (200 chars in the escalate branch, so a
 * bare ack never stands an escalation down) and by `openedAt`. The residual
 * risk it accepts is a busy multi-topic chat where a long answer to topic B
 * suppresses the nag for an unanswered obligation in topic A. That trade is
 * correct here: the escalate branch only runs after the whole re-present ladder
 * has been exhausted (minutes of re-asking), and a false nag on top of a
 * delivered answer is the user-visible defect, whereas a suppressed nag merely
 * loses one advisory the re-present ladder already made several times.
 *
 * Falls back to `false` (never suppresses) when history is unavailable.
 */
export function answeredSinceOpen(
  o: EscalationStalenessObligation,
  deps: EscalationStalenessDeps,
): boolean {
  if (!deps.historyEnabled) return false
  // Thread scope first — the precise answer when the reply landed where the
  // obligation lives. Chat scope second — the cross-topic reroute fallback.
  if (
    o.threadId !== undefined &&
    deps.hasOutboundDeliveredSince(o.chatId, o.openedAt, o.threadId)
  ) {
    return true
  }
  return deps.hasOutboundDeliveredSince(o.chatId, o.openedAt)
}

export interface EscalationSettleGate {
  /**
   * Called each time the sweep reaches the escalate decision for `id` and the
   * staleness check said "not answered". Returns true to DEFER (leave the
   * obligation open; a later sweep re-checks), false to proceed with the nudge.
   */
  shouldDefer(id: string, now: number): boolean
  /** Forget `id` — call on every terminal (silent close, escalation driven). */
  clear(id: string): void
  /** Live entry count. Test/diagnostic surface. */
  size(): number
}

/**
 * A settle gate: an escalation is only sent once the "no answer delivered" read
 * has held for `settleMs`.
 *
 * The first decision records `now` and defers. Subsequent decisions for the same
 * id proceed once `settleMs` has elapsed since that first read. Because the
 * caller only reaches this gate when the staleness check reported "not
 * answered", proceeding means the check was false at BOTH ends of the window —
 * so an answer that lands anywhere inside it suppresses the nudge instead.
 *
 * Bounded by construction: the delay is exactly `settleMs`; it cannot grow, and
 * a genuinely unanswered obligation still escalates one settle window later.
 * `settleMs <= 0` disables the gate (never defers).
 *
 * The id map is LRU-bounded so a long-lived gateway cannot grow it without
 * limit. Ids are per-message origin turn ids, so an evicted entry can only ever
 * cost one extra settle window, never a wrong decision for another obligation.
 */
export function createEscalationSettleGate(
  settleMs: number,
  maxKeys = 256,
): EscalationSettleGate {
  const firstDecidedAt = new Map<string, number>()
  return {
    shouldDefer(id: string, now: number): boolean {
      if (!(settleMs > 0)) return false
      const first = firstDecidedAt.get(id)
      if (first == null) {
        firstDecidedAt.set(id, now)
        if (firstDecidedAt.size > maxKeys) {
          const oldest = firstDecidedAt.keys().next().value
          if (oldest !== undefined) firstDecidedAt.delete(oldest)
        }
        return true
      }
      // A clock that jumped backwards must not pin the gate open forever:
      // re-anchor and defer exactly one more window.
      if (now < first) {
        firstDecidedAt.set(id, now)
        return true
      }
      return now - first < settleMs
    },
    clear(id: string): void {
      firstDecidedAt.delete(id)
    },
    size(): number {
      return firstDecidedAt.size
    },
  }
}
