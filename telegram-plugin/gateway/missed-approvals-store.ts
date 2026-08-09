/**
 * Persistence store for approvals that TTL-expired while the operator was
 * away (#2862, "approval cards don't stick — re-offer digest").
 *
 * Problem: when a permission card auto-denies on TTL (the #2411 timeout path)
 * with the operator absent, the gated work is silently dropped and NOTHING
 * re-offers it when the operator returns. For cron-fired work (marko's brevo
 * nurture-drip batches) the batch just doesn't go out and the operator finds
 * out a day later.
 *
 * Fix: at TTL auto-deny the gateway appends the missed request to this store
 * (persisted so a gateway restart — which happens ~14× on a fleet-roll day —
 * doesn't lose the digest). On the FIRST operator-activity event afterwards,
 * the gateway posts ONE compact digest card ("While you were away these
 * approvals timed out: …  [Ask agent to retry] [Dismiss]") to the origin
 * surface, then promotes the pending entries into a delivered-digest record
 * (the posted card is now the durable record in chat). Retry synthesizes an
 * inbound asking the agent to re-attempt the actions; Dismiss clears the
 * record and edits the card closed.
 *
 * File format: a single JSON object `{ pending, delivered }`, written
 * synchronously to avoid interleaving on concurrent auto-denies, mode 0o600,
 * ATOMICALLY (tmp + fsync + rename) so a crash mid-persist can't leave a torn
 * file. Mirrors the `permission-card-store.ts` pattern. Both lists are
 * hard-capped so the file stays tiny under a runaway loop. A corrupt file is
 * quarantined and logged loudly rather than silently read as "nothing was
 * missed" — see store-file.ts. NOTE: atomic REPLACEMENT only —
 * whole-old-or-whole-new, not power-loss durability; the missing
 * parent-directory fsync is tracked in #3603.
 */

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteStateFileSync } from '../../src/util/state-owner.js'
import {
  preserveUnreadableStoreFile,
  quarantineCorruptStoreFile,
  readStoreJsonSync,
} from './store-file.js'

export interface MissedApproval {
  /** The permission request_id that timed out (dedup key). */
  requestId: string
  /** Raw claude tool name, e.g. `mcp__brevo__post`. */
  toolName: string
  /** Natural-language action (from `naturalAction()`), e.g. "post to Brevo". */
  action: string
  /** Origin surface the card was posted to. */
  chatId: string
  threadId?: number | null
  /** When the TTL auto-deny fired (epoch ms). */
  timedOutAt: number
}

export interface DeliveredDigest {
  /** Short id embedded in the card's callback_data (retry/dismiss routing). */
  digestId: string
  /** Origin surface the digest card was posted to. */
  chatId: string
  threadId?: number | null
  /** The missed entries this digest covers (for the Retry synthesis). */
  entries: MissedApproval[]
  deliveredAt: number
}

interface FileShape {
  pending: MissedApproval[]
  delivered: DeliveredDigest[]
}

export interface MissedApprovalsStore {
  /** Record a newly-missed approval. Idempotent on requestId. */
  add(entry: MissedApproval): void
  /** Undelivered misses, oldest first. */
  listPending(): MissedApproval[]
  pendingCount(): number
  /**
   * Move a set of pending entries into a delivered-digest record. The entries
   * carried on `digest` are removed from `pending` (matched by requestId).
   */
  promoteToDigest(digest: DeliveredDigest): void
  /** Look up a delivered digest by its id (for a retry/dismiss tap). */
  getDigest(digestId: string): DeliveredDigest | undefined
  /** Drop a delivered digest (retry consumed it, or dismiss cleared it). */
  removeDigest(digestId: string): void
  /** Delete the backing file entirely. */
  clear(): void
}

/** Bound the on-disk file even under a runaway auto-deny loop. */
export const MAX_PENDING = 50
export const MAX_DELIVERED = 20

