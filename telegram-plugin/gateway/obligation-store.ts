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

import { dirname } from 'node:path'
import type { Obligation } from './obligation-ledger.js'

export interface ObligationStoreFsSeam {
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  /** Atomic same-dir replace (POSIX rename) so a crash mid-write can't tear
   *  the snapshot. */
  renameSync: (from: string, to: string) => void
  existsSync: (path: string) => boolean
  /** fsync the FILE at `path`. Atomicity ≠ durability: rename orders the
   *  metadata, it does not put the tmp file's DATA on stable storage. Call
   *  on the tmp file BEFORE the rename. */
  fsyncFileSync: (path: string) => void
  /** fsync the DIRECTORY at `path`, AFTER the rename — the new directory
   *  entry lives in the parent's own cached metadata and is otherwise lost
   *  in a power cut. */
  fsyncDirSync: (path: string) => void
  /** #4146: remove a snapshot this process will not maintain. Optional so any
   *  existing seam (tests, other callers) keeps compiling and keeps working —
   *  an absent `unlinkSync` degrades to "no cleanup", which is what those
   *  callers do today. */
  unlinkSync?: (path: string) => void
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
 * #3282 — true iff the optional captured-answer snapshot is structurally sound.
 * A malformed blob (partial write, forward-incompatible shape) must NOT crash the
 * resume: `sanitizeCapturedDelivery` strips it, so the obligation degrades to a
 * fresh-generation represent (today's behaviour) rather than throwing.
 */
function isValidCapturedDelivery(x: unknown): boolean {
  if (x == null || typeof x !== 'object') return false
  const c = x as Record<string, unknown>
  // Empty chunks ⇒ nothing to resume: treat as malformed so it is STRIPPED and
  // the obligation degrades to a (bounded) fresh-generation represent rather than
  // sitting non-null-but-empty and no-op'ing the sweep forever.
  if (!Array.isArray(c.chunks) || c.chunks.length === 0 || !c.chunks.every((t) => typeof t === 'string')) return false
  if (!Array.isArray(c.chunkStates)) return false
  return c.chunkStates.every((s) => {
    if (s == null || typeof s !== 'object') return false
    const st = s as Record<string, unknown>
    return (
      typeof st.index === 'number' &&
      typeof st.confirmed === 'boolean' &&
      Array.isArray(st.messageIds) &&
      st.messageIds.every((m) => typeof m === 'number')
    )
  })
}

/** Drop a malformed `capturedDelivery` in place so a corrupt snapshot degrades to
 *  fresh-generation represent instead of crashing the resume (fail-open). */
function sanitizeCapturedDelivery(o: Obligation): Obligation {
  if (o.capturedDelivery != null && !isValidCapturedDelivery(o.capturedDelivery)) {
    const { capturedDelivery: _drop, ...rest } = o
    return rest
  }
  return o
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
  return env.obligations.filter(isObligationRow).map(sanitizeCapturedDelivery)
}

/**
 * #4146 — drop a snapshot this process is NOT going to maintain.
 *
 * When the gateway is STATIC or `SWITCHROOM_OBLIGATION_LEDGER=0`, the ledger's
 * `onChange` persister is never wired, so obligations open and close purely in
 * memory while any previously-written `obligations.json` sits on disk
 * unchanged. That leftover is not harmless: the W1-d audience classifier
 * (`hooks/audience-classify.mjs`) reads this exact file to decide whether
 * anyone is waiting on a chat, and an empty-but-stale open set reads there as
 * POSITIVE evidence that nobody is — which is the one input that can make the
 * classifier suppress a message owed to a human.
 *
 * Removing the file restores that classifier's stated invariant ("absent ⇒
 * unknown ⇒ deliver") deterministically, with no freshness heuristic and no
 * clock. Note this is safe precisely because the snapshot has exactly one
 * writer: with the ledger ON, a merely-stopped gateway leaves a snapshot that
 * is accurate rather than stale, so nothing is lost by only cleaning up in the
 * modes where persistence is disabled.
 *
 * Best-effort and never throws — a failure degrades to the reader-side
 * ledger-off guard in the hook.
 *
 * @returns `true` iff a file was actually removed.
 */
export function removeUnmaintainedSnapshot(
  path: string,
  fs: ObligationStoreFsSeam,
  reason = 'persistence disabled',
  log: (line: string) => void = (l) => process.stderr.write(l),
): boolean {
  const unlink = fs.unlinkSync
  if (unlink == null) return false
  try {
    if (!fs.existsSync(path)) return false
    unlink(path)
    log(
      `obligation-store: persistence is off (${reason}) — removed unmaintained ` +
        `snapshot path=${path} so it cannot be read as "nobody is waiting" (#4146)\n`,
    )
    return true
  } catch (err) {
    log(
      `obligation-store: could not remove unmaintained snapshot path=${path}: ` +
        `${(err as Error).message} — audience classification falls back to the ` +
        `reader-side ledger-off guard (#4146)\n`,
    )
    return false
  }
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
    // Order matters: fsync the tmp file's DATA, THEN publish it by rename.
    // Renaming first would let a power cut leave the snapshot path pointing
    // at an inode whose bytes never reached the platter — a zero-length or
    // stale snapshot that reads as "no open obligations", which is exactly
    // the silent-drop this store exists to prevent.
    fs.fsyncFileSync(tmp)
    fs.renameSync(tmp, path)
  } catch (err) {
    log(
      `obligation-store: persist FAILED path=${path}: ${(err as Error).message} — ` +
        `durability degraded to in-memory\n`,
    )
    return
  }
  // The rename landed, so the snapshot is already correct for a process
  // crash; this last barrier only upgrades it to survive a power cut. Kept
  // in its own try so a directory-fsync failure isn't mislabelled as a
  // failed persist — the data IS written, just not provably on the platter.
  try {
    fs.fsyncDirSync(dirname(path))
  } catch (err) {
    log(
      `obligation-store: directory fsync FAILED path=${path}: ${(err as Error).message} — ` +
        `snapshot written but the rename may not survive a power cut\n`,
    )
  }
}
