/**
 * Driver that owns per-chat progress-card state and controls when to emit
 * an `update` call to the outer world (typically a handleStreamReply or a
 * test spy).
 *
 * Cadence rules:
 *   - Fire IMMEDIATELY on state transitions (tool start, tool end, stage
 *     change, enqueue). This is the key anti-flicker property — each event
 *     renders exactly once at the moment of semantic change.
 *   - Coalesce bursts: if multiple events land within `coalesceMs`, only
 *     the last render actually fires (a single setTimeout collapses them).
 *   - Hard floor: never emit faster than `minIntervalMs` to respect
 *     Telegram's editMessageText rate budget.
 *
 * Pure in-process state. No IO; the outer `emit` callback does the send.
 */

import type { SessionEvent } from './session-tail.js'
import {
  hasInFlightSubAgents,
  initialState,
  reduce,
  render,
  type ProgressCardState,
  type TaskNum,
} from './progress-card.js'

/**
 * Classification of a Telegram API error for failure-escalation purposes.
 *
 * - `permanent_4xx`: 4xx error that won't resolve itself (message deleted,
 *   bot blocked, etc.). After K consecutive such failures the card is marked
 *   terminal and all further edits are suppressed.
 * - `transient`: network/5xx error — retryable; does NOT count toward the
 *   permanent-failure threshold.
 * - `benign`: "message is not modified" — the edit had no effect because the
 *   text was already identical. Not a failure at all; counter must not advance.
 */
export type ApiFailureKind = 'permanent_4xx' | 'transient' | 'benign'

/**
 * Failure descriptor reported back to the driver after an async emit fails.
 * The outer layer (server.ts) inspects the raw Telegram error and classifies
 * it before calling `reportApiFailure`.
 */
export interface ApiFailureInfo {
  /** HTTP-level error code from Telegram (400, 403, 404, 500, …). */
  code: number
  /** Telegram's `description` field, e.g. "Forbidden: bot was blocked by the user". */
  description: string
  kind: ApiFailureKind
}

export interface ProgressDriverConfig {
  /**
   * Emit rendered HTML for the given chat+thread. Caller owns the send.
   *
   * `isFirstEmit` is true exactly once per turn — on the very first flush
   * that creates the Telegram message. The caller can use this signal to
   * pin the new message: after this call resolves, the message_id will be
   * available in the caller's draft-stream handle.
   */
  emit: (args: {
    chatId: string
    threadId?: string
    /** Unique key for this turn (chatId:threadId:seq). Use for pin/unpin tracking. */
    turnKey: string
    html: string
    done: boolean
    /** True only on the first flush for this turn (message creation). */
    isFirstEmit: boolean
  }) => void
  /**
   * Optional callback fired once per turn immediately after the final
   * render on `turn_end`. Receives a compact, one-line plain-text
   * summary suitable for the session-handoff continuity line. The outer
   * layer typically pipes this into `writeLastTurnSummary(agentDir, …)`
   * so that a session restart can show "↩️ Picked up — <summary>"
   * even if the Stop-hook summarizer didn't run.
   */
  onTurnEnd?: (summary: string) => void
  /**
   * Fired once per turn when `turn_end` is processed, with full chat
   * context. Use this for per-chat post-completion work: unpin the card,
   * send a completion summary to the main chat, etc.
   *
   * Fires BEFORE the per-chat state is deleted, so `summary` is still
   * accessible. The caller must NOT re-enter the driver from this callback.
   */
  onTurnComplete?: (args: {
    chatId: string
    threadId?: string
    /** Unique key for this turn (chatId:threadId:seq). Use for pin/unpin tracking. */
    turnKey: string
    summary: string
    taskIndex: number
    taskTotal: number
  }) => void
  /** Min ms between edits for a given chat+thread. Default 500. */
  minIntervalMs?: number
  /** Coalesce window — burst events within this land as one render. Default 400. */
  coalesceMs?: number
  /** `Date.now` override for tests. */
  now?: () => number
  /** `setTimeout` override for tests. */
  setTimeout?: (fn: () => void, ms: number) => { ref: unknown }
  clearTimeout?: (ref: unknown) => void
  /** `setInterval` override for tests (used by the heartbeat). */
  setInterval?: (fn: () => void, ms: number) => { ref: unknown }
  clearInterval?: (ref: unknown) => void
  /**
   * Heartbeat cadence for the no-events-flowing re-render. When a turn
   * has settled into a long-running tool call (e.g. a sub-agent that
   * emits no session-JSONL events for minutes), the elapsed-time counter
   * in the card header never visibly ticks because no event fires a
   * re-render. The heartbeat forces a flush every `heartbeatMs` while
   * any chat has a running turn. Default 5000. Set to 0 to disable.
   */
  heartbeatMs?: number
  /**
   * Multi-agent rate-limit guardrail (design §4.4). Telegram caps edits
   * at ~20/min/chat. With N parallel sub-agents emitting bursty events
   * the default 400ms coalesce + 500ms floor can exceed the cap. When
   * we observe more than `editBudgetThreshold` edits in the trailing
   * 60s for a chat, the coalesce window expands to `editBudgetCoalesceMs`
   * until the rate drops back. Heartbeat is also suppressed while the
   * budget is hot.
   *
   * Defaults: threshold=18, coalesce window when hot=3000ms.
   */
  editBudgetThreshold?: number
  editBudgetCoalesceMs?: number
  /**
   * Zombie-card ceiling. If a chat's `lastEventAt` is older than this
   * many ms, the heartbeat loop force-closes the card (flush done,
   * onTurnComplete, delete from chats). This is the backstop for cards
   * orphaned by a missed `turn_end` line or an enqueue echo-drop that
   * routed events to a different card — without it, the heartbeat
   * would re-render a stale card forever (50+ minute ghost cards).
   *
   * Default 30 minutes. Set to 0 to disable entirely (not recommended
   * outside tests).
   */
  maxIdleMs?: number
  /**
   * Suppress the progress card for fast turns. The first emit is
   * deferred by this many ms after startTurn. If `turn_end` arrives
   * before the timer fires (and isFirstEmit is still true), no card
   * is ever shown — the user only sees the final reply.
   *
   * Default 30000 (30 seconds). Set to 0 to disable.
   */
  initialDelayMs?: number
  /**
   * Number of consecutive 4xx Telegram API failures on card edits before
   * the card is marked terminal and all further edits are suppressed for
   * this turn. Transient (5xx/network) errors and "message is not modified"
   * do NOT count toward this threshold. A single success resets the counter.
   *
   * Default 3. Set to 0 to disable the escalation mechanism entirely.
   */
  maxConsecutive4xx?: number
}

