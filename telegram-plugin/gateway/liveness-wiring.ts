/**
 * liveness-wiring.ts — the silence-poke timer options (#2996 P8 PR-C3).
 *
 * Extracted VERBATIM from gateway.ts: the `silencePoke.startTimer({...})`
 * options object — `floorState`, the approval-blocked `onMidTurnFloor`
 * re-ping, and the 300 s `onFrameworkFallback` unwedge (turn teardown, stale
 * sibling purge, keyed clear, buffer self-heal). The gateway builds the deps
 * (`gatewayLivenessWiringDeps()`), calls `buildSilencePokeOptions(deps)` and
 * REGISTERS the timer itself (P0c: modules export the body; the gateway owns
 * the timer / boot side effect).
 *
 * The two user-visible sends cross as the injected `sendSilenceText` closure
 * so the `bot.api` touch stays behind the gateway retry-policy allowlist.
 * Volatile reads (`currentTurn`, `inFlightUpdate`, `turnsDb`, `inboundSpool`,
 * `ipcServer`) cross as getters. Module-level collaborators that are already
 * extracted (`silence-poke`, `turn-signal-tracker`, `pending-work-progress`,
 * `turn-state-purge`, registry, metrics) are imported directly.
 */
import type { LivenessWiringDeps } from './gateway.js'
import * as silencePoke from '../silence-poke.js'
import * as signalTracker from '../turn-signal-tracker.js'
import * as pendingProgress from '../pending-work-progress.js'
import { emitRuntimeMetric } from '../runtime-metrics.js'
import { logStreamingEvent } from '../streaming-metrics.js'
import { clearSilentEndState } from '../silent-end.js'
import { purgeStaleTurnsForChat } from './turn-state-purge.js'
import { removeTurnActiveMarker, readTurnActiveMarkerAgeMs } from './turn-active-marker.js'
import { decideHangRestart } from './hang-restart-decision.js'
import { recordTurnEnd } from '../registry/turns-schema.js'
import { hostdGetStatusOnce } from './hostd-dispatch.js'
import { formatUpdateStatusLine } from './update-status-line.js'
import { formatTurnLifecycle } from './status-surface-log.js'
import { redeliverBufferedInbound } from './pending-inbound-buffer.js'

