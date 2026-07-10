/**
 * In-memory storage for the LONG-TAIL of gateway.ts pending-state Maps —
 * the auth/vault-wizard, config-edit correlation, and transient capture Maps
 * that PR #3008 deferred when it moved the four agent-initiated approval-card
 * families behind `approval-card-stores.ts`. Phase 3 step 2 of the gateway
 * decomposition (see #2996): STORAGE ONLY.
 *
 * Two shapes, mirroring the two shapes the long-tail Maps actually have:
 *
 *  - `createSweepableStore<T>(isExpired)` — a Map-compatible store whose
 *    `sweep(now)` deletes every entry the caller's `isExpired(value, now)`
 *    predicate reports as past its TTL. The predicate is supplied by the
 *    gateway and CLOSES OVER the family's TTL constant, so the TTL and its
 *    comparison DIRECTION stay verbatim in gateway.ts — different families use
 *    `now - staged_at > TTL`, `now - startedAt > TTL`, `now - createdAt > TTL`,
 *    or an absolute `now > expiresAt`, and each is preserved byte-identically.
 *    `sweep` is a plain delete-past-TTL loop (no wake / side effects); it
 *    replaces the identical open-coded reaper / standalone-sweep loops. The
 *    delete-during-iteration is safe (JS Map iterators tolerate deleting the
 *    current key) — exactly as the original loops relied on.
 *
 *  - `createPlainStore<T>()` — a Map-compatible store with NO sweep, for the
 *    long-tail Maps whose lifetime is bounded by per-entry timers or an
 *    LRU cap rather than a TTL sweep (`pendingAskUser`, `agentButtonMeta`).
 *
 * Why a Map-compatible surface (get/set/delete/has/size/keys/values/entries/
 * forEach/iteration) rather than a bespoke API: every existing gateway call
 * site used the raw Map directly. Preserving the exact Map method surface —
 * and keeping the variable name unchanged — keeps those call sites
 * BYTE-IDENTICAL. The store moves WHERE the Map is constructed and (for the
 * sweepable shape) WHERE its sweep lives, nothing about how the gateway reads
 * or writes it.
 *
 * The backing Map is the sole storage and backs every iterator, so mutation-
 * during-iteration order/semantics are identical to the raw Map the gateway
 * used before.
 */

export interface PlainStore<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  delete(key: string): boolean
  has(key: string): boolean
  clear(): void
  readonly size: number
  keys(): IterableIterator<string>
  values(): IterableIterator<T>
  entries(): IterableIterator<[string, T]>
  forEach(cb: (value: T, key: string, map: Map<string, T>) => void): void
  [Symbol.iterator](): IterableIterator<[string, T]>
}

export interface SweepableStore<T> extends PlainStore<T> {
  /**
   * Delete every entry past its TTL per the injected `isExpired` predicate.
   * Plain delete-past-TTL, no wake — byte-identical to the open-coded reaper /
   * standalone sweep loop it replaces.
   */
  sweep(now: number): void
}

// Build the shared Map surface onto `target` (a getter for `size`, so the
// live Map size is read on every access — an object spread would freeze it).
function attachMapSurface<T, S extends object>(target: S, map: Map<string, T>): S & PlainStore<T> {
  return Object.defineProperties(target, {
    get: { value: (key: string) => map.get(key), enumerable: true },
    set: { value: (key: string, value: T) => void map.set(key, value), enumerable: true },
    delete: { value: (key: string) => map.delete(key), enumerable: true },
    has: { value: (key: string) => map.has(key), enumerable: true },
    clear: { value: () => map.clear(), enumerable: true },
    size: { get: () => map.size, enumerable: true },
    keys: { value: () => map.keys(), enumerable: true },
    values: { value: () => map.values(), enumerable: true },
    entries: { value: () => map.entries(), enumerable: true },
    forEach: {
      value: (cb: (value: T, key: string, m: Map<string, T>) => void) => map.forEach(cb),
      enumerable: true,
    },
    [Symbol.iterator]: { value: () => map[Symbol.iterator](), enumerable: true },
  }) as S & PlainStore<T>
}

/**
 * Create a Map-backed store with no automatic expiry. For long-tail Maps
 * whose entries are removed by per-entry timers or an LRU cap, not a TTL sweep.
 */
export function createPlainStore<T>(): PlainStore<T> {
  return attachMapSurface({}, new Map<string, T>())
}

/**
 * Create a Map-backed, self-sweeping store for one long-tail pending-state
 * family. `isExpired` closes over the family's TTL constant and encodes its
 * exact comparison direction; `sweep(now)` deletes every entry it flags.
 */
export function createSweepableStore<T>(
  isExpired: (value: T, now: number) => boolean,
): SweepableStore<T> {
  const map = new Map<string, T>()
  const sweep = (now: number): void => {
    for (const [k, v] of map) {
      if (isExpired(v, now)) map.delete(k)
    }
  }
  return attachMapSurface({ sweep }, map)
}
