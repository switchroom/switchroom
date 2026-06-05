/**
 * Guard for the per-turn reply anchor (`turn.sourceMessageId`).
 *
 * Telegram Bot API message ids are positive integers that fit within a signed
 * 32-bit int; `reply_parameters.message_id` HARD-rejects anything larger with
 * 400 "field 'message_id' must be a valid Number" (and `allow_sending_without_reply`
 * does NOT bypass that range check).
 *
 * Synthetic boot-resume inbounds (`resume-inbound-builder.ts`) fabricate a
 * `message_id` from `Date.now()` (~1.78e13) so the deliver-until-acked queue can
 * ack the synthetic by its own enqueue id. That round-trip is fine on its own —
 * but the enqueue handler also turns `ev.messageId` into `turn.sourceMessageId`,
 * which `drainActivitySummary` sends as the activity-feed reply anchor. A
 * fabricated 13-digit timestamp there 400s EVERY feed send for the whole turn,
 * so the live status feed is dark for the entire first post-restart turn (the
 * resume-dark-feed incident, 2026-06-05).
 *
 * This guard accepts a value as a real anchor ONLY when it is a plausible
 * Telegram message id; anything non-numeric or out of range yields null, so the
 * feed posts UNANCHORED (still correct — the anchor is a nicety, not required).
 * The synthetic's ack-tracking is unaffected: it keys on the enqueue event's own
 * id, never on this anchor.
 */

/** Telegram message ids fit within a signed 32-bit int for reply anchoring;
 *  anything at/above this is not a real message id (e.g. a wall-clock ms ts). */
export const MAX_TELEGRAM_MESSAGE_ID = 2 ** 31

/**
 * Parse an inbound's `messageId` into a usable reply anchor, or null when it is
 * not a plausible Telegram message id (non-numeric, non-positive, non-integer,
 * or out of the reply-anchor range — e.g. a fabricated `Date.now()` timestamp).
 */
export function parseSourceMessageId(raw: string | number | undefined | null): number | null {
  if (raw == null) return null
  const s = String(raw)
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isSafeInteger(n) || n <= 0 || n >= MAX_TELEGRAM_MESSAGE_ID) return null
  return n
}
