/**
 * escalation-staleness.ts — the two guards that stand an obligation ESCALATION
 * down when the agent has, in fact, already answered.
 *
 * The escalate branch of the obligation sweep sends a user-visible
 * "⚠️ I may have missed an earlier message" nudge. That nudge is only correct
 * when the agent genuinely never answered. Two mechanisms in the pre-fix code
 * let it fire on top of an answer the user had already received. Both are
 * reproduced from marko's `gateway-supervisor.log`, chat `-100…471` (the chat id
 * and the message bodies are deliberately NOT reproduced here — only ids,
 * topics and timings, which is all the derivation needs):
 *
 *   1. REROUTED ANSWER. The staleness check was keyed on the obligation's
 *      `threadId`. When the model names a topic on its `reply` and the
 *      framework's topic authority overrides it — the router logs exactly this,
 *      `EXPLICIT_OVERRIDDEN(model→N,routed→M)` — the answer is written to
 *      history under thread M while the obligation lives under thread N, so a
 *      thread-N query can never see it.
 *
 *      2026-08-10 06:36:07.921, obligation `…:4#5191` (thread 4):
 *      `EXPLICIT_OVERRIDDEN(model→4,routed→635)` — the model was answering the
 *      thread-4 obligation, the answer went to thread 635, and the nag fired
 *      126 ms later at 06:36:08.047.
 *      2026-08-10 07:52:36.026, obligation `…:3#5200` (thread 3):
 *      `EXPLICIT_OVERRIDDEN(model→3,routed→-)` — answer written with
 *      `thread_id IS NULL`; the nag had already fired at 07:52:34.400.
 *
 *      Fix: `answeredSinceOpen` keeps the thread scope and adds a fallback to
 *      the threads an answer ADDRESSED TO THIS OBLIGATION'S TOPIC was actually
 *      routed to, read from the router's own override record
 *      (`answer-route-overrides.ts`).
 *
 *      NOT a chat-wide fallback. A chat-wide "did anything long land since
 *      openedAt" query has no relationship to the obligation beyond the chat id,
 *      and in a busy forum it silently closes an obligation in topic A because
 *      an unrelated answer landed in topic B — dropping the user's message with
 *      no nudge and no re-present. The repo already states that principle for
 *      the sibling predicate (`turn-flush-suppression.ts`, "a background
 *      worker's progress_update … or a reply in a DIFFERENT forum topic all
 *      suppressed the flush, and the branch then CLOSED the delivery obligation
 *      — the user's real answer was dropped"). The field data agrees: on
 *      2026-08-13 obligation `…:4#5462` (thread 4) escalated at 04:03:06.140
 *      after a 292-char answer landed at 04:02:50.521 — but that answer was
 *      `via=origin` to turn `…:3#5480`, a DIFFERENT question in topic 3, and no
 *      override was logged in the whole represent→escalate window. Topic 4's
 *      message was genuinely unanswered. A chat-wide fallback would have closed
 *      it silently; the override-gated fallback correctly declines to.
 *
 *   2. NO SETTLE. The check is a point-in-time read of history, but the answer
 *      is frequently still IN FLIGHT at the instant the sweep decides: the reply
 *      tool has been invoked (or is about to be) and its history row does not
 *      exist yet. Same two 2026-08-10 incidents: 06:36 (reply invoked :07.919,
 *      escalation decided :08.047, answer delivered :09.281 — 1.23 s AFTER the
 *      decision) and 07:52 (decision :34.400, reply invoked :36.026, delivered
 *      :37.209 — 2.81 s after). A backward-looking widening of the cutoff cannot
 *      fix this: the cutoff is already `openedAt`, minutes in the past, so a
 *      delivered row would have matched. The row simply is not there yet. Fix:
 *      `createEscalationSettleGate` requires the staleness check to have read
 *      "not answered" ACROSS a settle window before the nudge is allowed out —
 *      the escalation is deferred once, re-checked on a later sweep, and only
 *      sent if the answer still has not landed.
 *
 * Both incidents needed BOTH guards: each answer was rerouted AND still in
 * flight at the decision instant, so neither guard alone suppresses either nag.
 *
 * Both guards are deliberately bounded: the settle gate delays a genuine
 * escalation by the settle window and no more, the reroute fallback only looks
 * where the router says this topic's answer went, and both keep the caller's
 * substantive-length floor — so an escalation for a genuinely unanswered
 * message still fires.
 */
