/**
 * current-turn-map.ts — per-topic `currentTurn` store behind the
 * emission-authority kill-switch (PR-4e).
 *
 * ## What 4e changes (and, crucially, what it does NOT)
 *
 * The `claude` CLI is genuinely SEQUENTIAL: never two foreground turns
 * executing CPU-simultaneously. So 4e is NOT about concurrent execution.
 * It is about the ISOLATION of per-topic emission STATE.
 *
 * Before 4e the gateway tracked the live foreground turn in ONE ambient
 * module-scope singleton (`let currentTurn`). That is correct for the
 * synchronous-to-the-live-turn reads — but it is WRONG for the LATE async
 * events that fire AFTER the live turn has flipped to a different topic:
 *
 *   - a deferred card drain captured for topic A,
 *   - the orphaned-reply backstop for A,
 *   - an over-ping decision for A,
 *   - the answer-stream suppressor for A,
 *
 * any of which can fire AFTER `currentTurn` flipped from A to B. A bare
 * `currentTurn === turnA` liveness check then reads B and FALSIFIES A's own
 * liveness (or, worse, a teardown keyed on the ambient singleton clobbers B's
 * card / ping / single-flight state). 4e keys the store by chat+thread so a
 * late A-captured callback resolves A's authority, never contaminating B.
 *
 * ## Defining property: flag-OFF ≡ flag-ON ≡ base
 *
 * The kill-switch (`SWITCHROOM_EMISSION_AUTHORITY`, default OFF) is read ONCE
 * here, mirroring `emission-authority.ts`'s `EMISSION_AUTHORITY_ENABLED`:
 *
 *   - **Flag OFF (default):** the accessors operate on the singleton ONLY.
 *     `byKey` is never written (stays empty, zero alloc). Every read returns
 *     the singleton. Byte-equivalent to base — there is no map.
 *   - **Flag ON:** the per-topic `byKey` map is the source of truth, AND the
 *     singleton is retained as a "most-recent-set" MIRROR so every GLOBAL
 *     liveness read (`isBusy`, the `if (currentTurn != null) return` poke
 *     guards, the orphaned-reply guard) stays byte-identical: under the
 *     sequential-CLI invariant the most-recently-set turn IS the live turn,
 *     so the mirror answers "is anything live" exactly as the old singleton.
 *
 * No lock is added here. Map ops are synchronous `Map.get/set/delete` — no
 * await, no lock — so the PR-4d no-deadlock invariant is untouched.
 *
 * ## Why a standalone module (not inline in gateway.ts)
 *
 * The gateway IIFE cannot be instantiated in-process, so the multi-topic
 * non-contamination behaviour would be untestable if this lived inline. As a
 * standalone module with a flag-read-once seam (mirroring
 * emission-authority-card-drain-gate.test.ts's `loadFacade` re-import idiom),
 * the per-topic isolation is driven directly in tests/per-topic-current-turn.test.ts.
 */

/**
 * Kill-switch — read ONCE at module top, `=== '1'` (default OFF), mirroring
 * `emission-authority.ts`'s `EMISSION_AUTHORITY_ENABLED`. The same flag governs
 * both modules: under it OFF the singleton is the only store; under it ON the
 * per-topic map is authoritative with the singleton kept as a most-recent mirror.
 */
export const EMISSION_AUTHORITY_ENABLED =
  process.env.SWITCHROOM_EMISSION_AUTHORITY === '1'

/**
 * Per-topic `currentTurn` store. Generic over the gateway's turn type (which is
 * module-local to gateway.ts and not exported) so this module stays decoupled.
 *
 * - `byKey` is the FLAG-ON store, keyed by `statusKey(chatId, threadId)`.
 * - `singleton` is the FLAG-OFF store AND, under flag-ON, the most-recent-set
 *   MIRROR that serves global "is anything live" reads byte-identically.
 *
 * The two thin accessors flag-branch in EXACTLY one place each.
 */
export class CurrentTurnMap<T> {
  /** Flag-ON store. Never written under flag OFF (stays empty, zero alloc). */
  readonly byKey = new Map<string, T>()

