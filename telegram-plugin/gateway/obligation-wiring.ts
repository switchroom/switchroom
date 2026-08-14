/**
 * obligation-wiring.ts — obligation open/close/cancel + the idle sweep
 * (#2996 P8 PR-C2).
 *
 * Extracted VERBATIM from gateway.ts: `closeObligationOnSubstantiveReply`,
 * `openObligationFromInbound`, `cancelInterruptedObligation` and
 * `obligationSweep` (idle-only re-present / escalate driver). STATE stays in
 * gateway.ts — the `ObligationLedger` instance + durable store,
 * `pendingCrossTurnGate`, `obligationEscalateInFlight`, the grace consts, and
 * the escalation NUDGE SEND (the one bot-api touch, kept behind the gateway's
 * retry-policy allowlist and injected as `sendEscalationNudge`). The sweep
 * `setInterval` stays gateway-owned (P0c: modules export the tick body).
 *
 * Never-storm invariants preserved by construction: grace consts injected
 * verbatim; `obligationEscalateInFlight` crosses as the SAME shared Set
 * reference; the represent/escalate guards are the same imported pure modules.
 */
import type { CurrentTurn, ObligationWiringDeps } from './gateway.js'
import type { InboundMessage } from './ipc-protocol.js'
import { shouldTrackDelivery } from './inbound-delivery-confirm.js'
import { deriveTurnId } from './derive-turn-id.js'
import { buildObligationRepresentInbound, type Obligation } from './obligation-ledger.js'
import { driveEscalation } from './escalation-drive.js'
import { shouldSuppressRepresent } from './represent-guard.js'
import { shouldDeferEscalationForBridge } from './escalation-bridge-gate.js'
import {
  answeredSinceOpen,
  createEscalationSettleGate,
  resolveEscalateSettleMs,
  resolveRerouteMatchWindowMs,
} from './escalation-staleness.js'
import { answerRouteOverrides } from './answer-route-overrides.js'
import { parkedTurnStartCount } from './stream-render.js'

