// Auto-wrap tool dispatch with a Telegram typing-indicator loop so the user
// sees a live "agent is working" signal during the 3–30s gap where the
// progress card is deliberately suppressed (its initialDelayMs is 3s).
// The first tool call on a given (chat, thread) fires the typing loop
// immediately so there's no silent dead window before the progress card
// appears. Subsequent calls on the same lane honour the debounce to avoid
// churn. Surface tools own their own loop — see isSurfaceTool.
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
  timer: ReturnType<typeof setTimeout>
  started: boolean
}

export function createTypingWrapper(deps: TypingWrapperDeps): TypingWrapper {
  const debounceMs = deps.debounceMs ?? 500
  const pending = new Map<string, Entry>()
  // Track per-(chat,thread) lanes that already have an active typing loop
  // so the first tool call on a lane fires immediately while subsequent
  // calls on the same lane use the debounce.
  const activeLanes = new Set<string>()

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
        if (prior.started) deps.stopTypingLoop(prior.chatId, prior.threadId)
        pending.delete(toolUseId)
      }
      // First tool on this lane: fire immediately rather than waiting for
      // the debounce — this closes the silent dead window before the first
      // progress card appears.
      if (!activeLanes.has(lane)) {
        deps.startTypingLoop(chatId, tid)
        activeLanes.add(lane)
        const entry: Entry = {
          chatId,
          threadId: tid,
          started: true,
          timer: setTimeout(() => {}, 0), // no-op sentinel
        }
        pending.set(toolUseId, entry)
        return
      }
      const entry: Entry = {
        chatId,
        threadId: tid,
        started: false,
        timer: setTimeout(() => {
          deps.startTypingLoop(chatId, tid)
          entry.started = true
        }, debounceMs),
      }
      pending.set(toolUseId, entry)
    },

    onToolResult(toolUseId) {
      if (!toolUseId) return
      const entry = pending.get(toolUseId)
      if (!entry) return
      clearTimeout(entry.timer)
      if (entry.started) {
        deps.stopTypingLoop(entry.chatId, entry.threadId)
        activeLanes.delete(chatKey(entry.chatId, entry.threadId) as string)
      }
      pending.delete(toolUseId)
    },

    drainAll() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        if (entry.started) deps.stopTypingLoop(entry.chatId, entry.threadId)
      }
      pending.clear()
      activeLanes.clear()
    },
  }
}
