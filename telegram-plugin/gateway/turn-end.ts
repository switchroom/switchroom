/**
 * turn-end.ts — the turn-END funnel + drain chokepoint (#2996 P8 PR-B).
 *
 * Extracted VERBATIM from gateway.ts (the 4757-5271 family): the canonical
 * `endCurrentTurnAtomic` funnel, the fallback `purgeReactionTracking` purge
 * (incl. the M2 pending-restart drain in its idle tail), the narrow
 * `releaseTurnBufferGate` first-reply release, and the buffer-drain chokepoint
 * (`performBufferDrain` / `drainBufferedIfAllowed` / `armNoReplyDrainTimer`).
 *
 * DI contract (the stream-render precedent): STATE stays in gateway.ts; this
 * module owns only the logic. All mutable stores, live singletons and
 * gateway-bound helpers arrive through `TurnEndDeps`
 * (`gatewayTurnEndDeps()` in gateway.ts — exact-by-construction via
 * `ReturnType`). Volatile reads (`currentTurn`, `inboundSpool`, `ipcServer`)
 * cross as GETTERS so every call sees the live value; `endingTurn` stays a
 * passed value (design §3 PR-B risk row). Pure decision helpers are imported
 * directly — they are already extracted modules with their own suites.
 *
 * P9 note (clusters B/D): the module-scope `currentTurn` reads that lived in
 * these bodies are funnelled through `deps.getCurrentTurn()` here, so they
 * leave gateway.ts with this move (P9 §5 recommendation).
 *
 * gateway.ts keeps thin function-declaration wrappers with the original
 * names, so every callsite (stream-render deps, halt path, disconnect-flush,
 * silence-poke fallback, executeReply) is byte-identical.
 */
import type { CurrentTurn, TurnEndDeps } from './gateway.js'
import type { ChatKey as _ChatKey } from './inbound-delivery-machine.js'
import { chatIdOfChatKey } from './chat-key.js'
import { mayDrainBufferedInbound, shouldArmNoReplyDrain } from './serialize-drain-gate.js'
import { redeliverBufferedInbound } from './pending-inbound-buffer.js'
import { decideObligationTurnEnd } from './obligation-turn-end.js'
import { formatTurnLifecycle, detectStatusSurfaceDegraded } from './status-surface-log.js'

