// Auto-wrap tool dispatch with a Telegram typing-indicator loop so the user
// sees a live "agent is working" signal for the run of a turn. This is now
// the PRIMARY liveness signal for short tool-using turns, not a bridge to a
// soon-to-appear pinned progress card: the pinned card is retired
// (`unpinProgressCardForChat = null`, see
// `docs/diagrams/deterministic-status-anatomy.spec.md`), and the worker
// progress card only gates in at `elapsed >= 60s OR sub-agent appeared` — for
// most short turns it never appears at all. The first tool call on a given
// (chat, thread) fires the typing loop immediately so there's no silent dead
// window at turn start. Subsequent calls on the same lane honour the
// debounce to avoid churn. Surface tools own their own loop — see
// isSurfaceTool.
//
// Keying changed from `chatId` to `(chatId, threadId)` in PR3 of the
// supergroup-mode rollout. In supergroup mode one agent owns many topics
// in one chat; chatId-only keying made topic A's typing indicator die when
// topic B's tool-call ended (last-stop-wins on a shared key). Per-thread
// keying preserves independent typing loops across topics — matches the
// per-(chat,thread) state model the rest of the gateway already uses.
// Callers that don't yet carry a thread context pass `undefined` and
// behave exactly as before (null thread collapses to `_` per chatKey()).

import { chatKey } from './gateway/chat-key.js'

export interface TypingWrapperDeps {
  startTypingLoop: (chatId: string, threadId?: number | null) => void
  stopTypingLoop: (chatId: string, threadId?: number | null) => void
  isSurfaceTool: (toolName: string) => boolean
  debounceMs?: number
}

export interface TypingWrapper {
  onToolUse: (
    toolUseId: string,
    chatId: string,
    toolName: string,
    threadId?: number | null,
  ) => void
  onToolResult: (toolUseId: string) => void
  drainAll: () => void
}

interface Entry {
  chatId: string
  threadId: number | null
  lane: string
  timer: ReturnType<typeof setTimeout>
}

/**
 * Per-lane bookkeeping: `count` is the number of outstanding (dispatched but
 * not yet resulted) tool-uses on the lane; `started` is whether the typing
 * loop is currently believed to be running for it. Ref-counted rather than a
 * boolean-per-lane `Set` (pre-fix#7 shape) because two PARALLEL tool_use
 * blocks on one lane must both hold the lane open: with a plain Set,
 * `onToolResult` for the first one deleted the lane and stopped the loop
 * while the second tool was still running, flickering the typing indicator
 * off until the next tool re-fired it. Only the count reaching zero may stop
 * the loop.
 */
interface LaneState {
  count: number
  started: boolean
}

export function createTypingWrapper(deps: TypingWrapperDeps): TypingWrapper {
  const debounceMs = deps.debounceMs ?? 500
  const pending = new Map<string, Entry>()
  const lanes = new Map<string, LaneState>()

  function laneFor(lane: string): LaneState {
    let s = lanes.get(lane)
    if (s == null) {
      s = { count: 0, started: false }
      lanes.set(lane, s)
    }
    return s
  }

  // Decrement the lane's outstanding count. Returns true iff the count just
  // reached zero AND the loop was running — i.e. iff the CALLER must now
  // call `stopTypingLoop`. This is the ref-count release: the loop only
  // stops once every outstanding tool-use on the lane has resulted.
  function release(lane: string): boolean {
    const s = lanes.get(lane)
    if (s == null) return false
    s.count = Math.max(0, s.count - 1)
    if (s.count === 0) {
      const wasStarted = s.started
      lanes.delete(lane)
      return wasStarted
    }
    return false
  }

  return {
    onToolUse(toolUseId, chatId, toolName, threadId) {
      if (!toolUseId) return
      if (deps.isSurfaceTool(toolName)) return
      const tid = threadId ?? null
      const lane = chatKey(chatId, tid) as string
      // Replace any pre-existing entry for the same id defensively.
      const prior = pending.get(toolUseId)
      if (prior) {
        clearTimeout(prior.timer)
        if (release(prior.lane)) deps.stopTypingLoop(prior.chatId, prior.threadId)
        pending.delete(toolUseId)
      }
      const state = laneFor(lane)
      state.count += 1
      // First outstanding tool-use on this lane: fire immediately rather
      // than waiting for the debounce — this closes the silent dead window
      // at turn start.
      if (state.count === 1) {
        deps.startTypingLoop(chatId, tid)
        state.started = true
        const entry: Entry = {
          chatId,
          threadId: tid,
          lane,
          timer: setTimeout(() => {}, 0), // no-op sentinel
        }
        pending.set(toolUseId, entry)
        return
      }
      const entry: Entry = {
        chatId,
        threadId: tid,
        lane,
        timer: setTimeout(() => {
          deps.startTypingLoop(chatId, tid)
          state.started = true
        }, debounceMs),
      }
      pending.set(toolUseId, entry)
    },

    onToolResult(toolUseId) {
      if (!toolUseId) return
      const entry = pending.get(toolUseId)
      if (!entry) return
      clearTimeout(entry.timer)
      if (release(entry.lane)) deps.stopTypingLoop(entry.chatId, entry.threadId)
      pending.delete(toolUseId)
    },

    drainAll() {
      const stoppedLanes = new Set<string>()
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        const state = lanes.get(entry.lane)
        if (state?.started && !stoppedLanes.has(entry.lane)) {
          deps.stopTypingLoop(entry.chatId, entry.threadId)
          stoppedLanes.add(entry.lane)
        }
      }
      pending.clear()
      lanes.clear()
    },
  }
}
