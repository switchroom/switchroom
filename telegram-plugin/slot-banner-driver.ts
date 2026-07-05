/**
 * Slot-banner driver — executes the BannerAction state transition
 * against a Telegram Bot API. Extracted from gateway.ts so the
 * dispatch is testable end-to-end via `tests/fake-bot-api.ts`.
 *
 * The pure decision lives in `slot-banner.ts` (decideBannerAction).
 * This module is the side-effecting half: takes a `bot` dependency,
 * executes the action, returns the next state. The state itself
 * stays in the caller (gateway.ts holds a module-global `let
 * pinnedBannerState` and re-passes it on every call).
 *
 * Error-handling contract: API failures are reported via `onError`
 * but never throw. The caller decides logging cadence (gateway logs
 * to stderr; tests can assert via the callback). On a pin failure
 * mid-sequence (sendMessage succeeded but pinChatMessage failed),
 * the prior state is preserved so we don't claim ownership of an
 * unpinned message.
 *
 * See #421 (banner pin lifecycle) and JTBD
 * `reference/jobs/track-plan-quota-live.md` ("at a glance").
 */

import type { BannerState } from './slot-banner.js';
import { decideBannerAction } from './slot-banner.js';

/** Minimal subset of grammy's `bot.api` we depend on. Letting tests
 *  swap in `fake-bot-api.ts` without dragging in the full Bot type. */
export interface BannerBotApi {
  sendMessage(
    chat_id: string | number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendRichMessage(
    chat_id: string | number,
    rich_message: { markdown: string },
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chat_id: string | number,
    message_id: number,
    text: string | { markdown: string },
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  pinChatMessage(
    chat_id: string | number,
    message_id: number,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  unpinChatMessage(
    chat_id: string | number,
    message_id: number,
  ): Promise<unknown>;
}

export interface BannerBot {
  api: BannerBotApi;
}

export interface RefreshBannerArgs {
  bot: BannerBot;
  ownerChatId: string;
  agentName: string;
  /** Active slot reported by `currentActiveSlot(agentDir)`. `null`
   *  means we couldn't read one — treated like default state (unpins
   *  any existing banner; never pins). */
  currentSlot: string | null;
  defaultSlot: string;
  /** State the gateway is holding from the last call. Pass `null`
   *  on first call. */
  prevState: BannerState | null;
  /** Optional API-failure observer. Phase identifies which Bot API
   *  call failed so the caller can log meaningfully. Default: silent. */
  onError?: (phase: 'pin' | 'edit' | 'unpin', err: unknown) => void;
  /** Optional durable-persistence hooks so an orphaned banner pin is
   *  recoverable across a gateway crash. The gateway wires these to the
   *  shared status-pin store (a distinct `banner:` pinKey), mirroring the
   *  status-pin store's persist-BEFORE-pin ordering. All hooks are
   *  best-effort — the driver guards each call so a throwing hook can never
   *  break banner pinning (persistence is cosmetic-recovery, never load-bearing
   *  for the live pin). Omit entirely to disable persistence (unit tests). */
  persist?: {
    /** Record a PENDING pin: the banner message was sent but the pin API call
     *  has not yet confirmed. Called AFTER sendMessage, BEFORE pinChatMessage,
     *  so a crash in that window leaves a recoverable record on disk. */
    pending?: (chatId: string, messageId: number) => void;
    /** Rewrite the record as confirmed once the pin lands. */
    confirm?: (chatId: string, messageId: number) => void;
    /** Drop the persisted record (banner unpinned, cleared, or pin failed). */
    clear?: () => void;
  };
}

/**
 * Execute the next banner-state transition. Returns the new
 * `BannerState` (or `null` when unpinned). Always resolves; never
 * throws — API errors are routed through `onError`.
 *
 * On pin-mid-sequence failure (sendMessage succeeded but
 * pinChatMessage failed), the function returns the *prior* state
 * unchanged. Otherwise the gateway would track a message_id it
 * never managed to pin, and the next refresh would think a banner
 * exists and try to edit/unpin it.
 */
export async function refreshBanner(
  args: RefreshBannerArgs,
): Promise<BannerState | null> {
  const action = decideBannerAction(
    args.prevState,
    args.currentSlot,
    args.agentName,
    args.defaultSlot,
  );

  // Persistence hooks are cosmetic-recovery; a throwing hook must never break
  // live banner pinning. Guard every call.
  const safePersist = (fn: (() => void) | undefined) => {
    if (!fn) return;
    try {
      fn();
    } catch {
      /* best-effort — persistence failures degrade to in-memory-only */
    }
  };

  if (action.kind === 'noop') return args.prevState;

  if (action.kind === 'unpin') {
    try {
      await args.bot.api.unpinChatMessage(args.ownerChatId, action.messageId);
    } catch (err) {
      args.onError?.('unpin', err);
    }
    // Even if unpin failed, drop our claim — the message may have been
    // unpinned out-of-band (operator did it manually) and re-pinning
    // would be more confusing than surfacing it again later. Drop the
    // persisted record too (unpin-then-clear mirrors the status-pin store:
    // a crash between unpin and clear just re-unpins next boot, idempotent).
    safePersist(args.persist?.clear);
    return null;
  }

  if (action.kind === 'pin') {
    let sent: { message_id: number };
    try {
      // sendRichMessage doesn't accept link_preview_options — omit it.
      sent = await args.bot.api.sendRichMessage(args.ownerChatId, { markdown: action.text }, {
        // OAuth slot banner is a status notice — silence the open ping.
        // (the pin below is already silent; the edit path doesn't ping.)
        disable_notification: true,
      });
    } catch (err) {
      args.onError?.('pin', err);
      return args.prevState;
    }
    // Persist INTENT (pending) BEFORE the pin API call: a crash between the pin
    // landing and its confirm rewrite leaves a pending record that boot cleanup
    // unpins next boot — closing the persist-after-pin leak.
    safePersist(() => args.persist?.pending?.(String(args.ownerChatId), sent.message_id));
    try {
      await args.bot.api.pinChatMessage(args.ownerChatId, sent.message_id, {
        disable_notification: true,
      });
    } catch (err) {
      args.onError?.('pin', err);
      // sendMessage succeeded but pin failed — don't claim the message, and
      // drop the pending record so we don't leave a phantom claim for a pin
      // that never landed.
      safePersist(args.persist?.clear);
      return args.prevState;
    }
    // Pin confirmed — rewrite the record without the pending flag.
    safePersist(() => args.persist?.confirm?.(String(args.ownerChatId), sent.message_id));
    return { messageId: sent.message_id, slot: action.slot };
  }

  // action.kind === 'edit'
  try {
    await args.bot.api.editMessageText(
      args.ownerChatId,
      action.messageId,
      { markdown: action.text },
      {
        link_preview_options: { is_disabled: true },
      },
    );
    return { messageId: action.messageId, slot: action.slot };
  } catch (err) {
    args.onError?.('edit', err);
    // Edit failed — keep the prior state so the next refresh tries again.
    return args.prevState;
  }
}
