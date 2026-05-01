/**
 * Side-effecting half of the auto-fallback flow (#11 / #420 / #421).
 *
 * `auto-fallback.ts` returns a pure `FallbackPlan`. This module
 * dispatches the user-visible Telegram notification for that plan
 * to the owner chat. Extracted from gateway.ts so the dispatch is
 * testable end-to-end via `tests/fake-bot-api.ts` instead of through
 * the full gateway boot path.
 *
 * Error-handling contract: API failures are reported via `onError`
 * but never throw. The gateway logs to stderr; tests assert via the
 * callback. A failed notification does not block the agent restart
 * downstream — the user being unaware of the swap is a worse failure
 * than burning a slot, but neither failure should kill the gateway.
 */

import type { FallbackPlan } from './auto-fallback.js';

/** Minimal subset of grammy's `bot.api` we depend on. */
export interface FallbackBotApi {
  sendMessage(
    chat_id: string | number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
}

export interface FallbackBot {
  api: FallbackBotApi;
}

export interface DispatchFallbackArgs {
  bot: FallbackBot;
  /** Owner chat (`access.allowFrom[0]`). When null/empty, dispatch
   *  becomes a noop — no chat to notify. */
  ownerChatId: string | null | undefined;
  plan: FallbackPlan;
  onError?: (err: unknown) => void;
}

export type DispatchOutcome =
  | { kind: 'sent'; messageId: number }
  | { kind: 'no-chat' }
  | { kind: 'error' };

/**
 * Send the plan's `notificationHtml` to the owner chat. Idempotent
 * within a plan (caller decides when to invoke). Always resolves.
 */
export async function dispatchFallbackNotification(
  args: DispatchFallbackArgs,
): Promise<DispatchOutcome> {
  if (!args.ownerChatId) return { kind: 'no-chat' };
  try {
    const sent = await args.bot.api.sendMessage(
      args.ownerChatId,
      args.plan.notificationHtml,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
    );
    return { kind: 'sent', messageId: sent.message_id };
  } catch (err) {
    args.onError?.(err);
    return { kind: 'error' };
  }
}
