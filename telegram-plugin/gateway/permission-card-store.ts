/**
 * Persistence store for in-flight permission card references.
 *
 * Problem: `pendingPermissions` is in-memory. When the gateway restarts
 * (gateway crash OR container restart), all entries are lost. Old permission
 * cards in Telegram keep their [Allow][Deny] inline keyboard buttons.
 * When the operator taps one, they get STALE_TAP_NOTICE ("already resolved
 * (timed out)"), which is misleading — the request wasn't resolved, it was
 * lost. Operators interpret this as "my approval didn't work."
 *
 * Fix: persist the (chatId, messageId) references for every posted card to a
 * JSON file in STATE_DIR. On each resolution (allow/deny/TTL-expire), remove
 * the entry. On gateway boot, load any surviving entries (they were never
 * resolved — the gateway crashed) and strip their inline keyboards + add a
 * "gateway restarted" footer so the operator sees a clear explanation instead
 * of a tappable-but-dead button.
 *
 * File format: JSON array of PersistedPermCard objects. Kept small (one file,
 * written synchronously to avoid interleaving on concurrent card posts).
 * Production rate: a few cards per permission request; file stays tiny.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface PersistedPermCard {
  requestId: string
  chatId: string
  messageId: number
  startedAt: number
  toolName: string
}

export interface PermissionCardStore {
  /** Record a newly-posted card. Idempotent on requestId+messageId. */
  add(entry: PersistedPermCard): void
  /** Remove all entries for this request (resolved — allow, deny, TTL). */
  remove(requestId: string): void
  /** Return all persisted entries (for boot-time stale-strip sweep). */
  loadAll(): PersistedPermCard[]
  /** Delete the backing file entirely (after boot sweep completes). */
  clear(): void
}

export function createPermissionCardStore(stateDir: string): PermissionCardStore {
  const filePath = join(stateDir, 'pending-perm-cards.json')

  function read(): PersistedPermCard[] {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PersistedPermCard[]) : []
    } catch {
      return []
    }
  }

  function write(entries: PersistedPermCard[]): void {
    // Atomic write: stage to .tmp then rename so a crash mid-write never
    // leaves a corrupt JSON file (consistent with saveAccess() pattern).
    const tmp = filePath + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(entries), { encoding: 'utf-8', mode: 0o600 })
      renameSync(tmp, filePath)
    } catch (err) {
      process.stderr.write(
        `telegram gateway: permission-card-store write failed: ${(err as Error).message}\n`,
      )
    }
  }

  return {
    add(entry) {
      const entries = read()
      // Replace existing entry for same (requestId, messageId) if present
      const idx = entries.findIndex(
        e => e.requestId === entry.requestId && e.messageId === entry.messageId,
      )
      if (idx >= 0) {
        entries[idx] = entry
      } else {
        entries.push(entry)
      }
      write(entries)
    },

    remove(requestId) {
      const entries = read()
      const filtered = entries.filter(e => e.requestId !== requestId)
      if (filtered.length !== entries.length) {
        write(filtered)
      }
    },

    loadAll() {
      return read()
    },

    clear() {
      try {
        unlinkSync(filePath)
      } catch {
        // File may not exist — that's fine
      }
    },
  }
}

/**
 * Sweep stale permission cards from a prior gateway session.
 *
 * For each entry, calls `editFn` to strip its inline keyboard and show a
 * "gateway restarted" notice, then removes the entry from the store. Removal
 * is per-card (not a bulk `clear()` at the end) so that fresh entries added
 * by new permission requests arriving during the sweep are not silently wiped.
 *
 * Exported for unit testing — gateway.ts calls this from `didOneTimeSetup`.
 */
export async function sweepStalePermCards(
  cards: PersistedPermCard[],
  editFn: (chatId: string, messageId: number, toolName: string) => Promise<void>,
  store: PermissionCardStore,
  log: (msg: string) => void = () => {},
): Promise<void> {
  if (cards.length === 0) return
  log(`telegram gateway: boot-sweep: stripping ${cards.length} stale permission card(s) from prior gateway session`)
  for (const card of cards) {
    try {
      await editFn(card.chatId, card.messageId, card.toolName)
    } catch (err) {
      log(
        `telegram gateway: boot-sweep: stale-card strip failed ` +
        `${card.chatId}:${card.messageId}: ${(err as Error).message}`,
      )
    }
    // Remove per-card: a bulk clear() after the loop would wipe entries added
    // by new permission requests arriving during the sweep (e.g. on a
    // gateway-only restart where Claude Code reconnects immediately).
    store.remove(card.requestId)
  }
}
