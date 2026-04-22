// Auto-wrap tool dispatch with a Telegram typing-indicator loop so the user
// sees a live "agent is working" signal during the 5–30s gap where the
// progress card is deliberately suppressed (its initialDelayMs is 30s).
// Fast tools (sub-500ms) don't trigger any flash; slow ones (Bash, Grep,
// WebFetch, …) do. Surface tools own their own loop — see isSurfaceTool.

export interface TypingWrapperDeps {
  startTypingLoop: (chatId: string) => void
  stopTypingLoop: (chatId: string) => void
  isSurfaceTool: (toolName: string) => boolean
  debounceMs?: number
}

export interface TypingWrapper {
  onToolUse: (toolUseId: string, chatId: string, toolName: string) => void
  onToolResult: (toolUseId: string) => void
  drainAll: () => void
}

interface Entry {
  chatId: string
  timer: ReturnType<typeof setTimeout>
  started: boolean
}

export function createTypingWrapper(deps: TypingWrapperDeps): TypingWrapper {
  const debounceMs = deps.debounceMs ?? 500
  const pending = new Map<string, Entry>()

  return {
    onToolUse(toolUseId, chatId, toolName) {
      if (!toolUseId) return
      if (deps.isSurfaceTool(toolName)) return
      // Replace any pre-existing entry for the same id defensively.
      const prior = pending.get(toolUseId)
      if (prior) {
        clearTimeout(prior.timer)
        if (prior.started) deps.stopTypingLoop(prior.chatId)
        pending.delete(toolUseId)
      }
      const entry: Entry = {
        chatId,
        started: false,
        timer: setTimeout(() => {
          deps.startTypingLoop(chatId)
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
      if (entry.started) deps.stopTypingLoop(entry.chatId)
      pending.delete(toolUseId)
    },

    drainAll() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        if (entry.started) deps.stopTypingLoop(entry.chatId)
      }
      pending.clear()
    },
  }
}
