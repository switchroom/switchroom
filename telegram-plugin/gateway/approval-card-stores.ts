/**
 * In-memory storage for the four AGENT-INITIATED approval-card families
 * (vault_request_access / vault_request_save / request_secret /
 * mental_model_propose), extracted from gateway.ts (Phase 3 step 1 of the
 * gateway decomposition — see #2996). STORAGE ONLY: the per-card expiry LOGIC
 * (card edits, timeout synthetics, missed-approval re-offers) still lives in
 * gateway.ts and is injected here as `expire`. This module owns the Map
 * lifecycle and CO-LOCATES the TTL sweep next to the storage it sweeps, so the
 * gateway's authoritative `pendingStateReaper` calls a single `store.sweep(now)`
 * delegation instead of open-coding a `sweepExpiredEntries(...)` per family.
 *
 * Why a Map-compatible surface (get/set/delete/has/iteration) rather than a
 * bespoke API: every existing gateway call site — the callback-query handlers,
 * the executor add-sites, and `restorePendingApprovalCards` — used the raw Map
 * directly. Preserving the exact Map method surface keeps those call sites
 * BYTE-IDENTICAL (the variable name and every `.get`/`.set`/`.delete`/`for..of`
 * are unchanged), which is the invariant this phase must not break: the store
 * moves WHERE the Map is constructed and WHERE its sweep lives, nothing about
 * how the gateway reads or writes it. Restore semantics are therefore untouched.
 *
 * Race contract preserved (pinned by approval-card-stores.test.ts):
 *   - A verdict (operator tap → `.delete(stageId)`) arriving DURING an expiry
 *     sweep is single-shot-safe: the pure `expirePendingCard` core removes the
 *     entry before any fallible side effect, so the same card can never both
 *     expire and resolve. The store's `sweep` is a thin pass-through to that
 *     core via `sweepExpiredEntries`, so the ordering guarantee is unchanged.
 *   - A verdict arriving DURING restore is a plain `.set`/`.delete` on the same
 *     Map instance the restore populates — no separate storage to desync.
 *   - The shared reaper cadence is unchanged: `sweep(now)` performs exactly the
 *     work the old `sweepPendingX(now)` free functions did, in the same order.
 *
 * `expire` and `log` are supplied as THUNKS so a store constructed early in
 * gateway module-eval can reference the hoisted `expire*Card` functions and the
 * `const cardExpiryLog` arrow (which is in the temporal dead zone at
 * construction time); both are resolved lazily at sweep time.
 */

import { sweepExpiredEntries } from './pending-card-expiry.js'

export interface SweepableCardStore<T> {
  get(stageId: string): T | undefined
  set(stageId: string, value: T): void
  delete(stageId: string): boolean
  has(stageId: string): boolean
  clear(): void
  readonly size: number
  keys(): IterableIterator<string>
  values(): IterableIterator<T>
  entries(): IterableIterator<[string, T]>
  forEach(cb: (value: T, key: string, map: Map<string, T>) => void): void
  [Symbol.iterator](): IterableIterator<[string, T]>
  /**
   * Expire every entry past its TTL. Delegates to the same pure
   * `sweepExpiredEntries` core the gateway used inline, so per-entry
   * fault-isolation and single-shot ordering are byte-identical.
   */
  sweep(now: number): void
}

export interface SweepableCardStoreDeps<T> {
  /** Predicate: is this entry past its TTL at `now`? Closes over the family TTL. */
  isExpired: (value: T, now: number) => boolean
  /**
   * Per-entry expiry action (card strip + timeout synthetic + missed-approval
   * re-offer). A THUNK so it can reference gateway functions that are hoisted /
   * defined after this store is constructed. Called once per expired entry.
   */
  expire: () => (stageId: string, value: T, now: number) => void
  /** Error sink thunk (resolves the gateway's `cardExpiryLog` lazily). */
  log: () => (msg: string) => void
}

/**
 * Create a Map-backed, self-sweeping store for one approval-card family.
 * The backing Map is the sole storage; the returned object forwards the Map
 * surface the gateway uses plus a co-located `sweep`.
 */
export function createSweepableCardStore<T>(
  deps: SweepableCardStoreDeps<T>,
): SweepableCardStore<T> {
  const map = new Map<string, T>()
  return {
    get: (stageId) => map.get(stageId),
    set: (stageId, value) => void map.set(stageId, value),
    delete: (stageId) => map.delete(stageId),
    has: (stageId) => map.has(stageId),
    clear: () => map.clear(),
    get size() {
      return map.size
    },
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    forEach: (cb) => map.forEach(cb),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    sweep: (now) =>
      sweepExpiredEntries(map, deps.isExpired, deps.expire(), now, deps.log()),
  }
}
