/**
 * Post-disconnect flush helper for the gateway IPC server.
 *
 * Why this exists as its own function:
 *
 * `onClientDisconnected` was firing for EVERY client disconnect, including
 * anonymous one-shot connections from `recall.py` that send a single legacy
 * `update_placeholder` IPC message and then close. The old code
 * unconditionally:
 *
 *   - flushed every active StatusReactionController to 👍 ("done")
 *   - disposed the progress driver (recreating turn state)
 *   - finalized every open draft stream
 *
 * The intent of that flush was "an actual agent (claude bridge) crashed —
 * clean up so the user's pinned 🤔/🔥/⚡ doesn't sit there forever". But the
 * effect was: every recall.py IPC handshake fired 👍 on the inbound message
 * mid-turn, then the redrawn driver caused a duplicate edited-message bug.
 *
 * Anonymous clients never call `register` so `agentName` stays null. The
 * fix is to scope the flush to clients that actually registered as an
 * agent — those are the only ones whose disconnect implies a real agent
 * crash/restart. Anonymous one-shots are no-ops here.
 *
 * Extracted into a pure function so the gating contract has its own unit
 * test (`telegram-plugin/tests/gateway-disconnect-flush.test.ts`) without
 * needing to spin up the whole gateway.
 */

export interface DisconnectFlushDeps<Ctrl extends { finalize: (reason?: 'done' | 'error') => void }, Stream extends { isFinal: () => boolean; finalize: () => Promise<void> }> {
  /** The disconnecting client's agentName. `null` ⇒ anonymous (never registered). */
  agentName: string | null

  /** In-flight status-reaction controllers keyed by chat:thread:msgId. */
  activeStatusReactions: Map<string, Ctrl>
  /** Mirror map: same keys → message metadata. */
  activeReactionMsgIds: Map<string, { chatId: string; messageId: number }>
  /** Mirror map: same keys → turn-start timestamps. */
  activeTurnStartedAt: Map<string, number>

  /** Open draft-stream handles keyed by chat:thread:replyId. */
  activeDraftStreams: Map<string, Stream>

  /** Persist-side reaction registry (per-agent on-disk state). */
  clearActiveReactions: () => void
  /** Progress driver — disposed with `preservePending: true` for sub-agent JTBDs (#393). */
  disposeProgressDriver: () => void

  /** #2650: stop EVERY live turn-typing loop (the per-(chat,thread)
   *  `setInterval` started by `turn-typing-loop.ts`). The bridge just died
   *  mid-turn; its turn-long `typing…` loop is never stopped by the canonical
   *  turn-end (which will never arrive), so a stale "typing…" shows to the user
   *  until the next turn's `start()` self-heals it. Wire to
   *  `() => turnTypingLoop.stopAll()`. Called ONLY on a registered-agent
   *  disconnect — an anonymous one-shot never owned a turn-typing loop. */
  stopTurnTypingLoops: () => void

  /** Optional: called when the registered-agent disconnect found dangling
   *  `activeTurnStartedAt` entries the controller loop did not clear (i.e.
   *  `finalize()` already ran on the canonical reply path, leaving
   *  `activeStatusReactions` empty but `activeTurnStartedAt` populated).
   *  The gateway uses this to null its module-scope `currentTurn` — the
   *  bridge that owned that turn just died. Without this, the next
   *  inbound is "held mid-turn" against a ghost (the 2026-05-23 audit
   *  found ~14 such events / 3 days / 9 agents).
   *
   *  No-op if no dangling keys are found. */
  onDanglingTurnsSwept?: (purgedKeys: string[]) => void

  /** #3552 — called once per turn key this flush tears down (both the
   *  controller loop and the dangling sweep). The bridge that owned those turns
   *  just died, so every per-turn timer keyed on them is orphaned. The gateway
   *  wires this to `silencePoke.endTurn`: without it the armed 300s silence-poke
   *  state outlived the dead turn and was only disarmed when the fallback later
   *  fired against the stale key and logged `turn_ended_cleanly_during_window`.
   *  Deterministic disarm at the point the turn actually ends.
   *
   *  Idempotent by contract — a key may be reported by both loops below.
   *  Optional (test harnesses). */
  onTurnKeyEnded?: (key: string) => void

  /** Logger — receives the one-line decision trace. */
  log: (msg: string) => void
}

/**
 * Apply the disconnect-flush policy. Returns `true` when the flush ran
 * (registered agent disconnected), `false` when it was skipped (anonymous
 * client). The boolean is for tests + observability — callers can ignore it.
 */
