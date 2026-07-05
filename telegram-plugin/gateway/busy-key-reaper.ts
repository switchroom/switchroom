/**
 * #2787 Mechanism B — the `claudeBusyKeys` orphan-reaper lifecycle, extracted
 * so the gateway glue that mutates the busy-key set stays in lockstep with its
 * shadow insertion-timestamp map and is unit-testable WITHOUT importing
 * `gateway.ts` (which boots the bot + IPC listener on module load and so cannot
 * run inside a unit test). The gateway keeps ownership of the two containers
 * (`claudeBusyKeys: Set`, `claudeBusyKeySince: Map`) and calls these helpers at
 * every mark / reap site; `disconnect-flush.ts` clears them at bridge death.
 * The test harness (`tests/busy-key-reaper.test.ts`) wires the SAME containers,
 * the SAME delivery queue, and the real `flushOnAgentDisconnect` to reproduce
 * the disconnect → reconnect → re-mark and slow-vs-orphan delivery sequences.
 *
 * Two invariants this module enforces:
 *
 *  1. LOCKSTEP. The timestamp map shadows actual SET MEMBERSHIP, not its own
 *     prior presence. `markBusyKeyLockstep` stamps a fresh timestamp whenever a
 *     key transitions idle→busy (`claudeBusyKeys.has(key) === false`). Gating on
 *     the set — not on `since.has` — is load-bearing: a disconnect flush clears
 *     `claudeBusyKeys` directly, so if the shadow map ever lagged, a `!since.has`
 *     guard would decline to re-stamp on the reconnect→re-mark and leave a
 *     stale, >TTL-old timestamp on a freshly-marked key — which the reaper would
 *     then reap out from under a live delivery.
 *
 *  2. SLOW-DELIVERY SAFETY (the #1922 hazard). `busy` is marked EAGERLY at
 *     delivery, and the gateway→claude enqueue-ack lag can be up to ~5 MINUTES
 *     under load (#1922). During that eager-mark→enqueue window the gateway's
 *     `currentTurn` is null yet the turn is real-and-merely-slow. A bare
 *     time-grace reaper cannot tell "slow" from "orphaned" and would reap a
 *     genuine delivery, re-opening the idle-drain gate while claude is about to
 *     process the very inbound whose key it just reaped (duplicate / concurrent
 *     delivery on the CORE inbound path). So the reap is PROOF-GATED: a key is
 *     reaped ONLY when it has NO entry in the delivery-confirm queue. A
 *     slow-but-real inbound is tracked there from delivery until claude's
 *     `enqueue` ack (via the never-drop re-deliver loop), so any key still
 *     awaiting its turn is present and skipped — no matter how slow. The time
 *     grace is retained as defense-in-depth, defaulting well above the observed
 *     ack-lag tail. Only a busy-marked key with NO pending delivery AND age past
 *     the grace is a true orphan (its turn acked and should have cleared busy at
 *     turn_end, or it was a steer/interrupt inbound excluded from tracking that
 *     amends a now-absent turn) — reaping those can never clobber a slow one.
 */

/** Lockstep mark: add to the busy set and, on the idle→busy transition only,
 *  stamp the insertion time. Keyed on set membership so a re-mark after a
 *  disconnect flush (which cleared the set directly) always re-stamps fresh. */
export function markBusyKeyLockstep(
  keys: Set<string>,
  since: Map<string, number>,
  key: string,
  now: number,
): void {
  const wasBusy = keys.has(key)
  keys.add(key)
  if (!wasBusy) since.set(key, now)
}

/** Lockstep clear: delete from both containers. */
export function clearBusyKeyLockstep(
  keys: Set<string>,
  since: Map<string, number>,
  key: string,
): void {
  keys.delete(key)
  since.delete(key)
}

export interface ReapOptions {
  /** Grace before a busy-marked key with no pending delivery is a true orphan. */
  ttlMs: number
  /** True iff a delivery-confirm entry is still tracked for this key — i.e. a
   *  slow-but-real inbound awaiting its enqueue ack. Such keys are NEVER reaped,
   *  regardless of age (the #1922 slow-delivery guarantee). */
  hasPendingDelivery: (key: string) => boolean
  /** Optional line logger for each reaped key (observability). */
  log?: (msg: string) => void
}

/**
 * Reap orphaned busy markers. Call ONLY once the gateway has asserted no turn is
 * in flight (`currentTurn == null`). Returns the keys reaped (for the caller's
 * metrics / assertions). Also prunes shadow-map entries whose key already left
 * the set, so the map can't grow unbounded.
 */
export function reapOrphanBusyKeys(
  keys: Set<string>,
  since: Map<string, number>,
  now: number,
  opts: ReapOptions,
): string[] {
  const reaped: string[] = []
  for (const key of [...since.keys()]) {
    if (!keys.has(key)) {
      since.delete(key)
      continue
    }
    // Proof gate: a key with a pending delivery is a slow-but-real inbound still
    // awaiting its enqueue ack (the never-drop re-deliver loop owns it) — NEVER
    // an orphan, regardless of age. Skip so a multi-minute (#1922) delivery
    // can't be reaped out from under claude.
    if (opts.hasPendingDelivery(key)) continue
    const stampedAt = since.get(key) ?? now
    if (now - stampedAt >= opts.ttlMs) {
      keys.delete(key)
      since.delete(key)
      reaped.push(key)
      opts.log?.(
        `telegram gateway: reaped orphan busy key=${key} (no turn in flight, ` +
          `no pending delivery, >${opts.ttlMs}ms) — unwedging idle-drain`,
      )
    }
  }
  return reaped
}
