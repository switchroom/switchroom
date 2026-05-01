/**
 * Pure handler for the `update_placeholder` IPC message.
 *
 * The bridge / hooks send `update_placeholder` over IPC so the gateway
 * can edit the user's pre-allocated draft mid-turn — `🔵 thinking` →
 * `📚 recalling memories` → `💭 thinking` → final reply, instead of a
 * static placeholder for the entire model TTFT.
 *
 * Lives in its own module (separate from gateway.ts) so the
 * behaviour is testable against `fake-bot-api.ts` without booting the
 * full gateway. The gateway-side wrapper at `gateway.ts` (search for
 * `handleUpdatePlaceholder`) does nothing but pass the closure-state
 * dependencies in.
 *
 * Best-effort, silent on three legitimate misses:
 *   1. No pre-alloc draft for this chat (forum topic, sendMessageDraft
 *      API absent, pre-alloc API call still in flight).
 *   2. Telegram API rejects the edit (rate limit, invalid text).
 *   3. The draft was already consumed by reply / stream_reply.
 */

/** Sanity cap on placeholder text length (chars). Anything longer is
 * almost certainly a misuse — the placeholder is meant to be a short
 * status indicator, not a long-form message. */
export const PLACEHOLDER_TEXT_MAX_LEN = 200

/** Outcome enum for tests + observability. */
export type UpdatePlaceholderOutcome =
  | { kind: 'edited'; chatId: string; draftId: number; text: string }
  | { kind: 'skipped'; reason: 'no-draft-api' | 'no-draft-for-chat' | 'empty-text' }
  | { kind: 'edit-failed'; chatId: string; draftId: number; error: Error }

/**
 * Pre-allocated draft entry — same shape as gateway.ts's
 * `preAllocatedDrafts` map values. Defined here so the test module
 * doesn't have to import from gateway.ts.
 */
export interface PreAllocatedDraftEntry {
  draftId: number
  allocatedAt: number
}

export interface UpdatePlaceholderInput {
  /** The IPC message body. */
  msg: { chatId: string; text: string }
  /**
   * The bound `sendMessageDraft` API call (or null when the API is
   * unavailable on this gateway). Same value as `sendMessageDraftFn`
   * in gateway.ts.
   */
  sendMessageDraftFn:
    | ((chatId: string, draftId: number, text: string) => Promise<unknown>)
    | null
  /**
   * The gateway's `preAllocatedDrafts` Map — passed by reference so
   * the handler can look up by chatId. Mutated only by reads here;
   * the gateway is the sole writer.
   */
  preAllocatedDrafts: Map<string, PreAllocatedDraftEntry>
}

/**
 * Handle one `update_placeholder` IPC message. Returns a discriminated
 * outcome; the gateway-side wrapper logs `edit-failed` to stderr.
 *
 * Returns synchronously with the decision; the actual `editMessageText`
 * call is fired-and-forgotten via `void`. The promise's eventual
 * outcome is delivered through the `onResult` callback if provided.
 *
 * The synchronous return shape is what makes this testable: the test
 * can assert `{ kind: 'edited' }` immediately, then await
 * `await Promise.resolve()` to settle the .then callback if it cares
 * about the success/failure tail.
 */
export function handleUpdatePlaceholder(
  input: UpdatePlaceholderInput,
  onResult?: (result: UpdatePlaceholderOutcome) => void,
): UpdatePlaceholderOutcome {
  const { msg, sendMessageDraftFn, preAllocatedDrafts } = input

  if (sendMessageDraftFn == null) {
    const result: UpdatePlaceholderOutcome = { kind: 'skipped', reason: 'no-draft-api' }
    onResult?.(result)
    return result
  }

  const preAllocated = preAllocatedDrafts.get(msg.chatId)
  if (preAllocated == null) {
    const result: UpdatePlaceholderOutcome = { kind: 'skipped', reason: 'no-draft-for-chat' }
    onResult?.(result)
    return result
  }

  const text = String(msg.text ?? '').slice(0, PLACEHOLDER_TEXT_MAX_LEN)
  if (text.length === 0) {
    const result: UpdatePlaceholderOutcome = { kind: 'skipped', reason: 'empty-text' }
    onResult?.(result)
    return result
  }

  const editedResult: UpdatePlaceholderOutcome = {
    kind: 'edited',
    chatId: msg.chatId,
    draftId: preAllocated.draftId,
    text,
  }

  // Fire-and-forget the API call. `onResult` fires twice in the
  // failure path: once with `edited` (intent), then with `edit-failed`
  // (settled outcome). The gateway-side wrapper logs the failure to
  // stderr; tests await the .catch to assert on it.
  void sendMessageDraftFn(msg.chatId, preAllocated.draftId, text)
    .catch((err: unknown) => {
      onResult?.({
        kind: 'edit-failed',
        chatId: msg.chatId,
        draftId: preAllocated.draftId,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })

  onResult?.(editedResult)
  return editedResult
}