export function flushOnAgentDisconnect<
  Ctrl extends { finalize: (reason?: 'done' | 'error') => void },
  Stream extends { isFinal: () => boolean; finalize: () => Promise<void> },
>(deps: DisconnectFlushDeps<Ctrl, Stream>): boolean {
  const {
    agentName,
    activeStatusReactions,
    activeReactionMsgIds,
    activeTurnStartedAt,
    activeDraftStreams,
    clearActiveReactions,
    disposeProgressDriver,
    stopTurnTypingLoops,
    onDanglingTurnsSwept,
    onTurnKeyEnded,
    log,
  } = deps

  if (agentName == null) {
    // Anonymous client — never registered, almost certainly a one-shot
    // recall.py IPC handshake. Do NOT touch turn state.
    log('telegram gateway: anonymous client disconnect — skipping reaction/driver flush')
    return false
  }

  // Real agent disconnect (e.g. the claude bridge crashed/restarted). Flush
  // all in-flight status reactions to 👍 so user messages don't stay stuck on
  // intermediate emoji (🤔, 🔥, etc.) after an agent crash/restart.
  // #1713: route through finalize() — single terminal path for the
  // status-reaction controller. Disconnect implies the agent bridge
  // died mid-turn; treat as a clean terminal so the user's emoji
  // doesn't stay stuck on an intermediate working state.
  for (const [key, ctrl] of activeStatusReactions.entries()) {
    ctrl.finalize('done')
    activeStatusReactions.delete(key)
    activeReactionMsgIds.delete(key)
    activeTurnStartedAt.delete(key)
    // #3552: disarm this turn's silence-poke state here, not 300s later.
    onTurnKeyEnded?.(key)
  }
  clearActiveReactions()

  // Defense-in-depth — sweep any `activeTurnStartedAt` keys the controller
  // loop above did not touch. The bridge has crashed; any turn it owned is
  // dead by definition, regardless of whether `activeStatusReactions`
  // still tracks it. The race that motivates this: `finalize()` already
  // fired on the canonical reply path (clearing the reaction controller)
  // BUT the disconnect arrived BEFORE `purgeReactionTracking` ran the
  // `activeTurnStartedAt.delete` line for that key. Without this sweep,
  // the key orphans, and the next inbound is "held mid-turn" against
  // a ghost — surfacing as the held-mid-turn / `currentTurn_nulled=true`
  // wedge symptom documented in feedback_5min_restart_wedge memo and
  // measured at ~14 events / 3 days / 9 agents (2026-05-23 audit).
  const danglingKeys = [...activeTurnStartedAt.keys()]
  if (danglingKeys.length > 0) {
    for (const k of danglingKeys) {
      activeTurnStartedAt.delete(k)
      activeReactionMsgIds.delete(k)
      // #3552: same deterministic disarm for the keys the controller loop missed.
      onTurnKeyEnded?.(k)
    }
    log(
      `telegram gateway: disconnect-flush swept ${danglingKeys.length} dangling turn key(s) ` +
      `post-bridge-death (controller loop missed — finalize raced disconnect)`,
    )
    onDanglingTurnsSwept?.(danglingKeys)
  }

  // (#2996 P1) The PR3b `claudeBusyKeys` orphan-sweep that lived here was
  // deleted with the set itself: the delivery machine's `bridgeDown` event
  // — emitted by the gateway's onClientDisconnected alongside this flush —
  // resets the machine to bridge_dead, which structurally clears the
  // turn-in-flight gate for synthetic-delivered turns that died without a
  // turn_end (the case the sweep existed for).

  // Stop coalesce timers that could emit into a finalized draft stream, but
  // preserve chats with pendingCompletion=true — those have background
  // sub-agents that legitimately outlive the parent bridge disconnect. The
  // heartbeat continues for preserved chats so elapsed-time ticks and the
  // deferred-completion-timeout path remain active. Fix for #393.
  disposeProgressDriver()

  // #2650: sweep the turn-typing loops. The bridge died mid-turn, so the
  // canonical turn-end that would normally call `turnTypingLoop.stop` will
  // never arrive — every live per-(chat,thread) `typing…` interval is now
  // orphaned and would show a stale "typing…" to the user until the next
  // turn's `start()` self-heals it. This is gated to a real registered-agent
  // disconnect (we returned early above for anonymous clients), so an
  // anonymous one-shot never triggers the sweep.
  stopTurnTypingLoops()

  // Finalize any open draft streams so they don't hang mid-edit.
  for (const [key, stream] of activeDraftStreams.entries()) {
    if (!stream.isFinal()) void stream.finalize().catch(() => {})
    activeDraftStreams.delete(key)
  }

  return true
}
