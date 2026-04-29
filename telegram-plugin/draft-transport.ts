/**
 * Shared draft-transport helpers for answer-stream and draft-stream.
 *
 * Extracted from answer-stream.ts so both the narrative answer-lane and the
 * model-driven stream_reply lane can share the same regex constants and
 * fallback logic without duplicating them.
 *
 * answer-stream.ts re-exports these symbols so existing callers (including
 * tests that import directly from answer-stream.ts) continue to work.
 */

// Error patterns matching OpenClaw's shouldFallbackFromDraftTransport.
// Exported for tests.
export const DRAFT_METHOD_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported)/i
export const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i

/**
 * Returns true when a sendMessageDraft rejection means "this API is not
 * available" rather than a transient network error.
 */
export function shouldFallbackFromDraftTransport(err: unknown): boolean {
  const text =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === 'object' && err != null && 'description' in err
          ? typeof (err as { description: unknown }).description === 'string'
            ? (err as { description: string }).description
            : ''
          : ''
  if (!/sendMessageDraft/i.test(text)) return false
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text)
}

/**
 * Symbol-keyed shared counter for draft-id allocation across concurrent
 * streams (mirrors openclaw's getDraftStreamState). Using Symbol.for ensures
 * the same counter is shared even if this module is loaded multiple times
 * (e.g. from different bundle chunks).
 */
const DRAFT_STREAM_STATE_KEY = Symbol.for('switchroom.draftStreamState')

interface DraftStreamState {
  nextDraftId: number
}

function getDraftStreamState(): DraftStreamState {
  const g = globalThis as Record<PropertyKey, unknown>
  let state = g[DRAFT_STREAM_STATE_KEY] as DraftStreamState | undefined
  if (!state) {
    state = { nextDraftId: 0 }
    g[DRAFT_STREAM_STATE_KEY] = state
  }
  return state
}

/**
 * Allocate a unique draft ID, wrapping at 2_147_483_647 (Telegram's int32
 * max for draft_id). IDs start at 1 and cycle.
 */
export function allocateDraftId(): number {
  const state = getDraftStreamState()
  state.nextDraftId = state.nextDraftId >= 2_147_483_647 ? 1 : state.nextDraftId + 1
  return state.nextDraftId
}

/** Reset the shared draft-id counter — for tests only. */
export function __resetDraftIdForTests(): void {
  getDraftStreamState().nextDraftId = 0
}
