/**
 * Deferred terminal-reaction bookkeeping for the "hold 👍 until background
 * sub-agent workers finish" behaviour.
 *
 * The status reaction on a user's inbound message reflects CURRENT TURN
 * ACTIVITY (see `status-reactions.ts`). When a turn dispatches a background
 * worker (Agent/Task) and then ends, the parent's `turn_end` would paint
 * the terminal 👍 immediately — reading as "done / nothing happening" even
 * though the worker keeps running and the model's own text said work is
 * ongoing. This helper holds the working glyph and defers the terminal 👍
 * until the sub-agent watcher reports the last worker complete.
 *
 * Extracted as a pure, dependency-injected unit so the gateway-side
 * interaction that bit us in review — `finalizeStatusReaction` defers, then
 * `endCurrentTurnAtomic` purges the controller out of `activeStatusReactions`
 * in the SAME `turn_end` sequence — is directly testable. The fix: promotion
 * finalizes off the STORED controller reference (its emit closure still binds
 * the right message id), not a re-lookup that the purge has already emptied.
 */

/** Minimal controller surface this helper drives. */
export interface HoldableController {
  /** Freeze on a working glyph, suppress stall promotion, stay non-terminal. */
  hold(): void
  /** Terminate to 👍 (done) / 😱 (error). Idempotent once finished. */
  finalize(reason?: 'done' | 'error'): void
}

export interface DeferredDoneDeps<C extends HoldableController> {
  /** Count of sub-agent workers still running (excludes historical/terminal). */
  countRunningWorkers(): number
  /** Current live controller registered for `key`, if any. */
  getActive(key: string): C | undefined
  /** Canonical turn-end cleanup for `key` (drops reaction/typing/etc state). */
  purge(key: string): void
}

export class DeferredDoneReactions<C extends HoldableController> {
  private readonly map = new Map<string, { ctrl: C }>()

  constructor(private readonly deps: DeferredDoneDeps<C>) {}

  /**
   * Attempt to defer a terminal 'done' for `key`/`ctrl`. Returns true when
   * deferred (the caller must NOT finalize or purge — the held controller
   * owns the reaction until {@link promote}). Returns false when there is no
   * running worker, in which case the caller finalizes normally.
   */
  tryDefer(key: string, ctrl: C): boolean {
    if (this.deps.countRunningWorkers() > 0) {
      ctrl.hold()
      this.map.set(key, { ctrl })
      // Race guard: a worker may have transitioned to done between the count
      // above and this registration, having already fired its completion
      // callback before the deferred entry existed. Re-check and promote now
      // so the held reaction can't hang on a 👍 that will never come.
      if (this.deps.countRunningWorkers() === 0) this.promote()
      return true
    }
    this.map.delete(key)
    return false
  }

  /** Drop any deferred entry for `key` without finalizing (e.g. on error). */
  drop(key: string): void {
    this.map.delete(key)
  }

  /**
   * Promote every deferred reaction to the terminal 👍 — but only once no
   * workers remain running. Finalize off the stored controller reference:
   * the canonical `turn_end` path purges the key out of the active map right
   * after deferring, so a key re-lookup would find nothing. `finalize()` is
   * idempotent, and the controller's emit closure still targets the correct
   * message. Only re-purge when the active map STILL points at this exact
   * controller — if a newer turn replaced it, that turn owns the key now and
   * must not be clobbered (and the turn_end path already purged, so we skip
   * a redundant second purge).
   */
  promote(): void {
    if (this.map.size === 0) return
    if (this.deps.countRunningWorkers() > 0) return
    for (const [key, { ctrl }] of this.map) {
      ctrl.finalize('done')
      if (this.deps.getActive(key) === ctrl) this.deps.purge(key)
    }
    this.map.clear()
  }

  /** Test/inspection hook. */
  has(key: string): boolean {
    return this.map.has(key)
  }

  get size(): number {
    return this.map.size
  }
}
