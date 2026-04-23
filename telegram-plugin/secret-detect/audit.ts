/**
 * Structured audit log for secret-detection events.
 *
 * Rationale: the telegram plugin already intercepts `process.stderr.write`
 * and tees every write to `~/.switchroom/logs/telegram-plugin.log` (see
 * plugin-logger.ts). We piggyback on that — `emitAudit` serializes the
 * event as a single JSON line prefixed with `[secret-detect-audit]` and
 * sends it through stderr. The logger rotation + ops tooling all work for
 * free.
 *
 * CRITICAL: the raw secret value is NEVER placed in the log. Only the slug
 * and rule id. See the `no-raw-secret-in-log` test.
 */

export type AuditAction = 'stored' | 'suppressed' | 'ambiguous' | 'failed' | 'rewritten'

export interface AuditEvent {
  event: 'secret-detected'
  chat_id: string
  message_id: number | null
  rule_id: string
  slug: string
  action: AuditAction
  delete_ok: boolean
  ts: number
  /** Optional free-form reason (never contains the raw secret). */
  detail?: string
}

export type AuditSink = (line: string) => void

let sink: AuditSink = (line) => {
  try {
    process.stderr.write(line + '\n')
  } catch {
    // best-effort — never let audit logging break the host path
  }
}

/**
 * Override the sink (tests only). Pass `null` to restore the default.
 */
export function setAuditSink(next: AuditSink | null): void {
  sink = next ?? ((line) => {
    try {
      process.stderr.write(line + '\n')
    } catch {
      /* ignore */
    }
  })
}

export function emitAudit(ev: Omit<AuditEvent, 'event' | 'ts'> & { ts?: number }): void {
  const full: AuditEvent = {
    event: 'secret-detected',
    ts: ev.ts ?? Math.floor(Date.now() / 1000),
    chat_id: ev.chat_id,
    message_id: ev.message_id,
    rule_id: ev.rule_id,
    slug: ev.slug,
    action: ev.action,
    delete_ok: ev.delete_ok,
    ...(ev.detail ? { detail: ev.detail } : {}),
  }
  sink(`[secret-detect-audit] ${JSON.stringify(full)}`)
}
