/**
 * obligation-store.ts — durable snapshot for the obligation ledger.
 *
 * Why this exists: `ObligationLedger` is an in-memory Map. A gateway/container
 * restart (switchroom update, agent restart, self-restart, OOM) empties it, so
 * an inbound that was OPEN-but-unanswered when the process died loses its
 * answer-obligation. The inbound-spool redelivers the MESSAGE on boot, but its
 * replay bypasses `handleInbound` (the only place obligations OPEN), so the
 * obligation is never reborn and a post-restart deferral is silently dropped —
 * the determinism hole the systems analysis flagged.
 *
 * This makes the obligation guarantee SELF-CONTAINED across restart: every
 * ledger mutation persists the full open set here; on boot the gateway hydrates
 * the ledger from it, so OPEN/ESCALATING obligations survive WITH their
 * representCount + escalateAttempts intact (the latter so a permanently-
 * undeliverable escalation can't re-enter its retry loop on every boot).
 *
 * Shape choice — SNAPSHOT, not append-log. The open set is tiny and bounded
 * (the count of currently-unanswered messages — normally 0–3), so rewriting the
 * whole set on each change is trivially cheap and needs NO compaction,
 * tombstones, or torn-tail replay. Crash-safety is a single write-tmp +
 * atomic rename: a crash leaves EITHER the prior complete snapshot OR the new
 * complete one — never a torn file. This is strictly simpler than the spool's
 * append+ack+compact idiom, which that file needs only because its set is
 * unbounded. PURE w.r.t. the injected fs seam ⇒ unit-testable.
 */

import type { Obligation } from './obligation-ledger.js'

export interface ObligationStoreFsSeam {
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  /** Atomic same-dir replace (POSIX rename) so a crash mid-write can't tear
   *  the snapshot. */
  renameSync: (from: string, to: string) => void
  existsSync: (path: string) => boolean
}

interface SnapshotEnvelope {
  v: 1
  obligations: Obligation[]
}

function isObligationRow(x: unknown): x is Obligation {
  if (x == null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.originTurnId === 'string' &&
    o.originTurnId.length > 0 &&
    typeof o.chatId === 'string' &&
    typeof o.messageId === 'number' &&
    typeof o.text === 'string' &&
    typeof o.openedAt === 'number' &&
    typeof o.representCount === 'number'
  )
}

/**
 * Load the persisted open set. Returns [] on a missing, unreadable, or
 * malformed file (fail-open to empty: a corrupt snapshot must never crash boot;
 * worst case we lose the cross-restart obligation guarantee for that boot and
 * fall back to the spool's message redelivery — strictly no worse than today).
 */
export function loadObligations(path: string, fs: ObligationStoreFsSeam): Obligation[] {
  if (!fs.existsSync(path)) return []
  let raw = ''
  try {
    raw = fs.readFileSync(path)
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed == null || typeof parsed !== 'object') return []
  const env = parsed as Record<string, unknown>
  if (env.v !== 1 || !Array.isArray(env.obligations)) return []
  return env.obligations.filter(isObligationRow)
}

/**
 * Persist the open set atomically (write sibling tmp → rename over the real
 * path). Best-effort relative to fs availability: a write failure is logged but
 * never thrown — a failing store degrades to in-memory-only (today's behaviour),
 * it must not break live delivery.
 */
export function persistObligations(
  path: string,
  fs: ObligationStoreFsSeam,
  snapshot: readonly Obligation[],
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const env: SnapshotEnvelope = { v: 1, obligations: [...snapshot] }
  const tmp = path + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(env))
    fs.renameSync(tmp, path)
  } catch (err) {
    log(
      `obligation-store: persist FAILED path=${path}: ${(err as Error).message} — ` +
        `durability degraded to in-memory\n`,
    )
  }
}
