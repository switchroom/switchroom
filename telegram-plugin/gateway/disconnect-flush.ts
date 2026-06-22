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
  /** PR3b: keys claude has actually been handed (delivered, not just
   *  received). Cleared on disconnect for the same reason as
   *  activeTurnStartedAt — the bridge just died, every turn it
   *  was handed is dead by definition. */
  claudeBusyKeys: Set<string>

  /** Open draft-stream handles keyed by chat:thread:replyId. */
  activeDraftStreams: Map<string, Stream>
  /** Mirror map: same keys → parse mode. */
  activeDraftParseModes: Map<string, 'HTML' | 'MarkdownV2' | undefined>

  /** Persist-side reaction registry (per-agent on-disk state). */
  clearActiveReactions: () => void
  /** Progress driver — disposed with `preservePending: true` for sub-agent JTBDs (#393). */
  disposeProgressDriver: () => void

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
    claudeBusyKeys,
    activeDraftStreams,
    activeDraftParseModes,
    clearActiveReactions,
    disposeProgressDriver,
    onDanglingTurnsSwept,
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
    claudeBusyKeys.delete(key)
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
      claudeBusyKeys.delete(k)
    }
    log(
      `telegram gateway: disconnect-flush swept ${danglingKeys.length} dangling turn key(s) ` +
      `post-bridge-death (controller loop missed — finalize raced disconnect)`,
    )
    onDanglingTurnsSwept?.(danglingKeys)
  }

  // PR3b orphan-sweep (#1880 follow-up): claudeBusyKeys can hold keys
  // that activeTurnStartedAt does NOT — specifically when a synthetic
  // inbound (cron via onInjectInbound, reaction dispatch, vault
  // grant-approved / -denied / save-discarded / -failed / -completed,
  // button-callback) was delivered. Those paths bypass handleInbound's
  // fresh-turn branch (which is what would set activeTurnStartedAt),
  // so the sweep loop above wouldn't notice them. Pre-PR3b this was
  // invisible because the fleet gate read activeTurnStartedAt.size —
  // synthetic-only turns never registered. PR3b's claudeBusyKeys.add
  // is the more-accurate "claude is busy on this" gate, which means
  // a synthetic-delivered turn that dies WITHOUT turn_end leaves an
  // orphan that the activeTurnStartedAt-keyed sweep can't see.
  // Cure: clear any leftover busy keys here. Bridge died → every
  // busy key is dead by definition. Same justification as the
  // dangling-sweep above for activeTurnStartedAt.
  if (claudeBusyKeys.size > 0) {
    const orphanCount = claudeBusyKeys.size
    const orphanKeys = [...claudeBusyKeys]
    claudeBusyKeys.clear()
    log(
      `telegram gateway: disconnect-flush cleared ${orphanCount} orphan claudeBusyKeys ` +
      `entr${orphanCount === 1 ? 'y' : 'ies'} (synthetic-inbound deliveries that never turn_ended)` +
      ` keys=${orphanKeys.join(',')}`,
    )
  }

  // Stop coalesce timers that could emit into a finalized draft stream, but
  // preserve chats with pendingCompletion=true — those have background
  // sub-agents that legitimately outlive the parent bridge disconnect. The
  // heartbeat continues for preserved chats so elapsed-time ticks and the
  // deferred-completion-timeout path remain active. Fix for #393.
  disposeProgressDriver()

  // Finalize any open draft streams so they don't hang mid-edit.
  for (const [key, stream] of activeDraftStreams.entries()) {
    if (!stream.isFinal()) void stream.finalize().catch(() => {})
    activeDraftStreams.delete(key)
    activeDraftParseModes.delete(key)
  }

  return true
}
