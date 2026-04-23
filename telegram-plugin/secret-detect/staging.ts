/**
 * In-memory staging map for ambiguous secret hits.
 *
 * When the detector returns an ambiguous detection (entropy-only, or a
 * confirmed hit near suppressor markers), we don't auto-store or auto-delete.
 * We park the detection in this map keyed by `(chat_id, message_id)` with a
 * 5-minute TTL. Follow-up inbound commands — `stash NAME`, `ignore`, `rename
 * X`, `forget` — look up the entry by chat and act on it.
 *
 * Keeping this as a plain Map (not SQLite) is intentional: the data is
 * ephemeral, and a restart discarding in-flight ambiguous captures is
 * the correct behavior (the user can re-paste if they still want it).
 */

import type { Detection } from './index.js'

export interface StagedSecret {
  chat_id: string
  message_id: number
  detection: Detection
  staged_at: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

export class StagingMap {
  private readonly map = new Map<string, StagedSecret>()
  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  private key(chat_id: string, message_id: number): string {
    return `${chat_id}:${message_id}`
  }

  set(entry: StagedSecret): void {
    this.map.set(this.key(entry.chat_id, entry.message_id), entry)
  }

  get(chat_id: string, message_id: number): StagedSecret | undefined {
    const k = this.key(chat_id, message_id)
    const entry = this.map.get(k)
    if (!entry) return undefined
    if (Date.now() - entry.staged_at > this.ttlMs) {
      this.map.delete(k)
      return undefined
    }
    return entry
  }

  /**
   * Return the most recent non-expired entry for a chat, regardless of
   * message_id. Used to resolve `stash NAME` / `ignore` follow-ups where
   * the user's reply message isn't the same as the original inbound.
   */
  latestForChat(chat_id: string): StagedSecret | undefined {
    const now = Date.now()
    let best: StagedSecret | undefined
    for (const [k, v] of this.map) {
      if (v.chat_id !== chat_id) continue
      if (now - v.staged_at > this.ttlMs) {
        this.map.delete(k)
        continue
      }
      if (!best || v.staged_at > best.staged_at) best = v
    }
    return best
  }

  delete(chat_id: string, message_id: number): boolean {
    return this.map.delete(this.key(chat_id, message_id))
  }

  /** Evict all expired entries. Idempotent. */
  sweep(): void {
    const now = Date.now()
    for (const [k, v] of this.map) {
      if (now - v.staged_at > this.ttlMs) {
        this.map.delete(k)
      }
    }
  }

  size(): number {
    return this.map.size
  }
}