export function createObligationWiring(deps: ObligationWiringDeps) {
  const {
    OBLIGATION_LEDGER_ENABLED,
    HISTORY_ENABLED,
    OBLIGATION_BACKGROUND_WORK_GRACE_MS,
    OBLIGATION_ESCALATE_GRACE_MS,
    OBLIGATION_REPRESENT_GRACE_MS,
    OBLIGATION_REPRESENT_MAX,
    OBLIGATION_REPRESENT_GUARD_MIN_REPLY_CHARS,
    OBLIGATION_ESCALATE_MAX,
    OBLIGATION_ESCALATE_SEND_DEADLINE_MS,
    obligationLedger,
    obligationEscalateInFlight,
    pendingCrossTurnGate,
    pendingInboundBuffer,
    capturedResume,
    getCurrentTurn,
    turnInFlightForGate,
    agentHasInFlightBackgroundWork,
    hasOutboundDeliveredSince,
    findTurnByOriginId,
    bridgeAlive,
    sendEscalationNudge,
  } = deps

  // Escalation settle gate (see escalation-staleness.ts). One instance per
  // wiring — the sweep is the only caller, and the gate must remember the FIRST
  // escalate decision for an obligation across sweep ticks.
  const escalateSettleMs = resolveEscalateSettleMs()
  const escalateSettleGate = createEscalationSettleGate(escalateSettleMs)
  // How stale an EXPLICIT_OVERRIDDEN record may be and still license a look in
  // the thread it names. Derived from the settle window, because the decision
  // that consults it is the one AFTER the gate. See escalation-staleness.ts.
  const rerouteMatchWindowMs = resolveRerouteMatchWindowMs(escalateSettleMs)

/**
 * PR2 obligation-ledger CLOSE. Called when a SUBSTANTIVE final answer lands
 * (not a bare interim ack — using finalAnswerSubstantive, the #2141 signal): the
 * obligation discharged is the one for the SAME origin the answer routes to
 * (origin_turn_id the model echoed, else the routed origin the gateway resolved,
 * else the live turn). So 713's reply closes 713's obligation even after
 * currentTurn flipped to 715, and 715 stays open until ITS own substantive
 * answer. Answers to re-presented obligations (via=quoted, no model echo) close
 * via the gateway-resolved routedOriginTurn. An ack does NOT close (so
 * ack-then-ghost is re-presented, not re-dropped). The live-turn fallback fires
 * only for the live turn's OWN obligation (it was the turn delivering this
 * reply), preserving the 713/715 invariant. No-op unless the flag is on.
 *
 * @param routedOriginTurn — the origin the reply router already resolved
 *   (echoedTurn ?? quotedTurn); pass whenever the TURN_ORIGIN_ROUTING path ran.
 *   Skipped when null/undefined (pre-routing paths, or DM with no quote).
 */
function closeObligationOnSubstantiveReply(
  args: Record<string, unknown>,
  liveTurn: CurrentTurn | null | undefined,
  routedOriginTurn?: CurrentTurn | null,
): void {
  if (!OBLIGATION_LEDGER_ENABLED) return
  const echoed = findTurnByOriginId(args.origin_turn_id as string | undefined)
  // routedOriginTurn is the gateway-resolved origin (echoedTurn ?? quotedTurn).
  // Only pass it as routedOriginId when it DIFFERS from the echoed turn (if
  // echoed is present, resolveCloseTarget's first branch already handles it),
  // and only when it is NOT the live turn (live-turn is the fallback, not the
  // routed origin — passing live turn here would bypass the live-turn fallback
  // logic and still close correctly, but naming matters for the 713/715 case:
  // the routed origin on a via=quoted reply IS the origin, not "live fallback").
  const routedOriginId =
    routedOriginTurn != null && echoed == null
      ? routedOriginTurn.turnId
      : null
  const target = obligationLedger.resolveCloseTarget(echoed?.turnId, liveTurn?.turnId, routedOriginId)
  if (target != null) {
    obligationLedger.close(target)
    // The settle gate must forget every terminal, not just the escalate-branch
    // ones, or a closed obligation's entry lives on until FIFO eviction.
    escalateSettleGate.clear(target)
  }
}

/**
 * PR2 obligation-ledger OPEN. Track a fresh user inbound as an unanswered
 * obligation the moment it is received — called BEFORE the buffer-until-idle /
 * deliver split so a mid-turn cross-topic inbound (the 715 case: buffered while
 * another turn runs) is tracked too. Drain paths re-deliver buffered inbounds
 * via sendToAgent (NOT through handleInbound), so handleInbound is the ONLY
 * point that sees every fresh inbound — opening here is mandatory for both
 * branches. Same gate as delivery-tracking (real user turns only; synthetic /
 * steering / `!` interrupt / empty excluded — they have no origin id / need no
 * answer; deriveTurnId null-guards them). Idempotent → opening at buffer-time
 * and any later delivery is safe. No-op unless the flag is on.
 */
function openObligationFromInbound(
  inboundMsg: InboundMessage,
  gate: { isSteering: boolean; isInterrupt: boolean; effectiveText: string },
): void {
  if (!OBLIGATION_LEDGER_ENABLED) return
  if (
    !shouldTrackDelivery({
      isSteering: gate.isSteering,
      isInterrupt: gate.isInterrupt,
      hasSource: inboundMsg.meta?.source != null,
      effectiveText: gate.effectiveText,
    })
  ) {
    return
  }
  const oid = deriveTurnId(inboundMsg.chatId, inboundMsg.threadId, inboundMsg.messageId)
  if (oid == null) return
  obligationLedger.openIfAbsent({
    originTurnId: oid,
    chatId: inboundMsg.chatId,
    threadId: inboundMsg.threadId,
    messageId: inboundMsg.messageId,
    text: inboundMsg.text ?? '',
    openedAt: Date.now(),
  })
}

/**
 * An `!` interrupt SIGINT-kills the in-flight turn. That turn was handling a
 * user message with an open obligation, and the killed turn does NOT reliably
 * emit turn_end (so endCurrentTurnAtomic never closes it) — so without this the
 * obligation survives and the idle sweep later re-presents/escalates "you have
 * an earlier message you never answered" for a question the user EXPLICITLY
 * cancelled. An interrupt is a deliberate redirect, so closing that obligation
 * is the correct terminal (the user chose to interrupt; they can re-ask). Only
 * the interrupted turn's OWN obligation is closed — queued siblings (other open
 * obligations) are untouched. No-op when the flag is off, no turn is in flight,
 * or the turn isn't a tracked obligation (synthetic / already closed).
 */
function cancelInterruptedObligation(): void {
  if (!OBLIGATION_LEDGER_ENABLED) return
  const turn = getCurrentTurn()
  if (turn == null) return
  if (obligationLedger.close(turn.turnId)) {
    escalateSettleGate.clear(turn.turnId)
    process.stderr.write(
      `telegram gateway: obligation cancelled by interrupt origin=${turn.turnId}\n`,
    )
  }
}


// Throttle for the background-work defer diagnostic (the 5s sweep would otherwise
// log every tick across a multi-minute research window).
let lastBgWorkDeferLogMs = 0

function obligationSweep(): void {
  if (!OBLIGATION_LEDGER_ENABLED) return
  if (!obligationLedger.hasOpen()) return
  if (turnInFlightForGate()) return // a turn is running — let it finish/answer
  const agent = process.env.SWITCHROOM_AGENT_NAME ?? ''
  const now = Date.now()
  // Session-busy signal (F2, decision half). A ~5-min silence poke can clear the
  // machine turn (`turnInFlightForGate()` above → false) while the CLI session is
  // STILL producing the answer — stream-render's live-turn mirror (`currentTurn`
  // whose endedAt is null, or a parked turn-start) still knows it is busy. Without
  // this, the sweep decides + buffers a represent mid-answer; the real reply lands
  // seconds later and the model consumes the queued represent → a duplicate answer
  // (the two-authorities-disagree defect). We treat a busy mirror the SAME as
  // in-flight background work: defer the represent, BOUNDED by the same grace, so a
  // wedged/hung session cannot silence a genuinely-unanswered turn forever.
  const liveTurn = getCurrentTurn()
  const sessionBusy = (liveTurn != null && liveTurn.endedAt == null) || parkedTurnStartCount() > 0
  // Background-work grace: while genuine autonomous sub-agent work is in flight
  // (a running worker, or an orphaned foreground sub-agent — neither visible to
  // the turn machine), OR the CLI session is still busy behind a poke-cleared
  // machine turn, an obligation younger than the ceiling is NOT re-presented
  // /escalated. Bounded by OBLIGATION_BACKGROUND_WORK_GRACE_MS (measured from
  // openedAt in decideAtIdle) so escalation always eventually fires. =0 disables it.
  const backgroundWorkActive =
    OBLIGATION_BACKGROUND_WORK_GRACE_MS > 0 &&
    (agentHasInFlightBackgroundWork(now) || sessionBusy)
  // Grace window: skip an obligation whose handling turn ended < grace ago — its
  // trailing slow/worker answer may still be landing (over-escalation fix).
  // Per-represent grace: skip an obligation re-presented < grace ago — prevents
  // the 5s sweep from immediately firing again before the re-present even lands.
  const decision = obligationLedger.decideAtIdle(
    OBLIGATION_ESCALATE_GRACE_MS > 0 || backgroundWorkActive || OBLIGATION_REPRESENT_GRACE_MS > 0
      ? {
          now,
          graceMs: OBLIGATION_ESCALATE_GRACE_MS,
          backgroundWorkActive,
          backgroundGraceMs: OBLIGATION_BACKGROUND_WORK_GRACE_MS,
          representGraceMs: OBLIGATION_REPRESENT_GRACE_MS,
        }
      : undefined,
  )
  const o = decision.obligation
  if (decision.action === 'none' || o == null) {
    if (backgroundWorkActive && obligationLedger.hasOpen() && now - lastBgWorkDeferLogMs > 60_000) {
      lastBgWorkDeferLogMs = now
      process.stderr.write(
        `telegram gateway: obligation sweep deferred — in-flight autonomous sub-agent work ` +
          `or busy CLI session behind a poke-cleared turn ` +
          `(${obligationLedger.size()} open, bounded ${Math.round(OBLIGATION_BACKGROUND_WORK_GRACE_MS / 60_000)}m from receipt)\n`,
      )
    }
    return
  }
  if (decision.action === 'represent') {
    // Fix #2472 — duplicate-represent guard. Before re-presenting AGAIN, check
    // whether the agent has ALREADY delivered a substantive outbound reply to
    // this chat SINCE the obligation was most recently re-presented. If so the
    // obligation is satisfied-but-misdetected (the reply landed but its routing
    // didn't resolve back to this origin, so the normal close path missed it) —
    // close silently and do NOT re-fire, which is what produced the near-identical
    // duplicate in #2472 (reply 10608 answered represent_count=1, yet
    // represent_count=2 fired anyway → duplicate 10609).
    //
    // The cutoff is `lastRepresentedAt` (the time of the PREVIOUS represent), NOT
    // `openedAt`. This is load-bearing: the genuine "agent wrote a plain-text
    // answer and never called reply" case must still represent ONCE. On the first
    // represent `lastRepresentedAt` is undefined, so this guard is a no-op and the
    // single represent fires as before. Only the SECOND-and-later represent is
    // gated — exactly where a reply that landed between fires must suppress the
    // re-ask. Falls back to false (never suppresses) if history is unavailable.
    if (
      shouldSuppressRepresent(o, {
        historyEnabled: HISTORY_ENABLED,
        // Pass the represent-guard's OWN low threshold — a terse-but-real reply
        // must suppress the duplicate (#2472/#2474), unlike the escalate branch
        // below which keeps the 200-char default.
        hasOutboundDeliveredSince: (chatId, sinceMs, threadId) =>
          hasOutboundDeliveredSince(
            chatId,
            sinceMs,
            threadId,
            OBLIGATION_REPRESENT_GUARD_MIN_REPLY_CHARS,
          ),
      })
    ) {
      process.stderr.write(
        `telegram gateway: obligation closed silently — reply delivered since last represent (no re-fire) origin=${o.originTurnId}\n`,
      )
      escalateSettleGate.clear(o.originTurnId)
      obligationLedger.close(o.originTurnId)
      return
    }
    // #3282 — source-aware represent: a captured snapshot ⇒ resume the non-confirmed tail byte-identically; no snapshot ⇒ the fresh-generation represent below.
    if (o.capturedDelivery != null) { capturedResume.dispatch(o); return }
    // Re-present goes through the bridge → buffer. Only the represent path is
    // gated on an empty buffer (let the existing drain run first, avoid
    // double-presenting). Escalation below is NOT gated on the buffer — it is a
    // direct Telegram send, independent of the bridge, so a represent stranded
    // behind a dead bridge can never block the operator nudge.
    if (pendingInboundBuffer.depth(agent) > 0) return
    pendingInboundBuffer.push(agent, buildObligationRepresentInbound(o, Date.now()))
    // PR1 (cross-turn stale-card guard, §9 lever 4 / race C/D). Arm the
    // card-OPEN gate for the synthetic turn this represent inbound will spawn:
    // carry the obligation's `openedAt` so that turn's first card-OPEN can ask
    // "was a substantive answer already delivered since the obligation was
    // raised?" and, if so, suppress the card (it would otherwise narrate beneath
    // the answer the user already received). Keyed on the obligation's
    // `originTurnId` — the SAME id the represent inbound carries
    // (`buildObligationRepresentInbound` reuses `o.messageId`/`o.chatId`/
    // `o.threadId`, so the enqueue-time `deriveTurnId` reconstructs exactly
    // `o.originTurnId`). Keying on the turn id (not chat/thread) means ONLY the
    // exact represent turn this gate was armed for can consume it; an unrelated
    // later foreground turn on the same chat/thread has a different originTurnId
    // → finds no entry → its card opens normally. This closes the residual
    // cross-contamination window where a never-enqueued represent's stale gate
    // could suppress an unrelated turn's card (the represent/duplicate-reply
    // family). This does NOT gate the represent SEND — the represent guard above
    // already owns suppressing an already-satisfied represent; this only governs
    // the decorative card.
    pendingCrossTurnGate.set(o.originTurnId, { sinceMs: o.openedAt })
    const attempt = obligationLedger.markRepresented(o.originTurnId)
    process.stderr.write(
      `telegram gateway: obligation re-presented origin=${o.originTurnId} attempt=${attempt}/${OBLIGATION_REPRESENT_MAX}\n`,
    )
    return
  }
  // escalate — re-present ladder exhausted. Before sending the user-visible
  // apology, check whether the agent has ALREADY delivered an outbound reply
  // to this chat since the obligation was opened. If yes, the obligation is
  // stale (the agent did answer, just without closing the obligation via the
  // normal close path) — close silently instead of alarming the user with a
  // false "I may have missed this". This is Fix 4: escalate only on knowledge,
  // not doubt. Fall back to false (safe: never suppresses) if history unavailable.
  //
  // #2788 Gap A — bridge-flap gate. The escalate branch DIRECT-SENDS (via
  // bot.api.sendMessage below), bypassing the bridge. So while the bridge is
  // down the represent branch is naturally stranded (bridge → buffer) but this
  // branch would still fire a false "I may have missed this", even though the
  // real reply is merely queued behind a transient outage. Defer: if the bridge
  // is not alive, leave the obligation OPEN and re-drive on a later sweep once
  // it recovers. Obligations survive bridge death (durable ledger, re-evaluated
  // every sweep), so this deferral adds NO unbounded liveness dependency — the
  // whole gateway already rests on the bridge eventually reconnecting.
  if (shouldDeferEscalationForBridge({ bridgeAlive: bridgeAlive(agent) })) {
    process.stderr.write(
      `telegram gateway: obligation escalation deferred — bridge down (nudge waits for reconnect) origin=${o.originTurnId}\n`,
    )
    return
  }
  // SCOPE: the obligation's own topic, PLUS — only while the router's
  // `EXPLICIT_OVERRIDDEN(model→N,routed→M)` record is still FRESH, and only
  // across that record's own instant + the match window — the topic it names.
  // Deliberately neither chat-wide, nor cut at `openedAt`, nor open-ended
  // forward: all three close a genuinely unanswered obligation in silence. Field
  // evidence for each in escalation-staleness.ts.
  //
  // FRESHNESS ANCHOR: the settle gate's `firstAt` for this obligation when a
  // window is already open, else this decision's `now`. NOT the re-check
  // instant — every gate above (`turnInFlightForGate`, the background-work /
  // session-busy defer, the escalate and represent graces) can SKIP sweep ticks
  // outright, so the decision that consults the record may run minutes after the
  // one that deferred, and a record that was fresh when the question was first
  // asked would read as stale purely because the sweep was starved. That same
  // starvation is why the DELIVERY needs its own upper bound: the anchor makes
  // the override read fresh at a re-check minutes later, and without a forward
  // bound it would then reach the whole of that gap. See `#4681` / form (iii).
  const answered = answeredSinceOpen(o, {
    historyEnabled: HISTORY_ENABLED,
    hasOutboundDeliveredSince,
    // The reroute fallback's query, bounded at BOTH ends. `minChars` stays at
    // the history default (200 — the escalate branch's substantive floor); only
    // the upper time bound is added.
    hasOutboundDeliveredBetween: (chatId, sinceMs, untilMs, threadId) =>
      hasOutboundDeliveredSince(chatId, sinceMs, threadId, undefined, untilMs),
    routeOverrides: answerRouteOverrides,
    anchorMs: escalateSettleGate.firstAt(o.originTurnId, o.openedAt) ?? now,
    rerouteMatchWindowMs: rerouteMatchWindowMs,
  })
  if (answered.answered) {
    // The two scopes log DISTINGUISHABLY: a `via=reroute` close is the widened
    // path, so its blast radius is measurable in production without a rebuild.
    const scope =
      answered.via === 'reroute'
        ? `via=reroute routed_thread=${answered.routedThreadId ?? '-'}`
        : 'via=thread'
    process.stderr.write(
      `telegram gateway: obligation closed silently — outbound delivered since open ${scope} origin=${o.originTurnId}\n`,
    )
    escalateSettleGate.clear(o.originTurnId)
    obligationLedger.close(o.originTurnId)
    return
  }
  if (answered.staleOverrideAgeMs != null) {
    // NEGATIVE-PATH telemetry for the freshness bound. A reroute WAS on record
    // for this obligation and the bound threw it away — indistinguishable from
    // "no reroute at all" without this line, which makes the bound (the whole
    // correctness argument for the fallback) unmeasurable in production. A near
    // miss here is the signal that the window is mis-tuned.
    process.stderr.write(
      `telegram gateway: obligation reroute record rejected age=${answered.staleOverrideAgeMs}ms ` +
        `window=${rerouteMatchWindowMs}ms origin=${o.originTurnId}\n`,
    )
  }
  // SETTLE. The check above is a point-in-time read, and the answer is often
  // still IN FLIGHT at this instant (reply tool invoked, history row not yet
  // written) — confirmed lags of 1.23s and 2.81s between this decision and the
  // answer landing. Defer the first decision and re-check on a later sweep, so
  // the nudge only goes out when "unanswered" held across the settle window.
  // Bounded: a genuinely unanswered obligation escalates one window later.
  if (escalateSettleGate.shouldDefer(o.originTurnId, now, o.openedAt)) {
    process.stderr.write(
      `telegram gateway: obligation escalation deferred — settling (re-checking for an in-flight answer) origin=${o.originTurnId}\n`,
    )
    return
  }
  // Proceed with escalation: send ONE operator-visible nudge and close the
  // obligation ONLY AFTER it actually lands. This inverts the old
  // close-before-send (which silently dropped the terminal whenever the send
  // failed): the close is now itself an observable terminal. A transient send
  // failure leaves the obligation OPEN → retried next sweep; a PERMANENT one
  // (dead topic even after thread-fallback, blocked bot) is bounded by
  // OBLIGATION_ESCALATE_MAX → close best-effort (the user is unreachable, so a
  // bounded give-up beats an infinite loop / a boot-surviving poison record).
  // Drive one escalation attempt. The send is a direct Telegram nudge
  // (retryWithThreadFallback: a stale/renumbered topic → THREAD_NOT_FOUND retries
  // thread-less, the #2096 pattern). driveEscalation guards against concurrent
  // sends, bounds the send with withDeadline (so a hung send can't leak the
  // in-flight flag and wedge the obligation OPEN), closes only after a successful
  // send, and bounds permanent failures to a best-effort close. Extracted so the
  // hang → bounded → terminal path is executable in escalation-drive.test.ts —
  // the path neither mtcute (can't hang Telegram) nor a synchronous test reaches.
  void driveEscalation({
    escId: o.originTurnId,
    inFlight: obligationEscalateInFlight,
    ledger: obligationLedger,
    // The nudge send stays in gateway.ts (it owns the bot handle + the
    // bot-api retry-policy allowlist); this module only decides WHEN it fires.
    send: () => sendEscalationNudge(o),
    maxAttempts: OBLIGATION_ESCALATE_MAX,
    deadlineMs: OBLIGATION_ESCALATE_SEND_DEADLINE_MS,
  })
  // Terminal for this settle episode. A send that FAILS leaves the obligation
  // open and re-drives on a later sweep; that retry then opens its own fresh
  // settle window, which is the same "re-check before nagging" guarantee, not a
  // regression. Keeps the gate map from retaining closed obligations.
  escalateSettleGate.clear(o.originTurnId)
}

  return {
    closeObligationOnSubstantiveReply,
    openObligationFromInbound,
    cancelInterruptedObligation,
    obligationSweep,
  }
}
