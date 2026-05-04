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
  hasAnyRunningSubAgent,
  initialState,
  reduce,
  render,
  type ProgressCardState,
  type TaskNum,
  type SubAgentState,
} from './progress-card.js'
import {
  createSubAgentCardRegistry,
  isPerAgentPinsEnabled,
  type SubAgentCardRegistry,
} from './subagent-card.js'
import { isTelegramReplyTool } from './tool-names.js'
import {
  applyToolResult as fleetApplyToolResult,
  applyToolUse as fleetApplyToolUse,
  applyTurnEnd as fleetApplyTurnEnd,
  createFleetMember,
  markStuck as fleetMarkStuck,
  roleFromDispatch,
  type FleetMember,
} from './fleet-state.js'

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
   *
   * `replyToMessageId` is set only on the first emit (when `isFirstEmit`
   * is true) and only when the turn was started with a source message_id
   * (via `startTurn({ replyToMessageId })`). The caller should pass this
   * as `reply_parameters` on the initial `sendMessage` so the progress
   * card is a tappable reply to the user's original message. Edits
   * (subsequent emits) must NOT carry reply_parameters — Telegram rejects
   * it on editMessageText.
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
    /**
     * Set on the first emit only (isFirstEmit=true) when the turn was
     * started via startTurn({ replyToMessageId }). Pass as
     * reply_parameters.message_id on the initial sendMessage.
     */
    replyToMessageId?: number
    /**
     * Per-agent card identity. Absent for parent-card emits (the
     * gateway treats absence as the parent sentinel `__parent__`).
     * Present for sub-agent-card emits when `PROGRESS_CARD_PER_AGENT_PINS=1`
     * is set, in which case the gateway must thread it through to
     * `pinMgr.considerPin` / `pinMgr.completeTurn` so each sub-agent
     * card pins independently. See `subagent-card.ts`.
     */
    agentId?: string
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
  /**
   * Fired when a turn ends with no reply sent (silentEnd=true). The outer
   * layer can write a state file so the Stop hook can block the session and
   * re-prompt the agent. The callback returns `{ suppressed: true }` when the
   * retry is allowed (retryCount was 0) — in that case the driver will
   * re-render the final card WITHOUT the "🙊 Ended without reply" warning so
   * the user doesn't see a false-positive before the retry lands.
   *
   * On the second silent-end (retryCount exhausted) the callback returns
   * `{ suppressed: false }` and the warning card renders as normal.
   *
   * Not fired for autonomous turns (wasAutonomous=true) — those intentionally
   * produce no user-visible reply.
   */
  onSilentEnd?: (args: {
    chatId: string
    threadId?: string
    turnKey: string
  }) => { suppressed: boolean } | void
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
   * The card can be promoted out of suppression early when a sub-agent
   * starts (see `promoteOnSubAgent`) — long-running tool work and
   * background dispatches stay visible without waiting the full delay.
   *
   * Default 60000 (60 seconds, #553 PR 4). Set to 0 to disable.
   */
  initialDelayMs?: number
  /**
   * Promote the first emit immediately when a sub-agent transitions to
   * running during the suppression window, when the watcher fires
   * `onSubAgentStall`, or when `startTurn` carries over running
   * sub-agents from a prior turn (#334 carry-over). The card jumps
   * straight to visible instead of waiting for `initialDelayMs`.
   *
   * Fast-turn suppression (`turn_end` before the card has emitted) is
   * unchanged — it short-circuits in `flush()` regardless of this flag.
   *
   * Default true. Set to false to disable promotion entirely (the card
   * will only appear after `initialDelayMs` elapses, even when sub-agents
   * are dispatched mid-turn).
   */
  promoteOnSubAgent?: boolean
  /**
   * Promote the card out of initial-delay suppression once the agent has
   * issued this many parent-side tool calls in the suppression window.
   * Closes #478 — the user sees no progress card for the first 30s of a
   * substantial turn that does parent-side work (Read/Grep/Bash/Edit)
   * but never dispatches a sub-agent.
   *
   * Symmetric to `promoteOnSubAgent`. **Default 0 (disabled, #553 PR 4):**
   * under the v2 contract tools alone never trigger the card — only
   * sub-agents or `elapsed >= 60s`. Values of 0 or non-finite (Infinity)
   * are treated as "never promote on tool count". Set to a positive
   * integer (e.g. 3) to opt back in to the pre-v2 behaviour.
   *
   * Fast-turn suppression in `flush()` is unchanged — if the turn
   * ends before promotion, the card still skips the emit.
   */
  promoteOnParentToolCount?: number
  /**
   * Time-based first-emit promotion (#553 F3): if the turn has been
   * running this long with no tool/sub-agent that already triggered
   * promotion, force the card to emit. Without this, single- or two-
   * tool turns that take 5–30s never cross any existing promotion
   * threshold and the card stays suppressed until `initialDelayMs`,
   * at which point fast-turn-suppression cancels it on `turn_end`.
   *
   * Symmetric to `promoteOnParentToolCount`: pure additive promotion,
   * never delays an emit that would otherwise fire. Fast-turn
   * suppression in `flush()` is unchanged — sub-`promoteAfterMs` turns
   * still skip the card.
   *
   * **Default 0 (disabled, #553 PR 4).** The PR #570 5s time-promote was
   * a stop-gap when `initialDelayMs` defaulted to 30s; with the new
   * 60s `initialDelayMs` and the sub-agent promote intact, time-based
   * promotion is no longer needed. `ensureTimePromoteScheduled` no-ops
   * when this is 0 so the timer never schedules. Set to a positive
   * value to opt back in to the pre-v2 behaviour.
   */
  promoteAfterMs?: number
  /**
   * Number of consecutive 4xx Telegram API failures on card edits before
   * the card is marked terminal and all further edits are suppressed for
   * this turn. Transient (5xx/network) errors and "message is not modified"
   * do NOT count toward this threshold. A single success resets the counter.
   *
   * Default 3. Set to 0 to disable the escalation mechanism entirely.
   */
  maxConsecutive4xx?: number
  /**
   * Gap 3 (orphan promotion): how long a `PendingAgentSpawn` must be
   * outstanding before the heartbeat promotes it to a synthesised
   * sub-agent row (state='running'). Gives the sub-agent JSONL watcher a
   * chance to deliver the real `sub_agent_started` event first.
   *
   * Default 5000 (5 seconds). Set to 0 to disable promotion entirely.
   */
  orphanPromotionMs?: number
  /**
   * Gap 4 (cold-JSONL detection): when a running sub-agent's last event
   * is older than this threshold, the heartbeat synthesises a
   * `sub_agent_turn_end` for it so the deferred-completion path can
   * proceed (avoids the card staying pinned forever on a dead watcher).
   *
   * Default 30000 (30 seconds). Set to 0 to disable the synthetic close.
   */
  coldSubAgentThresholdMs?: number
  /**
   * Gap 8 (decoupled render and unpin): after `turn_end` arrives while
   * sub-agents are still running, this is the maximum ms to wait before
   * force-closing the card with a "stalled — forced close" header and
   * calling `onTurnComplete`. This is separate from `maxIdleMs` (which
   * watches for absence of ALL events) — this timeout starts specifically
   * on parent `turn_end` and fires regardless of sub-agent activity.
   *
   * Default 180000 (3 minutes). Set to 0 to disable.
   */
  deferredCompletionTimeoutMs?: number
  /**
   * Fix #314 — elapsed-ticker interval for silent sub-agent gaps.
   *
   * While at least one sub-agent is in `state='running'`, the parent card
   * only re-renders when an event changes the HTML (tool start/end, stage
   * change). During silent stretches between tool calls the elapsed counter
   * freezes — the diff guard suppresses edits when only the timestamp
   * advances. This interval forces a render (bypassing that guard) every N ms
   * so the elapsed counter visibly ticks even when the sub-agent is quietly
   * thinking or waiting for I/O.
   *
   * 10 s was chosen as a balance: short enough that the counter advances
   * at human-perceptible speed (users notice a 15+ second freeze), long
   * enough to stay well under Telegram's ~20 edits/minute budget even when
   * multiple cards are active in parallel.
   *
   * Default 10000. Set to 0 to disable the elapsed-ticker path entirely.
   */
  subAgentTickIntervalMs?: number
}

/**
 * Issue #399: Sync the per-chat running-sub-agent registry after any state
 * transition that may have moved agents to a terminal state.
 *
 * Factored out from the inline block inside `ingest` so it can be called
 * from three paths that can transition agents to done/failed without going
 * through the normal ingest post-reduce step:
 *   1. ingest post-reduce (existing call site, refactored)
 *   2. cold-jsonl-synth path (Gap-4, heartbeat)
 *   3. closeZombie direct mutation path
 *   4. deferred-completion-timeout force-close (Gap-8, heartbeat)
 */
