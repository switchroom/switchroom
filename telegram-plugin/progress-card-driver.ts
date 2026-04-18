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
  initialState,
  reduce,
  render,
  type ProgressCardState,
  type TaskNum,
} from './progress-card.js'

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
   * Default 5000 (5 seconds). Set to 0 to disable.
   */
  initialDelayMs?: number
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
}

export interface ProgressDriver {
  /** Feed a session-tail event. Fires emit() as the cadence allows. */
  ingest(event: SessionEvent, chatId: string | null, threadId?: string): void
  /** Stop internal timers (heartbeat). Idempotent. */
  dispose?(): void
  /**
   * Begin a new turn synchronously — called from the inbound-message
   * handler the instant a user's message clears the gate, BEFORE any
   * session-tail event arrives. Creates a fresh progress card and fires
   * an immediate render of the "⚙️ Working…" skeleton so the user sees
   * it within ~1s of their message.
   *
   * If a card is already active for this chat, it is force-closed (done=true,
   * onTurnComplete fired) before the new card is created. Each call always
   * produces an independent card with its own pin lifecycle.
   */
  startTurn(args: { chatId: string; threadId?: string; userText: string }): void
  /** Current state for a chat (for tests / inspection). */
  peek(chatId: string, threadId?: string): ProgressCardState | undefined
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
  const initialDelayMs = config.initialDelayMs ?? 5000
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
   * Force-close a card from outside its normal turn_end path. Used by
   * the heartbeat zombie ceiling when a card has idled past `maxIdleMs`
   * with no real events landing. Synthesizes a `turn_end` through the
   * reducer so the final render shows the proper 'done' stage, fires
   * the same callbacks an ordinary turn_end would, and fully clears
   * chats / heartbeat bookkeeping. Must not re-enter ingest.
   */
  function closeZombie(cs: PerChatState): void {
    if (cs.pendingTimer != null) {
      clearT(cs.pendingTimer)
      cs.pendingTimer = null
    }
    const durationMs = Math.max(0, now() - cs.state.turnStartedAt)
    cs.state = reduce(cs.state, { kind: 'turn_end', durationMs }, now())
    flush(cs, /*forceDone*/ true)
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
    // Don't clear pendingSyncEchoes — the echo may arrive after zombie close.
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
        if (cs.state.stage === 'done') continue
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
        const html = render(cs.state, now())
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
        return
      }
      // Defer the first emit — schedule it for initialDelayMs from now
      // if not already scheduled.
      if (chatState.deferredFirstEmitTimer == null) {
        const capturedTurnKey = chatState.turnKey
        chatState.deferredFirstEmitTimer = setT(() => {
          if (!chats.has(capturedTurnKey)) return
          chatState.deferredFirstEmitTimer = DELAY_ELAPSED
          flush(chatState, false)
        }, initialDelayMs)
      }
      return
    }
    const taskNum = taskNumFor(chatState)
    const html = render(chatState.state, now(), taskNum.total > 1 ? taskNum : undefined)
    if (html === chatState.lastEmittedHtml && !forceDone) return
    chatState.lastEmittedHtml = html
    chatState.lastEmittedAt = now()
    recordEdit(chatState.turnKey)
    const isFirst = chatState.isFirstEmit
    chatState.isFirstEmit = false
    config.emit({
      chatId: chatState.chatId,
      threadId: chatState.threadId,
      turnKey: chatState.turnKey,
      html,
      done: forceDone || chatState.state.stage === 'done',
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
        if (currentTurnKey != null) {
          const existing = chats.get(currentTurnKey)
          if (existing != null && (existing.chatId === chatId || !existing.chatId)) {
            if (existing.pendingTimer != null) {
              clearT(existing.pendingTimer)
              existing.pendingTimer = null
            }
            if (existing.deferredFirstEmitTimer != null) {
              clearT(existing.deferredFirstEmitTimer)
              existing.deferredFirstEmitTimer = null
            }
            flush(existing, /*forceDone*/ true)
            const existingTaskNum = taskNumFor(existing)
            const existingSummary = summariseTurn(existing.state, now())
            if (config.onTurnComplete) {
              try {
                config.onTurnComplete({
                  chatId: existing.chatId,
                  threadId: existing.threadId,
                  turnKey: existing.turnKey,
                  summary: existingSummary,
                  taskIndex: existingTaskNum.index,
                  taskTotal: existingTaskNum.total,
                })
              } catch { /* never let completion callback break the stream */ }
            }
            // Don't clear pendingSyncEchoes here — the echo may arrive AFTER
            // this force-close. Guard 2 consumes it on arrival.
            chats.delete(currentTurnKey)
            lastHeartbeatBucket.delete(currentTurnKey)
            editTimestamps.delete(currentTurnKey)
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
        flush(chatState, /*forceDone*/ event.kind === 'turn_end')
        if (event.kind === 'turn_end') {
          // Emit a one-line summary for the handoff sidecar (see
          // writeLastTurnSummary in handoff-continuity.ts). Best-effort:
          // the outer callback swallows IO errors.
          const summary = summariseTurn(chatState.state, now())
          const taskNum = taskNumFor(chatState)
          if (config.onTurnEnd) {
            try {
              config.onTurnEnd(summary)
            } catch {
              /* never let a summary write break the stream */
            }
          }
          // Fire per-chat completion callback (for pin/unpin + completion
          // message). Must fire BEFORE chats.delete() so taskNumFor() can
          // still see this chat when computing the total.
          if (config.onTurnComplete) {
            try {
              config.onTurnComplete({
                chatId: chatState.chatId,
                threadId: chatState.threadId,
                turnKey: chatState.turnKey,
                summary,
                taskIndex: taskNum.index,
                taskTotal: taskNum.total,
              })
            } catch {
              /* never let completion callback break the stream */
            }
          }
          // Record turn_end so late enqueue echoes from the session-tail
          // are dropped (see Guard 2 in the enqueue handler above).
          // Don't clear pendingSyncEchoes — the echo may arrive after turn_end.
          // Cancel deferred first-emit timer if the card was never shown.
          if (chatState.deferredFirstEmitTimer != null) {
            clearT(chatState.deferredFirstEmitTimer)
            chatState.deferredFirstEmitTimer = null
          }
          // Drop the chat state so a subsequent turn starts clean.
          chats.delete(chatState.turnKey)
          lastHeartbeatBucket.delete(chatState.turnKey)
          editTimestamps.delete(chatState.turnKey)
          if (currentTurnKey === chatState.turnKey) {
            currentChatId = null
            currentThreadId = undefined
            currentTurnKey = null
          }
          // Stop heartbeat when no chats remain active.
          if (chats.size === 0) stopHeartbeat()
        }
        return
      }

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
