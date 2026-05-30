import { describe, it, expect, vi } from 'vitest'
import { DeferredDoneReactions, type HoldableController } from '../reaction-defer.js'

/** Fake controller recording hold/finalize calls; finalize is idempotent. */
function makeCtrl() {
  let finished = false
  const ctrl: HoldableController & { held: number; doneCount: number } = {
    held: 0,
    doneCount: 0,
    hold() {
      this.held++
    },
    finalize(reason: 'done' | 'error' = 'done') {
      if (finished) return
      finished = true
      if (reason === 'done') this.doneCount++
    },
  }
  return ctrl
}

/**
 * Harness modelling the gateway maps so the promote/purge interaction is
 * exercised end-to-end. `purge` deletes from `active` exactly as
 * `purgeReactionTracking` does, so a turn_end that purges right after a
 * defer is faithfully simulated.
 */
function makeHarness(initialRunning = 0) {
  const active = new Map<string, ReturnType<typeof makeCtrl>>()
  let running = initialRunning
  const purged: string[] = []
  const deferred = new DeferredDoneReactions<ReturnType<typeof makeCtrl>>({
    countRunningWorkers: () => running,
    getActive: (key) => active.get(key),
    purge: (key) => {
      purged.push(key)
      active.delete(key)
    },
  })
  return {
    active,
    deferred,
    purged,
    setRunning: (n: number) => {
      running = n
    },
  }
}

describe('DeferredDoneReactions', () => {
  it('does not defer when no workers are running', () => {
    const h = makeHarness(0)
    const ctrl = makeCtrl()
    h.active.set('k', ctrl)
    expect(h.deferred.tryDefer('k', ctrl)).toBe(false)
    expect(ctrl.held).toBe(0)
    expect(h.deferred.size).toBe(0)
  })

  it('defers and holds while a worker runs', () => {
    const h = makeHarness(1)
    const ctrl = makeCtrl()
    h.active.set('k', ctrl)
    expect(h.deferred.tryDefer('k', ctrl)).toBe(true)
    expect(ctrl.held).toBe(1)
    expect(ctrl.doneCount).toBe(0)
    expect(h.deferred.has('k')).toBe(true)
  })

  it('promotes to 👍 only once the last worker finishes', () => {
    const h = makeHarness(2)
    const ctrl = makeCtrl()
    h.active.set('k', ctrl)
    h.deferred.tryDefer('k', ctrl)

    // First worker done — one still running → no promotion.
    h.setRunning(1)
    h.deferred.promote()
    expect(ctrl.doneCount).toBe(0)
    expect(h.deferred.has('k')).toBe(true)

    // Last worker done → promote to 👍 and clear.
    h.setRunning(0)
    h.deferred.promote()
    expect(ctrl.doneCount).toBe(1)
    expect(h.deferred.size).toBe(0)
  })

  it('REGRESSION: promotes off the stored ref even after turn_end purged the active map', () => {
    // This is the bug review #1999 caught: on the canonical turn_end path,
    // finalizeStatusReaction defers, then endCurrentTurnAtomic →
    // purgeReactionTracking deletes the controller from activeStatusReactions
    // in the SAME sequence. A key re-lookup would find nothing and the held
    // reaction would hang forever on the working glyph.
    const h = makeHarness(1)
    const ctrl = makeCtrl()
    h.active.set('k', ctrl)
    h.deferred.tryDefer('k', ctrl)

    // Simulate endCurrentTurnAtomic purging the key out of the active map.
    h.active.delete('k')

    // Worker finishes.
    h.setRunning(0)
    h.deferred.promote()

    // Must still reach 👍 via the stored controller reference.
    expect(ctrl.doneCount).toBe(1)
    // No double-purge: active map no longer holds the controller, so promote
    // skips the redundant purge (turn_end already purged).
    expect(h.purged).toEqual([])
  })

  it('purges via the helper when the active map still owns the controller (reply path)', () => {
    // executeReply path keeps currentTurn (and the active map entry) alive,
    // so promote must own the purge.
    const h = makeHarness(1)
    const ctrl = makeCtrl()
    h.active.set('k', ctrl)
    h.deferred.tryDefer('k', ctrl)

    h.setRunning(0)
    h.deferred.promote()

    expect(ctrl.doneCount).toBe(1)
    expect(h.purged).toEqual(['k'])
  })

  it('instance guard: a newer turn that replaced the key is never finalized or purged', () => {
    const h = makeHarness(1)
    const oldCtrl = makeCtrl()
    h.active.set('k', oldCtrl)
    h.deferred.tryDefer('k', oldCtrl)

    // A fresh turn arrives on the same key with a brand-new controller.
    const newCtrl = makeCtrl()
    h.active.set('k', newCtrl)

    h.setRunning(0)
    h.deferred.promote()

    // Old held controller still reaches its 👍 (its message's workers done)...
    expect(oldCtrl.doneCount).toBe(1)
    // ...but the new turn's controller is untouched and its key not purged.
    expect(newCtrl.doneCount).toBe(0)
    expect(h.purged).toEqual([])
    expect(h.active.get('k')).toBe(newCtrl)
  })

  it('race guard: promotes immediately if the worker finished during defer', () => {
    // countRunningWorkers returns >0 on the first call (so we defer) then 0
    // on the re-check inside tryDefer — emulating a worker completing in the
    // window between the two reads.
    const active = new Map<string, ReturnType<typeof makeCtrl>>()
    const ctrl = makeCtrl()
    active.set('k', ctrl)
    let calls = 0
    const deferred = new DeferredDoneReactions<ReturnType<typeof makeCtrl>>({
      countRunningWorkers: () => (calls++ === 0 ? 1 : 0),
      getActive: (key) => active.get(key),
      purge: (key) => active.delete(key),
    })
    expect(deferred.tryDefer('k', ctrl)).toBe(true)
    // Race guard fired promote() inside tryDefer → already at 👍, map cleared.
    expect(ctrl.doneCount).toBe(1)
    expect(deferred.size).toBe(0)
  })

  it('drop() clears a deferred entry without finalizing (error path)', () => {
    const h = makeHarness(1)
    const ctrl = makeCtrl()
    h.active.set('k', ctrl)
    h.deferred.tryDefer('k', ctrl)
    expect(h.deferred.has('k')).toBe(true)

    h.deferred.drop('k')
    expect(h.deferred.has('k')).toBe(false)
    expect(ctrl.doneCount).toBe(0)
  })

  it('promote is a no-op when nothing is deferred', () => {
    const h = makeHarness(0)
    h.deferred.promote()
    expect(h.purged).toEqual([])
    expect(h.deferred.size).toBe(0)
  })
})
