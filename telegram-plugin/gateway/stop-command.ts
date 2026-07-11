/**
 * Telegram `/stop` command + bare operator "stop" keyword (#3020) — the
 * mid-turn kill switch. Both cancel the agent's in-flight claude turn via
 * the same halt sequence the empty-`!` interrupt uses (safe-boundary
 * deferral per the interrupt config, tmux C-c, obligation cancel).
 *
 * This module is the pure, grammY-free core — parser + reply builder —
 * mirroring the `effort-command.ts` split so the logic is unit-testable
 * without booting the bot. The side-effectful halt itself
 * (`executeHaltNow`) lives in gateway.ts next to the interrupt machinery
 * it shares.
 *
 * NOTE: `/stop` used to be the hostd container-stop verb; that moved to
 * `/agentstop` (pairing with `/agentstart`) so the intuitive word can do
 * the intuitive thing: stop what the agent is doing right now, not stop
 * the container.
 */

/**
 * True iff the message is a bare operator "stop" — the exact word `stop`
 * (case-insensitive) on its own, optionally followed by a single `.` or
 * `!`. Anything more ("stop the build", "stop it") is normal speech and
 * must flow to the agent as an ordinary turn.
 */
export function parseStopKeyword(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim())
}

export interface StopReply {
  text: string
}

/**
 * Build the operator-facing reply for a stop request.
 *
 *  - `turnInFlight === false` → honest "nothing running" (no C-c was sent).
 *  - `turnInFlight === true`  → confirmation the in-flight turn was
 *    cancelled. If pending-session-command slots (#3017/#3018) hold queued
 *    commands, say so — a queued `/model`/`/effort` survives the halt and
 *    still applies at idle, and silence here would read as "my /model got
 *    killed too".
 *
 * Plain text (no HTML) — queued labels carry arbitrary model names.
 */
export function buildStopReply(turnInFlight: boolean, queuedSessionCmds: string[]): StopReply {
  if (!turnInFlight) {
    return { text: 'Nothing running — no in-flight turn to cancel.' }
  }
  const lines = ['⏹ Turn cancelled.']
  if (queuedSessionCmds.length > 0) {
    lines.push(
      `Queued command${queuedSessionCmds.length > 1 ? 's' : ''} (${queuedSessionCmds.join(', ')}) survive${queuedSessionCmds.length > 1 ? '' : 's'} and will apply once the session is idle.`,
    )
  }
  return { text: lines.join('\n') }
}