/**
 * Compact one-line summary of a completed turn for the handoff sidecar.
 * Shape: `"<tool-count> tool[s], <duration> — <user-request>"`.
 * Falls back gracefully when fields are missing (empty items → "no tools";
 * no userRequest → just the stats prefix).
 */
export function summariseTurn(state: ProgressCardState, now: number): string {
  const toolCount = state.items.length
  const toolLabel = toolCount === 1 ? '1 tool' : `${toolCount} tools`
  const durSec = Math.max(0, Math.floor((now - state.turnStartedAt) / 1000))
  const dur =
    durSec >= 60
      ? `${Math.floor(durSec / 60)}:${(durSec % 60).toString().padStart(2, '0')}`
      : `${durSec}s`
  const stats = toolCount === 0 ? `no tools, ${dur}` : `${toolLabel}, ${dur}`
  const req = state.userRequest?.trim()
  return req ? `${stats} — ${req}` : stats
}

interface PerChatState {
  chatId: string
  threadId?: string
  /** Unique key for this turn: `chatId:threadId:seq`. Used as the chats-map key. */
  turnKey: string
  /** 1-based index of this card among all cards created for this chat:thread in this session. */
  taskIndex: number
  /** Total cards created for this chat:thread so far (snapshot at card creation). */
  taskTotal: number
  state: ProgressCardState
  lastEmittedAt: number
  lastEmittedHtml: string | null
  pendingTimer: unknown
  /** True until the very first flush fires for this turn. Cleared after first emit. */
  isFirstEmit: boolean
  /** Timer for the deferred first emit (initial-delay suppression). */
  deferredFirstEmitTimer: unknown
  /**
   * Wall-clock ms of the last real session event routed to this card.
   * Distinct from `lastEmittedAt`: the heartbeat ticks `lastEmittedAt`
   * every cycle, but `lastEventAt` only advances when an actual event
   * (enqueue, tool_use, tool_result, turn_end, sub_agent_*) lands on
   * this chat state. The heartbeat uses it as a zombie ceiling — a
   * card whose `lastEventAt` is older than `maxIdleMs` has been
   * orphaned (turn_end missed by the session-tail, or an enqueue
   * echo-drop routed events to a different card) and is force-closed
   * so it can't tick forever.
   */
  lastEventAt: number
  /**
   * True once the parent turn has ended (via `turn_end` or
   * `forceCompleteTurn`) BUT one or more sub-agents were still running
   * at that moment. The card stays alive and keeps ticking so the
   * running sub-agents remain visible. When the last running sub-agent
   * transitions to done (via `sub_agent_turn_end` or parent's Agent
   * `tool_result`), completion callbacks finally fire and the card is
   * closed. Guards against duplicate completion firing (both turn_end
   * and forceCompleteTurn can legitimately arrive).
   */
  pendingCompletion: boolean
  /**
   * Set to true the moment completion callbacks have fired, whether
   * immediately (no in-flight sub-agents at turn_end) or deferred
   * (after last sub-agent finished). Guards against double-firing if
   * multiple completion signals race.
   */
  completionFired: boolean
  /**
   * Tracks consecutive Telegram 4xx failures on card edits. Once
   * `terminal` is true, flush() and the heartbeat tick skip all edits
   * for this card (message deleted / bot blocked / stale message_id).
   *
   * Resets automatically when a fresh turn starts (new PerChatState).
   */
  apiFailures: {
    consecutive4xx: number
    lastError: { code: number; description: string; timestamp: number } | null
    terminal: boolean
  }
}

export interface ProgressDriver {
  /** Feed a session-tail event. Fires emit() as the cadence allows. */
  ingest(event: SessionEvent, chatId: string | null, threadId?: string): void
  /** Stop internal timers (heartbeat). Idempotent. */
  dispose?(): void
  /**
   * Begin a new turn synchronously — called from the inbound-message
   * handler the instant a user's message clears the gate, BEFORE any
   * session-tail event arrives. Creates a fresh progress card state; the
   * first visible render is gated by `initialDelayMs` (default 30s) so
   * turns that finish before the delay produce no card at all and the
   * user only sees the final reply.
   *
   * If a card is already active for this chat, it is force-closed (done=true,
   * onTurnComplete fired) before the new card is created. Each call always
   * produces an independent card with its own pin lifecycle.
   */
  startTurn(args: { chatId: string; threadId?: string; userText: string }): void
  /**
   * External completion hook — authoritative turn-finished signal from
   * outside the session-tail path. Intended for `stream_reply(done=true)`
   * so the final-answer arrival acts with equal authority to a session-tail
   * `turn_end` event. Idempotent: first caller wins, subsequent callers
   * on the same chat+thread find no active card and no-op.
   *
   * Closes any active card for (chatId, threadId):
   *   - cancels the deferred-first-emit timer (fast-turn suppression)
   *   - synthesizes a `turn_end` through the reducer
   *   - fires onTurnEnd + onTurnComplete
   *   - clears chats map + bookkeeping
   *
   * If the deferred first emit hasn't landed yet (fast turn), `flush` sees
   * `forceDone=true` on a still-`isFirstEmit=true` state and suppresses
   * the emit entirely — no ghost card. If the card already emitted, the
   * normal flush+unpin path runs via onTurnComplete.
   */
  forceCompleteTurn(args: { chatId: string; threadId?: string }): void
  /** Current state for a chat (for tests / inspection). */
  peek(chatId: string, threadId?: string): ProgressCardState | undefined
  /**
   * True when the driver is still managing an active card for this chat+
   * thread — either a normal turn or a deferred-completion turn waiting on
   * in-flight sub-agents. Used by the gateway's `closeProgressLane`
   * backstop to avoid tearing down the draft stream while the driver is
   * still going to emit into it. Without this guard, parent turn_end
   * closes the stream, sub-agent tool_use events fire fresh emits, and
   * each emit creates a new `sendMessage` on Telegram (= new push
   * notification) instead of editing the pinned card.
   */
  hasActiveCard(chatId: string, threadId?: string): boolean
  /**
   * Report a Telegram API failure back to the driver after an async emit
   * fails. The outer layer (server.ts catch handler) classifies the raw
   * error and calls this so the driver can track consecutive 4xx failures
   * and mark the card terminal when the threshold is reached.
   *
   * Rules:
   *   - `benign` (message is not modified) — ignored; counter unchanged.
   *   - `transient` (5xx, network) — logged at debug; counter unchanged.
   *   - `permanent_4xx` — counter incremented; terminal=true after K hits.
   *
   * Idempotent after terminal=true.
   */
  reportApiFailure(turnKey: string, failure: ApiFailureInfo): void
  /**
   * Report a successful Telegram API call for a card. Resets the
   * consecutive-4xx counter so a single success after a transient failure
   * doesn't leave the counter elevated. Call from the `.then()` handler
   * of the async emit in server.ts.
   */
  reportApiSuccess(turnKey: string): void
}

