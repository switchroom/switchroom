/**
 * Sweep logic for the active-pins sidecar.
 *
 * The sidecar (see `active-pins.ts`) records every progress-card
 * message the bot has pinned but not yet unpinned. Two lifecycle
 * events consume it:
 *
 *   1. Startup — when a new bot process boots, it sweeps any entries
 *      left over from a prior session that crashed or was killed
 *      mid-turn. Without this, the pins stay on Telegram forever
 *      because the in-memory map that tracks them died with the old
 *      process.
 *
 *   2. Pre-restart — when the /restart, /reconcile --restart, or
 *      /update commands fire a self-restart, the bot proactively
 *      unpins any still-pinned cards before it gets SIGTERM'd. This
 *      avoids a ~1s window where the restart ack is visible in chat
 *      but the previous turn's progress card is still pinned.
 *
 * Both consumers call `sweepActivePins`, which is shaped as a pure
 * function that takes the unpin callback as an argument. That keeps
 * it testable in isolation — the tests pass a fake unpin and assert
 * which pins were visited and whether the sidecar was cleared.
 */

import { readActivePins, clearActivePins, type ActivePin } from "./active-pins.js";

export type UnpinFn = (chatId: string, messageId: number) => Promise<unknown>;
/**
 * Optional pre-unpin hook. Called once per sidecar entry before the
 * unpin fires. Used by the boot-time orphan-pin reaper (#689) to edit
 * the message body to a "Restart interrupted this work" banner, so the
 * user sees WHY the card stopped updating rather than silently losing
 * the pin.
 *
 * Hook errors are logged and swallowed: a banner edit failing must
 * never block the unpin (frozen card is worse than no card).
 */
export type EditBeforeUnpinFn = (pin: ActivePin) => Promise<unknown>;

export interface SweepOptions {
  /** Upper bound on how long to wait for all unpin calls before returning. */
  timeoutMs?: number;
  /** Optional log hook — called with human-readable progress/error lines. */
  log?: (msg: string) => void;
  /**
   * Optional per-pin edit hook fired BEFORE the unpin. Failures are
   * caught and logged; the unpin still runs. See {@link EditBeforeUnpinFn}.
   */
  editBeforeUnpin?: EditBeforeUnpinFn;
}

export interface SweepResult {
  swept: ActivePin[];
  timedOut: boolean;
}

/**
 * Unpin every entry in the sidecar, then clear it. Bounded by
 * `timeoutMs` (default 2s) so a slow Telegram API can't block a
 * restart indefinitely. Unpin failures are logged and swallowed —
 * the sidecar is cleared regardless so stale entries don't pile up
 * on subsequent boots.
 */
export async function sweepActivePins(
  agentDir: string,
  unpin: UnpinFn,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 2000;
  const pins = readActivePins(agentDir);
  if (pins.length === 0) return { swept: [], timedOut: false };

  log(`sweeping ${pins.length} active pin(s)`);
  const editBeforeUnpin = options.editBeforeUnpin;
  const attempts = pins.map((pin) =>
    Promise.resolve()
      .then(async () => {
        if (editBeforeUnpin != null) {
          try {
            await editBeforeUnpin(pin);
          } catch (err) {
            // Banner edits are best-effort — message may already be gone
            // or the bot may have lost edit rights. Don't block unpin.
            const msg = err instanceof Error ? err.message : String(err);
            log(`banner edit failed for ${pin.chatId}/${pin.messageId}: ${msg}`);
          }
        }
        return unpin(pin.chatId, pin.messageId);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`unpin failed for ${pin.chatId}/${pin.messageId}: ${msg}`);
      }),
  );

  let timedOut = false;
  await Promise.race([
    Promise.allSettled(attempts),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs),
    ),
  ]);

  // By design: clear the sidecar on timeout even though in-flight unpins
  // may not have landed. Telegram's unpin is idempotent, so a retried unpin
  // on the next boot is a cheap no-op, whereas keeping the sidecar entries
  // around would have the sweep re-fire forever whenever Telegram is slow.
  clearActivePins(agentDir);
  return { swept: pins, timedOut };
}

/**
 * A single pinned message returned from Telegram's `getChat` API,
 * narrowed to the fields this sweep needs. `fromId` is null when the
 * pinned message has no `from` (e.g., anonymous channel posts) — in
 * that case the sweep treats the pin as foreign and stops, since we
 * can only confidently unpin messages we authored ourselves.
 */
export interface PinnedMessageInfo {
  messageId: number;
  fromId: number | null;
}

export type GetTopPinFn = (chatId: string) => Promise<PinnedMessageInfo | null>;

export interface BotAuthoredSweepResult {
  /** One entry per chat — how many bot-authored pins were unpinned there. */
  perChat: Record<string, number>;
  /** Total across all chats. */
  total: number;
}

/**
 * Sweep bot-authored pinned messages from the given chats. Telegram's
 * Bot API doesn't expose a "list all pinned messages" endpoint, only
 * `getChat().pinned_message` which returns the topmost pin. This
 * iterates that endpoint: if the top pin is authored by our bot, we
 * unpin it and re-check — the next most recent pin bubbles up. We
 * stop when the top pin is either missing or authored by someone
 * else, which is the safe behavior: a user-pinned message acts as a
 * barrier so we never interfere with pins the user made themselves.
 *
 * The per-chat loop is bounded by `maxPerChat` (default 32) so a
 * chat with an unexpected pile of bot pins can't spin forever.
 * Failures from `getChat` or `unpin` are logged and tolerated — the
 * sweep advances to the next chat rather than aborting the boot
 * sequence.
 *
 * This complements `sweepActivePins`, which only touches entries
 * previously recorded in the sidecar. Some stale pins never land in
 * the sidecar (e.g., if a pin write raced a crash before `addActivePin`
 * ran, or if the sidecar file itself was lost). This function is the
 * belt-and-suspenders backstop that picks those up on the next boot.
 */
export async function sweepBotAuthoredPins(
  chatIds: ReadonlyArray<string>,
  botUserId: number,
  getTopPin: GetTopPinFn,
  unpin: UnpinFn,
  options: SweepOptions & { maxPerChat?: number } = {},
): Promise<BotAuthoredSweepResult> {
  const log = options.log ?? (() => {});
  const maxPerChat = options.maxPerChat ?? 32;
  const perChat: Record<string, number> = {};
  let total = 0;

  for (const chatId of chatIds) {
    let unpinnedHere = 0;
    for (let i = 0; i < maxPerChat; i++) {
      let top: PinnedMessageInfo | null;
      try {
        top = await getTopPin(chatId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`getChat failed for ${chatId}: ${msg}`);
        break;
      }
      if (top == null) break;
      if (top.fromId !== botUserId) break;
      try {
        await unpin(chatId, top.messageId);
        unpinnedHere++;
        total++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`unpin failed for ${chatId}/${top.messageId}: ${msg}`);
        // If unpin fails, the top pin stays — another loop iteration
        // would fetch the same one and loop forever. Break out.
        break;
      }
    }
    if (unpinnedHere > 0) {
      perChat[chatId] = unpinnedHere;
      log(`unpinned ${unpinnedHere} bot-authored pin(s) in ${chatId}`);
    }
  }

  return { perChat, total };
}