export function createTurnEndFunnel(deps: TurnEndDeps) {
  const {
    // Flags (module-load consts in gateway; captured once — same semantics).
    SERIALIZE_UNTIL_REPLIED_ENABLED,
    SERIALIZE_NOREPLY_DRAIN_MS,
    OBLIGATION_LEDGER_ENABLED,
    // Volatile getters (live reads — P9 getter funnel).
    getCurrentTurn,
    getInboundSpool,
    sendToAgent,
    // Gateway-bound helpers (by name).
    turnInFlightForGate,
    turnLiveForItsTopic,
    endCurrentTurnForKey,
    clearAllCurrentTurns,
    statusKey,
    reapQueuedStatus,
    stopTurnTypingLoop,
    stopEarlyLivenessOpen,
    reconcileStatusPin,
    trackRedeliveredInbound,
    drainPendingSessionCommand,
    triggerSelfRestart,
    maybeProactiveCompact,
    snapshotContextOccupancy,
    emitTurnRecord,
    flushPendingUserFailureNotices,
    clearAnswerReadyFlushTimeout,
    shadowEmit,
    removeActiveReaction,
    resolveAgentDirFromEnv,
    // Stores (stable references owned by gateway).
    activeStatusReactions,
    activeReactionMsgIds,
    activeTurnStartedAt,
    busyAckPostedKeys,
    busyAckRecheckTimers,
    reactionTransitionCounts,
    firstTextReplyLogged,
    pendingRestarts,
    pendingInboundBuffer,
    obligationLedger,
  } = deps

/**
 * Component 1 — deliver-before-drain. The single chokepoint that both
 * turn-end drain sites (`purgeReactionTracking`, `releaseTurnBufferGate`)
 * route through. Drains the pending-inbound buffer ONLY when
 * `mayDrainBufferedInbound` says so: claude is idle AND (the
 * serialize-until-replied kill switch is off, OR there is no ending-turn
 * handle, OR the ending turn delivered its final answer). A no-reply turn
 * (finalAnswerDelivered=false) deliberately does NOT drain here — the
 * bounded escape-hatch timer in `endCurrentTurnAtomic` covers that
 * liveness case. The 300s silence-poke fallback (`redeliverBufferedInbound`
 * called directly, bypassing this gate) remains the long-stop.
 */
function performBufferDrain(reason: string): void {
  const selfAgentForFlush = process.env.SWITCHROOM_AGENT_NAME ?? ''
  if (pendingInboundBuffer.depth(selfAgentForFlush) <= 0) return
  const fr = redeliverBufferedInbound(
    pendingInboundBuffer,
    selfAgentForFlush,
    (m) => sendToAgent(selfAgentForFlush, m),
    getInboundSpool(),
    trackRedeliveredInbound,
  )
  if (fr.redelivered > 0) {
    process.stderr.write(
      `telegram gateway: ${reason} flushed ${fr.redelivered}/${fr.drained} ` +
      `held inbound for ${selfAgentForFlush}` +
      `${fr.rebuffered > 0 ? ` (${fr.rebuffered} re-buffered)` : ''}\n`,
    )
  }
}

function drainBufferedIfAllowed(endingTurn: CurrentTurn | undefined, reason: string): void {
  if (
    !mayDrainBufferedInbound({
      turnInFlight: turnInFlightForGate(),
      endingTurnFinalAnswerDelivered: endingTurn?.finalAnswerDelivered ?? null,
      enabled: SERIALIZE_UNTIL_REPLIED_ENABLED,
    })
  ) {
    return
  }
  performBufferDrain(reason)
}

/**
 * Component 2 — bounded no-reply escape hatch (THE liveness guarantee).
 *
 * A turn that legitimately ends with NO reply (handback ack, NO_REPLY /
 * HEARTBEAT_OK marker, silent-end, greeting already handled) sets
 * `finalAnswerDelivered=false`. Under component 1's serialize gate that
 * turn would block `drainBufferedIfAllowed` FOREVER — and the 300s
 * silence-poke is disarmed for these silent-end turns, so without this
 * timer a queued cross-topic message would never be released (a permanent
 * wedge). This timer is the bounded force-drain: SERIALIZE_NOREPLY_DRAIN_MS
 * (default 2500ms) after such a turn ends with a buffered inbound waiting,
 * drain unconditionally — the serialize gate's delivered-check is bypassed
 * because the turn ended for real with no reply coming. The drain still
 * respects `turnInFlightForGate()` indirectly: if a new turn started in the
 * window (e.g. the 300s fallback or another path drained first), the buffer
 * is already empty so `performBufferDrain` is a depth-checked no-op.
 *
 * Liveness proof: a no-reply turn followed by a queued cross-topic message
 * releases within SERIALIZE_NOREPLY_DRAIN_MS. The 300s silence-poke
 * unwedge fallback (`redeliverBufferedInbound` at the silence-poke
 * framework-fallback, called directly) remains the independent long-stop.
 */
function armNoReplyDrainTimer(turn: CurrentTurn): void {
  const selfAgent = process.env.SWITCHROOM_AGENT_NAME ?? ''
  // Pure guard (shared with the test): arm only for a no-reply turn that
  // has a buffered inbound waiting, and only when the feature is enabled.
  if (
    !shouldArmNoReplyDrain({
      enabled: SERIALIZE_UNTIL_REPLIED_ENABLED,
      finalAnswerDelivered: turn.finalAnswerDelivered,
      bufferedDepth: pendingInboundBuffer.depth(selfAgent),
    })
  ) {
    return
  }
  // Idempotent: clear any prior timer for this turn before re-arming.
  if (turn.noReplyDrainTimer != null) {
    clearTimeout(turn.noReplyDrainTimer)
    turn.noReplyDrainTimer = null
  }
  turn.noReplyDrainTimer = setTimeout(() => {
    turn.noReplyDrainTimer = null
    process.stderr.write(
      `telegram gateway: no-reply bounded drain (${SERIALIZE_NOREPLY_DRAIN_MS}ms) — ` +
      `turn ${turn.turnId} ended without a reply; force-draining buffered inbound\n`,
    )
    performBufferDrain('no-reply-bounded-drain')
  }, SERIALIZE_NOREPLY_DRAIN_MS)
  turn.noReplyDrainTimer.unref?.()
}

function purgeReactionTracking(key: string, endingTurn?: CurrentTurn): void {
  // Phase 2b: turn end. The key was registered via setTurnStarted when
  // the inbound arrived; purge is the canonical turn-end signal.
  //
  // outboundEmitted: read from the explicit `endingTurn` parameter when
  // provided (canonical path via endCurrentTurnAtomic — module-scope
  // currentTurn is already null by the time we get here), falling back
  // to `currentTurn?.replyCalled` for the legacy callsites that haven't
  // been threaded yet (sibling-key purges, restart-init cleanup).
  // Without this explicit-turn handoff the shadow trace would report
  // outboundEmitted=false on every replied turn (the dominant happy
  // path), producing strictly worse data than the blind `true` it
  // replaced. Invariant #5's `lastOutboundAt` correctness depends on
  // this signal being accurate.
  const outboundEmitted = endingTurn != null
    ? endingTurn.replyCalled === true
    : getCurrentTurn()?.replyCalled === true
  shadowEmit({ kind: 'turnEnd', key: key as _ChatKey, at: Date.now(), outboundEmitted })
  const msgInfo = activeReactionMsgIds.get(key)
  activeStatusReactions.delete(key)
  activeReactionMsgIds.delete(key)
  activeTurnStartedAt.delete(key)
  // Component 5 (reap) — defense-in-depth. The happy path deletes the
  // queued-status placeholder on the answer (executeReply / stream /
  // turn-flush). This catches the abnormal turn-end (silent-marker, wedge,
  // sibling purge) so a stale "Queued"/"On it" line can never dangle in
  // the topic. Idempotent: a no-op when already reaped. Prefer the ending
  // turn's session ids (canonical ownership); else parse the chatKey.
  if (endingTurn != null) {
    reapQueuedStatus(endingTurn.sessionChatId, endingTurn.sessionThreadId)
  } else {
    const pqChatId = chatIdOfChatKey(key as _ChatKey)
    const pqThreadPart = (key as string).slice(pqChatId.length + 1)
    const pqThread = pqThreadPart === '_' || pqThreadPart === '' ? null : Number(pqThreadPart)
    reapQueuedStatus(pqChatId, Number.isFinite(pqThread) ? (pqThread as number) : undefined)
  }
  // #2995 — reset the ending turn's OWN busy-ack dedupe + cancel its pending
  // deferred re-check. Per-key, not a global clear: a purge for topic A must
  // not reset topic B's dedupe or kill B's armed re-check. A buffered topic's
  // entry clears when ITS turn eventually runs and ends (this same path), and
  // the re-check timer self-guards on turnId anyway (defense-in-depth).
  busyAckPostedKeys.delete(key)
  const busyAckRecheck = busyAckRecheckTimers.get(key)
  if (busyAckRecheck != null) {
    clearTimeout(busyAckRecheck)
    busyAckRecheckTimers.delete(key)
  }
  // #2527: clear the per-key reaction-transition counter and first-reply
  // sentinel alongside the controller so we don't leak state across turns.
  reactionTransitionCounts.delete(key)
  firstTextReplyLogged.delete(key)
  // Human-feel UX: stop the turn-long `typing…` indicator started in
  // the turn-start block. `purgeReactionTracking` is the canonical
  // turn-end, so this is the single owner of the stop. (If an abnormal
  // abort skips purge, the stray loop self-heals: the next turn on this
  // chat calls `startTurnTypingLoop`, which stops the old interval
  // first.)
  // PR3 supergroup-mode: stop the per-(chat,thread) typing loop, not
  // the whole chat's. Prefer the ending-turn's session ids (the
  // canonical turn ownership); fall back to parsing the chatKey
  // for sibling-purge / restart-cleanup callers that don't have a
  // Turn handle.
  if (endingTurn != null) {
    stopTurnTypingLoop(endingTurn.sessionChatId, endingTurn.sessionThreadId ?? null)
  } else {
    const chatId = chatIdOfChatKey(key as _ChatKey)
    const threadPart = (key as string).slice(chatId.length + 1)
    const threadId = threadPart === '_' || threadPart === '' ? null : Number(threadPart)
    stopTurnTypingLoop(chatId, Number.isFinite(threadId) ? threadId : null)
  }
  // Cancel the enqueue-time early-open timer (paired with
  // `scheduleEarlyLivenessOpen` at turn start). `key` is the same status-key the
  // timer was registered under, so this is the single owner of the cancel. A
  // leaked timer would otherwise fire its `openLivenessFeedIfDue` against a
  // successor turn; the timer's own turnId match is the second guard, this is
  // the first. Idempotent — a no-op when no timer is registered.
  stopEarlyLivenessOpen(key as string)
  // Status-pin: turn end is the canonical unpin point for the foreground
  // pin. `purgeReactionTracking` is the single turn-end owner (all normal /
  // abnormal exit branches funnel here), so this is the one place the
  // foreground status pin is dropped. Idempotent: a no-op when nothing was
  // pinned (trivial turn that never opened a status message). The
  // drop-on-unpin contract in reconcilePin guarantees state clears even if
  // the unpin API throws — a stuck pin can never outlive its turn.
  {
    const pinChatId = endingTurn != null
      ? endingTurn.sessionChatId
      : chatIdOfChatKey(key as _ChatKey)
    void reconcileStatusPin(`fg:${key}`, pinChatId, { pinned: false })
  }
  if (msgInfo) {
    const agentDir = resolveAgentDirFromEnv()
    if (agentDir != null) removeActiveReaction(agentDir, msgInfo.chatId, msgInfo.messageId)
  }

  // If no more active turns and a restart is pending, perform it now.
  //
  // Cycle BOTH the agent unit and the gateway unit (us). Rationale: users
  // who ran `switchroom agent restart <name> --graceful-restart` after a
  // code change expect their telegram-plugin edits to land, and that code
  // only reloads when this gateway process restarts. Restarting only the
  // agent unit leaves us running the stale code until something else kicks
  // us over, which is a foot-gun (as observed on 2026-04-21 when a
  // klanker gateway ran pre-reorder progress-card code for half a day).
  //
  // Use detached spawn for the combined restart so the systemctl job
  // survives us getting killed by our own restart. Fire-and-forget;
  // response to the client was already sent when the restart was
  // scheduled, so nobody is waiting on this.
  //
  // Gated on the delivery machine (turns claude has actually been handed),
  // not `activeTurnStartedAt.size` (receipt-eager), so a buffered topic-B
  // inbound doesn't pin this gate forever while claude is genuinely idle
  // (the supergroup deadlock). The turnEnd event was emitted just above
  // (purgeReactionTracking head), so the machine is already idle here.
  // #1556: the deterministic delivery point. claude has just gone idle —
  // flush any inbound held mid-turn so the channel notification lands at
  // the idle prompt and submits as a fresh turn (instead of stranding in
  // the composer, the lawgpt wedge). Component 1 (deliver-before-drain):
  // routed through `drainBufferedIfAllowed`, which additionally gates on
  // the ending turn having delivered its reply so a buffered cross-topic
  // message can't drain ahead of the just-ended turn's late reply (the
  // Brevo→Meta wrong-topic bug). Zero-churn: the helper depth-checks
  // first. Lossless: redeliver re-buffers any per-message miss.
  drainBufferedIfAllowed(endingTurn, 'turn-complete')

  // Restart / compaction stay on the bare turn-end signal (NOT the
  // serialize gate): a pending self-restart or proactive compaction must
  // fire when claude is idle regardless of whether the last turn replied.
  if (!turnInFlightForGate()) {
    // Apply any /model|/effort command queued mid-turn (#3017) BEFORE the
    // restart drain reads the pending-restart map — drainPendingSessionCommand
    // itself checks pendingRestarts and, when a restart is also pending,
    // reports "restarting" on the ack card instead of a false confirmation.
    // The sr-*→Claude menu apply may ITSELF enqueue a restart, which the
    // restart drain below then picks up. Async + best-effort (own try/catch).
    void drainPendingSessionCommand()
    if (pendingRestarts.size > 0) {
      for (const [agentName, _timestamp] of pendingRestarts.entries()) {
        triggerSelfRestart(agentName, 'turn-complete-pending-restart');
        pendingRestarts.delete(agentName);
      }
    } else {
      // Strictly lower priority than a pending restart: if we just
      // kicked a restart the process is going away and compacting is
      // moot, so only evaluate when no restart drained this pass.
      maybeProactiveCompact();
    }
    // Context-headroom snapshot (RFC context-headroom-surface) — write the
    // current occupancy + cap so `switchroom status`/`doctor`/web can show
    // headroom. Independent of proactive-compaction (writes even when no cap
    // is configured) and best-effort (never throws). Runs on the same idle
    // signal — never mid-turn.
    snapshotContextOccupancy();
  }
}

/**
 * Narrow buffer-gate release. Clears the per-key
 * `activeTurnStartedAt` entry and triggers the held-inbound flush
 * if the fleet went idle, WITHOUT touching the reaction
 * controller, the active-reaction message-id, or the typing loop.
 *
 * Why split from `purgeReactionTracking`. #1718's contract keeps
 * `activeStatusReactions[key]` alive across the turn so the
 * working-state ladder can re-paint on every tool/thinking event
 * (and the steer-vs-queue logic at the inbound handler reads the
 * controller — gateway.ts:8322-8323 — to classify mid-turn
 * messages). Wiping the controller mid-turn would either collapse
 * the ladder to 👍 prematurely (#1713 regression) or break the
 * steer detection.
 *
 * The BUFFER gate (`activeTurnStartedAt`) is a separate concern:
 * it gates `shouldBufferInbound` (gateway.ts:8603) and the
 * "claude is idle" flush at `purgeReactionTracking`'s tail. The
 * #1728/#1729 fix released both halves together by gating on
 * `isFinalAnswerReply`, but a trivial-prompt reply that sets
 * `disable_notification: true` and is < 200 chars (e.g. the model
 * mis-classifies "4" as an interim ack) returns false from
 * `isFinalAnswerReply`, so neither half releases and the gate
 * wedges (v0.13.30 UAT regression — every subsequent inbound logs
 * `held mid-turn ... will flush on turn-complete` forever).
 *
 * `releaseTurnBufferGate` is called from `executeReply` on EVERY
 * successful reply finalize — regardless of `isFinalAnswerReply` —
 * so the buffer gate releases independently of the reaction
 * state. The reaction controller stays for #1713's bidirectional
 * ladder + steer detection; only the gate flips.
 *
 * Idempotent: a second release is a no-op `.delete()` on an
 * already-empty key.
 *
 * @internal exported only via the `gateway.ts` module — used by
 * `executeReply`'s post-send block and by tests via source-level
 * pinning in `vault-approval-posture.test.ts` / wedge-guard suites.
 */
function releaseTurnBufferGate(key: string, endingTurn?: CurrentTurn): void {
  if (!activeTurnStartedAt.has(key)) return
  activeTurnStartedAt.delete(key)
  // Shadow trace so the structural turn-end metric still records.
  // outboundEmitted=true is correct here — we only reach this from
  // executeReply AFTER an outbound landed.
  shadowEmit({ kind: 'turnEnd', key: key as _ChatKey, at: Date.now(), outboundEmitted: true })

  // Mirror the deterministic-delivery flush from `purgeReactionTracking`.
  // When the fleet hits zero-active-turns, drain any held inbound. This is
  // the load-bearing wedge fix: the gate that pinned msg 1874+ in
  // test-harness's 13:02 UAT now opens after the reply.
  //
  // Component 1 (deliver-before-drain): routed through the shared
  // `drainBufferedIfAllowed`. `releaseTurnBufferGate` is called on EVERY
  // reply finalize — interim ack AND final answer. The serialize gate
  // checks `endingTurn.finalAnswerDelivered`, so an INTERIM ack ("On it")
  // does NOT drain the cross-topic buffer (its turn hasn't delivered its
  // real answer yet); only the final-answer reply releases it. That is
  // exactly the serialize-until-replied contract. When the kill switch is
  // off, or no turn handle is threaded, the helper falls back to the
  // legacy drain-on-idle behaviour.
  drainBufferedIfAllowed(endingTurn, 'reply-released-gate')
}

/**
 * Atomic null-and-purge for a wedged turn. Every site that ends a
 * turn by nulling `currentTurn` MUST also clear the turn's statusKey
 * from `activeTurnStartedAt` — else a dangling entry survives and
 * `#1556`'s turn-gate holds every new inbound mid-turn forever
 * (gymbro / klanker held-mid-turn symptom, 2026-05-20).
 *
 * Pre-this, three turn-end paths (silent-marker / turn-flush /
 * `turn_end`) nulled `currentTurn` on code-paths whose
 * `purgeReactionTracking` calls weren't reached on every branch,
 * leaving sibling entries under the turn's statusKey that the
 * silence-poke framework-fallback's `purgeReactionTracking(fbKey)`
 * couldn't catch (different key shape). The fallback now also sweeps
 * siblings for `fbChatId` (`turn-state-purge.ts`) as defense-in-depth,
 * but THIS helper closes the leak at origin: null and purge are
 * inseparable at every call site.
 *
 * Idempotent: a second purge is a no-op `.delete()` on a key already
 * gone — handlers that already purge elsewhere are unharmed.
 */
function endCurrentTurnAtomic(
  turn: CurrentTurn,
  opts?: { deferRecord?: boolean; deferObligationClose?: boolean },
): number | null {
  // PR-4e — keyed liveness + keyed clear (leak-close-at-origin). Flag-OFF: the
  // guard is `currentTurn === turn` and the clear nulls the singleton, verbatim.
  // Flag-ON: the guard becomes `byKey.get(turn'sKey) === turn` (so a flip to
  // another topic doesn't spuriously short-circuit THIS topic's teardown) and
  // the clear does `byKey.delete(key)` + nulls the mirror iff it still points at
  // `turn`. `endCurrentTurnForKey` returns false (no delete) when the entry no
  // longer matches — the same early-return semantics as the old `!== turn` guard.
  const key = statusKey(turn.sessionChatId, turn.sessionThreadId)
  if (!turnLiveForItsTopic(turn)) return null
  // PR A — the turn is ending (this is the ONE place every turn-end path funnels
  // through, incl. the answer-ready flush's own synthetic turn_end). Clear the
  // quiescence timer so a real turn_end that lands first cancels a pending flush,
  // guaranteeing exactly-once delivery.
  clearAnswerReadyFlushTimeout(turn)
  endCurrentTurnForKey(turn, key) // currentTurnByKey.delete(key) + mirror clear
  // Status-surface observability: one line at every turn CLEAR (with how far
  // the turn got), plus a DEGRADED warning when the turn did tool work but the
  // live feed never opened because its sends failed (the resume-400 signature).
  const turnEndedAt = Date.now()
  // 2026-07 double-reply-on-DM fix (F2) — stamp the turn's end time so the
  // `latest-ended` supersede tier can be recency-bounded to the
  // supersede TTL (a stale latest-ended turn must not inherit deletion
  // authority over a newer turn's flush record). Set once; idempotent on the
  // deferRecord flush path (which calls this synchronously before its send).
  turn.endedAt = turnEndedAt
  process.stderr.write(
    `telegram gateway: ${formatTurnLifecycle('clear', 'turn_end', turn, turnEndedAt)}\n`,
  )
  // PR B — the turn-flush backstop defers the record write to its async send
  // IIFE (passing `{ deferRecord: true }`) so the recorded `status` reflects the
  // REAL send outcome (`turn.deliveryOutcome`) rather than the speculative
  // `finalAnswerDelivered` flag set before the send ran. All synchronous
  // turn-end paths still emit here, unchanged. `turnEndedAt` is returned so the
  // deferred caller stamps the same ended-at (stable `duration_ms`).
  if (opts?.deferRecord !== true) {
    emitTurnRecord(turn, turnEndedAt)
  }
  const degraded = detectStatusSurfaceDegraded(turn)
  if (degraded != null) {
    process.stderr.write(
      `telegram gateway: status-surface DEGRADED reason=${degraded.reason} ` +
        `turnId=${turn.turnId} chat=${turn.sessionChatId} ` +
        `thread=${turn.sessionThreadId ?? '-'} ${degraded.detail}\n`,
    )
  }
  // PR2 obligation-ledger CLOSE-at-turn-end. Close the ended turn's obligation
  // when it delivered a final answer. finalAnswerDelivered is the right signal
  // HERE (not isSubstantiveFinalReply at reply-time): a SHORT genuine answer
  // ("4") is final-but-not-substantive, so the reply-time substantive-close
  // missed it → it looked unanswered → the idle sweep double-asked every short
  // turn (canary, v0.14.59). At turn_end the #2141 logic has already demoted a
  // bare interim ack to non-final, so finalAnswerDelivered===true means GENUINELY
  // answered. This runs before the next idle sweep, so a short answer closes
  // cleanly (no double-ask); an ack-then-ghost / no-reply turn ends with
  // finalAnswerDelivered===false → stays open → re-presented (the intended
  // catch). close() is a no-op for synthetic turns (turnId not in the ledger).
  // No-op when the flag is off.
  //
  // #2624 — sr-* model short-reply cascade fix. When the model routes through
  // LiteLLM (sr-* path), the claude CLI calls reply("OK", {disable_notification:
  // true}) for short answers — below the 200-char backstop and notification-
  // suppressed, so isFinalAnswerReply returns false and finalAnswerDelivered stays
  // false. This triggers a cascade: obligation re-presents with growing 25k-token
  // context, blocking the agent for minutes. The ack-then-ghost case that
  // obligations are designed to catch ends via silence_fallback, NOT turn_end.
  // At turn_end with replyCalled=true the model explicitly signalled completion
  // AND replied, so the obligation is satisfied regardless of finalAnswerDelivered.
  // #3276 finding 1 — the turn-flush backstop passes `deferObligationClose` so
  // the obligation disposition reflects the REAL send outcome (resolved in its
  // async finally after the bounded retry), NOT the speculative fire-time
  // `finalAnswerDelivered=true`. Closing here would satisfy the obligation
  // before the send is known to have landed, re-introducing the silent-drop on
  // terminal failure. Every synchronous turn-end path is unchanged.
  if (OBLIGATION_LEDGER_ENABLED && opts?.deferObligationClose !== true) {
    if (decideObligationTurnEnd(turn.finalAnswerDelivered, turn.replyCalled) === 'close') {
      obligationLedger.close(turn.turnId)
    } else {
      // Turn ended WITHOUT any reply (no ack, no answer). If this turn was
      // handling an open obligation, stamp its grace clock so the idle sweep
      // waits before re-presenting/escalating. No-op when turn.turnId isn't
      // in the ledger (synthetic / already-closed turn).
      obligationLedger.noteTurnEnded(turn.turnId, Date.now())
    }
  }
  // Component 2 — clear any prior no-reply drain timer for this turn; a
  // fresh end re-evaluates below. (Idempotent — null when never armed.)
  if (turn.noReplyDrainTimer != null) {
    clearTimeout(turn.noReplyDrainTimer)
    turn.noReplyDrainTimer = null
  }
  // Teardown the narrative gate's early-paint timer so it can neither leak past
  // the turn nor fire against a torn-down turn. (Idempotent — no-op when never
  // armed / already fired. `flushPendingNarrativeAtTurnEnd` on the turn_end event
  // normally disarms it first; this is the belt-and-braces teardown net.)
  turn.narrativeGate?.teardown()
  // Pass `turn` so purgeReactionTracking sees the authoritative
  // replyCalled flag even though we just nulled module-scope
  // currentTurn. Without this, the shadow trace's outboundEmitted
  // would be false on every replied turn (the dominant happy path),
  // producing strictly worse data than the blind `true` it replaced.
  // Component 1: purgeReactionTracking runs the serialize-gated drain —
  // it drains only if this turn delivered its final answer.
  purgeReactionTracking(statusKey(turn.sessionChatId, turn.sessionThreadId), turn)
  // Component 2 — bounded no-reply escape hatch. If this turn ended
  // WITHOUT delivering (finalAnswerDelivered=false) the serialize gate
  // above did NOT drain. Arm the bounded timer so a queued cross-topic
  // message still releases within SERIALIZE_NOREPLY_DRAIN_MS instead of
  // wedging forever. No-op when this turn delivered, when nothing is
  // buffered, or when the serialize feature is off.
  armNoReplyDrainTimer(turn)
  // #3293 finding 1 — resolve any deferred non-operator failure notice against
  // this turn's outcome: replied → the turn recovered from the error line, the
  // gate drops the notice; reply-less → the turn genuinely died, the notice is
  // sent now. replyCalled covers the short-answer/#2624 shape where
  // finalAnswerDelivered stays false despite an explicit reply. No-op when
  // nothing is pending (the overwhelmingly common path). #3294 — `key` scopes
  // resolution to THIS turn's topic under keyed liveness.
  flushPendingUserFailureNotices(turn.finalAnswerDelivered || turn.replyCalled, key)
  return turnEndedAt
}

  /**
   * PR-E (#2996 P8, amendment M1) — the single auditable turn-end entry point,
   * reached by production callsites ONLY when SWITCHROOM_TURN_END_FUNNEL_V2=1
   * (the gateway wrappers gate on the flag; default OFF runs the PR-B paths
   * verbatim). Dispatches to the EXACT legacy shape per reason — goal:
   * byte-identical effects, verified by the PR-A shadowEmit sequence oracle
   * run under both flag settings.
   *
   * FIVE end shapes (M1), not three:
   *   1. 'turn-end'           — the canonical funnel (endCurrentTurnAtomic).
   *   2. 'fallback-purge'     — purge without/with a turn handle (disconnect
   *                             flush, silence-poke framework fallback).
   *   3. 'reply-gate-release' — first-reply buffer-gate release (executeReply).
   *   4. 'phantom-ttl-clear'  — the /model|/effort busy-check hard-TTL clear.
   *   5. 'bridge-died-clear'  — the onDanglingTurnsSwept disconnect clear.
   * Shapes 4-5 are GHOST-clears: the turns are dead (a stale atom / a dead
   * bridge), so their effect set is EXACTLY the atom clear and nothing else —
   * no purge, no obligation close, no drain, no shadow turnEnd. Routing them
   * through the full funnel would close obligations and drain buffers against
   * a dead bridge.
   */
  function endTurn(
    reason: TurnEndReason,
    args: {
      turn?: CurrentTurn
      opts?: { deferRecord?: boolean; deferObligationClose?: boolean }
      key?: string
      endingTurn?: CurrentTurn
    } = {},
  ): number | null | undefined {
    switch (reason) {
      case 'turn-end':
        return endCurrentTurnAtomic(args.turn as CurrentTurn, args.opts)
      case 'fallback-purge':
        purgeReactionTracking(args.key as string, args.endingTurn)
        return undefined
      case 'reply-gate-release':
        releaseTurnBufferGate(args.key as string, args.endingTurn)
        return undefined
      case 'phantom-ttl-clear':
      case 'bridge-died-clear':
        // M1 — atom-clear ONLY. See the docblock above; harness case 9 pins
        // that a ghost-clear emits NO shadow turnEnd, closes NO obligation,
        // drains NO buffer.
        clearAllCurrentTurns()
        return undefined
    }
  }

  return {
    performBufferDrain,
    drainBufferedIfAllowed,
    armNoReplyDrainTimer,
    purgeReactionTracking,
    releaseTurnBufferGate,
    endCurrentTurnAtomic,
    endTurn,
  }
}

/** PR-E — the five named end shapes (amendment M1). */
export type TurnEndReason =
  | 'turn-end'
  | 'fallback-purge'
  | 'reply-gate-release'
  | 'phantom-ttl-clear'
  | 'bridge-died-clear'
