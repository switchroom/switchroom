/**
 * Contract test for `flushOnAgentDisconnect` — the gating policy applied
 * when a client disconnects from the IPC server.
 *
 * Bug context (#553 hotfix): the gateway's `onClientDisconnected` used to
 * unconditionally flush every active StatusReactionController to 👍 and
 * dispose the progress driver. This fired on EVERY disconnect, including
 * anonymous one-shot connections from `vendor/hindsight-memory`'s
 * `recall.py` hook. The user-visible symptom: 👀 reaction (received) was
 * immediately followed by 👍 (done) while the agent was still producing
 * its reply, plus a duplicate edited-message bug from the re-created
 * progress driver.
 *
 * The fix scopes the flush to clients whose `agentName` is non-null —
 * i.e. clients that actually completed a `register` IPC handshake.
 * Anonymous clients (recall.py and similar) are silently no-op.
 */

import { describe, it, expect, vi } from 'vitest'
import { flushOnAgentDisconnect } from '../gateway/disconnect-flush.js'

interface FakeCtrl {
  // #1713: disconnect-flush now routes through finalize() — single
  // terminal path for the status-reaction controller.
  finalize: (reason?: 'done' | 'error') => void
}
interface FakeStream {
  isFinal: () => boolean
  finalize: () => Promise<void>
}

function makeDeps(agentName: string | null) {
  const setDoneA = vi.fn()
  const setDoneB = vi.fn()
  const finalizeA = vi.fn(async () => {})
  const finalizeB = vi.fn(async () => {})
  const clearActiveReactions = vi.fn()
  const disposeProgressDriver = vi.fn()
  const stopTurnTypingLoops = vi.fn()
  const log = vi.fn()

  const activeStatusReactions = new Map<string, FakeCtrl>([
    ['chat1:thr1:msg1', { finalize: setDoneA }],
    ['chat2:thr2:msg2', { finalize: setDoneB }],
  ])
  const activeReactionMsgIds = new Map<string, { chatId: string; messageId: number }>([
    ['chat1:thr1:msg1', { chatId: 'chat1', messageId: 1 }],
    ['chat2:thr2:msg2', { chatId: 'chat2', messageId: 2 }],
  ])
  const activeTurnStartedAt = new Map<string, number>([
    ['chat1:thr1:msg1', 100],
    ['chat2:thr2:msg2', 200],
  ])
  const activeDraftStreams = new Map<string, FakeStream>([
    ['chat1:thr1:r1', { isFinal: () => false, finalize: finalizeA }],
    ['chat2:thr2:r2', { isFinal: () => true, finalize: finalizeB }],
  ])
  // #2669: the activeDraftParseModes map was retired with parse-mode rotation
  // (single rich-markdown path now), so the disconnect-flush deps no longer
  // carry or clear it.

  return {
    spies: { setDoneA, setDoneB, finalizeA, finalizeB, clearActiveReactions, disposeProgressDriver, stopTurnTypingLoops, log },
    deps: {
      agentName,
      activeStatusReactions,
      activeReactionMsgIds,
      activeTurnStartedAt,
      activeDraftStreams,
      clearActiveReactions,
      disposeProgressDriver,
      stopTurnTypingLoops,
      log,
    },
  }
}

