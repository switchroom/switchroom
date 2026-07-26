/**
 * In-process orphan-pin retry (#3634).
 *
 * The durable half of the fix (`orphanPinKey` in status-pin-store.ts) makes a
 * failed unpin survive to the next boot. This is the other half: a gateway
 * that stays up for days would otherwise leave the pin visible for days.
 *
 * Deliberately TIMER-FREE. A background interval is another surface to leak,
 * to test, and to unref correctly; instead the registry is drained
 * opportunistically from the status-pin reconcile itself — i.e. at the next
 * turn boundary in that chat. The transient failures this exists for
 * (FLOOD_WAIT_ACTIVE, 5xx) clear within minutes, and a chat that has no
 * further turns has no further pins to confuse either.
 *
 * Bounded: `maxAttempts` retries per orphan, then it is forfeited in-process
 * (the durable row is still there, so boot cleanup gets its own ladder). Keyed
 * by chat+message, so registering the same leaked pin twice is idempotent. The
 * map is also capped (`MAX_TRACKED_ORPHANS`) so a pathological run of failed
 * unpins cannot grow it without bound — an evicted orphan still has its durable
 * row, so eviction defers cleanup to boot rather than losing it.
 *
 * NEVER UNPINS A LIVE PIN. A leaked message id can be CLAIMED AGAIN before the
 * retry fires — the group worker card (`wk:group:<feedKey>`) is one long-lived
 * message that is pinned, unpinned and re-pinned across turns, so a turn-end
 * unpin that flood-failed can be followed by a re-pin of that very id. Draining
 * blind would then unpin a card the user is actively watching. `isLive` is
 * therefore consulted immediately before every retry, and a superseded orphan
 * is DISCARDED (row and all): the live claim now owns that message and its own
 * row governs it.
 */

import { orphanPinKey } from './status-pin-store.js'

export const ORPHAN_PIN_MAX_ATTEMPTS = 5

/** Cap on tracked orphans. Well above any plausible real leak count; exists so
 *  a pathological failure run cannot grow the map without bound. */
export const MAX_TRACKED_ORPHANS = 100

export interface OrphanPinRegistryDeps {
  /** Best-effort unpin. May throw; a throw counts as one failed attempt. */
  unpin: (chatId: string, messageId: number) => Promise<unknown>
  /** Drop the durable orphan row once the unpin finally lands (or is
   *  forfeited). Receives the `orphanPinKey()` value. */
  clearRow: (pinKey: string) => void
  /** True when this chat+message is CURRENTLY claimed as a live status pin.
   *  Consulted immediately before each retry — see the module docblock. When
   *  omitted, every orphan is treated as stale (test convenience only; the
   *  gateway always passes it). */
  isLive?: (chatId: string, messageId: number) => boolean
  maxAttempts?: number
  log?: (line: string) => void
}

export interface OrphanPinRegistry {
  /** Record a pin whose unpin did not land. Idempotent per chat+message. */
  register: (chatId: string, messageId: number) => void
  /** Retry every orphan recorded for `chatId`. Never rejects. */
  drain: (chatId: string) => Promise<void>
  /** Outstanding orphan count (tests / diagnostics). */
  size: () => number
}

export function createOrphanPinRegistry(
  deps: OrphanPinRegistryDeps,
): OrphanPinRegistry {
  const maxAttempts = deps.maxAttempts ?? ORPHAN_PIN_MAX_ATTEMPTS
  const log = deps.log ?? ((l: string) => process.stderr.write(l))
  const orphans = new Map<
    string,
    { chatId: string; messageId: number; attempts: number }
  >()
  // Guards re-entrancy: `drain` is fired from the reconcile path, which can be
  // re-entered while an unpin is in flight. Without this, one slow orphan is
  // retried by every concurrent reconcile at once.
  const draining = new Set<string>()

  return {
    register(chatId, messageId) {
      const key = orphanPinKey(chatId, messageId)
      if (orphans.has(key)) return
      if (orphans.size >= MAX_TRACKED_ORPHANS) {
        // Evict the oldest (Map preserves insertion order). Its durable row is
        // untouched, so boot cleanup still finishes it.
        const oldest = orphans.keys().next().value
        if (oldest != null) {
          orphans.delete(oldest)
          log(
            `telegram gateway: orphan pin registry full (${MAX_TRACKED_ORPHANS}) — ` +
              `evicted ${oldest} from in-process retry; its durable row remains\n`,
          )
        }
      }
      orphans.set(key, { chatId, messageId, attempts: 0 })
    },

    async drain(chatId) {
      if (draining.has(chatId)) return
      draining.add(chatId)
      try {
        for (const [key, o] of [...orphans]) {
          if (o.chatId !== chatId) continue
          if (deps.isLive?.(o.chatId, o.messageId) === true) {
            // Superseded: this message is pinned again and a live claim owns
            // it. Unpinning here would tear down a card the user is watching.
            orphans.delete(key)
            deps.clearRow(key)
            log(
              `telegram gateway: orphan pin superseded — message is pinned again ` +
                `(chat=${o.chatId} msg=${o.messageId}); dropped ${key}\n`,
            )
            continue
          }
          try {
            await deps.unpin(o.chatId, o.messageId)
            orphans.delete(key)
            deps.clearRow(key)
            log(
              `telegram gateway: orphan pin cleared on retry ` +
                `(chat=${o.chatId} msg=${o.messageId} attempts=${o.attempts + 1})\n`,
            )
          } catch (err) {
            o.attempts += 1
            if (o.attempts >= maxAttempts) {
              orphans.delete(key)
              log(
                `telegram gateway: orphan pin giving up in-process after ` +
                  `${o.attempts} attempts (chat=${o.chatId} msg=${o.messageId}): ` +
                  `${err instanceof Error ? err.message : String(err)} — ` +
                  `durable row ${key} remains for boot cleanup\n`,
              )
            }
          }
        }
      } finally {
        draining.delete(chatId)
      }
    },

    size: () => orphans.size,
  }
}
