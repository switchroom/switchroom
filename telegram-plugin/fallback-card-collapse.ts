/**
 * Reactive-path message collapse (#3031 PR 3).
 *
 * Pre-fix, a mid-turn 429 emitted up to three separate operator messages:
 *   1. the ⚠️ model-unavailable card (sent BEFORE the fallback outcome is
 *      known — deliberate, see the promise-honesty note below),
 *   2. the fleet-fallback success announcement ("Switched to <account> …"),
 *   3. the resume/boot notice.
 *
 * This module owns the SAFE part of collapsing that flow: when the swap
 * SUCCEEDS, the announcement is folded into an EDIT of the just-sent
 * model-unavailable card (one evolving card) instead of a second message.
 *
 * CRITICAL constraint (2026-06-06→07 incident): the card is deliberately
 * sent before the outcome is known, and a FAILURE notice must arrive as its
 * own message on EVERY error path — the card promised an announcement, and
 * an edit that never happens (or a swallowed failure) breaks that promise.
 * Therefore:
 *   - `decideAnnouncementDelivery` returns 'edit' ONLY for a successful
 *     'switched' outcome with a fresh, fallback-promising card on record.
 *     Every other outcome kind ('all-blocked', 'no-old-active',
 *     'no-eligible-target', errors) is 'send' — a separate message, exactly
 *     the pre-fix behaviour.
 *   - The gateway falls back to a plain send when the edit itself throws.
 *
 * Pure module (injected clock, no Telegram/bot imports) so the decision
 * logic is unit-testable at the seam.
 */

/** One recorded model-unavailable card, per chat. */
export interface ModelUnavailableCardRecord {
  /** Telegram message id of the sent card (null until the send resolves —
   *  callers should record only after the send succeeds). */
  messageId: number;
  /** The rendered card text as sent, so the edit can append to it. */
  text: string;
  /** Unix ms the card send resolved. */
  atMs: number;
  /** Did the card promise an in-flight auto-failover? Only such cards may
   *  absorb the announcement — a manual-hint card never promised one. */
  promisedFallback: boolean;
}

/**
 * Freshness ceiling for folding into a card. The fallback dispatcher runs
 * seconds after the card in the normal case; a card older than this belongs
 * to a previous incident and must not absorb an unrelated announcement.
 *
 * Known accepted race (#3035 review, finding 4): the record lands only
 * AFTER the card send resolves, and stays editable for this whole window —
 * so a LATER 'switched' outcome (a second dispatch inside the window) can
 * edit a card whose incident was already answered. Bounded by this 5-min
 * ceiling plus the one-shot `take` semantics (a card absorbs at most one
 * announcement); worst case is one announcement folded into a slightly
 * older card instead of arriving as a separate message — never a lost
 * announcement.
 */
export const CARD_COLLAPSE_MAX_AGE_MS = 5 * 60_000;

export interface ModelUnavailableCardRegistry {
  /** Record the card most recently sent to `chatId` (replaces any prior). */
  record(chatId: string, rec: ModelUnavailableCardRecord): void;
  /**
   * One-shot take: return the fresh, fallback-promising card for `chatId`
   * and remove it (a card absorbs at most one announcement). Returns null —
   * and clears the entry — when the record is stale or never promised a
   * fallback.
   */
  take(chatId: string, now: number): ModelUnavailableCardRecord | null;
  /** Number of chats with a recorded card (test/introspection helper). */
  size(): number;
}

export function createModelUnavailableCardRegistry(
  maxAgeMs: number = CARD_COLLAPSE_MAX_AGE_MS,
): ModelUnavailableCardRegistry {
  const cards = new Map<string, ModelUnavailableCardRecord>();
  return {
    record(chatId, rec) {
      cards.set(chatId, rec);
    },
    take(chatId, now) {
      const rec = cards.get(chatId);
      if (!rec) return null;
      cards.delete(chatId);
      if (!rec.promisedFallback) return null;
      if (now - rec.atMs > maxAgeMs) return null;
      return rec;
    },
    size() {
      return cards.size;
    },
  };
}

/**
 * The outcome kinds `runFleetAutoFallback` can produce, plus 'error' for
 * the dispatcher-threw path (broker unreachable, listState/markExhausted
 * throw). Kept as a plain string union so this module stays import-free.
 */
export type FallbackDeliveryOutcomeKind =
  | 'switched'
  | 'all-blocked'
  | 'no-old-active'
  | 'no-eligible-target'
  | 'strict-pinned'
  | 'error';

/**
 * Should the announcement for `outcomeKind` be delivered by EDITING the
 * recorded model-unavailable card, or by SENDING a separate message?
 *
 * 'edit' is returned ONLY when the swap succeeded AND a fresh
 * fallback-promising card exists for the chat. Every failure / no-op
 * outcome is 'send' — the promise-honesty contract: a failure notice must
 * arrive as its own message on every error path.
 */
export function decideAnnouncementDelivery(
  outcomeKind: FallbackDeliveryOutcomeKind,
  card: ModelUnavailableCardRecord | null,
): 'edit' | 'send' {
  if (outcomeKind !== 'switched') return 'send';
  return card !== null ? 'edit' : 'send';
}

/**
 * The single evolving card: original card text plus the announcement,
 * separated by a rule so the "before/after" reads as one incident timeline.
 */
export function foldAnnouncementIntoCard(cardText: string, announcement: string): string {
  return `${cardText}\n\n${announcement}`;
}
