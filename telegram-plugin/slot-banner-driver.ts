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
 * `reference/track-plan-quota-live.md` ("at a glance").
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
  editMessageText(
    chat_id: string | number,
    message_id: number,
    text: string,
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

  if (action.kind === 'noop') return args.prevState;

  if (action.kind === 'unpin') {
    try {
      await args.bot.api.unpinChatMessage(args.ownerChatId, action.messageId);
    } catch (err) {
      args.onError?.('unpin', err);
    }
    // Even if unpin failed, drop our claim — the message may have been
    // unpinned out-of-band (operator did it manually) and re-pinning
    // would be more confusing than surfacing it again later.
    return null;
  }

  if (action.kind === 'pin') {
    let sent: { message_id: number };
    try {
      sent = await args.bot.api.sendMessage(args.ownerChatId, action.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      args.onError?.('pin', err);
      return args.prevState;
    }
    try {
      await args.bot.api.pinChatMessage(args.ownerChatId, sent.message_id, {
        disable_notification: true,
      });
    } catch (err) {
      args.onError?.('pin', err);
      // sendMessage succeeded but pin failed — don't claim the message.
      return args.prevState;
    }
    return { messageId: sent.message_id, slot: action.slot };
  }

  // action.kind === 'edit'
  try {
    await args.bot.api.editMessageText(
      args.ownerChatId,
      action.messageId,
      action.text,
      {
        parse_mode: 'HTML',
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
