/**
 * turn-start-surfaces.ts — the turn-START surfaces block (#2996 P8 PR-D).
 *
 * Extracted VERBATIM from gateway.ts `handleInbound` (the status-reaction
 * controller install + fresh-turn init + progress-card `startTurn`): the
 * steer/queue ack reactions, the fresh-turn StatusReactionController install
 * (incl. the #472-finding-17 prior-draft finalize await — load-bearing, kept
 * at the same await point), the silence-poke / signal-tracker / typing-loop
 * arming, and the progress-card `startTurn`.
 *
 * Why a single extracted surface, called ONCE on the shared tail: P7's inbound
 * router (`SWITCHROOM_INBOUND_ROUTER_V2`) branches only at the intercept
 * gauntlet (the v2 chain in inbound-router.ts vs the retained legacy inline
 * arm) and both arms re-converge BEFORE this block. Extracting it and calling
 * it from that shared convergence point means the v2 and legacy routing modes
 * run byte-identical turn-start surfaces — the design's "called from both
 * arms" acceptance criterion, satisfied structurally (a flip of the router
 * flag cannot fork turn-start behaviour because there is one implementation).
 *
 * DI contract (the turn-end.ts / stream-render precedent): STATE stays in
 * gateway.ts; this module owns only the logic. Mutable stores, live singletons
 * and gateway-bound helpers arrive through `TurnStartSurfacesDeps`
 * (`gatewayTurnStartSurfacesDeps()` in gateway.ts — exact-by-construction via
 * `ReturnType`). The volatile `currentTurn` read (the mid-turn auto-classify
 * shadow) crosses as `getCurrentTurn()` so it sees the live value (the P9
 * getter funnel, cluster for turn-start reads). Pure imports
 * (`StatusReactionController`, `autoClassifyMidTurnInbound`) come in directly.
 */
import type { ReactionTypeEmoji } from 'grammy/types'
import type { Access, TurnStartSurfacesDeps } from './gateway.js'
import { StatusReactionController } from '../status-reactions.js'
import { autoClassifyMidTurnInbound } from './auto-classify-mid-turn.js'

/** At-call captured facts the turn-start surfaces need. Every field is a
 *  value snapshotted at the handler's convergence point (never a live getter);
 *  the one live read (`currentTurn`) is funnelled through the deps getter. */
export interface TurnStartSurfacesParams {
  chat_id: string
  msgId: number | undefined
  messageThreadId: number | undefined
  text: string
  effectiveText: string
  access: Access
  inboundReceivedAt: number
  isSteerPrefix: boolean
  isQueuedPrefix: boolean
}

/** What the block computes for the downstream envelope/delivery path:
 *  `isSteering` (explicit /steer or /s) and `priorTurnStartedAt` (the prior
 *  in-flight turn's start, undefined on a fresh turn). */
export interface TurnStartSurfacesResult {
  isSteering: boolean
  priorTurnStartedAt: number | undefined
}

