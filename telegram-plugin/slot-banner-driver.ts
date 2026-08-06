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
// Shared rights model (D5): the banner adopts the status-pin path's rights
// detector, terminal-unpin classifier and per-process negative cache, so the two
// pin owners agree on which chats are rights-less instead of the banner's old
// drop-on-ANY-unpin. status-pin.ts is dependency-free.
import { isPinRightsError, isUnpinTerminalError, type PinRightsCache } from './status-pin.js';

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
  /** Shared per-process pin-rights negative cache (status-pin.ts
   *  `PinRightsCache`), unifying the banner with the status-pin path on
   *  rights-less chats (D5). When the chat is already known rights-less the pin
   *  action is skipped so we never emit an un-pinnable notice; a real pin-rights
   *  400 from the pin/unpin verb records the block and a confirmed pin clears
   *  it. Fed ONLY from the pin/unpin verbs — a `sendMessage` failure is never
   *  cached, because a send failure is not a pin-rights signal. Optional;
   *  omitted in unit tests. */
  rightsCache?: Pick<PinRightsCache, 'isBlocked' | 'block' | 'clear'>;
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
      // allow-raw-pin: the slot banner is a sanctioned separate pin owner (see
      // scripts/check-status-pin-single-path-allowlist.txt); its unpin is not
      // routed through reconcileStatusPin.
      await args.bot.api.unpinChatMessage(args.ownerChatId, action.messageId);
    } catch (err) {
      args.onError?.('unpin', err);
      // Feed the shared negative cache ONLY from a real pin-rights 400 on the
      // unpin verb — never from any other failure class (D5).
      if (isPinRightsError(err)) args.rightsCache?.block(String(args.ownerChatId));
      // Adopt the status-pin terminal-vs-never-confirmed contract (#3664 Defect
      // B) instead of drop-on-ANY-unpin: retain the claim when the unpin did
      // NOT terminally land (transient flood/5xx/network), so the next refresh
      // retries rather than orphaning a still-pinned banner with no record. A
      // terminal 4xx (rights, message gone, bot kicked) — and a success — fall
      // through to the drop below, because re-issuing cannot help.
      if (!isUnpinTerminalError(err)) return args.prevState;
    }
    // Terminal outcome: drop our claim and the persisted record. A crash
    // between unpin and clear just re-unpins next boot (idempotent).
    safePersist(args.persist?.clear);
    return null;
  }

  if (action.kind === 'pin') {
    // The banner is a PINNED notice: if this chat is already known rights-less
    // (proved by the status-pin path or an earlier banner pin), skip the whole
    // send+pin — an un-pinnable send is pure noise (D5).
    if (args.rightsCache?.isBlocked(String(args.ownerChatId))) return args.prevState;
    let sent: { message_id: number };
    try {
      // sendRichMessage doesn't accept link_preview_options — omit it.
      sent = await args.bot.api.sendRichMessage(args.ownerChatId, { markdown: action.text }, {
        // OAuth slot banner is a status notice — silence the open ping.
        // (the pin below is already silent; the edit path doesn't ping.)
        disable_notification: true,
      });
    } catch (err) {
      // SEND failure — deliberately NOT a pin-rights signal, so the cache is
      // NEVER written here even though the phase tag below is 'pin' (D5).
      args.onError?.('pin', err);
      return args.prevState;
    }
    // Persist INTENT (pending) BEFORE the pin API call: a crash between the pin
    // landing and its confirm rewrite leaves a pending record that boot cleanup
    // unpins next boot — closing the persist-after-pin leak.
    safePersist(() => args.persist?.pending?.(String(args.ownerChatId), sent.message_id));
    try {
      // allow-raw-pin: sanctioned banner pin owner (see the allowlist).
      await args.bot.api.pinChatMessage(args.ownerChatId, sent.message_id, {
        disable_notification: true,
      });
    } catch (err) {
      args.onError?.('pin', err);
      // The PIN verb failing with a real pin-rights 400 IS the rights signal —
      // record it so later refreshes skip the doomed send+pin (D5).
      if (isPinRightsError(err)) args.rightsCache?.block(String(args.ownerChatId));
      // sendMessage succeeded but pin failed — don't claim the message, and
      // drop the pending record so we don't leave a phantom claim for a pin
      // that never landed.
      safePersist(args.persist?.clear);
      return args.prevState;
    }
    // Pin confirmed — rights are present, so clear any stale block for this chat
    // (mirrors the status-pin path clearing on a successful pin).
    args.rightsCache?.clear(String(args.ownerChatId));
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
