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
 * by chat+message, so registering the same leaked pin twice is idempotent.
 */

import { orphanPinKey } from './status-pin-store.js'

export const ORPHAN_PIN_MAX_ATTEMPTS = 5

export interface OrphanPinRegistryDeps {
  /** Best-effort unpin. May throw; a throw counts as one failed attempt. */
  unpin: (chatId: string, messageId: number) => Promise<unknown>
  /** Drop the durable orphan row once the unpin finally lands (or is
   *  forfeited). Receives the `orphanPinKey()` value. */
  clearRow: (pinKey: string) => void
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
      orphans.set(key, { chatId, messageId, attempts: 0 })
    },

    async drain(chatId) {
      if (draining.has(chatId)) return
      draining.add(chatId)
      try {
        for (const [key, o] of [...orphans]) {
          if (o.chatId !== chatId) continue
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