import type { AnswerRouteOverrides } from './answer-route-overrides.js'

/**
 * Escalation settle window, in milliseconds.
 *
 * Derived from the observed decision→delivery lag on the confirmed false
 * escalations where the answer was in flight at decision time:
 *
 *   - 2026-08-10 06:36:08.047 decision → 06:36:09.281 delivery = 1,234 ms
 *   - 2026-08-10 07:52:34.400 decision → 07:52:37.209 delivery = 2,809 ms
 *
 * The window must (a) exceed the WORST observed lag with real margin — a send
 * can additionally sit behind the per-chat send-gate pacing — and (b) span at
 * least one 5,000 ms sweep tick, or no re-check ever runs and the gate is a pure
 * delay. 3 × 2,809 = 8,427 ms, rounded up to the nearest 500 ms → 8,500 ms,
 * which satisfies both.
 *
 * The upper bound is the genuinely-unanswered case that MUST still escalate:
 * 2026-08-12 09:08:14.524 decision → the agent's real answer at 09:08:56 =
 * 41,331 ms. 8,500 ms sits 4.9× below that, so a settle re-check cannot swallow
 * it.
 *
 * Kill switch: 0 disables the gate (pre-fix, escalate on the first decision).
 */
export const OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT = 8_500

/**
 * Hard ceiling on the settle window.
 *
 * The gate trades a bounded DELAY of a genuine nudge for suppression of a false
 * one, and that trade is only honest while the delay stays small next to the
 * ladder that precedes it. A fat-fingered
 * `SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS=85000000` would otherwise silently
 * suppress every escalation for a day — a config typo turning a guard into an
 * outage. 60 s is ~7× the derived default and still well under the represent
 * ladder's own minutes-long cadence, so any legitimate tuning fits under it and
 * anything above it is a typo, not an intent. Values above the ceiling are
 * CLAMPED (not rejected): clamping keeps the guard working, whereas falling back
 * to the default would silently ignore a deliberate 90 s choice.
 */
export const OBLIGATION_ESCALATE_SETTLE_MS_MAX = 60_000

/**
 * Resolve the settle window from the environment.
 *
 * Lives here rather than beside the other obligation constants in gateway.ts:
 * that file is under the anti-inflation line ratchet (#2996 P0.5) with zero
 * headroom, and the ratchet's whole point is that new logic lands in a module.
 * `SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS=0` is the kill switch (pre-fix
 * behaviour: escalate on the first decision); a non-numeric or negative value
 * falls back to the default rather than silently disabling the guard; a value
 * above `OBLIGATION_ESCALATE_SETTLE_MS_MAX` is clamped to it.
 */
export function resolveEscalateSettleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS
  if (raw == null || raw === '') return OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT
  const n = Number(raw)
  if (!(Number.isFinite(n) && n >= 0)) return OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT
  return Math.min(n, OBLIGATION_ESCALATE_SETTLE_MS_MAX)
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
  /** The router's explicit-thread override record (answer-route-overrides.ts). */
  routeOverrides: Pick<AnswerRouteOverrides, 'routedThreadsSince'>
}

export interface EscalationStalenessObligation {
  chatId: string
  openedAt: number
  threadId?: number | null
}

/** How the answer was found — carried into the sweep's log so a reroute-scope
 *  hit is distinguishable from a plain same-topic hit in production. */
export type AnsweredVia = 'thread' | 'reroute'

export interface AnsweredSinceOpenResult {
  answered: boolean
  via: AnsweredVia | null
  /** The thread the reroute-scope hit was found in. Only set when `via` is 'reroute'. */
  routedThreadId?: number | null
}

