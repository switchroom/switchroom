/**
 * escalation-staleness.ts — the two guards that stand an obligation ESCALATION
 * down when the agent has, in fact, already answered.
 *
 * The escalate branch of the obligation sweep sends a user-visible
 * "⚠️ I may have missed an earlier message" nudge. That nudge is only correct
 * when the agent genuinely never answered. Two mechanisms in the pre-fix code
 * let it fire on top of an answer the user had already received. Both are
 * reproduced from a production `gateway-supervisor.log` (the chat id and the
 * message bodies are deliberately NOT reproduced here — only thread ids,
 * message numbers and timings, which is all the derivation needs):
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
 *      NOT a chat-wide fallback, and NOT an open-ended one. Both weaker forms
 *      were tried on this branch and both silently drop a real message:
 *
 *      (i) CHAT-WIDE ("did anything long land in this chat since openedAt") has
 *      no relationship to the obligation beyond the chat id, so in a busy forum
 *      it closes an obligation in topic A because an unrelated answer landed in
 *      topic B. The repo already states that principle for the sibling
 *      predicate (`turn-flush-suppression.ts`, "a background worker's
 *      progress_update … or a reply in a DIFFERENT forum topic all suppressed
 *      the flush, and the branch then CLOSED the delivery obligation — the
 *      user's real answer was dropped").
 *
 *      (ii) OVERRIDE-GATED BUT CUT AT `openedAt` — "an override to topic M
 *      exists, therefore accept anything ≥200 chars ever delivered in M since
 *      this obligation opened" — is the same defect wearing a gate. The override
 *      proves a reroute HAPPENED; it says nothing about a delivery minutes
 *      later. The counter-example is 2026-08-13 obligation `…:4#5462`
 *      (thread 4, opened 03:50:02.807, escalated 04:03:06.140). Its window
 *      contains THREE `EXPLICIT_OVERRIDDEN(model→4,routed→3)` records
 *      (03:50:44.201, 03:51:43.108, 03:53:11.225) AND a later, unrelated 295-char
 *      delivery in thread 3 at 04:02:51.987 answering a DIFFERENT question
 *      (`via=origin` to turn `…:3#5480`). Cut at `openedAt`, the fallback pairs
 *      the stale override with that unrelated delivery and closes topic 4's
 *      genuinely-unanswered message in silence — pre-fix this escalates
 *      correctly, so that shape is a REGRESSION, not a fix.
 *
 *      So the fallback's cutoff is the OVERRIDE'S OWN `atMs`, and an override is
 *      only consulted while it is fresh (`resolveRerouteMatchWindowMs`). An
 *      override licenses a look for the answer THAT routing produced, in the
 *      moments after it — nothing more. On 2026-08-13 the newest override is
 *      594.9 s stale at the decision, so no fallback runs at all and the
 *      escalation fires, as it must.
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
 * Slack added to the settle window to get the reroute-match window (below).
 *
 * Two 5,000 ms sweep ticks. The window is measured from the settle gate's own
 * `firstAt` — the instant the decision FIRST read "unanswered" — so this slack
 * only has to cover the jitter between the routing decision and that first
 * read: the sweep runs on a 5,000 ms interval, and the read can land anywhere
 * inside a tick, so one tick of phase plus one more for a busy tick.
 *
 * It deliberately does NOT have to cover the gap to the RE-check. That gap is
 * unbounded in principle — the sweep's earlier gates (`turnInFlightForGate`,
 * the background-work / session-busy defer, and the escalate/represent graces)
 * can SKIP ticks entirely, not merely delay them, for minutes at a time — which
 * is exactly why the anchor is `firstAt` and not the re-check's `now`. See
 * `EscalationSettleGate.firstAt`.
 */
export const REROUTE_MATCH_GRACE_MS = 10_000

