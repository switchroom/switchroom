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
} from './progress-card.js'

export interface ProgressDriverConfig {
  /** Emit rendered HTML for the given chat+thread. Caller owns the send. */
  emit: (args: {
    chatId: string
    threadId?: string
    html: string
    done: boolean
  }) => void
  /**
   * Optional callback fired once per turn immediately after the final
   * render on `turn_end`. Receives a compact, one-line plain-text
   * summary suitable for the session-handoff continuity line. The outer
   * layer typically pipes this into `writeLastTurnSummary(agentDir, …)`
   * so that a session restart can show "↩️ Picked up — &lt;summary&gt;"
   * even if the Stop-hook summarizer didn't run.
   */
  onTurnEnd?: (summary: string) => void
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
  state: ProgressCardState
  lastEmittedAt: number
  lastEmittedHtml: string | null
  pendingTimer: unknown
}

export interface ProgressDriver {
  /** Feed a session-tail event. Fires emit() as the cadence allows. */
  ingest(event: SessionEvent, chatId: string | null, threadId?: string): void
  /** Stop internal timers (heartbeat). Idempotent. */
  dispose?(): void
  /**
   * Begin a new turn synchronously — called from the inbound-message
   * handler the instant a user's message clears the gate, BEFORE any
   * session-tail event arrives. Primes per-chat state and fires an
   * immediate render of the "⚙️ Working…" skeleton card so the user
   * sees the card land within ~1s of their message. Subsequent tool_use
   * / tool_result / turn_end events (from the session JSONL tail) fold
   * into the same state and continue editing the card in place.
   *
   * Safe to call redundantly: a second startTurn for the same chat
   * before turn_end just re-primes state with the new userRequest.
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

  const chats = new Map<string, PerChatState>()
  let heartbeatHandle: { ref: unknown } | null = null
  // Tracks the last elapsed-seconds bucket we emitted for each chat so
  // the heartbeat can coalesce — if the HTML hasn't changed AND the
  // header elapsed counter (rounded to the heartbeat cadence) would
  // still render identically, skip the edit.
  const lastHeartbeatBucket = new Map<string, number>()

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
      for (const [k, cs] of chats) {
        if (cs.state.stage === 'done') continue
        const html = render(cs.state, now())
        const bucket = Math.floor(now() / heartbeatMs)
        const prevBucket = lastHeartbeatBucket.get(k)
        if (html === cs.lastEmittedHtml && bucket === prevBucket) continue
        lastHeartbeatBucket.set(k, bucket)
        cs.lastEmittedHtml = html
        cs.lastEmittedAt = now()
        config.emit({
          chatId: cs.chatId,
          threadId: cs.threadId,
          html,
          done: false,
        })
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

  function key(chatId: string, threadId?: string): string {
    return threadId != null ? `${chatId}:${threadId}` : chatId
  }

  function flush(chatState: PerChatState, forceDone: boolean): void {
    const html = render(chatState.state, now())
    if (html === chatState.lastEmittedHtml && !forceDone) return
    chatState.lastEmittedHtml = html
    chatState.lastEmittedAt = now()
    config.emit({
      chatId: chatState.chatId,
      threadId: chatState.threadId,
      html,
      done: chatState.state.stage === 'done',
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
      }
      if (chatId == null) return

      const k = key(chatId, threadId)
      let chatState = chats.get(k)
      // Drop late events for a turn that already ended. Without this, a
      // stray tool_result arriving after turn_end would spawn a fresh
      // initialState and paint a half-empty card. enqueue always starts
      // a new turn so it bypasses this guard.
      if (chatState == null && event.kind !== 'enqueue') return
      if (chatState == null) {
        chatState = {
          chatId,
          threadId,
          state: initialState(),
          lastEmittedAt: 0,
          lastEmittedHtml: null,
          pendingTimer: null,
        }
        chats.set(k, chatState)
        // New chat became active — ensure the heartbeat is running so
        // the elapsed counter visibly ticks even during long stretches
        // with no session events (e.g. sub-agent work).
        startHeartbeatIfNeeded()
      }

      const prev = chatState.state
      chatState.state = reduce(chatState.state, event, now())
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
          if (config.onTurnEnd) {
            try {
              config.onTurnEnd(summariseTurn(chatState.state, now()))
            } catch {
              /* never let a summary write break the stream */
            }
          }
          // Drop the chat state so a subsequent turn starts clean.
          chats.delete(k)
          lastHeartbeatBucket.delete(k)
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
      const sinceLast = now() - chatState.lastEmittedAt
      const delay = Math.max(coalesceMs, minIntervalMs - sinceLast, 0)
      chatState.pendingTimer = setT(() => {
        // Defensive: if the chat was deleted between schedule and fire
        // (e.g. a turn_end racing with an async boundary added later),
        // don't resurrect it with a stale flush.
        if (!chats.has(k)) return
        chatState!.pendingTimer = null
        flush(chatState!, /*forceDone*/ false)
      }, delay)
    },

    startTurn({ chatId, threadId, userText }) {
      // Synthesize an enqueue event and run it through the normal ingest
      // path. This guarantees we share all the flush/cadence/teardown
      // semantics with session-tail-driven enqueues (including the
      // "fire immediately" branch for enqueue events). The rawContent
      // wrapper matches the shape extractUserText expects.
      const raw = `<channel source="clerk-telegram" chat_id="${chatId}"${threadId != null ? ` message_thread_id="${threadId}"` : ''}>${userText}</channel>`
      this.ingest(
        {
          kind: 'enqueue',
          chatId,
          messageId: null,
          threadId: threadId ?? null,
          rawContent: raw,
        },
        chatId,
        threadId,
      )
    },

    peek(chatId, threadId) {
      const k = key(chatId, threadId)
      return chats.get(k)?.state
    },

    dispose() {
      stopHeartbeat()
      for (const cs of chats.values()) {
        if (cs.pendingTimer != null) {
          clearT(cs.pendingTimer)
          cs.pendingTimer = null
        }
      }
    },
  }
}
