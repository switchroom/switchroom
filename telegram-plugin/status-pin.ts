/**
 * Status-pin — pure decision logic.
 *
 * Keeps an already-rendered status message pinned while its work is
 * in-flight, and unpins it the moment the work completes. This is the
 * ONE sanctioned pin under the `chat-is-the-single-source-of-truth`
 * invariant (see `reference/invariants.md` §
 * `chat-is-the-single-source-of-truth` and the
 * `know-what-my-agent-is-doing` job spec): it re-surfaces a message the
 * conversation ALREADY owns — the per-turn activity/status message and
 * the `🛠 Worker` background-worker message — and never renders a new
 * parallel surface.
 *
 * Why a pin at all: fast answers, more background workers, and much
 * longer turns mean the conversation moves on quickly in the feed and
 * the user loses sight of in-flight work — work now routinely outlives
 * the visible window. Pinning the message the feed already holds keeps
 * it in view; it carries no new content.
 *
 * This module is dependency-free so it's provable in isolation; the
 * gateway (via `status-pin-driver.ts`) translates a `PinAction` into
 * actual Telegram API calls. The design mirrors `slot-banner.ts` +
 * `slot-banner-driver.ts` — one pure decision, one side-effecting
 * reconcile, the claim dropped on unpin even when the API throws.
 */

/** The message the framework is currently claiming as pinned for a key. */
export type PinState = {
  /** Telegram message_id we pinned. */
  messageId: number
}

/** What the caller wants pinned for a key right now. */
export type DesiredPin =
  /** Work is in-flight; this already-rendered message should be pinned. */
  | { pinned: true; messageId: number }
  /** Work is done (or never opened a message); nothing should be pinned. */
  | { pinned: false }

export type PinAction =
  | { kind: 'noop'; reason: string }
  /** Pin an EXISTING message. Caller pins, then records the message_id
   *  back into PinState. No new message is sent — this pins a message the
   *  chat already rendered. */
  | { kind: 'pin'; messageId: number }
  /** Unpin + forget. Caller unpins (best-effort) and clears state EVEN IF
   *  the unpin call throws. */
  | { kind: 'unpin'; messageId: number }

/**
 * Decide the single pin action for a key given the previously-claimed
 * state and what the caller now wants.
 *
 * Exactly one action per (prev, desired) — the whole point is that pin
 * state can never get stuck: an in-flight → done transition always yields
 * an `unpin`, and the driver drops the claim on unpin regardless of API
 * outcome.
 */
export function decidePinAction(
  prev: PinState | null,
  desired: DesiredPin,
): PinAction {
  if (!desired.pinned) {
    if (prev) return { kind: 'unpin', messageId: prev.messageId }
    return { kind: 'noop', reason: 'nothing pinned, nothing wanted' }
  }
  // desired.pinned === true
  if (prev == null) return { kind: 'pin', messageId: desired.messageId }
  if (prev.messageId === desired.messageId) {
    return { kind: 'noop', reason: 'already pinned this message' }
  }
  // The message we want pinned changed (the feed re-posted after a stale
  // edit dropped its id). Unpin the old claim; a subsequent desired-pin
  // re-pins the new one on the next reconcile.
  return { kind: 'unpin', messageId: prev.messageId }
}