export function syncChatRunningSubagents(
  prev: ProgressCardState,
  next: ProgressCardState,
  cBaseKey: string,
  chatRunningSubagents: Map<string, Map<string, SubAgentState>>,
): { newRunningAppeared: boolean } {
  if (prev.subAgents === next.subAgents) return { newRunningAppeared: false }
  let newRunningAppeared = false
  // Check for new or newly-running entries (sub_agent_started path).
  for (const [agentId, sa] of next.subAgents) {
    if (sa.state === 'running') {
      const prevSa = prev.subAgents.get(agentId)
      if (prevSa == null || prevSa.state !== 'running') {
        // Newly running — register in chat-scoped registry.
        let chatMap = chatRunningSubagents.get(cBaseKey)
        if (chatMap == null) {
          chatMap = new Map<string, SubAgentState>()
          chatRunningSubagents.set(cBaseKey, chatMap)
        }
        chatMap.set(agentId, sa)
        newRunningAppeared = true
      }
    } else if (sa.state === 'done' || sa.state === 'failed') {
      // Terminal state — remove from chat registry if present.
      chatRunningSubagents.get(cBaseKey)?.delete(agentId)
    }
  }
  // Also handle entries that were removed from subAgents entirely
  // (shouldn't happen normally but be defensive).
  for (const agentId of prev.subAgents.keys()) {
    if (!next.subAgents.has(agentId)) {
      chatRunningSubagents.get(cBaseKey)?.delete(agentId)
    }
  }
  return { newRunningAppeared }
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
   * F3 fix (#553): timer for the time-based first-emit promotion.
   * Scheduled on the first ingest event; fires after `promoteAfterMs`
   * to force-promote turns that don't trip parent-tool-count or
   * sub-agent thresholds (e.g. one long Bash). Cleared on
   * `promoteFirstEmit` or turn end.
   */
  timePromoteTimer: unknown
  /**
   * The Telegram message_id of the user's original inbound message that
   * triggered this turn. Set via startTurn({ replyToMessageId }). Passed
   * as reply_parameters on the FIRST sendMessage only — edits must not
   * carry it (Telegram rejects reply_parameters on editMessageText).
   */
  replyToMessageId?: number
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
   * Set to true when an external code path has assumed ownership of
   * the pinned card message (e.g. turn-flush rewriting the card with
   * the user-facing answer — see #654). Once true, `flush()`
   * short-circuits at the top so the driver never edits the card
   * again for this turn. The external owner is responsible for
   * issuing the final edit/unpin via pinMgr.
   */
  cardTakenOver: boolean
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
  /**
   * Issue #132: did the agent call `reply` or `stream_reply` (under any
   * MCP server-key prefix) at least once during this turn?
   *
   * Set true on the first matching `tool_use` event observed by `ingest()`.
   * When the turn ends with this still false, the card renders the
   * "🙊 Ended without reply" silent-end variant instead of "✅ Done" so the
   * user can tell the difference between "agent acknowledged with text"
   * and "agent ran tools and went mute". Resets implicitly with each new
   * `PerChatState` (one per turn).
   */
  replyToolCalled: boolean
  /**
   * Issue #137: how many outbound replies actually landed in the chat
   * this turn? Bumped by `ProgressDriver.recordOutboundDelivered()` from
   * the gateway's executeReply / executeStreamReply success paths.
   *
   * Combined with `replyToolCalled` at turn-end, this distinguishes:
   *   - both false              → silent-end (#132, "Ended without reply")
   *   - replyToolCalled only    → reply attempted but never delivered
   *                               (#137 — render a degraded variant
   *                               distinct from silent-end so the user
   *                               knows the agent TRIED)
   *   - delivered>0             → real success
   */
  outboundDeliveredCount: number
  /**
   * Issue #259: true when the turn was started by an autonomous wakeup
   * sentinel (`<<autonomous-loop>>` or `<<autonomous-loop-dynamic>>`).
   * When set, the "🙊 Ended without reply" silent-end warning is
   * suppressed — autonomous turns intentionally produce no user-visible
   * reply and ending without one is entirely expected.
   */
  wasAutonomous: boolean
  /**
   * Set by prepareSilentEndSuppression when onSilentEnd returns
   * { suppressed: true }. Causes flush() to render the final card without
   * the "🙊 Ended without reply" header so no false-positive appears before
   * the retry reply lands.
   */
  silentEndSuppressed: boolean
  /**
   * Idempotent guard for prepareSilentEndSuppression — ensures the
   * onSilentEnd callback (which writes the Stop-hook state file) only
   * fires once per turn even if multiple sites call into the helper.
   */
  silentEndPrepared: boolean
  /**
   * Gap 8 (decoupled render and unpin): set to the timestamp when parent
   * `turn_end` landed while sub-agents were still running. Used by the
   * heartbeat to enforce `deferredCompletionTimeoutMs`. Null until
   * parent turn_end with in-flight sub-agents is observed.
   */
  parentTurnEndAt: number | null
  /**
   * Gap 8: true once the parent-done render (✅ Done header with sub-agents
   * still visible) has been emitted. Prevents re-rendering the ✅ Done
   * frame on every sub-agent event while deferred.
   */
  parentDoneRendered: boolean
  /**
   * Gap 3 (orphan promotion): set of toolUseIds from `pendingAgentSpawns`
   * that have already been promoted to synthetic sub-agent rows. Guards
   * against re-promotion on successive heartbeat ticks and against
   * double-registration if a real `sub_agent_started` arrives later.
   */
  promotedSpawnIds: Set<string>
  /**
   * P0 of #662 — shadow fleet map updated alongside `state.subAgents` at
   * every sub_agent_* event. Coexists with the legacy map; P1/P2/P3 build
   * the v2 two-zone status card on this without disturbing the existing
   * renderer. See fleet-state.ts for the pure transitions.
   */
  fleet: Map<string, FleetMember>
}

export interface ProgressDriver {
  /** Feed a session-tail event. Fires emit() as the cadence allows. */
  ingest(event: SessionEvent, chatId: string | null, threadId?: string): void
  /**
   * Stop internal timers and clear driver state. Idempotent.
   *
   * When called with `{ preservePending: true }`, chats with
   * `pendingCompletion === true` are preserved so their heartbeat and
   * deferred-completion timeout continue firing after a bridge disconnect.
   * Coalesce timers (`pendingTimer`, `deferredFirstEmitTimer`) on those
   * preserved chats ARE cleared — they cannot safely emit into a finalized
   * draft stream. Chats WITHOUT `pendingCompletion` are fully removed.
   * The heartbeat is only stopped if no `pendingCompletion` chats remain.
   *
   * When called with no args or `{ preservePending: false }`, the existing
   * wipe-everything behavior is retained for back-compat.
   */
  dispose?(opts?: { preservePending?: boolean }): void
  /**
   * Begin a new turn synchronously — called from the inbound-message
   * handler the instant a user's message clears the gate, BEFORE any
   * session-tail event arrives. Creates a fresh progress card state; the
   * first visible render is gated by `initialDelayMs` (default 60s) so
   * turns that finish before the delay produce no card at all and the
   * user only sees the final reply.
   *
   * If a card is already active for this chat, it is force-closed (done=true,
   * onTurnComplete fired) before the new card is created. Each call always
   * produces an independent card with its own pin lifecycle.
   */
  startTurn(args: { chatId: string; threadId?: string; userText: string; replyToMessageId?: number }): void
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
  /**
   * #654 deterministic double-message fix. Hand off ownership of the
   * pinned progress card for an active turn so an external code path
   * (specifically the turn-flush backstop in gateway.ts) can rewrite
   * the card message with the user-facing answer instead of issuing a
   * fresh sendMessage that lands as a second Telegram message.
   *
   * Effects:
   *   - cancels the deferred-first-emit timer if pending (no late
   *     card emission can race the takeover)
   *   - sets `cardTakenOver = true` — `flush()` short-circuits at the
   *     top, so no further edits go out from the driver for this turn
   *   - sets `completionFired = true` — guards against double-firing
   *     `completeTurnFully` if a deferred-completion path also runs
   *
   * Returns:
   *   - `wasEmitted`: true iff the card has already been published to
   *     Telegram (i.e. the deferred-emit timer fired or pinning has
   *     occurred). Caller can use this to decide between editMessageText
   *     vs sendMessage.
   *   - `turnKey`: the active turn's full key (chatId:threadId?:seq)
   *     so the caller can look up the pinned messageId via pinMgr.
   *     Null only when no active card exists for (chatId, threadId).
   *
   * Idempotent — safe to call multiple times for the same turn; the
   * second call returns the same shape with timer-cancellation already
   * complete.
   */
  takeOverCard(args: { chatId: string; threadId?: string }): {
    wasEmitted: boolean
    turnKey: string | null
  }
  /** Current state for a chat (for tests / inspection). */
  peek(chatId: string, threadId?: string): ProgressCardState | undefined
  /**
   * P0 of #662 — fetch the shadow fleet map for a chat. Used by tests
   * and (eventually) by the v2 renderer. Same lookup semantics as
   * `peek`. Returns undefined when no active card exists.
   */
  peekFleet(chatId: string, threadId?: string): Map<string, FleetMember> | undefined
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
   * Issue #305 Option A — push a sub-agent narrative line into the
   * pinned progress card's row body for `agentId` (jsonl_agent_id).
   * Replace-on-each-call. Caller (gateway) is responsible for truncating
   * `text` to the 200-char card cap before invocation.
   *
   * Returns:
   *   - `{ ok: true }` when the narrative was applied + flush triggered.
   *   - `{ ok: false, reason: 'no_active_card' }` if no card is tracked
   *     for (chatId, threadId) or its turn already completionFired.
   *   - `{ ok: false, reason: 'unknown_agent' }` if the card is active
   *     but does not yet contain a sub-agent for `agentId` (likely a
   *     race with sub-agent watcher's jsonl_agent_id backfill — caller
   *     should fall through to the message-send path).
   *
   * Never throws.
   */
  recordSubAgentNarrative(args: {
    chatId: string
    threadId?: string
    agentId: string
    text: string
  }): { ok: true } | { ok: false; reason: 'no_active_card' | 'unknown_agent' }
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
  /**
   * Issue #137: bump the per-turn outbound-delivered counter for the
   * card matching (chatId, threadId). Called from the gateway's reply
   * success paths (executeReply, executeStreamReply) AFTER the
   * `bot.api.sendMessage` resolved. If no card is active for that
   * chat+thread, the call is a silent no-op (boot banners and other
   * system messages don't tick the counter).
   */
  recordOutboundDelivered(chatId: string, threadId?: string): void
  /**
   * Option C — watcher stall callback. Called by the sub-agent watcher
   * (via config.onStall) when a running sub-agent's JSONL goes silent for
   * longer than `stallThresholdMs`. Updates the sub-agent's `lastEventAt`
   * to trigger the elapsed-ticker so the progress card re-renders with a
   * visible ⚠️ stall indicator, even when the bridge has disconnected.
   *
   * No-op if no card is currently tracking this `agentId`.
   */
  onSubAgentStall(agentId: string, idleMs: number, description: string): void
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
  // v2 card-gate (#553 PR 4): card visibility is `(elapsed >= 60s) OR
  // (any sub-agent appeared)`. Tools alone never trigger the card.
  //   - initialDelayMs: 60s (was 30s) — pushes the time-based gate to
  //     the spec value.
  //   - promoteOnParentToolCount: 0 (was 3) — disabled. The check below
  //     treats 0 (and Infinity) as "never promote on tool count".
  //   - promoteAfterMs: 0 (was 5_000) — disabled. ensureTimePromoteScheduled
  //     no-ops when this is 0, so the timer never schedules. The PR #570
  //     time-promote was a stop-gap when initialDelayMs was 30s; with
  //     initialDelayMs=60s and the sub-agent promote intact, it is no
  //     longer needed.
  //   - promoteOnSubAgent: true (unchanged) — sub-agents/background workers
  //     break the suppression immediately.
  const initialDelayMs = config.initialDelayMs ?? 60_000
  const promoteOnSubAgent = config.promoteOnSubAgent ?? true
  const promoteOnParentToolCount = config.promoteOnParentToolCount ?? 0
  const promoteAfterMs = config.promoteAfterMs ?? 0
  const maxConsecutive4xx = config.maxConsecutive4xx ?? 3
  const orphanPromotionMs = config.orphanPromotionMs ?? 5_000
  const coldSubAgentThresholdMs = config.coldSubAgentThresholdMs ?? 30_000
  const deferredCompletionTimeoutMs = config.deferredCompletionTimeoutMs ?? 3 * 60_000
  const subAgentTickIntervalMs = config.subAgentTickIntervalMs ?? 10_000
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

  // Issue #334: per-chat registry of sub-agents that are still running.
  // Keyed by baseKey(chatId, threadId) → Map<agentId, SubAgentState>.
  // When a sub-agent starts it's added; when it reaches a terminal state
  // (done/failed) it's removed. On a new turn for the same chat, any
  // entries here are cloned into the new PerChatState's subAgents so the
  // new turn's progress card shows still-running background sub-agents
  // from the prior turn.
  const chatRunningSubagents = new Map<string, Map<string, SubAgentState>>()

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
  // Fix #314: tracks the last sub-agent elapsed-tick bucket per turn.
  // Works exactly like `lastHeartbeatBucket` but uses `subAgentTickIntervalMs`
  // as the bucket width. When the bucket advances AND at least one sub-agent
  // is running, the heartbeat forces an emit even when the HTML hash is
  // unchanged. Bucket-based (not timestamp-based) so the comparison is stable
  // even when multiple heartbeat ticks fire at the same `now()` value during
  // a fake-clock advance in tests.
  const lastSubAgentTickBucket = new Map<string, number>()

  // Per-sub-agent card registry (#per-agent-cards). Off by default; opt
  // in with PROGRESS_CARD_PER_AGENT_PINS=1. When enabled, the registry
  // tracks one pinned Telegram card per running sub-agent (alongside
  // the parent card) and emits via the same `config.emit` callback —
  // gated by a synthetic turnKey so the gateway's existing stream-reply
  // infra routes them as separate messages.
  const subAgentCards: SubAgentCardRegistry = createSubAgentCardRegistry(
    { enabled: isPerAgentPinsEnabled() },
    {
      emit: (args) => {
        config.emit({
          chatId: args.chatId,
          threadId: args.threadId,
          turnKey: args.turnKey,
          agentId: args.agentId,
          html: args.html,
          done: args.done,
          isFirstEmit: args.isFirstEmit,
        })
      },
      now,
      // Reuse the driver's coalesce/min-interval defaults so per-agent
      // cards behave consistently with the parent card. The wider
      // `multiCardCoalesceMs` is tuned for the multi-card edit-budget
      // case (§6) — when ≥ 2 sub-agent cards are active in the same
      // chat+thread the registry expands its coalesce window.
      coalesceMs,
      multiCardCoalesceMs: 800,
      minIntervalMs,
      heartbeatMs,
      log: (line) => process.stderr.write(line),
    },
  )

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
  /**
   * Prepare silent-end suppression BEFORE the final flush.
   *
   * Must run before the outer `flush(cs, true)` at every site that calls
   * `completeTurnFully`, so the render at that flush already knows whether
   * to suppress the "🙊 Ended without reply" header. If we relied on
   * `completeTurnFully` to set the flag and re-flush, the outer flush would
   * already have queued a warning-card edit/send to Telegram — and in the
   * worst case (the first edit finalizes before the second arrives) the
   * user sees both the warning AND the corrected card as separate messages.
   *
   * Idempotent — `silentEndPrepared` guards against re-firing the
   * `onSilentEnd` callback (which writes a state file the Stop hook reads).
   */
  function prepareSilentEndSuppression(cs: PerChatState): void {
    if (cs.silentEndPrepared) return
    cs.silentEndPrepared = true
    // #371 fix: when stream_reply(done=true) lands as the final tool call,
    // the Stop hook can fire before session-tail observes the matching
    // tool_use event. Pre-fix replyToolCalled stayed false long enough for
    // isSilentEnd to read true → the silent-end retry kicks in → the user
    // sees a duplicate reply.
    //
    // outboundDeliveredCount is bumped synchronously by
    // recordOutboundDelivered() inside the stream_reply MCP handler when
    // the API call returns successfully — it doesn't depend on the
    // session-tail event landing. Consulting it here closes the race.
    const isSilentEnd =
      !cs.replyToolCalled
      && cs.outboundDeliveredCount === 0
      && !cs.wasAutonomous
    if (!isSilentEnd || !config.onSilentEnd) return
    try {
      const result = config.onSilentEnd({ chatId: cs.chatId, threadId: cs.threadId, turnKey: cs.turnKey })
      if (result?.suppressed === true) {
        cs.silentEndSuppressed = true
      }
    } catch {
      /* never let the callback break the completion path */
    }
  }

  function completeTurnFully(cs: PerChatState): void {
    if (cs.completionFired) return
    cs.completionFired = true
    // Defensive: if a caller forgot to call prepareSilentEndSuppression
    // before its flush, run it now so the onSilentEnd callback still fires
    // (the Stop hook still gets the state file). The flag is already set
    // for any caller that did call it (idempotent guard).
    prepareSilentEndSuppression(cs)
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
    if (cs.timePromoteTimer != null) {
      clearT(cs.timePromoteTimer)
      cs.timePromoteTimer = null
    }
    // Per-agent cards (#per-agent-cards): force-finalize any sub-agent
    // cards still tracked under this parent turn so they emit a final
    // done=true frame and the gateway can unpin them. No-op when the
    // env flag is off (registry has nothing tracked).
    subAgentCards.finalizeAll(cs.turnKey, now())
    chats.delete(cs.turnKey)
    lastHeartbeatBucket.delete(cs.turnKey)
    lastSubAgentTickBucket.delete(cs.turnKey)
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
    // Gate on ANY running sub-agent (correlated OR orphan). Orphans from
    // `Agent({run_in_background:true})` only deregister via their own
    // `sub_agent_turn_end` — the card must stay pinned until then so the
    // user sees the background work. Closes #87. Historical ghost-pin
    // risk (#31/#43) is bounded by `closeZombie` on new enqueue +
    // `maxIdleMs` heartbeat ceiling.
    if (hasAnyRunningSubAgent(cs.state)) return
    process.stderr.write(`telegram gateway: progress-card: deferred completion firing turnKey=${cs.turnKey} (last sub-agent finished)\n`)
    // Set silentEndSuppressed BEFORE the outer flush so the rendered card
    // already excludes the "🙊 Ended without reply" header when a retry is
    // queued. Otherwise the outer flush would queue a warning-card edit
    // and a follow-up correction edit could race or land as a second msg.
    prepareSilentEndSuppression(cs)
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
    // ALL running sub-agents explicitly (including orphans) so the final
    // render shows all work accounted for.
    if (hasAnyRunningSubAgent(cs.state)) {
      const prevStateForSync = cs.state
      const closed = new Map(cs.state.subAgents)
      const nowMs = now()
      for (const [k, sa] of closed) {
        if (sa.state === 'running') {
          closed.set(k, { ...sa, state: 'done', finishedAt: nowMs, pendingPreamble: null })
        }
      }
      cs.state = { ...cs.state, subAgents: closed }
      // Issue #399: sync the chat-scoped running-sub-agent registry so
      // stale entries don't carry over into the next turn's progress card.
      syncChatRunningSubagents(
        prevStateForSync,
        cs.state,
        baseKey(cs.chatId, cs.threadId),
        chatRunningSubagents,
      )
    }
    // Set silentEndSuppressed BEFORE the outer flush — see deferred path.
    prepareSilentEndSuppression(cs)
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
      // Gap 3: pendingAgentSpawns that need orphan promotion this tick.
      const orphanPromotions: PerChatState[] = []
      // Gap 4: running sub-agents whose JSONL watcher appears cold.
      const coldSubAgents: Array<{ cs: PerChatState; agentId: string }> = []
      // Gap 8: cards where the deferred-completion timeout has expired.
      const stalledCards: PerChatState[] = []
      for (const [, cs] of chats) {
        // P3 of #662 — per-member stuck escalation runs FIRST, before any
        // skip gate. This is pure data plumbing on the fleet shadow map;
        // it must happen even when the chat is in the initial-delay window
        // or budget-hot (the renderer's job is gated by those conditions
        // separately). markStuck is idempotent and a no-op for non-running
        // members, so running it every tick is cheap.
        {
          const fleet = cs.fleet
          if (fleet.size > 0) {
            const tNow = now()
            for (const [agentId, m] of fleet) {
              const next = fleetMarkStuck(m, tNow, 60_000)
              if (next !== m) fleet.set(agentId, next)
            }
          }
        }

        // Skip only when TRULY done. During the deferred-completion
        // window (parent turn_end fired but sub-agents — correlated or
        // orphan — are still running), reducer stage is 'done' but the
        // card is still alive. Keeping the heartbeat ticking lets per-row
        // elapsed times advance visibly; otherwise the card looks frozen
        // ("card went dead" bug). Same gate as the defer paths so the
        // heartbeat lifetime tracks the pin lifetime exactly.
        if (cs.state.stage === 'done' && !hasAnyRunningSubAgent(cs.state)) continue
        // Skip heartbeat for terminal cards — the Telegram message is gone
        // (deleted / bot blocked). No edits should be attempted.
        if (cs.apiFailures.terminal) continue
        // Don't heartbeat a card that's still in the initial delay window.
        if (cs.isFirstEmit && cs.deferredFirstEmitTimer !== DELAY_ELAPSED) continue
        if (maxIdleMs > 0 && now() - cs.lastEventAt > maxIdleMs) {
          zombies.push(cs)
          continue
        }

        // Gap 3 — orphan promotion: if any PendingAgentSpawn has been
        // waiting longer than orphanPromotionMs without a matching
        // sub_agent_started, promote it to a synthesised sub-agent row so
        // the work is at least visible on the card.
        if (orphanPromotionMs > 0 && cs.state.pendingAgentSpawns.size > 0) {
          for (const [toolUseId, pending] of cs.state.pendingAgentSpawns) {
            if (!cs.promotedSpawnIds.has(toolUseId) && now() - pending.startedAt >= orphanPromotionMs) {
              orphanPromotions.push(cs)
              break
            }
          }
        }

        // Gap 4 — cold-JSONL detection: if a running sub-agent hasn't
        // emitted an event for coldSubAgentThresholdMs, synthesise a
        // sub_agent_turn_end so the deferred-completion path can proceed.
        if (coldSubAgentThresholdMs > 0 && cs.pendingCompletion) {
          for (const [agentId, sa] of cs.state.subAgents) {
            if (sa.state === 'running' && sa.lastEventAt != null && now() - sa.lastEventAt >= coldSubAgentThresholdMs) {
              coldSubAgents.push({ cs, agentId })
            }
          }
        }

        // Gap 8 — deferred-completion timeout: if the parent turn_end fired
        // but sub-agents never finished within deferredCompletionTimeoutMs,
        // force-close with a "stalled" header.
        if (
          deferredCompletionTimeoutMs > 0
          && cs.parentTurnEndAt != null
          && now() - cs.parentTurnEndAt >= deferredCompletionTimeoutMs
        ) {
          stalledCards.push(cs)
          continue
        }

        // Fix #314 — elapsed-ticker bucket: compute BEFORE the budget-hot
        // skip so the ticker can override the skip when the elapsed counter
        // would otherwise freeze. A bursty sub-agent (many tool calls) makes
        // the chat hot, which suppresses the heartbeat — but the user still
        // expects elapsed time to advance visibly. The ticker provides a hard
        // floor every `subAgentTickIntervalMs` so the UI never looks dead for
        // longer than that, even when a sub-agent is grinding through tools.
        const subAgentRunning = subAgentTickIntervalMs > 0 && hasAnyRunningSubAgent(cs.state)
        const subAgentBucket = subAgentTickIntervalMs > 0 ? Math.floor(now() / subAgentTickIntervalMs) : 0
        const prevSubAgentBucket = lastSubAgentTickBucket.get(cs.turnKey)
        const elapsedTickDue = subAgentRunning && subAgentBucket !== prevSubAgentBucket

        // Skip heartbeat while the chat is hot — sub-agent bursts are
        // already producing edits, the elapsed counter is ticking from
        // those, and an extra heartbeat edit just spends budget. (Design
        // §4.4: "heartbeat respects budget too".) EXCEPTION: when the
        // elapsed-ticker is due, push one render through to keep elapsed
        // visibly advancing — this is the floor that fixes #314.
        if (isBudgetHot(cs.turnKey) && !elapsedTickDue) continue
        if (elapsedTickDue) {
          lastSubAgentTickBucket.set(cs.turnKey, subAgentBucket)
        }
        const stuckMs = Math.max(0, now() - cs.lastEventAt)
        // Issue #132: silentEnd only matters once the parent turn is in
        // `stage='done'` AND no sub-agents are still running. While work
        // is in flight, "no reply yet" is normal; the card stays in
        // "Working…". The renderer applies the same gate, so passing the
        // unconditional flag here is safe.
        // Issue #259: suppress for autonomous wakeup turns (no reply is expected).
        // silentEndSuppressed: set when a retry is queued (first silent-end) so
        // the heartbeat renders "✅ Done" instead of "🙊 Ended without reply".
        const silentEnd = !cs.replyToolCalled && !cs.wasAutonomous && !cs.silentEndSuppressed
        // Issue #137: agent called reply/stream_reply (replyToolCalled=true)
        // but the actual outbound never landed (recordOutboundDelivered was
        // never called for this card). Distinct from silentEnd because the
        // agent TRIED — the failure is in the delivery layer, not the model.
        const replyNotDelivered = cs.replyToolCalled && cs.outboundDeliveredCount === 0
        // Gap 8: pass parentDone to renderer during the deferred-unpin window.
        const parentDone = cs.parentTurnEndAt != null && hasAnyRunningSubAgent(cs.state)
        const html = render(cs.state, now(), undefined, { stuckMs, silentEnd, replyNotDelivered, parentDone }, undefined, cs.fleet)
        const bucket = Math.floor(now() / heartbeatMs)
        const prevBucket = lastHeartbeatBucket.get(cs.turnKey)

        // Fix #314 — elapsed-ticker bypass for the html-unchanged guard. When
        // the elapsed-ticker is due, push the emit through even if html and
        // heartbeat-bucket are both unchanged. Combined with the budget-hot
        // bypass above, this guarantees the elapsed counter advances at most
        // `subAgentTickIntervalMs` apart while a sub-agent is running.
        if (html === cs.lastEmittedHtml && bucket === prevBucket && !elapsedTickDue) continue

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

      // Gap 3: promote stale PendingAgentSpawns to synthetic sub-agent rows.
      for (const cs of orphanPromotions) {
        for (const [toolUseId, pending] of cs.state.pendingAgentSpawns) {
          if (cs.promotedSpawnIds.has(toolUseId)) continue
          if (now() - pending.startedAt < orphanPromotionMs) continue
          cs.promotedSpawnIds.add(toolUseId)
          const syntheticId = `orphan-${toolUseId}`
          process.stderr.write(
            `telegram gateway: progress-card: orphan-promotion toolUseId=${toolUseId} syntheticId=${syntheticId} description="${pending.description}" (Gap 3 #313)\n`,
          )
          // Synthesise a sub_agent_started event — drives the reducer's
          // existing sub_agent_started path (adds to subAgents, removes
          // from pendingAgentSpawns, links checklist item via spawnedAgentId).
          cs.state = reduce(cs.state, {
            kind: 'sub_agent_started',
            agentId: syntheticId,
            firstPromptText: pending.promptText,
          }, now())
          cs.lastEventAt = now()
          flush(cs, false)
        }
      }

      // Gap 4: synthesise sub_agent_turn_end for cold-JSONL sub-agents.
      for (const { cs, agentId } of coldSubAgents) {
        process.stderr.write(
          `telegram gateway: progress-card: cold-jsonl-synth-turn-end agentId=${agentId} turnKey=${cs.turnKey} (Gap 4 #313)\n`,
        )
        const prevStateGap4 = cs.state
        cs.state = reduce(cs.state, { kind: 'sub_agent_turn_end', agentId }, now())
        // Issue #399: sync the chat-scoped running-sub-agent registry so the
        // cold-synth terminal transition doesn't leave a stale entry that would
        // carry over into the next turn's progress card.
        syncChatRunningSubagents(
          prevStateGap4,
          cs.state,
          baseKey(cs.chatId, cs.threadId),
          chatRunningSubagents,
        )
        cs.lastEventAt = now()
        maybeCompleteDeferredTurn(cs)
        if (!cs.completionFired) flush(cs, false)
      }

      // Gap 8: force-close cards whose deferred-completion timeout has expired.
      for (const cs of stalledCards) {
        process.stderr.write(
          `telegram gateway: progress-card: deferred-completion-timeout-expired turnKey=${cs.turnKey} deferredCompletionTimeoutMs=${deferredCompletionTimeoutMs} (Gap 8 #313)\n`,
        )
        // Mark all still-running sub-agents as done first so that the emit's
        // `done` flag is true (the notification-spam guard suppresses done=true
        // while sub-agents are running). The renderer still shows
        // "⚠️ Stalled — forced close" because stalledClose=true now overrides
        // trulyDone in progress-card.ts.
        if (hasAnyRunningSubAgent(cs.state)) {
          const prevStateGap8 = cs.state
          const closed = new Map(cs.state.subAgents)
          const nowMs = now()
          for (const [k, sa] of closed) {
            if (sa.state === 'running') {
              closed.set(k, { ...sa, state: 'done', finishedAt: nowMs, pendingPreamble: null })
            }
          }
          cs.state = { ...cs.state, subAgents: closed }
          // Issue #399: sync the chat-scoped running-sub-agent registry so
          // stale entries from this force-close don't carry into the next turn.
          syncChatRunningSubagents(
            prevStateGap8,
            cs.state,
            baseKey(cs.chatId, cs.threadId),
            chatRunningSubagents,
          )
        }
        prepareSilentEndSuppression(cs)
        flush(cs, /*forceDone*/ true, /*stalledClose*/ true)
        completeTurnFully(cs)
      }
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
  function flush(chatState: PerChatState, forceDone: boolean, stalledClose = false): void {
    // If this card has hit the permanent-failure threshold, don't attempt
    // any more edits. Avoids log spam and pointless retries for deleted
    // messages / blocked bots.
    if (chatState.apiFailures.terminal) return
    // External takeover (e.g. turn-flush rewriting the card with the
    // user-facing answer text — see #654). Once handed off, the driver
    // must never issue another edit for this card; the new owner has
    // full control of the message until they call pinMgr.completeTurn.
    if (chatState.cardTakenOver) return
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
    // Issue #259: autonomous wakeup turns never produce a reply by design —
    // suppress the silent-end warning so the card renders "✅ Done" instead
    // of "🙊 Ended without reply" when ScheduleWakeup / CronCreate fires.
    // silentEndSuppressed is set by completeTurnFully when onSilentEnd returns
    // { suppressed: true } — used to re-render the final card without the
    // warning after a retry is queued, preventing a false-positive flash.
    const silentEnd =
      !chatState.replyToolCalled && !chatState.wasAutonomous && !chatState.silentEndSuppressed
    const replyNotDelivered =
      chatState.replyToolCalled && chatState.outboundDeliveredCount === 0
    // Gap 8: during the deferred-unpin window (parent turn_end fired but
    // sub-agents still running), show ✅ Done in the parent header immediately.
    const parentDone = chatState.parentTurnEndAt != null && hasAnyRunningSubAgent(chatState.state)
    const html = render(
      chatState.state,
      now(),
      taskNum.total > 1 ? taskNum : undefined,
      { stuckMs, silentEnd, replyNotDelivered, parentDone, stalledClose },
      undefined,
      chatState.fleet,
    )
    // Issue #81 diagnostic: which checklist branch is the renderer taking?
    // The card prefers `narratives` (human preambles) over `items` (raw
    // tool counts). When prose lands without narratives we want to know
    // why — log the available state at the decision boundary.
    //
    // Fires on the first emit AND on any forced-done flush (terminal
    // state via completeTurnFully / closeZombie / maybeCompleteDeferredTurn)
    // — both are useful inflection points for understanding what the card
    // looked like when it transitioned.
    if (forceDone || chatState.lastEmittedHtml == null /* first emit or terminal flush */) {
      const s = chatState.state
      const branch = s.narratives.length > 0
        ? 'narratives'
        : s.items.length > 0
          ? 'tool-count-fallback'
          : 'empty'
      process.stderr.write(
        `progress-card.diag: render branch=${branch} chatId=${chatState.chatId} turnKey=${chatState.turnKey} ` +
        `narratives=${s.narratives.length} items=${s.items.length} latestText_len=${s.latestText?.length ?? 0} ` +
        `subagents=${s.subAgents.size} pendingPreamble=${s.pendingPreamble ? 'yes' : 'no'} forceDone=${forceDone}\n`,
      )
    }
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
    // Safe to gate on `hasAnyRunningSubAgent`: the completion paths
    // (`completeTurnFully` / `closeZombie` / `maybeCompleteDeferredTurn`)
    // either (a) ran when no sub-agents are running or (b) explicitly
    // marked every running sub-agent as done in the reducer state BEFORE
    // the final flush. Including orphans here keeps `done=true` suppressed
    // while a background dispatch is still active (closes #87).
    const terminal =
      (forceDone || chatState.state.stage === 'done')
      && !hasAnyRunningSubAgent(chatState.state)
    config.emit({
      chatId: chatState.chatId,
      threadId: chatState.threadId,
      turnKey: chatState.turnKey,
      html,
      done: terminal,
      isFirstEmit: isFirst,
      // Thread the source message_id through on the first emit only so
      // the caller can pass it as reply_parameters on the initial
      // sendMessage. Edits (isFirstEmit=false) must NOT carry it.
      ...(isFirst && chatState.replyToMessageId != null
        ? { replyToMessageId: chatState.replyToMessageId }
        : {}),
    })
  }

  /**
   * Promote a card out of the initial-delay suppression window early.
   * Idempotent — short-circuits if the card has already emitted, the
   * delay has already elapsed, or the card is terminal.
   *
   * Sets `deferredFirstEmitTimer = DELAY_ELAPSED` so the very next
   * `flush()` call bypasses the suppression branch and emits a real
   * card render. Cancels any in-flight deferred timer to prevent a
   * second emit when the original `initialDelayMs` clock would have
   * fired. Calls `flush()` directly so the card surfaces immediately.
   *
   * Used by:
   *   - sub-agent state diff in `ingest()` when a sub-agent transitions
   *     to running during the suppression window
   *   - the enqueue branch when carriedOver running sub-agents seed the
   *     fresh PerChatState (#334 cross-turn carry-over)
   *   - `onSubAgentStall()` when a watcher reports a stalled sub-agent
   *     before the card has emitted
   */
  function promoteFirstEmit(cs: PerChatState, reason: string): void {
    if (!cs.isFirstEmit) return
    if (cs.deferredFirstEmitTimer === DELAY_ELAPSED) return
    if (cs.apiFailures.terminal) return
    if (cs.deferredFirstEmitTimer != null) {
      clearT(cs.deferredFirstEmitTimer)
    }
    if (cs.timePromoteTimer != null) {
      clearT(cs.timePromoteTimer)
      cs.timePromoteTimer = null
    }
    cs.deferredFirstEmitTimer = DELAY_ELAPSED
    process.stderr.write(
      `telegram gateway: progress-card: promoteFirstEmit turnKey=${cs.turnKey} reason=${reason}\n`,
    )
    flush(cs, /*forceDone*/ false)
  }

  /**
   * F3 fix (#553): schedule a one-shot timer that force-promotes the
   * card after `promoteAfterMs` if no other promotion path has fired
   * by then. Idempotent — safe to call repeatedly. The timer is
   * cleared by `promoteFirstEmit` (so the existing promotion paths
   * still win when they fire first) and at turn end.
   *
   * Without this proactive timer, a long single-tool turn (e.g. one
   * 10s Bash) never crosses any existing promotion threshold and
   * the card stays suppressed until `initialDelayMs` (30s by
   * default). Fast-turn-suppression then cancels it on `turn_end`.
   */
  function ensureTimePromoteScheduled(cs: PerChatState): void {
    if (!cs.isFirstEmit) return
    if (cs.deferredFirstEmitTimer === DELAY_ELAPSED) return
    if (cs.apiFailures.terminal) return
    if (cs.timePromoteTimer != null) return
    if (promoteAfterMs <= 0) return
    const elapsed = now() - cs.state.turnStartedAt
    const remaining = Math.max(0, promoteAfterMs - elapsed)
    const capturedTurnKey = cs.turnKey
    cs.timePromoteTimer = setT(() => {
      if (!chats.has(capturedTurnKey)) return
      const cs2 = chats.get(capturedTurnKey)!
      cs2.timePromoteTimer = null
      // Idempotency belt-and-braces: promoteFirstEmit no-ops if already
      // promoted by another path between scheduling and firing.
      promoteFirstEmit(cs2, `time_${promoteAfterMs}ms`)
    }, remaining)
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
      if (sa.currentNarrative !== sb.currentNarrative) return true
    }
    return false
  }

  // P0 of #662 — shadow fleet maintenance. Mutates cs.fleet in place
  // by replacing entries with new immutable FleetMember objects from the
  // pure transition functions in fleet-state.ts.
  function updateFleetForEvent(cs: PerChatState, event: SessionEvent): void {
    switch (event.kind) {
      case 'sub_agent_started': {
        // Idempotent — late duplicates of the same agentId keep the
        // original startedAt + originatingTurnKey snapshot.
        if (cs.fleet.has(event.agentId)) return
        const role = roleFromDispatch(undefined, event.subagentType, event.firstPromptText)
        cs.fleet.set(
          event.agentId,
          createFleetMember({
            agentId: event.agentId,
            role,
            startedAt: now(),
            originatingTurnKey: currentTurnKey ?? cs.turnKey,
          }),
        )
        return
      }
      case 'sub_agent_tool_use': {
        const m = cs.fleet.get(event.agentId)
        if (m == null) return
        cs.fleet.set(event.agentId, fleetApplyToolUse(m, event.toolName, event.input, now()))
        return
      }
      case 'sub_agent_tool_result': {
        const m = cs.fleet.get(event.agentId)
        if (m == null) return
        cs.fleet.set(event.agentId, fleetApplyToolResult(m, event.isError))
        return
      }
      case 'sub_agent_turn_end': {
        const m = cs.fleet.get(event.agentId)
        if (m == null) return
        cs.fleet.set(event.agentId, fleetApplyTurnEnd(m, now()))
        return
      }
      default:
        return
    }
  }

  // Cardinality reconciler: the legacy state.subAgents map can grow
  // through paths the fleet shadow doesn't know about (parent Agent
  // tool_use synthesised correlations, heartbeat orphan promotions,
  // cross-turn carry-over). Mirror those into fleet so the invariant
  // that `fleet` is a superset-or-equal of `subAgents` (by key) holds.
  function reconcileFleetWithSubAgents(cs: PerChatState): void {
    for (const [agentId, sa] of cs.state.subAgents) {
      if (!cs.fleet.has(agentId)) {
        // P0 follow-up (#662 reviewer items 1+2): preserve `startedAt`
        // from the legacy SubAgentState when present so the synthesised
        // carry-over entry doesn't reset the clock and immediately mask
        // a stuck condition. `originatingTurnKey` has no legacy
        // counterpart — fall back to the current/active turn.
        const startedAt = sa.startedAt > 0 ? sa.startedAt : now()
        cs.fleet.set(
          agentId,
          createFleetMember({
            agentId,
            role: sa.description ?? 'agent',
            startedAt,
            originatingTurnKey: currentTurnKey ?? cs.turnKey,
          }),
        )
      }
    }
    // Drop fleet entries the legacy map no longer tracks (rare — only
    // when a parent tool_result correlation prunes a sub-agent before
    // any sub_agent_turn_end arrived).
    for (const agentId of [...cs.fleet.keys()]) {
      if (!cs.state.subAgents.has(agentId)) {
        cs.fleet.delete(agentId)
      }
    }
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

        // Issue #334: seed the new turn's subAgents from any still-running
        // background sub-agents dispatched in a prior turn for this chat.
        const initialTurnState = reduce(initialState(), event, now())
        const cBaseKey = baseKey(chatId, threadId)
        const carriedOver = chatRunningSubagents.get(cBaseKey)
        const seededState: ProgressCardState = (carriedOver != null && carriedOver.size > 0)
          ? {
              ...initialTurnState,
              subAgents: new Map<string, SubAgentState>(
                [...carriedOver.entries()].map(([id, sa]) => [id, { ...sa }]),
              ),
            }
          : initialTurnState

        const chatState: PerChatState = {
          chatId,
          threadId,
          turnKey: slot.turnKey,
          taskIndex: slot.index,
          taskTotal: slot.total,
          state: seededState,
          lastEmittedAt: 0,
          lastEmittedHtml: null,
          pendingTimer: null,
          isFirstEmit: true,
          deferredFirstEmitTimer: null,
          timePromoteTimer: null,
          lastEventAt: now(),
          pendingCompletion: false,
          completionFired: false,
          cardTakenOver: false,
          apiFailures: { consecutive4xx: 0, lastError: null, terminal: false },
          replyToolCalled: false,
          outboundDeliveredCount: 0,
          wasAutonomous: false,
          silentEndSuppressed: false,
          silentEndPrepared: false,
          parentTurnEndAt: null,
          parentDoneRendered: false,
          promotedSpawnIds: new Set(),
          fleet: new Map<string, FleetMember>(),
        }
        chats.set(slot.turnKey, chatState)
        if (event.isSync) {
          pendingSyncEchoes.set(baseKey(chatId, threadId), now())
        }
        startHeartbeatIfNeeded()
        // #334 cross-turn carry-over: a fresh PerChatState seeded with
        // running sub-agents from a prior turn already has visible work
        // to surface. Skip suppression and emit immediately. The diff-
        // based promote in the reducer block above misses this case
        // because the carried-over sub-agents were copied during
        // `initialState()` reduction — there is no prev→next transition
        // for it to detect.
        //
        // Defensive: post-#401, `closeZombie` syncs the chat-scoped
        // registry on every parent-replacement enqueue, so carriedOver
        // is empty in the common path. Keeping the hook means future
        // regressions in the sync path (or a code path that bypasses
        // closeZombie) still produce a visible card instead of a
        // silently-suppressed turn.
        // Per-agent card sync for carried-over sub-agents on the new
        // turn — without this, sub-agents that survive across turn
        // boundaries (#334) wouldn't get their per-agent cards spawned
        // until the next event landed.
        subAgentCards.syncFromParent({
          state: chatState.state,
          chatId: chatState.chatId,
          threadId: chatState.threadId,
          parentTurnKey: chatState.turnKey,
          now: now(),
        })
        if (promoteOnSubAgent && carriedOver != null && carriedOver.size > 0) {
          promoteFirstEmit(chatState, 'carried_over_subagents')
        } else {
          flush(chatState, /*forceDone*/ false)
        }
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
      if (k == null) {
        if (event.kind.startsWith('sub_agent_')) {
          process.stderr.write(
            `telegram gateway: progress-card: late-sub-agent-event-dropped kind=${event.kind} agentId=${'agentId' in event ? (event as { agentId: string }).agentId : 'n/a'} chatId=${chatId}\n`,
          )
        }
        return
      }
      let chatState = chats.get(k)
      if (chatState == null) return

      const prev = chatState.state
      chatState.state = reduce(chatState.state, event, now())
      chatState.lastEventAt = now()

      // P0 of #662 — shadow fleet map. Mirror sub_agent_* events into
      // the parallel FleetMember map using the pure transitions from
      // fleet-state.ts. Legacy state.subAgents is unchanged; P1/P2/P3
      // build on `fleet` without touching the existing renderer.
      updateFleetForEvent(chatState, event)
      // Reconcile shadow with legacy map: any sub-agent that appears in
      // state.subAgents (e.g. via parent-tool-result correlation, the
      // heartbeat orphan-promotion path, or carry-over) but is missing
      // from fleet gets a synthetic FleetMember so the cardinality
      // invariant holds. Conversely, drop fleet entries that legacy
      // dropped (these are already terminal in the watcher's view).
      reconcileFleetWithSubAgents(chatState)
      const stageChanged = chatState.state.stage !== prev.stage
      const visibleChanged = visibleDiff(prev, chatState.state)

      // Per-agent card sync (#per-agent-cards): walk the post-reduce
      // state.subAgents map and spawn / flush / finalize per-sub-agent
      // cards. No-op when PROGRESS_CARD_PER_AGENT_PINS is unset.
      subAgentCards.syncFromParent({
        state: chatState.state,
        chatId: chatState.chatId,
        threadId: chatState.threadId,
        parentTurnKey: chatState.turnKey,
        now: now(),
      })

      // Issue #334/#399: mirror sub-agent state changes into the chat-scoped
      // running-sub-agent registry so new turns can seed from it.
      // We diff prev.subAgents vs chatState.state.subAgents to catch all
      // mutation paths: sub_agent_started, sub_agent_turn_end, and parent
      // tool_result (which can finalize a sub-agent via parentToolUseId).
      // Factored into syncChatRunningSubagents (issue #399) so closeZombie
      // and the heartbeat's cold-jsonl-synth path can call the same logic.
      // Returns `newRunningAppeared` so the caller can promote the card
      // out of initial-delay suppression on a fresh sub-agent transition.
      const { newRunningAppeared: newRunningSubAgentAppeared } = syncChatRunningSubagents(
        prev,
        chatState.state,
        baseKey(chatState.chatId, chatState.threadId),
        chatRunningSubagents,
      )

      // Promote the card out of initial-delay suppression as soon as a
      // sub-agent transitions to running. Long-running sub-agent dispatches
      // are exactly the case where the user wants to see what's happening
      // — waiting the full `initialDelayMs` before showing the card means
      // 30s of staring at a frozen draft bubble. Diff-based detection
      // (rather than gating on a specific event kind) catches every path
      // that reaches `running`: real `sub_agent_started`, heartbeat orphan
      // promotion, and parent-tool-result correlation.
      if (
        newRunningSubAgentAppeared
        && promoteOnSubAgent
        && chatState.isFirstEmit
        && chatState.deferredFirstEmitTimer !== DELAY_ELAPSED
        && !chatState.apiFailures.terminal
      ) {
        promoteFirstEmit(chatState, 'sub_agent_started')
      }

      // #478 / #553 PR 4: promote the card when the agent has issued
      // enough parent-side tool calls during the suppression window.
      // Disabled by default in v2 (promoteOnParentToolCount=0 / Infinity)
      // — under the v2 contract tools alone never trigger the card. The
      // check is preserved as a config knob for callers that want the
      // old behaviour, but values of 0 or non-finite (Infinity) are
      // treated as "never promote on tool count".
      if (
        promoteOnParentToolCount > 0
        && Number.isFinite(promoteOnParentToolCount)
        && chatState.isFirstEmit
        && chatState.deferredFirstEmitTimer !== DELAY_ELAPSED
        && !chatState.apiFailures.terminal
        && chatState.state.items.length >= promoteOnParentToolCount
      ) {
        promoteFirstEmit(chatState, `parent_tool_count_${chatState.state.items.length}`)
      }

      // F3 fix (#553): schedule the time-based promotion timer on
      // every ingest event (idempotent — only the first call schedules;
      // subsequent calls are no-ops). Without this, a long single-tool
      // turn never crossed parent_tool_count or sub_agent thresholds
      // and the card stayed suppressed until initialDelayMs (30s).
      ensureTimePromoteScheduled(chatState)

      // Issue #132: track whether the agent has called `reply` or
      // `stream_reply` at least once this turn so the renderer can
      // distinguish "Done with reply" from "Done without reply" at
      // turn_end. Tool-use intent is the right granularity here — if
      // the call landed but failed mid-API, the model sees the error
      // in tool_result and may retry, which still flips this true.
      // Only false → true; never reset mid-turn.
      if (
        !chatState.replyToolCalled
        && event.kind === 'tool_use'
        && isTelegramReplyTool(event.toolName)
      ) {
        chatState.replyToolCalled = true
      }

      // Issue #81 diagnostic: when a 'text' event lands, did the reducer
      // recognize it as a narrative step? If narratives.length didn't grow,
      // the card's "human-readable preamble" path can't render and the
      // tool-count fallback wins. The log lets us correlate "user typed
      // status?" telemetry with the missing narrative path.
      //
      // Gated behind PROGRESS_CARD_DIAG=1 because this fires on every
      // assistant text event — a long verbose turn could produce dozens
      // of lines per minute. The render-branch and prose-recovery diags
      // (~2x and ~1x per turn respectively) stay always-on. Flip the env
      // var on a one-off agent restart to capture data, then turn it off.
      if (event.kind === 'text' && process.env.PROGRESS_CARD_DIAG === '1') {
        const before = prev.narratives.length
        const after = chatState.state.narratives.length
        const last = chatState.state.narratives[after - 1]
        const preview = last?.text ? last.text.slice(0, 60).replace(/\n/g, ' ') : ''
        const took = before === after ? 'discarded' : 'captured'
        process.stderr.write(
          `progress-card.diag: text-event ${took} chatId=${chatState.chatId} turnKey=${chatState.turnKey} ` +
          `narratives_before=${before} narratives_after=${after} text_len=${event.text.length} preview=${JSON.stringify(preview)}\n`,
        )
      }

      // Cancel any pending coalesce timer — we'll either fire now or
      // reschedule.
      if (chatState.pendingTimer != null) {
        clearT(chatState.pendingTimer)
        chatState.pendingTimer = null
      }

      // Fire immediately on terminal state — no coalesce delay when the
      // turn finishes. The user sees the final card the instant turn_end
      // lands. (Note: `enqueue` events are handled upstream by startTurn,
      // not ingested here, so the prior `event.kind === 'enqueue'` check
      // was dead code per the SessionEvent union.)
      if (event.kind === 'turn_end' || stageChanged) {
        if (event.kind === 'turn_end') {
          process.stderr.write(`telegram gateway: progress-card: turn_end flush chatId=${chatState.chatId} threadId=${chatState.threadId ?? '-'} turnKey=${chatState.turnKey}\n`)
          // Only fire silent-end prep when we're actually about to complete —
          // i.e. no sub-agents still running. The sub-agent defer path
          // returns below and prep will run later via maybeCompleteDeferredTurn.
          if (!hasAnyRunningSubAgent(chatState.state)) {
            prepareSilentEndSuppression(chatState)
          }
        }
        if (event.kind === 'turn_end' && hasAnyRunningSubAgent(chatState.state)) {
          // Gap 8: parent turn_end with sub-agents still running — render
          // done=true immediately (card shows ✅ Done) then defer unpin.
          // Set parentTurnEndAt BEFORE flush so flush()'s parentDone
          // computation picks it up on this very call.
          chatState.parentTurnEndAt = now()
        }
        flush(chatState, /*forceDone*/ event.kind === 'turn_end')
        if (event.kind === 'turn_end') {
          if (hasAnyRunningSubAgent(chatState.state)) {
            // Parent turn ended but at least one sub-agent is still running.
            // Keep the card alive so the sub-agent work stays visible; defer
            // completion until the last running sub-agent reports done via
            // its own sub_agent_turn_end (or the parent Agent tool_result).
            // Closes #87: orphans from `Agent({run_in_background:true})` now
            // gate the defer too, so background dispatches stay visible past
            // parent turn-end. Safety nets: `closeZombie` on new enqueue +
            // the `maxIdleMs` heartbeat ceiling bound the bad case (orphan
            // never reports done).
            chatState.pendingCompletion = true
            const correlated: string[] = []
            const orphans: string[] = []
            for (const [k, sa] of chatState.state.subAgents) {
              if (sa.state === 'running') {
                if (sa.parentToolUseId != null) correlated.push(k)
                else orphans.push(k)
              }
            }
            process.stderr.write(`telegram gateway: progress-card: turn_end deferred turnKey=${chatState.turnKey} reason=in-flight-sub-agents correlated=${correlated.length} orphans=${orphans.length} correlatedAgentIds=[${correlated.join(',')}] orphanAgentIds=[${orphans.join(',')}]\n`)
            return
          }
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

    startTurn({ chatId, threadId, userText, replyToMessageId }) {
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
      // Stash the source message_id and autonomous flag on the newly-created
      // PerChatState so flush() can use them. Do this AFTER ingest() so the
      // new PerChatState entry is in chats.
      if (currentTurnKey != null) {
        const cs = chats.get(currentTurnKey)
        if (cs != null && cs.chatId === chatId) {
          if (replyToMessageId != null) {
            cs.replyToMessageId = replyToMessageId
          }
          // Issue #259: autonomous wakeup turns (ScheduleWakeup / CronCreate
          // sentinel) never produce a user-visible reply by design. Suppress
          // the "🙊 Ended without reply" warning for these turns.
          if (userText.startsWith('<<autonomous-loop')) {
            cs.wasAutonomous = true
          }
        }
      }
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
      if (hasAnyRunningSubAgent(target.state)) {
        target.pendingCompletion = true
        const correlated: string[] = []
        const orphans: string[] = []
        for (const [k, sa] of target.state.subAgents) {
          if (sa.state === 'running') {
            if (sa.parentToolUseId != null) correlated.push(k)
            else orphans.push(k)
          }
        }
        process.stderr.write(`telegram gateway: progress-card: forceCompleteTurn deferred turnKey=${target.turnKey} reason=in-flight-sub-agents correlated=${correlated.length} orphans=${orphans.length} correlatedAgentIds=[${correlated.join(',')}] orphanAgentIds=[${orphans.join(',')}]\n`)
        return
      }
      completeTurnFully(target)
    },

    takeOverCard({ chatId, threadId }) {
      // Mirror the (chatId, threadId) lookup used by forceCompleteTurn
      // — prefer the currentTurnKey-pinned target so concurrent fresh
      // turns can't get clobbered.
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
      if (target == null) return { wasEmitted: false, turnKey: null }

      // Cancel any pending deferred-first-emit timer so no card emits
      // late, AFTER the external owner takes over. If the timer has
      // already fired (DELAY_ELAPSED sentinel), nothing to clear.
      if (target.deferredFirstEmitTimer != null && target.deferredFirstEmitTimer !== DELAY_ELAPSED) {
        clearT(target.deferredFirstEmitTimer)
        target.deferredFirstEmitTimer = null
      }
      // The card has been emitted iff the deferred-emit timer fired
      // (driver's own indicator) or `isFirstEmit === false` (an emit
      // path other than the deferred one already ran).
      const wasEmitted =
        target.deferredFirstEmitTimer === DELAY_ELAPSED || !target.isFirstEmit

      target.cardTakenOver = true
      target.completionFired = true

      process.stderr.write(
        `telegram gateway: progress-card: takeOverCard turnKey=${target.turnKey} wasEmitted=${wasEmitted}\n`,
      )
      return { wasEmitted, turnKey: target.turnKey }
    },

    peekFleet(chatId, threadId) {
      if (currentTurnKey != null) {
        const cs = chats.get(currentTurnKey)
        if (cs != null && cs.chatId === chatId && cs.threadId === threadId) {
          return cs.fleet
        }
      }
      for (const cs of chats.values()) {
        if (cs.chatId === chatId && cs.threadId === threadId) return cs.fleet
      }
      return undefined
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

    recordSubAgentNarrative({ chatId, threadId, agentId, text }) {
      // Locate the active card for (chatId, threadId). Mirrors
      // hasActiveCard's iteration since `chats` is keyed by turnKey.
      let cs: PerChatState | null = null
      for (const candidate of chats.values()) {
        if (
          candidate.chatId === chatId
          && candidate.threadId === threadId
          && !candidate.completionFired
        ) {
          cs = candidate
          break
        }
      }
      if (cs == null) {
        return { ok: false, reason: 'no_active_card' }
      }
      // Sub-agents are keyed by jsonl_agent_id in the reducer state.
      if (!cs.state.subAgents.has(agentId)) {
        return { ok: false, reason: 'unknown_agent' }
      }
      // Dispatch through the same reduce path used by ingest().
      cs.state = reduce(
        cs.state,
        { kind: 'sub_agent_narrative', agentId, text },
        now(),
      )
      // Force re-render even though milestoneVersion didn't bump.
      flush(cs, false)
      return { ok: true }
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

    recordOutboundDelivered(chatId, threadId) {
      // Issue #137: walk the active chats and find the entry matching the
      // outbound destination. We can't index by chatId alone — multiple
      // turns may queue against the same chat — so iterate. The map is
      // small (one entry per active turn) so the linear scan is fine.
      for (const cs of chats.values()) {
        if (cs.chatId === chatId && cs.threadId === threadId) {
          cs.outboundDeliveredCount += 1
          return
        }
      }
      // No active card → outbound was likely a system message (boot
      // banner, restart ack, etc.) and isn't part of any agent turn.
      // Silent no-op.
    },

    dispose(opts?: { preservePending?: boolean }) {
      // Per-agent card registry (#per-agent-cards): only dispose
      // outright when we're not preserving pending. With
      // preservePending the registry continues ticking heartbeats for
      // any cards whose parent chats are still alive — finalizeAll
      // for them fires from the eventual completeTurnFully.
      if (opts?.preservePending !== true) {
        subAgentCards.dispose()
      }
      if (opts?.preservePending === true) {
        // Selective dispose: preserve chats with pendingCompletion=true so
        // their heartbeat and deferred-completion timeout continue firing
        // after a bridge disconnect. This is the fix for the regression
        // introduced in commit 4c0186d where dispose() wiped all in-flight
        // card state on every bridge disconnect (stdio-MCP per-call lifecycle).
        let hasPending = false
        for (const [turnKey, cs] of chats) {
          // Always clear coalesce timers — they could emit into a finalized
          // draft stream and spawn duplicate messages.
          if (cs.pendingTimer != null) {
            clearT(cs.pendingTimer)
            cs.pendingTimer = null
          }
          if (cs.deferredFirstEmitTimer != null) {
            clearT(cs.deferredFirstEmitTimer)
            cs.deferredFirstEmitTimer = null
          }
          if (cs.pendingCompletion) {
            // Keep this chat alive — it has running background sub-agents
            // that will continue emitting events and need the heartbeat.
            hasPending = true
          } else {
            // No pending completion — clear this chat (existing behavior).
            chats.delete(turnKey)
          }
        }
        // Only stop the heartbeat if nothing is pending; if any chat is still
        // alive, the heartbeat is exactly what drives future re-renders.
        if (!hasPending) {
          stopHeartbeat()
        }
        // Reset currentChatId/currentTurnKey only if they no longer map to
        // a surviving pendingCompletion chat.
        if (currentTurnKey != null && !chats.has(currentTurnKey)) {
          currentChatId = null
          currentThreadId = undefined
          currentTurnKey = null
        }
        pendingSyncEchoes.clear()
        seenEnqueueMsgIds.clear()
      } else {
        // Back-compat: wipe everything (original behavior).
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
      }
    },

    onSubAgentStall(agentId: string, _idleMs: number, _description: string) {
      // Option C: watcher detected a stall for this sub-agent. Find which
      // chat state is tracking it and force an elapsed-tick re-render so the
      // ⚠️ stall indicator becomes visible even when no events are flowing.
      for (const cs of chats.values()) {
        if (!cs.state.subAgents.has(agentId)) continue
        const sa = cs.state.subAgents.get(agentId)!
        if (sa.state !== 'running') continue
        // Leave sa.lastEventAt unchanged — the render computes the ⚠️
        // stall badge from (now - sa.lastEventAt) >= SUBAGENT_STALL_MS,
        // so the stale value is exactly what makes the badge appear.
        // All we need to do here is force a re-render so the user sees it.
        //
        // If the card is still suppressed (no first emit yet), the user
        // has nothing on screen — the stall warning needs to be visible
        // immediately. Promote out of the initial-delay window before
        // forcing the heartbeat tick.
        if (
          promoteOnSubAgent
          && cs.isFirstEmit
          && cs.deferredFirstEmitTimer !== DELAY_ELAPSED
          && !cs.apiFailures.terminal
        ) {
          promoteFirstEmit(cs, 'sub_agent_stall')
        }
        // Force the next heartbeat tick to emit by clearing the diff-guard
        // buckets for this turnKey. Note: this clears the chat-level and
        // sub-agent-tick buckets — distinct from cs.lastEventAt (chat-level,
        // drives stuckMs) which is left untouched.
        lastHeartbeatBucket.delete(cs.turnKey)
        lastSubAgentTickBucket.delete(cs.turnKey)
        // If the heartbeat isn't running (it would have been kept alive by
        // preserve-pending, but check defensively), start it.
        if (chats.size > 0) startHeartbeatIfNeeded()
        break
      }
    },
  }
}
