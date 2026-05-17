/**
 * Update-flow PR C — boot-card surfacing for MCP-originated updates.
 *
 * When an agent (e.g. klanker) runs `mcp__hostd__update_apply` the work
 * happens hostd-side, the agent itself restarts at the end, and the
 * resulting boot card for THIS agent (the one that just restarted via
 * the redeploy) needs to surface the outcome — success or failure with a
 * recovery hint — so the operator sees what happened without trawling
 * the audit log.
 *
 * Implementation: on boot, scan ~/.switchroom/host-control-audit.log for
 * the most recent `phase: "terminal"` `update_apply` row within a recent
 * window. Dedupe via an atomic O_EXCL marker so a respawn within the
 * window doesn't re-announce. Render a single line that's appended to
 * the existing boot-card body.
 *
 * Pure & test-friendly — `readLastTerminalUpdateAudit` accepts an
 * injectable file-reader, `renderUpdateOutcomeLine` is a pure function,
 * and `claimUpdateAnnouncement` accepts an injectable claim-dir + clock.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readAndFilter, defaultAuditLogPath, type AuditEntry } from '../../src/host-control/audit-reader.js'

/** Default lookback window: 10 minutes is enough to catch the boot that
 *  follows a normal update_apply but small enough that an audit row from
 *  yesterday's run can't re-trigger an announcement after a long
 *  outage. */
export const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000

export interface ReadOpts {
  /** Read the file system. Override in tests. */
  readFile?: (path: string) => string
  /** Exists check. Override in tests. */
  exists?: (path: string) => boolean
  /** Override the audit-log path (defaults to ~/.switchroom/host-control-audit.log). */
  auditLogPath?: string
  /** Wall-clock for the lookback comparison. */
  now?: number
  /** Lookback window in ms. Defaults to {@link DEFAULT_LOOKBACK_MS}. */
  lookbackMs?: number
}

/**
 * Read the audit log and return the most-recent `update_apply` terminal
 * row within the lookback window, or null if none. We deliberately do
 * not filter by caller — any update_apply outcome is interesting to the
 * person watching this chat regardless of which agent ran the verb.
 */
export function readLastTerminalUpdateAudit(opts: ReadOpts = {}): AuditEntry | null {
  const path = opts.auditLogPath ?? defaultAuditLogPath()
  const exists = opts.exists ?? existsSync
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  if (!exists(path)) return null
  let raw: string
  try {
    raw = readFile(path)
  } catch {
    return null
  }
  // Pull recent update_apply rows, then trim to terminal-phase within window.
  const recent = readAndFilter(raw, { op: 'update_apply' }, 200)
  const now = opts.now ?? Date.now()
  const since = now - (opts.lookbackMs ?? DEFAULT_LOOKBACK_MS)
  let best: AuditEntry | null = null
  for (const e of recent) {
    if (e.phase !== 'terminal') continue
    const ts = Date.parse(e.ts)
    if (Number.isNaN(ts)) continue
    if (ts < since) continue
    if (best == null || Date.parse(best.ts) < ts) best = e
  }
  return best
}

const RECOVERY_HINTS: Record<string, string> = {
  binary:
    'curl https://switchroom.ai/install.sh | sh && switchroom update',
  source:
    'cd ~/code/switchroom && git pull && bun install && bun run build && switchroom update',
  'source-unlinked':
    'cd ~/code/switchroom && bun link && switchroom update  # ensures binary is in PATH first',
  docker:
    'docker compose -p switchroom pull && docker compose -p switchroom up -d',
  unknown:
    'Cannot auto-detect install type. Run `switchroom apply` to refresh ~/.switchroom/install-type.json, then retry.',
}

function recoveryHint(installType: string | undefined): string {
  if (!installType) return RECOVERY_HINTS.unknown
  return RECOVERY_HINTS[installType] ?? RECOVERY_HINTS.unknown
}

function shortSha(s: string): string {
  return s.replace(/^sha256:/, '').slice(0, 12)
}

/**
 * Pure renderer. Returns the single line (HTML-safe — plain ASCII)
 * to append to the boot card body. `null` means nothing to surface
 * (entry too stale, schema invalid, etc.).
 */
export function renderUpdateOutcomeLine(entry: AuditEntry): string {
  const success = entry.exit_code === 0 && entry.result !== 'error' && entry.result !== 'denied'
  if (success) {
    const channel = entry.channel ? `channel:${entry.channel}` : entry.pin ? `pin:${entry.pin}` : 'channel:?'
    let shaStr = ''
    if (entry.resolved_sha) {
      const firstSha = Object.values(entry.resolved_sha)[0]
      if (firstSha) shaStr = `, sha:${shortSha(firstSha)}`
    }
    return `✅ update completed (${channel}${shaStr})`
  }
  const stderrTail = (entry.stderr_tail ?? entry.error ?? '').slice(-400)
  const opStep = entry.op
  const hint = recoveryHint(entry.install_context?.install_type)
  // Single line is reader-friendly when short; multi-line when stderr is present.
  const lines = [`❌ update failed at ${opStep}: ${stderrTail || '(no stderr captured)'}`, `    ↳ Recovery: ${hint}`]
  return lines.join('\n')
}

export interface ClaimOpts {
  /** Override state-dir base (default: $TELEGRAM_STATE_DIR or ~/.switchroom/<agent>/telegram). */
  stateDir?: string
}

/**
 * Atomic claim via `O_CREAT|O_EXCL` — returns true if THIS process is
 * the first to announce this request_id. Idempotent across respawns
 * within the same state-dir. We deliberately don't clean up old
 * markers — they're tiny and bounded by the lookback window above.
 */
export function claimUpdateAnnouncement(requestId: string, opts: ClaimOpts = {}): boolean {
  const stateDir = opts.stateDir ?? process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.switchroom')
  const dir = join(stateDir, 'update-announced')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return false
  }
  const safeId = requestId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 200)
  const path = join(dir, safeId)
  try {
    // O_CREAT | O_EXCL — fails with EEXIST if another boot already
    // claimed this request_id.
    const fd = openSync(path, 'wx')
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

/**
 * Combined entry-point used by the gateway boot path: read + claim +
 * render. Returns the line to append (already escaped for HTML — plain
 * ASCII text — caller embeds with no further processing) or null when
 * there's nothing to surface OR another boot already claimed the row.
 */
export function maybeRenderUpdateAnnouncement(opts: ReadOpts & ClaimOpts = {}): string | null {
  const entry = readLastTerminalUpdateAudit(opts)
  if (!entry) return null
  if (!claimUpdateAnnouncement(entry.request_id, opts)) return null
  return renderUpdateOutcomeLine(entry)
}