export function createMissedApprovalsStore(
  stateDir: string,
  /** Log sink — defaults to stderr (the gateway's runtime log). */
  log: (line: string) => void = l => process.stderr.write(l),
): MissedApprovalsStore {
  const filePath = join(stateDir, 'missed-approvals.json')

  const EMPTY = (): FileShape => ({ pending: [], delivered: [] })

  /** Set when the last read failed for a non-ENOENT reason — the next write
   * must preserve the file it could not read instead of clobbering it. */
  let unreadable = false

  function read(): FileShape {
    const result = readStoreJsonSync(filePath, 'missed-approvals-store', log)
    unreadable = result.status === 'unreadable'
    if (result.status !== 'ok') return EMPTY()
    const parsed = result.value as Partial<FileShape>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      quarantineCorruptStoreFile(
        filePath,
        'missed-approvals-store',
        'parsed to a non-object — not a missed-approvals file',
        log,
      )
      return EMPTY()
    }
    // A PRESENT-but-non-array list is corruption, not "empty". Coercing it to
    // [] would resurrect the exact bug this store was hardened against: a
    // half-written `{"pending": null}` parses fine, so quarantine would never
    // fire and the digest would silently come up empty. An ABSENT list is the
    // legitimate cold-start/partial-shape case and stays silent.
    for (const field of ['pending', 'delivered'] as const) {
      if (parsed[field] !== undefined && !Array.isArray(parsed[field])) {
        quarantineCorruptStoreFile(
          filePath,
          'missed-approvals-store',
          `\`${field}\` is present but not an array — truncated or malformed write`,
          log,
        )
        return EMPTY()
      }
    }
    return {
      pending: parsed.pending ?? [],
      delivered: parsed.delivered ?? [],
    }
  }

  function write(f: FileShape): void {
    try {
      // Fail closed: never let an overwrite be what destroys state we merely
      // failed to READ (flaky mount, transient EACCES).
      if (unreadable) {
        preserveUnreadableStoreFile(filePath, 'missed-approvals-store', log)
        unreadable = false
      }
      // tmp + fsync + rename — never truncate the destination in place.
      atomicWriteStateFileSync(filePath, JSON.stringify(f), 0o600)
    } catch (err) {
      log(`telegram gateway: missed-approvals-store write failed: ${(err as Error).message}\n`)
    }
  }

  return {
    add(entry) {
      const f = read()
      const idx = f.pending.findIndex(e => e.requestId === entry.requestId)
      if (idx >= 0) {
        f.pending[idx] = entry
      } else {
        f.pending.push(entry)
      }
      // Keep only the most-recent MAX_PENDING (drop oldest by insertion order).
      if (f.pending.length > MAX_PENDING) {
        f.pending = f.pending.slice(f.pending.length - MAX_PENDING)
      }
      write(f)
    },

    listPending() {
      return read().pending
    },

    pendingCount() {
      return read().pending.length
    },

    promoteToDigest(digest) {
      const f = read()
      const ids = new Set(digest.entries.map(e => e.requestId))
      f.pending = f.pending.filter(e => !ids.has(e.requestId))
      // Replace any existing record with the same id, then append.
      f.delivered = f.delivered.filter(d => d.digestId !== digest.digestId)
      f.delivered.push(digest)
      if (f.delivered.length > MAX_DELIVERED) {
        f.delivered = f.delivered.slice(f.delivered.length - MAX_DELIVERED)
      }
      write(f)
    },

    getDigest(digestId) {
      return read().delivered.find(d => d.digestId === digestId)
    },

    removeDigest(digestId) {
      const f = read()
      const filtered = f.delivered.filter(d => d.digestId !== digestId)
      if (filtered.length !== f.delivered.length) {
        f.delivered = filtered
        write(f)
      }
    },

    clear() {
      try {
        unlinkSync(filePath)
      } catch {
        // File may not exist — fine.
      }
    },
  }
}