/**
 * Hard ceiling on the reroute-match window.
 *
 * Same reasoning as `OBLIGATION_ESCALATE_SETTLE_MS_MAX`, mirrored for the other
 * direction of harm: a fat-fingered `SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS`
 * widens the window in which an unrelated delivery can be mistaken for this
 * obligation's rerouted answer — i.e. it widens the SILENT-CLOSE exposure, the
 * one failure this module treats as unacceptable. The ceiling is the largest
 * value the derivation itself can ever produce (the clamped maximum settle
 * window plus the grace), so every legitimate tuning fits under it and anything
 * above it is a typo. Clamped, not rejected, for the same reason as the settle
 * ceiling: a clamped guard still guards.
 */
export const OBLIGATION_REROUTE_MATCH_MS_MAX =
  OBLIGATION_ESCALATE_SETTLE_MS_MAX + REROUTE_MATCH_GRACE_MS

/**
 * How stale an `EXPLICIT_OVERRIDDEN` record may be and still license a look in
 * the thread it names.
 *
 * This bound is the whole correctness argument for the reroute fallback, so it
 * is derived, not picked. Staleness is measured from the settle gate's
 * `firstAt`, so a legitimate override is at most `settleMs` old (the answer was
 * in flight when that first decision deferred), plus up to two sweep ticks of
 * scheduling slack — `REROUTE_MATCH_GRACE_MS`. At the default that is
 * 8,500 + 10,000 = 18,500 ms.
 *
 * Both justifying incidents sit far inside it (2026-08-10 06:36 override
 * :07.921 → delivery :09.281 = 1.36 s; 07:52 override :36.026 → delivery
 * :37.209 = 1.18 s), and the counter-example sits far outside it (2026-08-13
 * newest override 03:53:11.225 → the unrelated delivery at 04:02:51.987 =
 * 594.8 s, a 32× margin over the window). Nothing observed lives in between.
 *
 * KILL SWITCH: `SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS=0` disables the reroute
 * fallback entirely (thread scope only — pre-fix behaviour for this half of the
 * fix). It is its OWN switch: `SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS=0`
 * disables the settle gate and NOTHING ELSE. The fallback needs one because it
 * is the only mechanism here that can close a genuinely unanswered obligation
 * silently; the settle gate can only ever DELAY a nudge. A non-numeric or
 * negative value falls back to the derivation rather than silently disabling or
 * widening the guard; a value above `OBLIGATION_REROUTE_MATCH_MS_MAX` is
 * clamped.
 *
 * RESIDUAL, stated plainly: within the window the fallback still cannot tell
 * the rerouted answer from a second ≥200-char delivery that lands in the same
 * thread in those few seconds — the override carries no message id to tie it to
 * one row. The window is what bounds that exposure; it is not eliminated.
 */
