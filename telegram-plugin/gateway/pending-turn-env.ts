/**
 * Writer for the one-shot `.pending-turn.env` diagnostic file (Stage 4 of
 * simplify-restart, #250) — extracted verbatim from gateway.ts (#2996
 * ratchet discipline: new inline code must not land in gateway.ts).
 *
 * The gateway writes `<agentDir>/.pending-turn.env` at boot when the
 * previous shutdown left an interrupted turn; start.sh sources and then
 * consumes it. These vars are PASSIVE forensic context for the wake-audit
 * / "why did you restart" protocols — the real wake signal is the
 * synthesized resume inbound, not this file.
 */

import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Turn } from '../registry/turns-schema.js'

/**
 * Write (or clear) the pending-turn env file. Atomic tmp+rename: a crash
 * mid-write must never leave a truncated file that start.sh `source`s —
 * partial SWITCHROOM_PENDING_* vars or a malformed line would break shell
 * parsing inside the source. Never throws (logs via `log`).
 */
export function writePendingTurnEnv(
  agentDir: string,
  pending: Turn | null,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const pendingEnvPath = join(agentDir, '.pending-turn.env')
  try {
    if (pending != null) {
      const lines = [
        `SWITCHROOM_PENDING_TURN=true`,
        `SWITCHROOM_PENDING_TURN_KEY=${pending.turn_key}`,
        `SWITCHROOM_PENDING_CHAT_ID=${pending.chat_id}`,
        pending.thread_id != null
          ? `SWITCHROOM_PENDING_THREAD_ID=${pending.thread_id}`
          : `SWITCHROOM_PENDING_THREAD_ID=`,
        pending.last_user_msg_id != null
          ? `SWITCHROOM_PENDING_USER_MSG_ID=${pending.last_user_msg_id}`
          : `SWITCHROOM_PENDING_USER_MSG_ID=`,
        `SWITCHROOM_PENDING_ENDED_VIA=${pending.ended_via ?? 'unknown'}`,
        `SWITCHROOM_PENDING_STARTED_AT=${pending.started_at}`,
        pending.interrupt_reason != null
          ? `SWITCHROOM_PENDING_INTERRUPT_REASON=${pending.interrupt_reason}`
          : `SWITCHROOM_PENDING_INTERRUPT_REASON=`,
      ]
      const pendingEnvTmp = `${pendingEnvPath}.tmp-${process.pid}`
      writeFileSync(pendingEnvTmp, lines.join('\n') + '\n', { mode: 0o600 })
      renameSync(pendingEnvTmp, pendingEnvPath)
      log(
        `telegram gateway: pending-turn env written to ${pendingEnvPath} ` +
          `turnKey=${pending.turn_key} endedVia=${pending.ended_via ?? 'open'}\n`,
      )
    } else if (existsSync(pendingEnvPath)) {
      rmSync(pendingEnvPath, { force: true })
      log(`telegram gateway: pending-turn env cleared (clean previous shutdown)\n`)
    }
  } catch (err) {
    log(`telegram gateway: pending-turn env write failed (${(err as Error).message})\n`)
  }
}
