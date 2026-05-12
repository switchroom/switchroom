/**
 * Gateway-side writer for the agent quarantine marker (#1076).
 *
 * Mirrors the on-disk contract owned by `src/agents/quarantine.ts` —
 * the host-side host CLI reads the marker, the gateway writes it. We
 * keep a tiny copy here (writer only) because the gateway is bundled
 * separately and can't import from `src/`.
 *
 * The schema MUST stay in sync with `src/agents/quarantine.ts`:
 *
 *   { v: 1, reason: "startup.unauthorized", ts: <ms>, detail?: <string> }
 *
 * Any change to the shape should land in both files in the same PR
 * (or be guarded by `v`). See the src module's docstring for the full
 * threat-model and operator remediation.
 *
 * SECURITY: never write the bot token (or any secret material) into
 * the marker. The detail field is for the API description ("Unauthorized")
 * and similar non-secret context.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const QUARANTINE_FILENAME = 'quarantine.json'

export type QuarantineReason =
  | 'startup.unauthorized'
  // Config-class refusal-to-boot. Added 2026-05-13 after the
  // vault-posture init started throwing as an unhandled rejection
  // when the operator declared telegram-id posture but the auto-
  // unlock blob couldn't be read. Pre-fix that path produced a tight
  // restart loop ($n/60s -> hit supervisor cap -> stop) and posted
  // an "agent-crashed" event per restart. The right outcome is a
  // single EX_CONFIG exit at the first failure → supervisor
  // quarantines → operator sees one clean error.
  | 'startup.config_error'

export interface QuarantineMarker {
  v: 1
  reason: QuarantineReason
  ts: number
  detail?: string
}

/**
 * Write the quarantine marker into a Telegram state dir (typically
 * `process.env.TELEGRAM_STATE_DIR`). Idempotent — overwrites any
 * existing marker. Creates the parent dir if missing.
 */
export function writeQuarantineMarker(
  telegramStateDir: string,
  reason: QuarantineReason,
  detail?: string,
  nowFn: () => number = Date.now,
): void {
  mkdirSync(telegramStateDir, { recursive: true, mode: 0o700 })
  const marker: QuarantineMarker = {
    v: 1,
    reason,
    ts: nowFn(),
    detail,
  }
  writeFileSync(
    join(telegramStateDir, QUARANTINE_FILENAME),
    JSON.stringify(marker) + '\n',
    'utf-8',
  )
}
