/**
 * Sweep logic for the active-reactions sidecar.
 *
 * The sidecar (see `active-reactions.ts`) records every in-flight
 * status reaction the bot has set but not yet resolved to a terminal
 * state (👍 done or 😱 error). Two lifecycle events consume it:
 *
 *   1. Startup — when a new gateway process boots, it sweeps any
 *      entries left over from a prior session that crashed or was
 *      killed mid-turn. Without this, reactions stay stuck on
 *      intermediate emoji (🤔, 🔥, etc.) forever because the
 *      in-memory map that tracks them died with the old process.
 *
 *   2. Pre-restart — when /restart, /reconcile --restart, or /update
 *      commands fire a self-restart, the gateway proactively promotes
 *      any still-active reactions to 👍 before it gets SIGTERM'd.
 *
 * Both consumers call `sweepActiveReactions`, which is shaped as a
 * pure function that takes the setDone callback as an argument. That
 * keeps it testable in isolation — the tests pass a fake callback and
 * assert which reactions were visited and whether the sidecar was
 * cleared.
 */

import { readActiveReactions, clearActiveReactions, type ActiveReaction } from "./active-reactions.js";

export type SetDoneReactionFn = (chatId: string, messageId: number) => Promise<unknown>;

export interface SweepOptions {
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface SweepResult {
  swept: ActiveReaction[];
  timedOut: boolean;
}

/**
 * Promote every entry in the sidecar to 👍, then clear it. Bounded by
 * `timeoutMs` (default 2s) so a slow Telegram API can't block a
 * restart indefinitely. Failures are logged and swallowed — the
 * sidecar is cleared regardless so stale entries don't pile up on
 * subsequent boots.
 */
export async function sweepActiveReactions(
  agentDir: string,
  setDone: SetDoneReactionFn,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 2000;
  const reactions = readActiveReactions(agentDir);
  if (reactions.length === 0) return { swept: [], timedOut: false };

  log(`sweeping ${reactions.length} stale reaction(s)`);
  const attempts = reactions.map((r) =>
    Promise.resolve()
      .then(() => setDone(r.chatId, r.messageId))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`reaction sweep failed for ${r.chatId}/${r.messageId}: ${msg}`);
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

  clearActiveReactions(agentDir);
  return { swept: reactions, timedOut };
}
