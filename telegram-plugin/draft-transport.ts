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
 * PR D — extract the `retry_after` seconds from a grammY 429 error.
 * Returns null when the error isn't a 429 (or has no retry_after).
 *
 * Shared with `issues-card.ts:extractRetryAfterSecs`. Duck-typed on the
 * documented grammY `GrammyError` shape to keep this module
 * test-friendly without importing `GrammyError` directly.
 */
export function extractDraft429RetryAfterSecs(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null
  const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } }
  if (e.error_code !== 429) return null
  const ra = e.parameters?.retry_after
  if (typeof ra === 'number' && Number.isFinite(ra) && ra > 0) return ra
  return null
}

/**
 * PR D — was this a 429 from `sendMessageDraft` specifically? Used by
 * draft-stream to differentiate "draft is rate-limited" (transient,
 * just back off this stream) from a non-429 send error (handled
 * separately by `shouldFallbackFromDraftTransport`).
 *
 * Both cases trigger fallback to message transport for the rest of
 * the stream, but the 429 case ALSO bumps the throttle window to
 * honor Telegram's `retry_after` — so the message-transport fallback
 * doesn't immediately fire a fresh send before Telegram's cooldown
 * elapses and re-429s.
 */
export function isDraft429(err: unknown): boolean {
  if (extractDraft429RetryAfterSecs(err) == null) return false
  // grammY GrammyError carries the method name in its `method` field.
  // Best-effort: match either the structured method or the error text.
  if (typeof err === 'object' && err != null && 'method' in err) {
    const m = (err as { method?: unknown }).method
    if (typeof m === 'string' && /sendMessageDraft/i.test(m)) return true
  }
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
  return /sendMessageDraft/i.test(text)
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
