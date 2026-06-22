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

/**
 * Maximum number of times the orphaned-reply backstop timer may re-arm
 * itself when a tool call is in flight, before it fires a synthetic turn_end
 * anyway (to surface a genuinely hung tool).
 *
 * Math: 20 re-arms × 30 s fuse = 10 min of genuine tool activity before the
 * backstop surfaces. Chosen to cover multi-phase agent turns (write → compile
 * → test → fix loop) while still catching a truly wedged single tool within a
 * reasonable wall-clock bound.
 */
export const ORPHANED_REPLY_MAX_REARMS = 20

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
  progressCardActive?: boolean
}): boolean {
  return (
    params.currentSessionChatId != null &&
    params.capturedTextCount > 0 &&
    !params.replyCalled &&
    !params.progressCardActive
  )
}
