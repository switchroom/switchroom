/**
 * Helpers for detecting and handling context-window exhaustion.
 *
 * When Claude Code's context fills up, the assistant emits a text block
 * whose content begins with "Prompt is too long" and the turn ends
 * WITHOUT a `turn_duration` system event. The orphaned-reply backstop
 * then waits for `turn_end` forever, so every subsequent user message
 * hits the same wall — permanent silence.
 *
 * These helpers are pure so they're easy to unit-test. The side-effecty
 * restart / notify logic lives in server.ts.
 */

export const CONTEXT_EXHAUSTION_MARKER = 'Prompt is too long'
export const ORPHANED_REPLY_TIMEOUT_MS = 30_000

export function isContextExhaustionText(text: string): boolean {
  return text.includes(CONTEXT_EXHAUSTION_MARKER)
}

/**
 * Should the orphaned-reply timeout be armed right now? True when the
 * session has a chat, captured assistant text, and the reply tool has
 * not yet been called for this turn.
 */
export function shouldArmOrphanedReplyTimeout(params: {
  currentSessionChatId: string | null
  capturedTextCount: number
  replyCalled: boolean
}): boolean {
  return (
    params.currentSessionChatId != null &&
    params.capturedTextCount > 0 &&
    !params.replyCalled
  )
}
