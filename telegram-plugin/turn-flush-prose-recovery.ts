/**
 * Turn-flush prose recovery for #51.
 *
 * The gateway's `currentTurnCapturedText` accumulator gates on
 * `currentSessionChatId != null`, while the progress-card driver's
 * `ingest` uses the `chatId` from the IPC envelope (chatHint). When those
 * two views of "is this turn one we're tracking" disagree — e.g., text
 * arrives before enqueue's chatId is captured, or after a mid-turn reset
 * — the progress card renders the assistant prose as narrative steps but
 * `capturedText` stays empty, so `decideTurnFlush` returns `'empty-text'`
 * and the turn-flush backstop never sends the prose to Telegram. The
 * user sees a step bullet on the card and nothing in their chat.
 *
 * This helper bridges the gap: at turn_end, if the gateway has no
 * captured text, peek the progress-card state and recover the assistant
 * prose from the narrative steps. Pure for testability — the gateway
 * is responsible for actually wiring the recovered text into the flush
 * decision.
 */

import type { ProgressCardState } from './progress-card.js'

/**
 * Returns the joined assistant prose recorded as narrative steps in the
 * progress-card state, trimmed. Empty string when the state has no
 * narratives (or is undefined).
 */
export function recoverProseFromProgressCard(
  state: ProgressCardState | undefined,
): string {
  if (state == null) return ''
  // Defensive: older state shapes (e.g. partial persisted state, mocks
  // in tests) may lack the `narratives` field. Don't throw.
  if (!Array.isArray(state.narratives)) return ''
  const parts: string[] = []
  for (const n of state.narratives) {
    if (typeof n.text === 'string' && n.text.length > 0) parts.push(n.text)
  }
  return parts.join('\n').trim()
}