export function createProgressDriver(config: ProgressDriverConfig): ProgressDriver {
  const minIntervalMs = config.minIntervalMs ?? 500
  const coalesceMs = config.coalesceMs ?? 400
  const now = config.now ?? (() => Date.now())
  const setT =
    config.setTimeout ??
    ((fn, ms) => {
      const h = setTimeout(fn, ms)
      return { ref: h }
    })
  const clearT =
    config.clearTimeout ??
    ((ref) => {
      const handle = (ref as { ref: ReturnType<typeof setTimeout> }).ref
      clearTimeout(handle)
    })
  const setI =
    config.setInterval ??
    ((fn, ms) => {
      const h = setInterval(fn, ms)
      return { ref: h }
    })
  const clearI =
    config.clearInterval ??
    ((ref) => {
      const handle = (ref as { ref: ReturnType<typeof setInterval> }).ref
      clearInterval(handle)
    })
  const heartbeatMs = config.heartbeatMs ?? 5000
  const editBudgetThreshold = config.editBudgetThreshold ?? 18
  const editBudgetCoalesceMs = config.editBudgetCoalesceMs ?? 3000
  const maxIdleMs = config.maxIdleMs ?? 30 * 60_000
  const initialDelayMs = config.initialDelayMs ?? 30_000
  const maxConsecutive4xx = config.maxConsecutive4xx ?? 3
  // Per-chat sliding 60s window of recent emit timestamps. When the
  // window holds more than `editBudgetThreshold` entries we're "hot"
  // and coalesce more aggressively.
  const editTimestamps = new Map<string, number[]>()
  function recordEdit(k: string): void {
    const arr = editTimestamps.get(k) ?? []
    arr.push(now())
    // Drop entries older than 60s.
    const cutoff = now() - 60_000
    while (arr.length > 0 && arr[0] < cutoff) arr.shift()
    editTimestamps.set(k, arr)
  }
  function isBudgetHot(k: string): boolean {
    const arr = editTimestamps.get(k)
    if (!arr) return false
    const cutoff = now() - 60_000
    while (arr.length > 0 && arr[0] < cutoff) arr.shift()
    return arr.length >= editBudgetThreshold
  }

  const chats = new Map<string, PerChatState>()
  // Per-chat turn sequence counters. Key = baseKey(chatId, threadId).
  // Each new startTurn increments the counter; the value is the NEXT seq
  // to allocate (so current total = value - 1 once at least one was allocated).
  const baseTurnSeqs = new Map<string, number>()
  // Tracks base keys of turns started via isSync (startTurn). When the
  // corresponding non-sync session-tail echo arrives, it's dropped and
  // the entry is consumed. This prevents orphan cards when a fast turn
  // completes before the session-tail fires its enqueue echo — Guard 1
  // misses it because currentTurnKey is already null, but this guard
  // catches the echo regardless of turn lifecycle state.
  const pendingSyncEchoes = new Map<string, number>()
  // MessageId-based dedup: tracks recently seen enqueue messageIds so
  // that repeated delivery of the same user message (from session
  // restarts, reconnects, or JSONL rotation) is dropped even after
  // Guard 2's one-shot marker has been consumed. Keyed by
  // `base:messageId` → timestamp. Entries expire after 60s.
  const seenEnqueueMsgIds = new Map<string, number>()

  /** Allocate a new turn slot for chatId:threadId. Returns the unique turnKey and 1-based index. */
  function allocateTurnSlot(chatId: string, threadId?: string): { turnKey: string; index: number; total: number } {
    const base = baseKey(chatId, threadId)
    const seq = (baseTurnSeqs.get(base) ?? 0) + 1
    baseTurnSeqs.set(base, seq)
    return { turnKey: `${base}:${seq}`, index: seq, total: seq }
  }

  // Track the last enqueued turn key so non-enqueue session events (tool_use,
  // tool_result, turn_end) which arrive with chatIdMaybe=null from the
  // session-tail supervisor still route to the correct card.
  let currentChatId: string | null = null
  let currentThreadId: string | undefined
  /** Full turn key (chatId:threadId:seq) for the currently active turn. */
  let currentTurnKey: string | null = null
  let heartbeatHandle: { ref: unknown } | null = null
  // Tracks the last elapsed-seconds bucket we emitted for each chat so
  // the heartbeat can coalesce — if the HTML hasn't changed AND the
  // header elapsed counter (rounded to the heartbeat cadence) would
  // still render identically, skip the edit.
  const lastHeartbeatBucket = new Map<string, number>()

  /**
   * Fire completion callbacks + delete chatState + tidy bookkeeping.
   * Idempotent via `completionFired`. Does not touch the reducer or
   * flush — the caller is responsible for putting the state into its
   * final shape before invoking this.
   *
   * Shared by three completion paths:
   *   - Normal turn_end with no in-flight sub-agents
   *   - Deferred completion (last sub-agent finishes after parent turn_end)
   *   - Abandonment (closeZombie for maxIdle / enqueue-force-close)
   */
  function completeTurnFully(cs: PerChatState): void {
    if (cs.completionFired) return
    cs.completionFired = true
    const taskNum = taskNumFor(cs)
    const summary = summariseTurn(cs.state, now())
    if (config.onTurnEnd) {
      try {
        config.onTurnEnd(summary)
      } catch {
        /* never let a summary write break the stream */
      }
    }
    if (config.onTurnComplete) {
      process.stderr.write(`telegram gateway: progress-card: onTurnComplete firing turnKey=${cs.turnKey}\n`)
      try {
        config.onTurnComplete({
          chatId: cs.chatId,
          threadId: cs.threadId,
          turnKey: cs.turnKey,
          summary,
          taskIndex: taskNum.index,
          taskTotal: taskNum.total,
        })
      } catch {
        /* never let completion callback break the stream */
      }
    }
    if (cs.pendingTimer != null) {
      clearT(cs.pendingTimer)
      cs.pendingTimer = null
    }
    if (cs.deferredFirstEmitTimer != null) {
      clearT(cs.deferredFirstEmitTimer)
      cs.deferredFirstEmitTimer = null
    }
    chats.delete(cs.turnKey)
    lastHeartbeatBucket.delete(cs.turnKey)
    editTimestamps.delete(cs.turnKey)
    if (currentTurnKey === cs.turnKey) {
      currentChatId = null
      currentThreadId = undefined
      currentTurnKey = null
    }
    if (chats.size === 0) stopHeartbeat()
  }

  /**
   * Post-ingest check: if the turn is in `pendingCompletion` state and
   * no sub-agents are still in-flight, fire completion. Called after
   * every reducer dispatch that could transition a sub-agent to done
   * (sub_agent_turn_end, parent Agent tool_result, etc.).
   */
  function maybeCompleteDeferredTurn(cs: PerChatState): void {
    if (!cs.pendingCompletion) return
    if (hasInFlightSubAgents(cs.state)) return
    process.stderr.write(`telegram gateway: progress-card: deferred completion firing turnKey=${cs.turnKey} (last sub-agent finished)\n`)
    flush(cs, /*forceDone*/ true)
    completeTurnFully(cs)
  }

  /**
   * Force-close a card regardless of sub-agent state. Used by the
   * heartbeat zombie ceiling (idle > maxIdleMs) and by the enqueue
   * force-close path when a new turn arrives while the old card is
   * still alive. Synthesizes a `turn_end` through the reducer, then
   * explicitly abandons any still-running sub-agents (they won't
   * receive their own sub_agent_turn_end because we're giving up on
   * them) so the final render shows them as done, then runs the
   * shared completion path. Must not re-enter ingest.
   */
  function closeZombie(cs: PerChatState): void {
    if (cs.pendingTimer != null) {
      clearT(cs.pendingTimer)
      cs.pendingTimer = null
    }
    const durationMs = Math.max(0, now() - cs.state.turnStartedAt)
    cs.state = reduce(cs.state, { kind: 'turn_end', durationMs }, now())
    // turn_end no longer force-closes running sub-agents (background
    // agents may legitimately outlive parent turn_end). But closeZombie
    // IS the abandonment path — we ARE giving up on them here. Close
    // them explicitly so the final render shows all work accounted for.
    if (hasInFlightSubAgents(cs.state)) {
      const closed = new Map(cs.state.subAgents)
      const nowMs = now()
      for (const [k, sa] of closed) {
        if (sa.state === 'running') {
          closed.set(k, { ...sa, state: 'done', finishedAt: nowMs, pendingPreamble: null })
        }
      }
      cs.state = { ...cs.state, subAgents: closed }
    }
    flush(cs, /*forceDone*/ true)
    completeTurnFully(cs)
    // Don't clear pendingSyncEchoes — the echo may arrive after zombie close.
  }

  function startHeartbeatIfNeeded(): void {
    if (heartbeatMs <= 0) return
    if (heartbeatHandle != null) return
    if (chats.size === 0) return
    heartbeatHandle = setI(() => {
      // Force a re-render for any chat with an open turn so the header
      // elapsed time and per-item `(dur)` tick visibly — even when no
      // session-JSONL events have arrived for a while (common while a
      // sub-agent is running). Coalesce: only actually emit if either
      // the rendered HTML changed or the elapsed-time bucket
      // (rounded to the heartbeat period) advanced.
      //
      // Zombie ceiling: collect any card whose last real event is
      // older than maxIdleMs and force-close it after the iteration.
      // Deferring the close keeps Map iteration safe and lets us batch
      // the cleanup.
      const zombies: PerChatState[] = []
      for (const [, cs] of chats) {
        // Skip only when TRULY done. During the deferred-completion
        // window (parent turn_end fired but background sub-agents are
        // still running), reducer stage is 'done' but the card is
        // still alive and `hasInFlightSubAgents` is true. We want the
        // heartbeat to keep ticking so elapsed time + sub-agent
        // durations visibly advance — a frozen "✅ Done" card was the
        // "card went dead" bug.
        if (cs.state.stage === 'done' && !hasInFlightSubAgents(cs.state)) continue
        // Skip heartbeat for terminal cards — the Telegram message is gone
        // (deleted / bot blocked). No edits should be attempted.
        if (cs.apiFailures.terminal) continue
        // Don't heartbeat a card that's still in the initial delay window.
        if (cs.isFirstEmit && cs.deferredFirstEmitTimer !== DELAY_ELAPSED) continue
        if (maxIdleMs > 0 && now() - cs.lastEventAt > maxIdleMs) {
          zombies.push(cs)
          continue
        }
        // Skip heartbeat while the chat is hot — sub-agent bursts are
        // already producing edits, the elapsed counter is ticking from
        // those, and an extra heartbeat edit just spends budget. (Design
        // §4.4: "heartbeat respects budget too".)
        if (isBudgetHot(cs.turnKey)) continue
        const stuckMs = Math.max(0, now() - cs.lastEventAt)
        const html = render(cs.state, now(), undefined, { stuckMs })
        const bucket = Math.floor(now() / heartbeatMs)
        const prevBucket = lastHeartbeatBucket.get(cs.turnKey)
        if (html === cs.lastEmittedHtml && bucket === prevBucket) continue
        lastHeartbeatBucket.set(cs.turnKey, bucket)
        cs.lastEmittedHtml = html
        cs.lastEmittedAt = now()
        recordEdit(cs.turnKey)
        config.emit({
          chatId: cs.chatId,
          threadId: cs.threadId,
          turnKey: cs.turnKey,
          html,
          done: false,
          isFirstEmit: false,
        })
      }
      for (const cs of zombies) closeZombie(cs)
      // Evict stale dedup entries to prevent unbounded map growth.
      const t60 = now() - 60_000
      for (const [k, ts] of seenEnqueueMsgIds) {
        if (ts <= t60) seenEnqueueMsgIds.delete(k)
      }
      const t30 = now() - 30_000
      for (const [k, ts] of pendingSyncEchoes) {
        if (ts <= t30) pendingSyncEchoes.delete(k)
      }
      // If every chat has ended, stop the heartbeat to avoid an
      // always-on timer.
      if (chats.size === 0) stopHeartbeat()
    }, heartbeatMs)
  }

  function stopHeartbeat(): void {
    if (heartbeatHandle == null) return
    clearI(heartbeatHandle)
    heartbeatHandle = null
  }

  /** Base key for a chat:thread (no turn seq). Used as prefix for turn keys. */
  function baseKey(chatId: string, threadId?: string): string {
    return threadId != null ? `${chatId}:${threadId}` : chatId
  }

  /**
   * Return the N/M task counter for a card. Index and total are derived
   * from the currently ACTIVE cards for this chat:thread — NOT the
   * session-cumulative baseTurnSeqs counter. Using the cumulative counter
   * causes "(11/11)" to appear after 11 sequential turns, which reads as
   * "task 11 of 11" (confusingly final-looking) rather than conveying
   * parallel concurrency. The N/M suffix is only meaningful when 2+ cards
   * are simultaneously active; for sequential turns it should be absent.
   */
  function taskNumFor(chatState: PerChatState): TaskNum {
    const base = baseKey(chatState.chatId, chatState.threadId)
    // Count only currently active cards for this chat:thread so that
    // sequential turns always return total=1 (counter hidden) and only
    // parallel active turns (2+ simultaneous cards) show "(N/M)".
    let activeCount = 0
    let activeIndex = 1
    for (const [, cs] of chats) {
      if (baseKey(cs.chatId, cs.threadId) === base) {
        activeCount++
        if (cs.turnKey === chatState.turnKey) activeIndex = activeCount
      }
    }
    return { index: activeIndex, total: activeCount }
  }

  const DELAY_ELAPSED = 'elapsed'
  function flush(chatState: PerChatState, forceDone: boolean): void {
    // If this card has hit the permanent-failure threshold, don't attempt
    // any more edits. Avoids log spam and pointless retries for deleted
    // messages / blocked bots.
    if (chatState.apiFailures.terminal) return
    // Suppress the card entirely if the turn ends before the initial
    // delay has elapsed — no point flashing a "Working…" card for a
    // turn that completed in under initialDelayMs.
    if (chatState.isFirstEmit && initialDelayMs > 0 && chatState.deferredFirstEmitTimer !== DELAY_ELAPSED) {
      if (forceDone || chatState.state.stage === 'done') {
        // Turn ended before the card was ever shown — suppress it.
        if (chatState.deferredFirstEmitTimer != null) {
          clearT(chatState.deferredFirstEmitTimer)
          chatState.deferredFirstEmitTimer = null
        }
        process.stderr.write(`telegram gateway: progress-card: fast-turn suppression turnKey=${chatState.turnKey} (turn ended before initialDelayMs=${initialDelayMs}ms)\n`)
        return
      }
      // Defer the first emit — schedule it for initialDelayMs from now
      // if not already scheduled.
      if (chatState.deferredFirstEmitTimer == null) {
        const capturedTurnKey = chatState.turnKey
        process.stderr.write(`telegram gateway: progress-card: scheduled initial-delay timer turnKey=${capturedTurnKey} delay=${initialDelayMs}ms\n`)
        chatState.deferredFirstEmitTimer = setT(() => {
          if (!chats.has(capturedTurnKey)) return
          chatState.deferredFirstEmitTimer = DELAY_ELAPSED
          process.stderr.write(`telegram gateway: progress-card: initial-delay timer fired turnKey=${capturedTurnKey}\n`)
          flush(chatState, false)
        }, initialDelayMs)
      }
      return
    }
    const taskNum = taskNumFor(chatState)
    const stuckMs = Math.max(0, now() - chatState.lastEventAt)
    const html = render(
      chatState.state,
      now(),
      taskNum.total > 1 ? taskNum : undefined,
      { stuckMs },
    )
    if (html === chatState.lastEmittedHtml && !forceDone) return
    chatState.lastEmittedHtml = html
    chatState.lastEmittedAt = now()
    recordEdit(chatState.turnKey)
    const isFirst = chatState.isFirstEmit
    chatState.isFirstEmit = false
    // Notification-spam fix (2026-04-23): never emit done=true while the
    // card is still waiting on in-flight sub-agents. The reducer sets
    // `stage='done'` the moment parent turn_end lands, so a naive
    // `done: stage==='done'` passes done=true on every subsequent sub-
    // agent event. handleStreamReply finalizes + deletes the draft
    // stream after every done=true call, so the NEXT emit creates a
    // fresh sendMessage — which Telegram delivers as a new push
    // notification. Ken observed ~13 identical "✅ Done" notifications
    // while two parallel review sub-agents were grinding.
    //
    // Safe to gate on `hasInFlightSubAgents`: the completion paths
    // (`completeTurnFully` / `closeZombie` / `maybeCompleteDeferredTurn`)
    // either (a) ran when !hasInFlightSubAgents or (b) explicitly marked
    // every running sub-agent as done in the reducer state BEFORE the
    // final flush. So at the instant the terminal emit fires, the
    // condition evaluates to "no running sub-agents" and done=true
    // flows through correctly.
    const terminal =
      (forceDone || chatState.state.stage === 'done')
      && !hasInFlightSubAgents(chatState.state)
    config.emit({
      chatId: chatState.chatId,
      threadId: chatState.threadId,
      turnKey: chatState.turnKey,
      html,
      done: terminal,
      isFirstEmit: isFirst,
    })
  }

  /**
   * True if `a` and `b` differ in any field that actually appears in the
   * rendered card (items, stage, userRequest, latestText). Internal
   * bookkeeping fields like `thinking` that don't reach render() don't
   * count — we don't want to waste a Telegram edit on them.
   */
  function visibleDiff(a: ProgressCardState, b: ProgressCardState): boolean {
    if (a.stage !== b.stage) return true
    if (a.userRequest !== b.userRequest) return true
    if (a.latestText !== b.latestText) return true
    if (a.items.length !== b.items.length) return true
    for (let i = 0; i < a.items.length; i++) {
      if (a.items[i].state !== b.items[i].state) return true
      if (a.items[i].tool !== b.items[i].tool) return true
      // Multi-agent: spawnedAgentId attached on correlation matters for
      // the [Main] line's 🤖 vs ✅ glyph (PR 3 renderer).
      if (a.items[i].spawnedAgentId !== b.items[i].spawnedAgentId) return true
    }
    // Multi-agent: any change in sub-agent shape or per-sub-agent state
    // is user-visible. Cheap O(N) scan; N is the sub-agent count, which
    // is bounded by how many parallel Agent calls one turn makes (~4–12
    // in practice).
    if (a.subAgents.size !== b.subAgents.size) return true
    for (const [k, sa] of a.subAgents) {
      const sb = b.subAgents.get(k)
      if (!sb) return true
      if (sa.state !== sb.state) return true
      if (sa.toolCount !== sb.toolCount) return true
      if (sa.description !== sb.description) return true
      if (sa.parentToolUseId !== sb.parentToolUseId) return true
      if (sa.nestedSpawnCount !== sb.nestedSpawnCount) return true
      if ((sa.currentTool?.toolUseId ?? null) !== (sb.currentTool?.toolUseId ?? null)) return true
    }
    return false
  }

  return {
    ingest(event, chatIdMaybe, threadId) {
      // An `enqueue` event carries its own chatId (extracted from the XML
      // channel wrapper). Everything else falls back to the caller-provided
      // chatIdMaybe, which the session-tail supervisor tracks.
      let chatId = chatIdMaybe
      if (event.kind === 'enqueue') {
        chatId = event.chatId
        threadId = event.threadId ?? undefined

        // Skip enqueue events with no chatId. These come from non-channel
        // turns (e.g. terminal input) forwarded by the bridge's session-tail.
        // Creating a card with chatId=null spams "chat null is not allowlisted"
        // on every emit attempt and produces a ghost card that occupies
        // currentTurnKey, potentially interfering with real card routing.
        if (chatId == null || chatId === '') return

        // A session-tail enqueue (isSync not set) arriving while a card is
        // already live for the same chat+thread is an echo of a sync
        // startTurn() call — drop it. startTurn owns the turn lifecycle for
        // non-steering messages; if we fell through we'd orphan the pinned
        // card and spawn a second "Working…" message that takes over all
        // the updates while the original stays stuck at 0ms.
        if (!event.isSync) {
          // Guard 0 (messageId dedup): if we've already seen an enqueue
          // with this messageId for this chat+thread, drop it. Session
          // restarts can produce multiple echoes of the same user message
          // (each restart re-processes the queue, writing a fresh enqueue
          // to a new JSONL). Guard 2 only catches the first; this guard
          // catches all subsequent duplicates by messageId.
          if (event.messageId != null) {
            const base = baseKey(chatId, threadId ?? undefined)
            const dedupKey = `${base}:${event.messageId}`
            const seenAt = seenEnqueueMsgIds.get(dedupKey)
            if (seenAt != null && now() - seenAt < 60_000) {
              return
            }
            seenEnqueueMsgIds.set(dedupKey, now())
          }

          // Guard 1: active card exists for this chat+thread.
          if (currentTurnKey != null) {
            const existing = chats.get(currentTurnKey)
            if (
              existing != null &&
              existing.chatId === chatId &&
              existing.threadId === threadId
            ) {
              return
            }
          }
          // Guard 2: this enqueue is the session-tail echo of a sync
          // startTurn() call. Drop it and consume the marker. Without
          // this, fast turns that complete before the echo arrives would
          // pass Guard 1 (currentTurnKey already null) and spawn an
          // orphan card.
          const base = baseKey(chatId, threadId ?? undefined)
          const syncStart = pendingSyncEchoes.get(base)
          if (syncStart != null && now() - syncStart < 30_000) {
            pendingSyncEchoes.delete(base)
            return
          }
        }

        // Allocate a new turn slot FIRST — this increments baseTurnSeqs so
        // that taskNumFor() on the old card will see the correct total (N+1)
        // when we render its final "done" frame below.
        const slot = allocateTurnSlot(chatId, threadId)

        // If an existing card is still active for this chat, force-close it
        // so it gets properly done/unpinned before the new card takes over.
        // Also close ghost cards (chatId is null/empty) — these come from
        // non-channel session-tail events that slipped through before the
        // null guard above was added, or from a race.
        //
        // Route through closeZombie so any still-running sub-agents on
        // the old card are explicitly marked done (abandoned) and the
        // shared completion sequence fires exactly once. This is the
        // correct path for "new turn replacing old" even when the old
        // turn was in pendingCompletion state (background sub-agent
        // hadn't reported done yet).
        if (currentTurnKey != null) {
          const existing = chats.get(currentTurnKey)
          if (existing != null && (existing.chatId === chatId || !existing.chatId)) {
            closeZombie(existing)
          }
        }
        currentChatId = chatId
        currentThreadId = threadId
        currentTurnKey = slot.turnKey

        const chatState: PerChatState = {
          chatId,
          threadId,
          turnKey: slot.turnKey,
          taskIndex: slot.index,
          taskTotal: slot.total,
          state: reduce(initialState(), event, now()),
          lastEmittedAt: 0,
          lastEmittedHtml: null,
          pendingTimer: null,
          isFirstEmit: true,
          deferredFirstEmitTimer: null,
          lastEventAt: now(),
          pendingCompletion: false,
          completionFired: false,
          apiFailures: { consecutive4xx: 0, lastError: null, terminal: false },
        }
        chats.set(slot.turnKey, chatState)
        if (event.isSync) {
          pendingSyncEchoes.set(baseKey(chatId, threadId), now())
        }
        startHeartbeatIfNeeded()
        flush(chatState, /*forceDone*/ false)
        return
      } else if (chatId == null) {
        // Non-enqueue event with no explicit chat: fall back to the
        // most recently enqueued chat for this driver.
        chatId = currentChatId
        threadId = threadId ?? currentThreadId
      }
      if (chatId == null) return

      // Route to the current active turn key. Drop late events for a turn
      // that already ended — without this, a stray tool_result after turn_end
      // would resurrect the card. currentTurnKey is cleared on turn_end.
      const k = currentTurnKey
      if (k == null) return
      let chatState = chats.get(k)
      if (chatState == null) return

      const prev = chatState.state
      chatState.state = reduce(chatState.state, event, now())
      chatState.lastEventAt = now()
      const stageChanged = chatState.state.stage !== prev.stage
      const visibleChanged = visibleDiff(prev, chatState.state)

      // Cancel any pending coalesce timer — we'll either fire now or
      // reschedule.
      if (chatState.pendingTimer != null) {
        clearT(chatState.pendingTimer)
        chatState.pendingTimer = null
      }

      // Fire immediately on terminal state — no coalesce delay when the
      // turn finishes. The user sees the final card the instant turn_end
      // lands.
      if (event.kind === 'turn_end' || event.kind === 'enqueue' || stageChanged) {
        if (event.kind === 'turn_end') {
          process.stderr.write(`telegram gateway: progress-card: turn_end flush chatId=${chatState.chatId} threadId=${chatState.threadId ?? '-'} turnKey=${chatState.turnKey}\n`)
        }
        flush(chatState, /*forceDone*/ event.kind === 'turn_end')
        if (event.kind === 'turn_end') {
          if (hasInFlightSubAgents(chatState.state)) {
            // Parent turn ended but sub-agents are still running (common
            // for background Agent calls). Keep the card alive so the
            // sub-agent work stays visible; defer completion until the
            // last running sub-agent reports done via its own
            // sub_agent_turn_end (or the parent Agent tool_result for
            // the foreground case). The heartbeat keeps ticking so the
            // card visibly tracks the in-flight sub-agents.
            chatState.pendingCompletion = true
            const running: string[] = []
            for (const [k, sa] of chatState.state.subAgents) {
              if (sa.state === 'running') running.push(k)
            }
            process.stderr.write(`telegram gateway: progress-card: turn_end deferred turnKey=${chatState.turnKey} reason=in-flight-sub-agents n=${running.length} agentIds=[${running.join(',')}]\n`)
            return
          }
          // No in-flight sub-agents: complete the turn the normal way.
          completeTurnFully(chatState)
        }
        return
      }

      // Post-reduce deferred-completion check: if this event transitioned
      // the last in-flight sub-agent to done (sub_agent_turn_end, parent
      // Agent tool_result), fire completion now.
      maybeCompleteDeferredTurn(chatState)

      // If this event didn't change anything user-visible (e.g. a
      // `thinking` flag toggle that isn't rendered), don't schedule a
      // flush. Prevents emit noise from events that only mutate internal
      // state, and avoids spurious edits driven by ticking elapsed time
      // in the header.
      if (!visibleChanged) return

      // Otherwise: respect the min-interval floor. If we just emitted,
      // defer to at least minIntervalMs after the last emit. Also always
      // coalesce bursts — even a burst that runs past minIntervalMs gets
      // at most one flush per coalesce window.
      //
      // Multi-agent rate-limit: if the chat has emitted >threshold edits
      // in the last 60s, expand the coalesce window to
      // editBudgetCoalesceMs (default 3s) so the Telegram 20/min cap is
      // never exceeded by sub-agent bursts.
      const sinceLast = now() - chatState.lastEmittedAt
      const effectiveCoalesce = isBudgetHot(chatState.turnKey) ? editBudgetCoalesceMs : coalesceMs
      const delay = Math.max(effectiveCoalesce, minIntervalMs - sinceLast, 0)
      const capturedTurnKey = chatState.turnKey
      chatState.pendingTimer = setT(() => {
        // Defensive: if the chat was deleted between schedule and fire
        // (e.g. a turn_end racing with an async boundary added later),
        // don't resurrect it with a stale flush.
        if (!chats.has(capturedTurnKey)) return
        chatState!.pendingTimer = null
        flush(chatState!, /*forceDone*/ false)
      }, delay)
    },

    startTurn({ chatId, threadId, userText }) {
      // Synthesize an enqueue event and run it through the normal ingest
      // path. This guarantees we share all the flush/cadence/teardown
      // semantics with session-tail-driven enqueues.
      //
      // Each call creates a NEW card — if a card is already active for
      // this chat it is force-closed first so it gets properly done/unpinned.
      const raw = `<channel source="switchroom-telegram" chat_id="${chatId}"${threadId != null ? ` message_thread_id="${threadId}"` : ''}>${userText}</channel>`
      this.ingest(
        {
          kind: 'enqueue',
          chatId,
          messageId: null,
          threadId: threadId ?? null,
          rawContent: raw,
          isSync: true,
        },
        chatId,
        threadId,
      )
    },

    forceCompleteTurn({ chatId, threadId }) {
      // Find active chatState for this chat:thread. Prefer the one pointed
      // at by currentTurnKey; fall back to any state matching the chat key.
      let target: PerChatState | undefined
      if (currentTurnKey != null) {
        const cs = chats.get(currentTurnKey)
        if (cs != null && cs.chatId === chatId && cs.threadId === threadId) {
          target = cs
        }
      }
      if (target == null) {
        for (const cs of chats.values()) {
          if (cs.chatId === chatId && cs.threadId === threadId) {
            target = cs
            break
          }
        }
      }
      if (target == null) {
        // No active card for this chat+thread — either the turn already
        // completed via another path, or no turn is in flight. Idempotent
        // no-op.
        return
      }
      // Simulate the normal turn_end path so in-flight sub-agents keep
      // their card surface. If sub-agents are running, this sets
      // pendingCompletion and defers; if not, it closes immediately.
      // stream_reply(done=true) signals "user's answer landed", not
      // "all background work finished" — we must not abandon still-
      // running sub-agents just because the final reply was sent.
      if (target.completionFired) return
      process.stderr.write(`telegram gateway: progress-card: forceCompleteTurn turnKey=${target.turnKey} (external completion signal, e.g. stream_reply done=true)\n`)
      const durationMs = Math.max(0, now() - target.state.turnStartedAt)
      target.state = reduce(target.state, { kind: 'turn_end', durationMs }, now())
      target.lastEventAt = now()
      flush(target, /*forceDone*/ true)
      if (hasInFlightSubAgents(target.state)) {
        target.pendingCompletion = true
        const running: string[] = []
        for (const [k, sa] of target.state.subAgents) {
          if (sa.state === 'running') running.push(k)
        }
        process.stderr.write(`telegram gateway: progress-card: forceCompleteTurn deferred turnKey=${target.turnKey} reason=in-flight-sub-agents n=${running.length} agentIds=[${running.join(',')}]\n`)
        return
      }
      completeTurnFully(target)
    },

    peek(chatId, threadId) {
      // Return the current active turn state for this chat:thread.
      if (currentTurnKey != null) {
        const cs = chats.get(currentTurnKey)
        if (cs != null && cs.chatId === chatId && cs.threadId === threadId) {
          return cs.state
        }
      }
      // Fallback: find any active card for this chatId (threadId match optional).
      for (const cs of chats.values()) {
        if (cs.chatId === chatId && cs.threadId === threadId) return cs.state
      }
      return undefined
    },

    hasActiveCard(chatId, threadId) {
      for (const cs of chats.values()) {
        if (
          cs.chatId === chatId
          && cs.threadId === threadId
          && !cs.completionFired
        ) {
          return true
        }
      }
      return false
    },

    reportApiFailure(turnKey, failure) {
      const cs = chats.get(turnKey)
      if (cs == null) return // turn already completed — ignore
      if (cs.apiFailures.terminal) return // already terminal — no-op

      if (failure.kind === 'benign') {
        // "message is not modified" — not a real failure; don't touch counter.
        return
      }
      if (failure.kind === 'transient') {
        // Network/5xx — retryable by the outer layer; don't escalate.
        process.stderr.write(
          `telegram gateway: progress-card: transient API error turnKey=${turnKey} code=${failure.code} (${failure.description}) — will retry\n`,
        )
        return
      }

      // permanent_4xx
      cs.apiFailures.consecutive4xx++
      cs.apiFailures.lastError = {
        code: failure.code,
        description: failure.description,
        timestamp: now(),
      }

      if (maxConsecutive4xx > 0 && cs.apiFailures.consecutive4xx >= maxConsecutive4xx) {
        cs.apiFailures.terminal = true
        process.stderr.write(
          `telegram gateway: progress-card: card edit giving 4xx, abandoning locally` +
          ` (chat=${cs.chatId}, turnKey=${turnKey}, code=${failure.code}, desc="${failure.description}")\n`,
        )
      } else {
        process.stderr.write(
          `telegram gateway: progress-card: card edit 4xx (${cs.apiFailures.consecutive4xx}/${maxConsecutive4xx})` +
          ` turnKey=${turnKey} code=${failure.code} (${failure.description})\n`,
        )
      }
    },

    reportApiSuccess(turnKey) {
      const cs = chats.get(turnKey)
      if (cs == null) return
      if (cs.apiFailures.consecutive4xx > 0) {
        cs.apiFailures.consecutive4xx = 0
      }
    },

    dispose() {
      stopHeartbeat()
      for (const cs of chats.values()) {
        if (cs.pendingTimer != null) {
          clearT(cs.pendingTimer)
          cs.pendingTimer = null
        }
        if (cs.deferredFirstEmitTimer != null) {
          clearT(cs.deferredFirstEmitTimer)
          cs.deferredFirstEmitTimer = null
        }
      }
      chats.clear()
      currentChatId = null
      currentThreadId = undefined
      currentTurnKey = null
      pendingSyncEchoes.clear()
      seenEnqueueMsgIds.clear()
    },
  }
}
