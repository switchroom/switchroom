/**
 * Persistence for the gateway's 30-min scoped-approval windows
 * (`scopedGrants: ScopedGrantStore`, see ../scoped-approval.ts).
 *
 * Problem: the store is in-memory. Any gateway restart (fleet roll, config
 * apply, failover probe — marko saw ~14 boots on 2026-07-05) wipes it, so an
 * action the operator allowed with a 30-min scope minutes ago re-cards
 * immediately. It reads as "my approval didn't stick."
 *
 * Fix: mirror the store to a tiny JSON file in STATE_DIR (same shape as
 * permission-card-store.ts — synchronous ATOMIC writes (tmp + fsync + rename),
 * mode 0o600, one small file; a corrupt file is quarantined and logged loudly
 * rather than silently read as "no grants" — see store-file.ts). NOTE: atomic
 * REPLACEMENT only — whole-old-or-whole-new, not power-loss durability; the
 * missing parent-directory fsync is tracked in #3603.
 * Write-through on every grant and on sweep-expiry removal; reload at boot,
 * dropping entries already past their ABSOLUTE expiry.
 *
 * This only widens WHEN a still-valid window survives a restart — never WHAT
 * qualifies. Expiry is absolute wall-clock, captured at the original tap, so a
 * restart can never extend a window. All fail-closed semantics
 * (destructive-Bash never scoped, expiry lookup fails closed) live in
 * scoped-approval.ts and are untouched — a reloaded grant runs the identical
 * `lookupScopedGrant` gate as an in-memory one.
 *
 * Kill switch: SWITCHROOM_SCOPED_GRANT_PERSIST=0 → boot with an empty store
 * and never write (any pre-existing file is ignored).
 */

import { join } from 'node:path'
import { atomicWriteStateFileSync } from '../../src/util/state-owner.js'
import {
  preserveUnreadableStoreFile,
  quarantineCorruptStoreFile,
  readStoreJsonSync,
} from './store-file.js'
import {
  serializeScopedGrants,
  deserializeScopedGrants,
  type ScopedGrantStore,
} from '../scoped-approval.js'

export interface ScopedGrantPersistence {
  /** True unless the kill switch disabled persistence. */
  readonly enabled: boolean
  /** Load surviving grants (absolute expiry > now). Empty when disabled. */
  load(now: number): ScopedGrantStore
  /** Write-through the current store. No-op when disabled. */
  save(store: ScopedGrantStore): void
}

/** Persistence is on unless SWITCHROOM_SCOPED_GRANT_PERSIST is exactly "0". */
export function scopedGrantPersistEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SWITCHROOM_SCOPED_GRANT_PERSIST !== '0'
}

export function createScopedGrantStore(
  stateDir: string,
  env: Record<string, string | undefined> = process.env,
  /** Log sink — defaults to stderr (the gateway's runtime log). */
  log: (line: string) => void = l => process.stderr.write(l),
): ScopedGrantPersistence {
  const filePath = join(stateDir, 'scoped-grants.json')
  const enabled = scopedGrantPersistEnabled(env)

  /** Set when the last read failed for a non-ENOENT reason — the next write
   * must preserve the file it could not read instead of clobbering it. */
  let unreadable = false

  function read(): unknown[] {
    const result = readStoreJsonSync(filePath, 'scoped-grant-store', log)
    unreadable = result.status === 'unreadable'
    if (result.status !== 'ok') return []
    const parsed = result.value
    if (!Array.isArray(parsed)) {
      quarantineCorruptStoreFile(
        filePath,
        'scoped-grant-store',
        'parsed to a non-array — not a scoped-grants file',
        log,
      )
      return []
    }
    return parsed
  }

  return {
    enabled,

    load(now) {
      if (!enabled) return new Map()
      return deserializeScopedGrants(read(), now)
    },

    save(store) {
      if (!enabled) return
      try {
        // Fail closed: never let an overwrite be what destroys grants we
        // merely failed to READ (flaky mount, transient EACCES).
        if (unreadable) {
          preserveUnreadableStoreFile(filePath, 'scoped-grant-store', log)
          unreadable = false
        }
        // tmp + fsync + rename — a crash mid-persist leaves the previous
        // grant set intact rather than a torn file that reads as "no grants".
        atomicWriteStateFileSync(filePath, JSON.stringify(serializeScopedGrants(store)), 0o600)
      } catch (err) {
        log(`telegram gateway: scoped-grant-store write failed: ${(err as Error).message}\n`)
      }
    },
  }
}