  /** Flag-OFF store AND flag-ON most-recent-set mirror. */
  private singleton: T | null = null

  /**
   * Read the live turn.
   *
   *  - Flag OFF: the singleton.
   *  - Flag ON: `byKey.get(key)` when a key is given (per-topic liveness);
   *    otherwise the singleton mirror (global "is anything live" read).
   */
  get(key?: string): T | null {
    if (EMISSION_AUTHORITY_ENABLED) {
      if (key != null) return this.byKey.get(key) ?? null
      return this.singleton
    }
    return this.singleton
  }

  /**
   * Set the live turn for `key`.
   *
   *  - Flag OFF: assign the singleton (key ignored).
   *  - Flag ON: set `byKey[key]` AND update the singleton mirror to
   *    most-recent-set, so global liveness reads stay byte-identical.
   */
  set(turn: T, key: string): void {
    if (EMISSION_AUTHORITY_ENABLED) {
      this.byKey.set(key, turn)
      this.singleton = turn
      return
    }
    this.singleton = turn
  }

  /**
   * Is `turn` still the live turn FOR ITS OWN topic `key`?
   *
   *  - Flag OFF: `singleton === turn` (the ambient liveness check, verbatim).
   *  - Flag ON: `byKey.get(key) === turn` — so a B-flip never falsifies A's
   *    own liveness. This is the load-bearing cross-topic isolation read.
   */
  isLiveForKey(turn: T, key: string): boolean {
    if (EMISSION_AUTHORITY_ENABLED) {
      return this.byKey.get(key) === turn
    }
    return this.singleton === turn
  }

  /**
   * End (delete) `turn` for `key`, iff `key` still maps to `turn` — the
   * leak-close-at-origin used by `endCurrentTurnAtomic` and the silence-poke
   * fallback.
   *
   *  - Flag OFF: clear the singleton iff it still points at `turn`.
   *  - Flag ON: `byKey.delete(key)` iff `byKey.get(key) === turn`, AND clear
   *    the singleton mirror iff it STILL points at `turn` (i.e. no later turn
   *    has flipped the mirror). Returns true iff a delete happened.
   */
  endTurnForKey(turn: T, key: string): boolean {
    if (EMISSION_AUTHORITY_ENABLED) {
      if (this.byKey.get(key) !== turn) return false
      this.byKey.delete(key)
      if (this.singleton === turn) this.singleton = null
      return true
    }
    if (this.singleton !== turn) return false
    this.singleton = null
    return true
  }

  /**
   * Clear EVERYTHING — every entry is a ghost (the disconnect-flush /
   * bridge-died sweep). Drops the whole `byKey` map and the singleton mirror.
   */
  clearAll(): void {
    this.byKey.clear()
    this.singleton = null
  }

  /**
   * Self-heal backstop: drop any `byKey` entries whose key belongs to `chatId`
   * AND pass the per-sibling `isStale` gate — mirroring `purgeStaleTurnsForChat`
   * (turn-state-purge.ts) exactly, including its `:`-prefix chat match and the
   * one-agent-owns-supergroup safety (a LIVE sibling topic of the same chatId is
   * spared unless it is itself stale). Also clears the singleton mirror iff it
   * pointed at one of the swept entries. No-op under flag OFF (the map is empty).
   *
   * @param isStale per-sibling staleness gate; defaults to always-stale for the
   *   DM / single-topic case (every sibling is genuinely dangling), matching the
   *   `purgeStaleTurnsForChat` default.
   * @returns the keys swept.
   */
  purgeChatStale(chatId: string, isStale: (key: string) => boolean = () => true): string[] {
    if (!chatId) return []
    const swept: string[] = []
    for (const key of [...this.byKey.keys()]) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      if (key.slice(0, sep) !== chatId) continue
      if (!isStale(key)) continue // live sibling topic — leave its turn intact
      const victim = this.byKey.get(key)
      this.byKey.delete(key)
      swept.push(key)
      if (this.singleton === victim) this.singleton = null
    }
    return swept
  }
}