export function buildSilencePokeOptions(deps: LivenessWiringDeps): Parameters<typeof silencePoke.startTimer>[0] {
  const {
    SILENCE_FALLBACK_MS,
    SILENCE_FALLBACK_HARD_MS,
    SILENCE_FLOOR_MS,
    SILENCE_DEFER_INFLIGHT_TOOLS,
    TURN_PREVIEW_MAX,
    STATE_DIR,
    isLegitimatelyWorking,
    getCurrentTurn,
    getInFlightUpdate,
    getTurnsDb,
    getInboundSpool,
    sendToAgent,
    sendSilenceText,
    getMyAgentName,
    statusKey,
    activeTurnStartedAt,
    activeStatusReactions,
    lastPtyPreviewByChat,
    preambleSuppressor,
    purgeReactionTracking,
    currentTurnMap,
    turnLiveForItsTopic,
    endCurrentTurnForKey,
    getPendingInboundBuffer,
    trackRedeliveredInbound,
    closeActivityLane,
    closeProgressLane,
    hangRestart,
  } = deps

  return {
  thresholdsMs: { fallback: SILENCE_FALLBACK_MS, fallbackHardCeiling: SILENCE_FALLBACK_HARD_MS, floor: SILENCE_FLOOR_MS },
  deferFallbackWhileToolInFlight: SILENCE_DEFER_INFLIGHT_TOOLS,
  isLegitimatelyWorking: (key) => isLegitimatelyWorking(key),
  // #3552 — orphan-state reaper predicate. Deliberately the SAME condition the
  // `onFrameworkFallback` late-fire guard below uses: no `activeTurnStartedAt`
  // entry AND no current turn ⇒ the turn this state belongs to is over. Note
  // `activeTurnStartedAt` alone is NOT sufficient — `releaseTurnBufferGate`
  // clears it mid-turn on every final-answer reply while the turn keeps running
  // (post-answer housekeeping), and silence-poke must keep watching that turn.
  isTurnLive: (key) => !(activeTurnStartedAt.get(key) == null && getCurrentTurn() == null),
  emitMetric: (event) => {
    // Re-emit through the unified runtime-metrics fan-out (PostHog + JSONL).
    emitRuntimeMetric(event)
  },
  // #2527 — the gateway-owned half of the mid-turn-floor decision: only the
  // live turn knows its loop role + whether a substantive answer has landed.
  // Keyed on statusKey so a DM (threadId null) and a forum topic are identical.
  floorState: (key) => {
    const turn = getCurrentTurn()
    if (turn == null) return null
    if (statusKey(turn.sessionChatId, turn.sessionThreadId) !== key) return null
    return { role: turn.role, finalAnswerDelivered: turn.finalAnswerDelivered }
  },
  // Phase 3 (reference/rfcs/deterministic-turn-liveness.md): the busy-but-
  // silent TEXT floor is retired. The climbing card (Phase 1 — the 0-label
  // branch of `feedHeartbeatTick` / `runSilentTurnHeartbeatTick` above) IS
  // the mid-turn floor now: it edits the already-open activity card's
  // elapsed clock every `FEED_HEARTBEAT_MIN_STALE_MS`, model-independent, no
  // ping. This handler still decides/fires via `decideMidTurnFloor` (the
  // timing + role + fire-once machinery in `silence-poke.ts` /
  // `turn-liveness-floor.ts` is unchanged and still load-bearing — see
  // below), but its ONLY surviving delivery is the approval-blocked re-ping.
  // Do not re-add a generic "still working…" text send here believing this
  // path covers the silent-tool case; it does not, and re-adding one would
  // reintroduce the exact banned cadence ping `conversational-pacing.md`
  // retired in #2667.
  onMidTurnFloor: async (ctx) => {
    // Late-fire guard, mirroring the fallback: a clean turn-end can race the
    // tick. If the turn is gone, stay silent.
    if (activeTurnStartedAt.get(ctx.key) == null && getCurrentTurn() == null) return
    const blockedOnApproval = activeStatusReactions
      .get(statusKey(ctx.chatId, ctx.threadId))
      ?.isAwaiting() ?? false
    // The one surviving text case: the turn is parked on an approval card
    // waiting for YOUR tap. That's not a stall — it names the real blocker —
    // so it keeps this quiet re-ping (`conversational-pacing.md` § Silence-
    // poke fallback names this one of the two surviving honest cases). The
    // busy-but-silent (non-approval) case sends nothing here; the card climb
    // (Phase 1) is its only signal now.
    if (!blockedOnApproval) return
    const text = silencePoke.formatFrameworkFallbackText(
      'working',
      ctx.silenceMs,
      ctx.inFlightTools,
      blockedOnApproval,
    )
    if (text == null) return
    try {
      // The quiet beat: visible in-thread, no device buzz. (The 300s
      // fallback pings; the floor must not train the user to mute.) The send
      // stays in gateway.ts behind the bot-api retry policy (sendSilenceText).
      await sendSilenceText(ctx.chatId, ctx.threadId ?? null, text, true)
      // Count it as production so the silence clock resets — the user just
      // saw a real message, so the 300s loud fallback is measured from here.
      silencePoke.noteProduction(ctx.key, Date.now())
    } catch (err) {
      process.stderr.write(
        `silence-poke mid-turn floor sendMessage failed chat=${ctx.chatId} thread=${ctx.threadId}: ${err}\n`,
      )
    }
  },
  onFrameworkFallback: async (ctx) => {
    // Late-fire short-circuit (2026-05-23 audit finding). The fallback
    // can race a clean turn-end: the model's actual reply lands inside
    // the silence window's final ~50ms, the canonical turn-end path
    // clears `activeTurnStartedAt` and nulls `currentTurn`, and then
    // this handler fires anyway. Without this check we emit a noisy
    // "still working…" ping to the user (right after they got their
    // real reply) AND a misleading "ended wedged turn ... currentTurn_
    // nulled=false drained_buffered=0/0" log line. The 7-day audit
    // showed this race accounts for ~90% of all framework_fallback log
    // events (124 of 138 `currentTurn_nulled=false` cases). Distinct
    // log line so observability still tracks the fact that the silence
    // crossed threshold; the wedge counter is no longer polluted.
    //
    // #3552: with the `isTurnLive` reaper wired above, this branch is now only
    // the sub-poll-interval race (the turn ends between the tick's reap check
    // and this handler running). The steady-state case it used to absorb —
    // state armed for the full 300s against a turn that ended minutes earlier,
    // 504 events in 14 days vs 110 real fires — is reaped at the tick instead,
    // so this counter finally reads as the genuine race it names.
    if (activeTurnStartedAt.get(ctx.key) == null && getCurrentTurn() == null) {
      process.stderr.write(
        `telegram gateway: silence-poke framework-fallback late-fire skipped — ` +
        `turn ended cleanly during silence window ` +
        `chat=${ctx.chatId} thread=${ctx.threadId ?? '-'} silence_ms=${ctx.silenceMs}\n`,
      )
      // #2527: structured skip event so the late-fire race is machine-readable.
      logStreamingEvent({
        kind: 'silence_poke_skip',
        chatId: ctx.chatId,
        threadId: ctx.threadId ?? undefined,
        silenceMs: ctx.silenceMs,
        skipReason: 'turn_ended_cleanly_during_window',
      })
      // Tell silence-poke this chat-thread is finished so the next
      // arming doesn't carry stale state.
      silencePoke.endTurn(ctx.key)
      return
    }

    // Stage B: escalate a mid-tool hang to a REAL restart. The fallback fires
    // here with a tool still in flight only after silence crossed the 15-min
    // defer ceiling (isLegitimatelyWorking held it that long). The honest
    // hang/health discriminator is the turn-active marker's mtime age: a healthy
    // turn keeps advancing it (tool_use + sub-agent JSONL growth), a true hang
    // lets it go stale. A known-long-running tool in flight (Task/Agent/Bash/
    // WebFetch/research) is protected regardless of marker age — a single long
    // foreground tool legitimately can't advance the marker (Finding A). Only a
    // stale (or absent) marker with no protected long tool triggers the
    // SIGTERM-PID1 restart; the boot classifier then routes recovery through the
    // ask-first resume_watchdog_timeout inbound. We return BEFORE the state-
    // teardown so the turn-active marker survives for the boot reclassification.
    if (hangRestart != null && ctx.inFlightTools.length > 0) {
      const markerAgeMs = readTurnActiveMarkerAgeMs(STATE_DIR)
      const inFlightToolNames = ctx.inFlightTools.map((t) => t.name)
      const decision = decideHangRestart({
        inFlightToolNames,
        markerAgeMs,
        stalenessThresholdMs: hangRestart.stalenessThresholdMs,
      })
      process.stderr.write(
        `telegram gateway: [hang-watchdog] fallback mid-tool chat=${ctx.chatId} ` +
        `thread=${ctx.threadId ?? '-'} silence_ms=${ctx.silenceMs} ` +
        `tools=${inFlightToolNames.join(',')} marker_age_ms=${markerAgeMs ?? 'null'} ` +
        `restart=${decision.restart} reason=${decision.reason}\n`,
      )
      if (decision.restart) {
        hangRestart.request(decision.reason, markerAgeMs ?? ctx.silenceMs)
        return
      }
    }

    // Deterministic in-flight update status (klanker incident). If this
    // gateway dispatched an update_apply that's still running, the
    // recurring framework fallback carries hostd's REAL phase + elapsed
    // instead of the content-free "still working…". No model: pure
    // get_status snapshot → pure formatter. Any hostd unavailability
    // degrades silently to the existing generic text (zero regression).
    let text: string | null = null
    // Hoisted out of the generic-fallback branch below because the send site
    // gates `disable_notification` on it: when the turn is parked on an
    // approval card, the fallback TEXT is a user-gating re-ping ("waiting for
    // your approval — tap Approve or Deny …"), and that must stay LOUD so the
    // user knows the ball is in their court. The reaction controller tracks the
    // park via setAwaiting on the permission-request.
    const blockedOnApproval = activeStatusReactions
      .get(statusKey(ctx.chatId, ctx.threadId))
      ?.isAwaiting() ?? false
    const upd = getInFlightUpdate()
    if (upd != null) {
      try {
        const st = await hostdGetStatusOnce(getMyAgentName(), upd.requestId)
        if (st !== 'not-configured' && st !== 'unavailable') {
          text = formatUpdateStatusLine(st, upd.startedAt, Date.now())
        }
      } catch {
        /* degrade to generic fallback below */
      }
    }
    if (text == null) {
      // Wording is load-bearing — extracted to `formatFrameworkFallbackText`
      // in `silence-poke.ts` so it can be snapshot-tested in isolation
      // (CC-4 in `docs/status-ask-cause-classes.md`). Derives "N min" suffix
      // from `ctx.silenceMs` so the wording stays honest if the 300s
      // threshold is tuned.
      // Honesty: if the turn is parked on an approval card (the dominant
      // benign "wedge" class — claude is alive, waiting on the operator's
      // tap), say so instead of "still working…". The reaction controller
      // already tracks this (setAwaiting on the permission-request park).
      text = silencePoke.formatFrameworkFallbackText(
        ctx.fallbackKind,
        ctx.silenceMs,
        ctx.inFlightTools,
        blockedOnApproval,
      )
    }
    // #2527: log the actual poke fire with structured data before sending,
    // so the event is visible even if the send fails. The stall-notice
    // stop-gap is retired (the user-visible send below is now gated), but the
    // fire event is still logged so observability + the unwedge accounting are
    // unchanged — mirrors PR #2641 (drop the chat badge, keep the log).
    logStreamingEvent({
      kind: 'silence_poke_fire',
      chatId: ctx.chatId,
      threadId: ctx.threadId ?? undefined,
      silenceMs: ctx.silenceMs,
      fallbackKind: ctx.fallbackKind,
    })
    // Send a user-visible message ONLY when there's something honest to say:
    //   - a deterministic in-flight update_apply phase (`text` set above), or
    //   - the approval-blocked re-ping (`formatFrameworkFallbackText` returns a
    //     string only for that case).
    // The generic "still working… (no update from agent in N min)" stall notice
    // is retired — `formatFrameworkFallbackText` returns null for it, so `text`
    // stays null and we skip the send. The turn-teardown below (the unwedge —
    // the one job the live draft can't do, per the conversational-pacing RFC)
    // still runs unconditionally.
    if (text != null) {
      try {
        // Conditional: when the turn is parked on an approval card, this
        // fallback carries a user-gating re-ping ("waiting for your
        // approval — tap Approve or Deny …") — that must PING, because the
        // user is the one being waited on. The deterministic update-status
        // line stays SILENT (a status surface). Gate on `blockedOnApproval`.
        // The send stays in gateway.ts behind the bot-api retry policy.
        await sendSilenceText(ctx.chatId, ctx.threadId ?? null, text, blockedOnApproval ? false : true)
      } catch (err) {
        process.stderr.write(
          `silence-poke fallback sendMessage failed chat=${ctx.chatId} thread=${ctx.threadId}: ${err}\n`,
        )
      }
    }
    // #1122 follow-up: end the wedged turn AFTER the fallback fires.
    // Without this, `activeTurnStartedAt` stays set, every subsequent
    // inbound is routed as `queued="true" prior_turn_in_progress="true"`
    // (see handleInbound mid-turn branch ~line 6160), and the user's
    // conversation is permanently stuck behind a dead turn no signal
    // will ever close. Caught by the human-style fuzz on 2026-05-13:
    // 23/23 inbounds queued behind msg 599 that never got a turn_ended.
    //
    // Cleanup mirrors the regular reply / silent-marker turn-end paths
    // (lines 4985 / 5274) so a late `turn_end` from claude — once it
    // finally exits the wedge — finds nulled state and bails at the
    // handler-entry `const turn = currentTurn` check (lines 4441,
    // 4593, etc), avoiding a double-emit / stale-turn-close on the
    // next inbound's fresh turn.
    const fbKey = ctx.key
    const fbChatId = ctx.chatId
    const fbThreadId = ctx.threadId ?? undefined
    const wedgedTurn = getCurrentTurn()
    // Match by sessionChatId + sessionThreadId before mutating
    // `currentTurn` — multi-chat agents shouldn't have their CURRENT
    // (different-chat) turn nulled by this fallback.
    const turnMatchesFallback =
      wedgedTurn != null &&
      wedgedTurn.sessionChatId === fbChatId &&
      wedgedTurn.sessionThreadId === fbThreadId
    const turnStartedAt = activeTurnStartedAt.get(fbKey)
    if (turnStartedAt != null) {
      const turnDurationMs = Date.now() - turnStartedAt
      const outboundMetrics = signalTracker.getOutboundMetrics(fbKey)
      emitRuntimeMetric({
        kind: 'turn_ended',
        chat_id: fbChatId,
        thread_id: ctx.threadId,
        duration_ms: turnDurationMs,
        ttfo_ms: outboundMetrics.ttfoMs,
        outbound_count: outboundMetrics.outboundCount,
        longest_silent_gap_ms: outboundMetrics.longestOutboundGapMs,
        ended_via: 'framework_fallback',
      })
      // #1892-follow-up: do NOT clear signalTracker state here. When the
      // model recovers post-fallback (the framework's user-visible
      // "still working" message is the load-bearing unwedge primitive —
      // see `project_silence_poke_broken_and_cross_turn_fix`), its late
      // reply calls fire `signalTracker.noteOutbound(fbKey, ...)`. If
      // state is already cleared, that's a silent no-op and the late
      // reply is invisible to outbound_count + ttfo metrics — the
      // canonical session-end path (silent-marker line 7407 or normal
      // turn-end line 7502) emits turn_ended a second time, reading
      // the empty state and reporting outbound_count=0 even though
      // replies landed. Defer clear to the canonical paths so
      // post-fallback recoveries are correctly counted.
    }
    // Stamp the turn-DB end row as `timeout` so the wedged turn doesn't
    // stay open until a SIGTERM/restart relabels it (false-negative for
    // clean completion). Mirrors the canonical stop-path at line 5250.
    const fbTurnsDb = getTurnsDb()
    if (fbTurnsDb != null && turnMatchesFallback && wedgedTurn?.registryKey != null) {
      const _turnKey = wedgedTurn.registryKey
      const capturedJoined = wedgedTurn.capturedText.join('')
      const assistantReplyPreview = capturedJoined
        ? capturedJoined.slice(0, TURN_PREVIEW_MAX)
        : null
      try {
        recordTurnEnd(fbTurnsDb, {
          turnKey: _turnKey,
          endedVia: 'timeout' as const,
          lastAssistantMsgId: wedgedTurn.lastAssistantMsgId,
          lastAssistantDone: wedgedTurn.lastAssistantDone,
          assistantReplyPreview,
          toolCallCount: wedgedTurn.toolCallCount,
        })
      } catch (err) {
        process.stderr.write(
          `telegram gateway: recordTurnEnd(timeout) failed turnKey=${_turnKey}: ${(err as Error).message}\n`,
        )
      }
    }
    // Bridge-watchdog (#412): clear the on-disk turn-active marker so
    // the watchdog doesn't read a stale "turn active" file after a
    // wedge-recovery. Same defence the canonical paths run at 4971,
    // 5270.
    try { removeTurnActiveMarker(STATE_DIR) } catch { /* best-effort */ }
    // Stream/lane teardown — a pinned progress card or buffered
    // preamble survives the wedge otherwise and lands on the next
    // turn. Mirror the canonical stop-path at 5228-5229; skip
    // closeProgressLane analogue from the silent-marker path because
    // we have no streams to finalize here.
    closeActivityLane(fbChatId, fbThreadId)
    closeProgressLane(fbChatId, fbThreadId)
    lastPtyPreviewByChat.delete(fbKey)
    preambleSuppressor.dropNow()
    // Drop silence-poke state and clear turn-active so the next inbound
    // for this chat starts a fresh turn instead of queueing forever.
    silencePoke.endTurn(fbKey)
    pendingProgress.noteTurnEnd(fbKey)
    purgeReactionTracking(fbKey)
    // Defense-in-depth: the fallback's purgeReactionTracking above
    // clears the canonical statusKey(chatId, threadId) for fbKey
    // only. activeTurnStartedAt can hold sibling entries for the
    // SAME chat (different threads, or a `null` vs `undefined`-thread
    // variant left over from a normal turn-end path that nulled
    // currentTurn without invoking purgeReactionTracking — the
    // gymbro/klanker held-mid-turn symptom, 2026-05-20); sweep them via
    // the same purger. Multi-chat-safe — only touches keys for fbChatId, so
    // #1546's intentional cross-chat safety guard is preserved.
    //
    // BUT a sibling is NOT "by definition stale": in one-agent-owns-supergroup
    // every forum topic shares fbChatId, so a chatId-only sweep would purge a
    // LIVE sibling topic's reaction controller + typing loop when THIS topic's
    // poke fires. Gate each sibling on its OWN silence clock — purge only those
    // also silent ≥ the fallback threshold (their own poke would fire too),
    // sparing topics that are actively mid-turn. Use silence, not turn-start
    // age, so a long-but-narrating turn isn't mistaken for stale.
    // See turn-state-purge.ts.
    const fbNow = Date.now()
    const fbExtraPurge = purgeStaleTurnsForChat(
      fbChatId,
      activeTurnStartedAt.keys(),
      purgeReactionTracking,
      (siblingKey) => {
        if (siblingKey === fbKey) return true // the firing key is genuinely stale
        const sib = silencePoke.silenceMsForKey(siblingKey, fbNow)
        // No silence-poke state → dangling (turn ended, key not purged) → stale.
        return sib == null || sib >= silencePoke.DEFAULT_THRESHOLDS.fallback
      },
    )
    // PR-4e self-heal backstop: drop any per-topic `currentTurnByKey` entries
    // for fbChatId whose turn is stale-by-the-same-silence-gate the sibling
    // sweep above used — the same precedent as `purgeStaleTurnsForChat`'s
    // activeTurnStartedAt sweep, so a leaked map entry (a turn whose keyed
    // delete somehow never ran) can never outlive its chat. Gated identically:
    // the firing key is always stale; a sibling is stale iff it's silent ≥ the
    // fallback threshold (or has no silence state). No-op under the flag OFF
    // (the map is empty).
    currentTurnMap.purgeChatStale(fbChatId, (siblingKey) => {
      if (siblingKey === fbKey) return true
      const sib = silencePoke.silenceMsForKey(siblingKey, fbNow)
      return sib == null || sib >= silencePoke.DEFAULT_THRESHOLDS.fallback
    })
    // Null `currentTurn` if it's still pointing at the wedged turn —
    // when claude eventually fires a late `turn_end` for this session
    // (or never does), the handler's `const turn = currentTurn` snapshot
    // returns null and the regular teardown short-circuits. Without
    // this, the late event would re-emit `turn_ended` AND clobber
    // whatever fresh turn the next inbound started.
    // PR-4e — keyed liveness for the guard. Flag-OFF: `turnLiveForItsTopic`
    // reduces to `currentTurn === wedgedTurn` (singleton mirror), verbatim.
    // Flag-ON: `byKey.get(fbKey) === wedgedTurn`, so the keyed delete still
    // fires when the LIVE mirror has already flipped to another topic B (a bare
    // `currentTurn === wedgedTurn` would falsely skip and leak A's byKey entry).
    if (turnMatchesFallback && wedgedTurn != null && turnLiveForItsTopic(wedgedTurn)) {
      // Status-surface observability: emit the lifecycle CLEAR for the
      // silence-poke teardown so a fallback-nulled turn has a turn-lifecycle
      // line like every other clear path (the framework-fallback line below is
      // its own format — this makes the dark-out greppable in the same shape).
      process.stderr.write(
        `telegram gateway: ${formatTurnLifecycle('clear', 'silence_fallback', wedgedTurn, Date.now())}\n`,
      )
      // PR-4e — keyed delete for the wedged turn's OWN key (fbKey == the
      // statusKey this fallback fired for, == the wedgedTurn's key since
      // turnMatchesFallback gated chat+thread equality). Flag-OFF nulls the
      // singleton, verbatim; flag-ON deletes only this topic's entry and clears
      // the mirror iff it still points here — a live sibling topic is untouched.
      endCurrentTurnForKey(wedgedTurn, fbKey)
    }
    // Best-effort: clear any pending silent-end marker so the Stop hook
    // doesn't double-block when claude eventually exits the wedged turn.
    try {
      clearSilentEndState(fbKey)
    } catch { /* best-effort */ }
    // Self-heal the inbound buffer. pendingInboundBuffer otherwise
    // drains ONLY on bridge re-register (onClientRegistered). After a
    // network storm that settles with the bridge STILL connected, user
    // messages buffered during the flap sit forever — until a manual
    // restart forces a re-register (the fleet-update thundering-herd
    // incident, 2026-05-19: agents "not responding", logs show
    // pending-inbound-buffer depth>0 with no drain). Flushing on
    // wedge-clear makes the agent self-heal. selfAgent-keyed; a miss
    // re-buffers so nothing is lost if the bridge is genuinely offline.
    const fbSelfAgent = process.env.SWITCHROOM_AGENT_NAME ?? ''
    const fbRedeliver = redeliverBufferedInbound(
      getPendingInboundBuffer(),
      fbSelfAgent,
      (m) => sendToAgent(fbSelfAgent, m),
      getInboundSpool(),
      trackRedeliveredInbound,
    )
    process.stderr.write(
      `telegram gateway: silence-poke framework-fallback ended wedged turn ` +
      `chat=${fbChatId} thread=${ctx.threadId ?? '-'} silence_ms=${ctx.silenceMs} ` +
      `currentTurn_nulled=${turnMatchesFallback} ` +
      `drained_buffered=${fbRedeliver.redelivered}/${fbRedeliver.drained}` +
      `${fbRedeliver.rebuffered > 0 ? ` rebuffered=${fbRedeliver.rebuffered}` : ''}` +
      `${fbExtraPurge.purged.length > 0 ? ` extra_keys_purged=${fbExtraPurge.purged.length}` : ''}\n`,
    )
  },
  }
}
