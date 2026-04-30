/**
 * Pinned slot banner — pure decision logic.
 *
 * The gateway pins a banner in the owner chat when the agent is
 * running on a non-default account slot (e.g. after auto-fallback
 * swapped away from `default`). The banner unpins when the agent
 * returns to `default`. This gives the user an always-visible answer
 * to "what slot am I on right now?" exactly when it's not what they
 * expect, and zero noise when everything is normal.
 *
 * This module is dependency-free so it's testable in isolation; the
 * gateway translates `BannerAction` into actual Telegram API calls.
 *
 * v1 scope: one banner per gateway process, in the owner chat
 * (access.allowFrom[0]). Per-topic forum support and multi-chat
 * pinning are tracked as #421 follow-ups.
 *
 * See #421 (Switchroom).
 */

export type BannerState = {
  /** Telegram message_id of the currently pinned banner. */
  messageId: number;
  /** The slot name shown by the pinned message — used to skip
   *  redundant edits when the slot hasn't changed. */
  slot: string;
};

export type BannerAction =
  | { kind: 'noop'; reason: string }
  /** Pin a fresh banner. Caller sends + pins, then records the
   *  resulting message_id back into BannerState. */
  | { kind: 'pin'; text: string; slot: string }
  /** Edit the existing pinned banner's text. */
  | { kind: 'edit'; messageId: number; text: string; slot: string }
  /** Unpin + forget. Caller unpins (best-effort) and clears state. */
  | { kind: 'unpin'; messageId: number };

/**
 * Decide what to do with the banner given the current active slot,
 * the default slot, and the previously-pinned banner state.
 */
export function decideBannerAction(
  prev: BannerState | null,
  currentSlot: string | null,
  agentName: string,
  defaultSlot: string,
): BannerAction {
  // Default state (or no slot yet): no banner needed. If one is
  // pinned from a prior failover, unpin so the chat is clean again.
  if (currentSlot === null || currentSlot === defaultSlot) {
    if (prev) return { kind: 'unpin', messageId: prev.messageId };
    return { kind: 'noop', reason: 'on default slot, nothing pinned' };
  }

  // Non-default state. Either pin fresh or edit existing.
  const text = formatBannerHtml(agentName, currentSlot, defaultSlot);
  if (!prev) return { kind: 'pin', text, slot: currentSlot };
  if (prev.slot === currentSlot) {
    return { kind: 'noop', reason: 'banner already shows current slot' };
  }
  return { kind: 'edit', messageId: prev.messageId, text, slot: currentSlot };
}

/**
 * The banner body. Kept short — the user reads this at a glance,
 * and pinned messages eat vertical space at the top of the chat.
 */
export function formatBannerHtml(
  agentName: string,
  currentSlot: string,
  defaultSlot: string,
): string {
  return [
    `📌 <b>${escapeHtml(agentName)}</b> is running on slot <code>${escapeHtml(currentSlot)}</code>`,
    `<i>(failover from <code>${escapeHtml(defaultSlot)}</code>)</i>`,
  ].join(' ');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