describe('flushOnAgentDisconnect — anonymous clients (the regression scenario)', () => {
  it('returns false and does NOT touch any state when agentName is null', () => {
    const { spies, deps } = makeDeps(null)

    const ran = flushOnAgentDisconnect(deps)

    expect(ran).toBe(false)
    expect(spies.setDoneA).not.toHaveBeenCalled()
    expect(spies.setDoneB).not.toHaveBeenCalled()
    expect(spies.finalizeA).not.toHaveBeenCalled()
    expect(spies.finalizeB).not.toHaveBeenCalled()
    expect(spies.clearActiveReactions).not.toHaveBeenCalled()
    expect(spies.disposeProgressDriver).not.toHaveBeenCalled()

    // All maps untouched — sizes preserved.
    expect(deps.activeStatusReactions.size).toBe(2)
    expect(deps.activeReactionMsgIds.size).toBe(2)
    expect(deps.activeTurnStartedAt.size).toBe(2)
    expect(deps.activeDraftStreams.size).toBe(2)

    // But it should log so the operator can correlate the no-op decision.
    expect(spies.log).toHaveBeenCalledTimes(1)
    expect(spies.log.mock.calls[0][0]).toMatch(/anonymous client disconnect/i)
  })

  it('explicitly does not fire setDone on any controller for anonymous disconnects', () => {
    // Tighter assertion of the user-visible bug: 👍 must NOT fire while the
    // agent is producing its reply just because recall.py opened a socket.
    const { spies, deps } = makeDeps(null)
    flushOnAgentDisconnect(deps)
    expect(spies.setDoneA).toHaveBeenCalledTimes(0)
    expect(spies.setDoneB).toHaveBeenCalledTimes(0)
  })

  it('#2650: does NOT sweep the turn-typing loops for anonymous disconnects', () => {
    // An anonymous one-shot IPC client (recall.py, etc.) never owned a
    // turn-typing loop. The sweep MUST be gated by the agentName-null
    // early-return so a constant stream of anonymous disconnects can't
    // kill a live agent's typing indicator.
    const { spies, deps } = makeDeps(null)
    flushOnAgentDisconnect(deps)
    expect(spies.stopTurnTypingLoops).not.toHaveBeenCalled()
  })
})

describe('flushOnAgentDisconnect — registered agent disconnects (existing behavior preserved)', () => {
  it('returns true and flushes every status reaction for a real agent disconnect', () => {
    const { spies, deps } = makeDeps('clerk')

    const ran = flushOnAgentDisconnect(deps)

    expect(ran).toBe(true)
    expect(spies.setDoneA).toHaveBeenCalledTimes(1)
    expect(spies.setDoneB).toHaveBeenCalledTimes(1)
    expect(deps.activeStatusReactions.size).toBe(0)
    expect(deps.activeReactionMsgIds.size).toBe(0)
    expect(deps.activeTurnStartedAt.size).toBe(0)
  })

  it('disposes the progress driver and clears the on-disk reaction registry', () => {
    const { spies, deps } = makeDeps('clerk')
    flushOnAgentDisconnect(deps)
    expect(spies.disposeProgressDriver).toHaveBeenCalledTimes(1)
    expect(spies.clearActiveReactions).toHaveBeenCalledTimes(1)
  })

  it('#2650: sweeps the turn-typing loops on a real agent disconnect', () => {
    // The bridge died mid-turn — the canonical turn-end that would stop the
    // per-(chat,thread) `typing…` interval will never arrive, so the flush
    // must sweep every live loop or a stale "typing…" shows until next turn.
    const { spies, deps } = makeDeps('clerk')
    flushOnAgentDisconnect(deps)
    expect(spies.stopTurnTypingLoops).toHaveBeenCalledTimes(1)
  })

  it('finalizes only non-final draft streams and clears the maps', () => {
    const { spies, deps } = makeDeps('clerk')
    flushOnAgentDisconnect(deps)
    // Stream A was non-final → finalize called.
    expect(spies.finalizeA).toHaveBeenCalledTimes(1)
    // Stream B was already final → finalize skipped.
    expect(spies.finalizeB).not.toHaveBeenCalled()
    // Both stream maps cleared regardless.
    expect(deps.activeDraftStreams.size).toBe(0)
  })
})

