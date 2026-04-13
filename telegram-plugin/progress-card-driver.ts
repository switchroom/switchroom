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
  /** Min ms between edits for a given chat+thread. Default 500. */
  minIntervalMs?: number
  /** Coalesce window — burst events within this land as one render. Default 400. */
  coalesceMs?: number
  /** `Date.now` override for tests. */
  now?: () => number
  /** `setTimeout` override for tests. */
  setTimeout?: (fn: () => void, ms: number) => { ref: unknown }
  clearTimeout?: (ref: unknown) => void
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

  const chats = new Map<string, PerChatState>()

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
          // Drop the chat state so a subsequent turn starts clean.
          chats.delete(k)
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
        chatState!.pendingTimer = null
        flush(chatState!, /*forceDone*/ false)
      }, delay)
    },

    peek(chatId, threadId) {
      const k = key(chatId, threadId)
      return chats.get(k)?.state
    },
  }
}
