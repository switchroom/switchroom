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

import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * Does this boot RESTORE the previous Claude transcript (via `--continue`)?
 *
 * The boot reset must NOT fire when the transcript persists: a `continue`/`auto`
 * agent whose container restarts mid-`/private` task replays the SAME transcript,
 * so flipping privacy to public would resume storing that very task (the FIX-3
 * mid-task-reset shape). Mirrors `decideBootBriefing` (boot-briefing-builder.ts):
 * `continue` always replays; `auto` MAY replay (only when the JSONL is under
 * `resume_max_bytes`) — the gateway can't see the inner CONTINUE_FLAG, so `auto`
 * is treated conservatively as a restore (privacy persists; safe direction — an
 * over-retained private interval merely excludes more, never leaks). A `/new`
 * `/reset` force-fresh boot is genuinely fresh even under continue/auto.
 */
export function bootRestoresTranscript(opts: {
  resumeMode: string | undefined
  forceFresh: boolean
}): boolean {
  if (opts.forceFresh) return false
  return opts.resumeMode === 'continue' || opts.resumeMode === 'auto'
}

/**
 * Env/marker-reading convenience over `bootRestoresTranscript` for the gateway
 * boot site. Reads `SWITCHROOM_RESUME_MODE` and the force-fresh signal
 * (`SWITCHROOM_FORCE_FRESH`, hoisted by start.sh, with the `.force-fresh-session`
 * marker as the non-docker fallback — same pair `boot-briefing-wiring.ts` uses).
 */
export function isContinueRestoreBoot(agentDir: string | null): boolean {
  const forceFresh =
    process.env.SWITCHROOM_FORCE_FRESH === '1' ||
    (agentDir != null && existsSync(join(agentDir, '.force-fresh-session')))
  return bootRestoresTranscript({
    resumeMode: process.env.SWITCHROOM_RESUME_MODE,
    forceFresh,
  })
}
