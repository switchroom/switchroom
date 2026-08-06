/**
 * Gateway-owned session-start privacy reset (PR3 of the `/private` `/public`
 * feature).
 *
 * A genuine new session — cold boot / crash / planned restart, and a `/clear`
 * (which starts a new logical session) — must return memory writing to its
 * PUBLIC default. If the previous session ended while still private (an OPEN
 * interval was left behind), the operator is told loudly, so they are never
 * silently surprised that a stretch they thought was private is now being
 * recorded again.
 *
 * The gateway is the SINGLE owner of this reset+announce (the Python
 * `session_start.py` is deliberately NOT wired to it), which eliminates the
 * two-owner clear/announce race. Reconnect paths (`bridge-reconnect`) and the
 * compaction / resume / continue paths are EXEMPT by construction: they
 * reattach to a PERSISTING session, so this is simply never called from them —
 * there is no `source`-string branch to get wrong.
 *
 * This thin factory exists so gateway.ts holds only the loud-send primitive
 * (which needs the bot handle) and the call sites stay one-liners; the
 * reset/announce decision lives in `privacy-state.ts` and is unit-tested there.
 */

import { resetPrivacyOnGenuineSessionStart, SESSION_RESET_ALERT } from './privacy-state.js'

/** Posts the loud (notification-ON) reset alert. Provided by the gateway. */
export type LoudResetSender = (
  chatId: string,
  threadId: number | undefined,
  text: string,
) => void

/**
 * Bind the loud-send primitive into a `(chatId, threadId)` reset function.
 * Calling the returned function always resets privacy to public; it invokes
 * `send` (the loud alert) only when a private→public transition actually
 * happened.
 */
export function makePrivacyResetForNewSession(
  send: LoudResetSender,
): (chatId: string, threadId: number | undefined) => void {
  return (chatId, threadId) => {
    resetPrivacyOnGenuineSessionStart({
      onOpenIntervalReset: () => send(chatId, threadId, SESSION_RESET_ALERT),
    })
  }
}
