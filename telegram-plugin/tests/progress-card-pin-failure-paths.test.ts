/**
 * PR-C2 — pin/unpin failure paths beyond what PR-A covered.
 *
 * PR-A added: pin reject + sidecar still cleared (`firePin API rejection
 * deletes from pinned map and clears sidecar`), unpin reject + sidecar
 * still cleared.
 *
 * This file extends with the consistency-of-internal-state angle:
 *
 *   1. After a pin REJECTION, the manager's `pinned` map must NOT
 *      retain the failed message id — otherwise a later completeTurn
 *      would issue an unpin for a message that was never actually
 *      pinned, and pinnedTurnKeys() would lie.
 *
 *   2. After an unpin REJECTION, the (turnKey, agentId) must still be
 *      considered "unpinned" so a duplicate completeTurn doesn't
 *      double-fire deps.unpin (the .finally branch only clears the
 *      sidecar; the in-memory `pinned`/`unpinned` bookkeeping is what
 *      guards against duplicate API calls).
 *
 * fails when: firePin's catch branch forgets to delete the composite
 * from the `pinned` map (so pinnedTurnKeys grows ghost entries) OR
 * doUnpin's `unpinned.add(key)` is moved to inside the success branch
 * of the unpin promise (so a reject leaves unpinned set un-flipped and
 * a second completeTurn double-unpins).
 */
import { describe, it, expect } from 'vitest'
import { createPinManager, type TimerHandle } from '../progress-card-pin-manager.js'
import { errors } from './fake-bot-api.js'

interface T { fn: () => void; cancelled: boolean; fired: boolean }
function makeHarness() {
  const timers: T[] = []
  const sidecar: Array<{ chatId: string; messageId: number }> = []
  let pinCalls = 0
  let unpinCalls = 0

  let pinReject: Error | null = null
  let unpinReject: Error | null = null

  const mgr = createPinManager({
    pin: async (_chatId, _messageId) => {
      pinCalls++
      if (pinReject) {
        const e = pinReject
        pinReject = null
        throw e
      }
      return true
    },
    unpin: async (_chatId, _messageId) => {
      unpinCalls++
      if (unpinReject) {
        const e = unpinReject
        unpinReject = null
        throw e
      }
      return true
    },
    addPin: (e) => { sidecar.push({ chatId: e.chatId, messageId: e.messageId }) },
    removePin: (chatId, messageId) => {
      const i = sidecar.findIndex((s) => s.chatId === chatId && s.messageId === messageId)
      if (i >= 0) sidecar.splice(i, 1)
    },
    log: () => {},
    now: () => 1000,
    scheduleTimer: (fn): TimerHandle => {
      const t: T = { fn, cancelled: false, fired: false }
      timers.push(t)
      return { cancel: () => { t.cancelled = true } }
    },
  })

  return {
    mgr,
    sidecar,
    fireTimers: () => {
      for (const t of [...timers]) {
        if (t.cancelled || t.fired) continue
        t.fired = true
        t.fn()
      }
    },
    setPinReject: (e: Error) => { pinReject = e },
    setUnpinReject: (e: Error) => { unpinReject = e },
    counts: () => ({ pin: pinCalls, unpin: unpinCalls }),
  }
}

describe('PR-C2: pin/unpin failure → internal map consistency', () => {
  it('pin REJECT: pinned map drops the composite so pinnedTurnKeys() does not lie', async () => {
    const h = makeHarness()
    h.setPinReject(errors.forbidden())
    h.mgr.considerPin({
      chatId: 'c', threadId: '0', turnKey: 'c:0:1', messageId: 500, isFirstEmit: true,
    })
    h.fireTimers()
    await h.mgr.drainInFlight()

    // Sidecar cleared by firePin's catch branch (already covered in PR-A).
    expect(h.sidecar).toEqual([])
    // CRITICAL extension: the in-memory pinned map must not still claim
    // turnKey c:0:1 was successfully pinned.
    expect(h.mgr.pinnedTurnKeys()).toEqual([])
    expect(h.mgr.pinnedMessageId('c:0:1')).toBeUndefined()

    // And a follow-up completeTurn must NOT issue any unpin call —
    // there's nothing to unpin.
    h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:0:1' })
    await h.mgr.drainInFlight()
    expect(h.counts().unpin).toBe(0)
  })

  it('unpin REJECT: duplicate completeTurn does NOT double-fire deps.unpin', async () => {
    const h = makeHarness()
    h.setUnpinReject(errors.badRequest('chat not found', 'unpinChatMessage'))

    h.mgr.considerPin({
      chatId: 'c', threadId: '0', turnKey: 'c:0:1', messageId: 500, isFirstEmit: true,
    })
    h.fireTimers()
    await h.mgr.drainInFlight()
    expect(h.counts().pin).toBe(1)
    expect(h.mgr.pinnedTurnKeys()).toEqual(['c:0:1'])

    // First completeTurn — unpin attempted, rejects.
    h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:0:1' })
    await h.mgr.drainInFlight()
    expect(h.counts().unpin).toBe(1)

    // Second completeTurn (e.g. forceCompleteTurn racing with turn_end).
    // The in-memory bookkeeping must guard against re-firing unpin.
    h.mgr.completeTurn({ chatId: 'c', turnKey: 'c:0:1' })
    await h.mgr.drainInFlight()
    expect(h.counts().unpin).toBe(1)
    // pinned map empty (doUnpin deletes regardless of unpin promise outcome)
    expect(h.mgr.pinnedTurnKeys()).toEqual([])
  })
})