export function resolveRerouteMatchWindowMs(
  settleMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const derived = Math.max(settleMs, 0) + REROUTE_MATCH_GRACE_MS
  const raw = env.SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS
  if (raw == null || raw === '') return derived
  const n = Number(raw)
  if (!(Number.isFinite(n) && n >= 0)) return derived
  return Math.min(n, OBLIGATION_REROUTE_MATCH_MS_MAX)
}

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
  routeOverrides: Pick<AnswerRouteOverrides, 'routedOverridesSince' | 'newestOverrideSince'>
  /**
   * The instant the freshness window is measured BACK from — the settle gate's
   * `firstAt` for this obligation when a settle window is already open, else
   * this decision's `now`.
   *
   * NOT the re-check instant. The sweep's earlier gates can skip ticks outright
   * (an in-flight turn is unbounded; the background-work/session-busy defer is
   * bounded at 20 min; the escalate and represent graces add tens of seconds),
   * so the decision that consults the override record can run minutes after the
   * one that deferred. Anchored at `now`, a record that was fresh when the
   * question "has this been answered?" was FIRST asked reads as stale purely
   * because the sweep was starved — and the nudge fires on top of the answer.
   * Anchored at `firstAt`, the window means what its derivation says it means.
   */
  anchorMs: number
  /** How stale an override may be — `resolveRerouteMatchWindowMs(settleMs)`.
   *  `<= 0` disables the reroute fallback entirely (kill switch). */
  rerouteMatchWindowMs: number
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
  /**
   * Age (relative to `anchorMs`) of the NEWEST override the freshness bound
   * rejected, when the fallback found nothing AND a record for this obligation
   * existed. Absent when there was simply no record.
   *
   * Negative-path telemetry: without it "no reroute on record" and "a reroute
   * was on record and the bound threw it away" are the same silent result, and
   * the bound — which is the whole correctness argument for the fallback — is
   * unmeasurable in production. The caller logs it.
   */
  staleOverrideAgeMs?: number
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
 *      (`EXPLICIT_OVERRIDDEN(model→N,routed→M)`), and only for as long as that
 *      record is FRESH (`rerouteMatchWindowMs` before `nowMs`). Each override is
 *      queried from ITS OWN `atMs`, never from `openedAt`: the record licenses a
 *      look for the answer that routing produced, not for anything the thread
 *      has carried since the obligation opened. No fresh override ⇒ no second
 *      query ⇒ an unrelated message in another topic can never stand this
 *      escalation down. Both weaker cutoffs are counter-exampled in the module
 *      header with the log lines that break them.
 *
 * Both scopes keep the caller's substantive-length floor (200 chars in the
 * escalate branch, so a bare ack never stands an escalation down), and neither
 * can ever reach back past `openedAt`.
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
  // Kill switch. A zero/negative window means "no reroute fallback at all", not
  // "a zero-width window an override recorded at this very instant slips
  // through" — an off-switch that still fires for one timing is not one.
  if (!(deps.rerouteMatchWindowMs > 0)) return NOT_ANSWERED
  // Freshness floor: never older than the window (measured back from the FIRST
  // "unanswered" read — see `anchorMs`), and never before the obligation
  // existed. A stale override licenses nothing.
  const notBefore = Math.max(o.openedAt, deps.anchorMs - deps.rerouteMatchWindowMs)
  for (const ovr of deps.routeOverrides.routedOverridesSince(o.chatId, o.threadId, notBefore)) {
    // `routedThreadId` is already the history's thread semantics: a number for a
    // topic, `null` for the chat root (`thread_id IS NULL`). Never `undefined`,
    // which would re-open the chat-wide any-thread query this guard avoids.
    // The cutoff is the override's OWN instant — see the module header for the
    // incident that an `openedAt` cutoff regresses.
    const since = Math.max(ovr.atMs, o.openedAt)
    if (deps.hasOutboundDeliveredSince(o.chatId, since, ovr.routedThreadId)) {
      return { answered: true, via: 'reroute', routedThreadId: ovr.routedThreadId }
    }
  }
  // Nothing matched. Distinguish "no record" from "a record the bound rejected"
  // so the bound is observable in production (the caller logs the age).
  const newest = deps.routeOverrides.newestOverrideSince(o.chatId, o.threadId, o.openedAt)
  if (newest != null && newest.atMs < notBefore) {
    return { answered: false, via: null, staleOverrideAgeMs: Math.max(0, deps.anchorMs - newest.atMs) }
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
  /**
   * The instant this obligation's OPEN settle window started — the decision that
   * first read "not answered" for this episode. `undefined` when no window is
   * open for `id` (first decision, gate disabled, or the entry was evicted).
   *
   * This is the freshness anchor for the reroute fallback (`anchorMs`). Read
   * BEFORE `shouldDefer`, so the first decision anchors at its own `now` and
   * every re-check anchors at that same instant however many ticks were skipped
   * in between. `openedAt` is matched for the same reason `shouldDefer` matches
   * it: a re-opened obligation under the same origin id must not inherit the
   * previous episode's anchor.
   *
   * Fails in the safe direction: no entry ⇒ the caller anchors at `now`, which
   * can only make an override look OLDER, i.e. over-escalate.
   */
  firstAt(id: string, openedAt: number): number | undefined
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
    firstAt(id: string, openedAt: number): number | undefined {
      const prev = entries.get(id)
      if (prev == null || prev.openedAt !== openedAt) return undefined
      return prev.firstAt
    },
    clear(id: string): void {
      entries.delete(id)
    },
    size(): number {
      return entries.size
    },
  }
}