describe('flushOnAgentDisconnect — dangling-turn sweep (2026-05-23 wedge fix)', () => {
  // The race that motivates this: the canonical reply path fires
  // `setDone()` on the StatusReactionController BEFORE purgeReactionTracking
  // runs `activeTurnStartedAt.delete(key)`. If the bridge crashes between
  // those two steps, the controller loop sees an EMPTY activeStatusReactions
  // (already cleared by setDone) but activeTurnStartedAt still has the key.
  // Without the sweep, that key orphans and the next inbound is "held mid-
  // turn" against a ghost.

  it('sweeps activeTurnStartedAt keys the controller loop missed', () => {
    // Construct the exact race: activeStatusReactions is EMPTY (setDone
    // already cleared it on the reply path) but activeTurnStartedAt still
    // has an entry.
    const onDanglingTurnsSwept = vi.fn()
    const clearActiveReactions = vi.fn()
    const disposeProgressDriver = vi.fn()
    const stopTurnTypingLoops = vi.fn()
    const log = vi.fn()
    const deps = {
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>([
        ['ghost:thr:msg', { chatId: 'ghost', messageId: 42 }],
      ]),
      activeTurnStartedAt: new Map<string, number>([['ghost:thr:msg', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions,
      disposeProgressDriver,
      stopTurnTypingLoops,
      onDanglingTurnsSwept,
      log,
    }

    flushOnAgentDisconnect(deps)

    // The sweep fired and cleared the dangling entry.
    expect(deps.activeTurnStartedAt.size).toBe(0)
    expect(deps.activeReactionMsgIds.size).toBe(0)
    expect(onDanglingTurnsSwept).toHaveBeenCalledTimes(1)
    expect(onDanglingTurnsSwept.mock.calls[0][0]).toEqual(['ghost:thr:msg'])
    // The log line names what happened so the operator can audit.
    expect(
      log.mock.calls.some((c: unknown[]) =>
        typeof c[0] === 'string' && /swept .* dangling turn/.test(c[0]),
      ),
    ).toBe(true)
  })

  it('does not fire the sweep when the controller loop already cleaned up everything', () => {
    // Normal-path disconnect: activeStatusReactions had entries, the
    // controller loop ran setDone + delete on each, activeTurnStartedAt
    // is already empty by the end of the loop. No dangling to sweep.
    const { spies, deps } = makeDeps('clerk')
    const onDanglingTurnsSwept = vi.fn()
    const depsWithCallback = { ...deps, onDanglingTurnsSwept }

    flushOnAgentDisconnect(depsWithCallback)

    // Controller loop already cleaned both entries.
    expect(deps.activeTurnStartedAt.size).toBe(0)
    // Callback NOT fired — nothing left to sweep after the loop.
    expect(onDanglingTurnsSwept).not.toHaveBeenCalled()
    // Regression: the existing setDone path still works.
    expect(spies.setDoneA).toHaveBeenCalledTimes(1)
    expect(spies.setDoneB).toHaveBeenCalledTimes(1)
  })

  it('does NOT sweep for anonymous disconnects (no agent registered)', () => {
    // Critical regression guard: the sweep MUST be gated by the
    // agentName-null early-return. Anonymous one-shot IPC clients
    // (recall.py, etc.) disconnect constantly and must never touch
    // turn state.
    const onDanglingTurnsSwept = vi.fn()
    const deps = {
      agentName: null,
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>(),
      activeTurnStartedAt: new Map<string, number>([['real-turn:thr:msg', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
      stopTurnTypingLoops: vi.fn(),
      onDanglingTurnsSwept,
      log: vi.fn(),
    }

    flushOnAgentDisconnect(deps)

    // Anonymous disconnect: turn state preserved, sweep callback not fired.
    expect(deps.activeTurnStartedAt.size).toBe(1)
    expect(onDanglingTurnsSwept).not.toHaveBeenCalled()
  })

  // (#2996 P1) The PR3b claudeBusyKeys orphan-sweep tests that lived here
  // were deleted with the set itself — the delivery machine's bridgeDown
  // event (emitted by the gateway alongside this flush) structurally
  // clears the turn-in-flight gate for synthetic-delivered turns that
  // died without a turn_end.

  it('omitting onDanglingTurnsSwept is safe (optional callback)', () => {
    // Backward-compat guard — existing callers that don't pass the new
    // callback still work without runtime error.
    const deps = {
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>(),
      activeTurnStartedAt: new Map<string, number>([['ghost:thr:msg', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
      stopTurnTypingLoops: vi.fn(),
      // onDanglingTurnsSwept intentionally omitted.
      log: vi.fn(),
    }

    expect(() => flushOnAgentDisconnect(deps)).not.toThrow()
    // The sweep still happens, just without the callback observation.
    expect(deps.activeTurnStartedAt.size).toBe(0)
  })
})