export function createTurnStartSurfaces(deps: TurnStartSurfacesDeps) {
  const {
    AUTOCLASSIFY_MIDTURN_SHADOW,
    getCurrentTurn,
    statusKey,
    streamKey,
    isDmChatId,
    sendReaction,
    logStreamingEvent,
    probeAvailableReactions,
    startTurnTypingLoop,
    emitRuntimeMetric,
    classifyInbound,
    resolveAgentDirFromEnv,
    addActiveReaction,
    signalTracker,
    silencePoke,
    pendingProgress,
    progressDriver,
    activeStatusReactions,
    activeTurnStartedAt,
    lastAgentOutputAt,
    activeDraftStreams,
    suppressPtyPreview,
    chatAvailableReactions,
    reactionTransitionCounts,
    activeReactionMsgIds,
    progressUpdateTurnCount,
  } = deps

  async function armTurnStartSurfaces(
    p: TurnStartSurfacesParams,
  ): Promise<TurnStartSurfacesResult> {
    const { chat_id, msgId, messageThreadId, text, effectiveText, access, inboundReceivedAt, isSteerPrefix, isQueuedPrefix } = p
    // Status reaction controller
    let isSteering = false
    let priorTurnStartedAt: number | undefined
    if (msgId != null) {
      const key = statusKey(chat_id, messageThreadId)
      const priorActive = activeStatusReactions.get(key)
      const priorTurnInFlight = priorActive != null
      // New default: mid-turn messages are queued unless the user explicitly
      // steers. isSteering is true only when the steer prefix is present.
      // (Legacy: without any prefix the old behavior was isSteering=true; now
      // it's false so the message goes through as queued="true".)
      isSteering = priorTurnInFlight && isSteerPrefix
      if (priorTurnInFlight) priorTurnStartedAt = activeTurnStartedAt.get(key)

      // Mid-turn auto-classify SHADOW: compute what a topic+recency classifier
      // WOULD decide and log it — behaviour is UNCHANGED (isSteering above is
      // untouched). Gathers the real-world distribution (same-topic continuation
      // vs cross-topic, recency spread) to tune auto-steer before it ever acts.
      // No-op unless the shadow flag is on AND a turn is in flight (the only case
      // a steer-vs-queue decision is meaningful).
      if (AUTOCLASSIFY_MIDTURN_SHADOW && priorTurnInFlight) {
        const lastOut = lastAgentOutputAt.get(key)
        const msSinceOut = lastOut != null ? Date.now() - lastOut : null
        const shadow = autoClassifyMidTurnInbound({
          isSteerPrefix,
          isQueuePrefix: isQueuedPrefix,
          priorTurnInFlight,
          isDm: isDmChatId(chat_id),
          incomingThreadId: messageThreadId ?? null,
          activeTurnThreadId: getCurrentTurn()?.sessionThreadId ?? null,
          msSinceLastAgentOutput: msSinceOut,
          dmSteerWindowMs: 0, // DM auto-steer stays off (the April regime)
          topicSteerWindowMs: 8_000, // candidate window — what we're tuning
        })
        process.stderr.write(
          `telegram gateway: autoclassify-shadow chat_id=${chat_id} ` +
          `would=${shadow.decision} reason=${shadow.reason} same_topic=${shadow.sameTopic ?? '-'} ` +
          `ms_since_out=${msSinceOut ?? '-'} actual=${isSteering ? 'steer' : 'queue'}\n`,
        )
      }

      if (access.statusReactions !== false) {
        if (isSteering) {
          // Explicit steer: mark with 🤝 on the inbound message; leave the
          // existing StatusReactionController running for the in-flight turn.
          void sendReaction(chat_id, msgId, '🤝').catch(() => {})
        } else if (priorTurnInFlight) {
          // Queued mid-turn message (new default): don't touch the existing
          // controller; just ack the inbound message with 👀 so the user
          // knows we received it, without disrupting the in-flight reaction.
          void sendReaction(chat_id, msgId, '👀').catch(() => {})
          // #203: time-to-ack metric — measure gateway-receive → ack-post delta.
          logStreamingEvent({ kind: 'inbound_ack', chatId: chat_id, messageId: msgId, ackDelayMs: Date.now() - inboundReceivedAt })
        } else {
          // Fresh turn — priorTurnInFlight is false, so priorActive is
          // provably undefined. Earlier `if (priorActive)` block was dead
          // code, removed in the same first-paint cleanup pass.
          const sKey = streamKey(chat_id, messageThreadId)
          const priorStream = activeDraftStreams.get(sKey)
          if (priorStream && !priorStream.isFinal()) {
            // Closes #472 finding #17 — pre-fix this finalize was
            // fire-and-forget. The new turn's reply tool would then create
            // a fresh stream and send its first chunk while the prior
            // stream's terminal sendMessage was still in flight. The
            // late-materialise landed AFTER the new turn's content,
            // visible to the user as a stale "Done" message followed by
            // the new reply (or worse — duplicate content).
            //
            // Awaiting here costs the few hundred ms the final API call
            // takes, but only on rapid follow-ups where the prior turn
            // hadn't yet flushed. The latency hit beats the duplicate-
            // content bug. Delete from the map FIRST so any concurrent
            // reads can't see the stale stream while we await.
            activeDraftStreams.delete(sKey)
            await priorStream.finalize().catch(() => {})
          }
          suppressPtyPreview.delete(sKey)

          // #542 fix: pass the cached chat-level allowed-reactions filter
          // so the controller's resolveEmoji can fall through to a permitted
          // variant instead of attempting an emoji Telegram will reject.
          // First message in a chat sees `null` (cache miss) — kicks off
          // the probe for next time.
          const allowedReactions = chatAvailableReactions.get(chat_id) ?? null
          if (!chatAvailableReactions.has(chat_id)) {
            probeAvailableReactions(chat_id)
          }
          // #2527: use inbound msgId as a stable per-turn reaction identifier.
          // The controller is created before currentTurn.turnId is assigned
          // (that happens in handleSessionEvent's enqueue branch), so we capture
          // msgId here and use it as the reaction-session token in log events.
          const ctrlTurnToken = `${chat_id}:${msgId}`
          const ctrl = new StatusReactionController(async (emoji) => {
            await sendReaction(chat_id, msgId, emoji as ReactionTypeEmoji['emoji'])
            // #203: every status-reaction transition is a user-visible signal.
            signalTracker.noteSignal(key, Date.now())
          }, allowedReactions, {
            // #2527: emit a structured transition event on each emoji change so
            // the reaction lifecycle is visible in streaming-metrics logs. Also
            // increment the per-key counter for the turn_no_reply_warn metric.
            onTransition: (emoji) => {
              reactionTransitionCounts.set(key, (reactionTransitionCounts.get(key) ?? 0) + 1)
              logStreamingEvent({
                kind: 'status_reaction_transition',
                chatId: chat_id,
                turnId: ctrlTurnToken,
                emoji,
              })
            },
          })
          activeStatusReactions.set(key, ctrl)
          activeReactionMsgIds.set(key, { chatId: chat_id, messageId: msgId })
          activeTurnStartedAt.set(key, Date.now())
          progressUpdateTurnCount.set(key, 0)  // Reset turn counter
          // #2527: log controller install so the lifecycle start is observable.
          logStreamingEvent({
            kind: 'status_reaction_install',
            chatId: chat_id,
            turnId: ctrlTurnToken,
            messageId: msgId,
          })
          ctrl.setQueued()
          // #203: time-to-ack metric — setQueued() triggers the initial 👀 reaction
          // asynchronously through the controller chain.
          logStreamingEvent({ kind: 'inbound_ack', chatId: chat_id, messageId: msgId, ackDelayMs: Date.now() - inboundReceivedAt })
          // #203: signal tracker — start tracking silent gaps for this fresh turn.
          signalTracker.reset(statusKey(chat_id, messageThreadId), Date.now())
          // #1122 silence-poke: start the silence clock for this turn so
          // the framework can nudge the model if it goes quiet past the
          // soft / firm thresholds.
          silencePoke.startTurn(statusKey(chat_id, messageThreadId), Date.now())
          // Ack-first gate clear is centralised in handleSessionEvent's
          // `enqueue` branch — that fires for EVERY fresh turn atom
          // (real inbound, cron, subagent-handback, vault-grant wake,
          // restart marker) so cron/handback turns also re-arm the gate.
          // See the call site under `case 'enqueue'` (~line 6794).
          // #1445 cross-turn pending-async ambient. A new turn starting
          // (user inbound, synthesised wake, or handback channel) is the
          // signal that the model is about to re-engage — clear any
          // pending-progress edits anchored to the *prior* turn's
          // outbound so the framework stops talking over the new turn.
          // clearPending drops the per-key state outright, so the new
          // turn's `tool_use(Agent|Task|Bash bg)` + outbound capture
          // afresh via `noteAsyncDispatch` / `noteOutbound`.
          pendingProgress.clearPending(
            statusKey(chat_id, messageThreadId),
            'inbound',
          )
          // Human-feel UX: hold a continuous `typing…` indicator for the
          // WHOLE turn, not just the split-second a reply is transmitted.
          // A person you message shows as typing the entire time they
          // compose; switchroom used to fire only one-shot ~5s pings, so
          // any turn that read a file or thought for a moment went dark
          // after 5s. Self-renews every 4s; stopped at the canonical
          // turn-end (`purgeReactionTracking → stopTurnTypingLoop`).
          // Deterministic, framework-owned, no prose — the mechanical
          // ambient layer of the pacing contract.
          // PR3 supergroup-mode: pass thread so the indicator lands in
          // this turn's topic (otherwise topic A's turn-end would kill
          // topic B's typing indicator on shared chat_id keying).
          startTurnTypingLoop(chat_id, messageThreadId ?? null)
          // #1122 KPI: emit turn_started so dashboards can compute funnel
          // start counts + correlate to turn_ended for duration / TTFO.
          emitRuntimeMetric({
            kind: 'turn_started',
            chat_id,
            message_id: msgId,
            thread_id: messageThreadId ?? null,
            inbound_classified_as_status_query: classifyInbound(text).isStatusQuery,
          })
          const agentDir = resolveAgentDirFromEnv()
          if (agentDir != null) {
            addActiveReaction(agentDir, { chatId: chat_id, messageId: msgId, threadId: messageThreadId ?? null, reactedAt: Date.now() })
          }
        }
      } else if (access.ackReaction) {
        void sendReaction(chat_id, msgId, access.ackReaction as ReactionTypeEmoji['emoji']).catch(() => {})
        // #203: time-to-ack metric for the custom-ack-reaction path.
        logStreamingEvent({ kind: 'inbound_ack', chatId: chat_id, messageId: msgId, ackDelayMs: Date.now() - inboundReceivedAt })
      }
    }

    // Start a new progress card only for fresh turns (no prior turn in flight).
    // Queued mid-turn messages piggyback on the existing card; steer messages
    // also don't start a new card (the in-flight turn owns it).
    if (!isSteering && priorTurnStartedAt == null) {
      try {
        progressDriver?.startTurn({
          chatId: chat_id,
          threadId: messageThreadId != null ? String(messageThreadId) : undefined,
          userText: effectiveText,
          replyToMessageId: msgId != null ? msgId : undefined,
        })
      } catch (err) {
        process.stderr.write(`telegram gateway: progress-card startTurn failed: ${(err as Error).message}\n`)
      }

      // Pre-allocated draft + forum-topic placeholder send removed in
      // #553 PR 5. The 👀 status reaction (#568) and
      // sendChatAction('typing') indicator (#585) now bridge the
      // ~1s gap between inbound and the agent's first real text.
    }

    return { isSteering, priorTurnStartedAt }
  }

  return { armTurnStartSurfaces }
}