/**
 * True when a substantive outbound that can be tied to THIS obligation was
 * delivered since it was opened — i.e. the agent answered and the nudge would be
 * redundant.
 *
 * Two scopes, in order:
 *
 *   1. THREAD — the obligation's own topic. The precise, pre-existing check.
 *      (An obligation with `threadId === undefined` — a DM, or a turn the
 *      gateway never resolved a topic for — has always meant "any thread" to
 *      `hasOutboundDeliveredSince`; that is unchanged.)
 *   2. REROUTE — only the topics the router RECORDED an answer addressed to this
 *      obligation's topic as having been routed to
 *      (`EXPLICIT_OVERRIDDEN(model→N,routed→M)`, since `openedAt`). No override
 *      on record ⇒ no second query ⇒ an unrelated message in another topic can
 *      never stand this escalation down. See the module header for the field
 *      case where a chat-wide fallback would have got that wrong.
 *
 * Both scopes keep the caller's substantive-length floor (200 chars in the
 * escalate branch, so a bare ack never stands an escalation down) and the
 * `openedAt` cutoff.
 *
 * Falls back to "not answered" (never suppresses) when history is unavailable.
 */
export function answeredSinceOpen(
  o: EscalationStalenessObligation,
  deps: EscalationStalenessDeps,
): AnsweredSinceOpenResult {
  const NOT_ANSWERED: AnsweredSinceOpenResult = { answered: false, via: null }
  if (!deps.historyEnabled) return NOT_ANSWERED
  if (deps.hasOutboundDeliveredSince(o.chatId, o.openedAt, o.threadId)) {
    return { answered: true, via: 'thread' }
  }
  for (const routed of deps.routeOverrides.routedThreadsSince(o.chatId, o.threadId, o.openedAt)) {
    // `routed` is already the history's thread semantics: a number for a topic,
    // `null` for the chat root (`thread_id IS NULL`). Never `undefined`, which
    // would re-open the chat-wide any-thread query this guard exists to avoid.
    if (deps.hasOutboundDeliveredSince(o.chatId, o.openedAt, routed)) {
      return { answered: true, via: 'reroute', routedThreadId: routed }
    }
  }
  return NOT_ANSWERED
}

export interface EscalationSettleGate {
  /**
   * Called each time the sweep reaches the escalate decision for `id` and the
   * staleness check said "not answered". Returns true to DEFER (leave the
   * obligation open; a later sweep re-checks), false to proceed with the nudge.
   *
   * `openedAt` is the obligation's open instant, carried as an EPOCH: an
   * obligation closed and later RE-OPENED under the same origin turn id gets a
   * new `openedAt`, and a mismatch resets the window — so a stale entry from the
   * previous episode can never let the new one's first escalation skip its
   * re-check.
   */
  shouldDefer(id: string, now: number, openedAt: number): boolean
  /** Forget `id` — call on EVERY obligation terminal (silent close, cancel,
   *  escalation driven), so the map never retains closed obligations. */
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
 * The id map is bounded and evicted oldest-INSERTED-first (FIFO — entries are
 * not re-inserted on access, so this is deliberately not an LRU) so a long-lived
 * gateway cannot grow it without limit. Ids are per-obligation origin turn ids,
 * so an evicted entry can only ever cost one extra settle window, never a wrong
 * decision for another obligation.
 */
export function createEscalationSettleGate(
  settleMs: number,
  maxKeys = 256,
): EscalationSettleGate {
  const entries = new Map<string, { firstAt: number; openedAt: number }>()
  return {
    shouldDefer(id: string, now: number, openedAt: number): boolean {
      if (!(settleMs > 0)) return false
      const prev = entries.get(id)
      // Absent, or belonging to a PREVIOUS episode of the same origin id →
      // start a fresh window.
      if (prev == null || prev.openedAt !== openedAt) {
        entries.set(id, { firstAt: now, openedAt })
        while (entries.size > maxKeys) {
          const oldest = entries.keys().next().value
          if (oldest === undefined) break
          entries.delete(oldest)
        }
        return true
      }
      // A clock that jumped backwards must not pin the gate open forever:
      // re-anchor and defer exactly one more window.
      if (now < prev.firstAt) {
        entries.set(id, { firstAt: now, openedAt })
        return true
      }
      return now - prev.firstAt < settleMs
    },
    clear(id: string): void {
      entries.delete(id)
    },
    size(): number {
      return entries.size
    },
  }
}
