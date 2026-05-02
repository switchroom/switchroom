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

export interface DisconnectFlushDeps<Ctrl extends { setDone: () => void }, Stream extends { isFinal: () => boolean; finalize: () => Promise<void> }> {
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
  /** Mirror map: same keys → parse mode. */
  activeDraftParseModes: Map<string, 'HTML' | 'MarkdownV2' | undefined>

  /** Persist-side reaction registry (per-agent on-disk state). */
  clearActiveReactions: () => void
  /** Progress driver — disposed with `preservePending: true` for sub-agent JTBDs (#393). */
  disposeProgressDriver: () => void

  /** Logger — receives the one-line decision trace. */
  log: (msg: string) => void
}

/**
 * Apply the disconnect-flush policy. Returns `true` when the flush ran
 * (registered agent disconnected), `false` when it was skipped (anonymous
 * client). The boolean is for tests + observability — callers can ignore it.
 */
export function flushOnAgentDisconnect<
  Ctrl extends { setDone: () => void },
  Stream extends { isFinal: () => boolean; finalize: () => Promise<void> },
>(deps: DisconnectFlushDeps<Ctrl, Stream>): boolean {
  const {
    agentName,
    activeStatusReactions,
    activeReactionMsgIds,
    activeTurnStartedAt,
    activeDraftStreams,
    activeDraftParseModes,
    clearActiveReactions,
    disposeProgressDriver,
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
  for (const [key, ctrl] of activeStatusReactions.entries()) {
    ctrl.setDone()
    activeStatusReactions.delete(key)
    activeReactionMsgIds.delete(key)
    activeTurnStartedAt.delete(key)
  }
  clearActiveReactions()

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
