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
  // PR3b: claudeBusyKeys tracks turns actually handed to claude. In a
  // healthy registered-disconnect scenario both maps would carry the
  // same keys (delivery succeeded); the dangling-sweep tests below
  // override individual deps to exercise the orphaned-key path.
  const claudeBusyKeys = new Set<string>([
    'chat1:thr1:msg1',
    'chat2:thr2:msg2',
  ])
  // #2787: shadow timestamp map, kept in lockstep with claudeBusyKeys.
  const claudeBusyKeySince = new Map<string, number>([
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
    spies: { setDoneA, setDoneB, finalizeA, finalizeB, clearActiveReactions, disposeProgressDriver, log },
    deps: {
      agentName,
      activeStatusReactions,
      activeReactionMsgIds,
      activeTurnStartedAt,
      claudeBusyKeys,
      claudeBusyKeySince,
      activeDraftStreams,
      clearActiveReactions,
      disposeProgressDriver,
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
    const log = vi.fn()
    const deps = {
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>([
        ['ghost:thr:msg', { chatId: 'ghost', messageId: 42 }],
      ]),
      activeTurnStartedAt: new Map<string, number>([['ghost:thr:msg', 100]]),
      claudeBusyKeys: new Set<string>(['ghost:thr:msg']),
      claudeBusyKeySince: new Map<string, number>([['ghost:thr:msg', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions,
      disposeProgressDriver,
      onDanglingTurnsSwept,
      log,
    }

    flushOnAgentDisconnect(deps)

    // PR3b: claudeBusyKeys swept alongside the activeTurnStartedAt
    // dangling entry — both maps mirror each other on registered
    // disconnects, so a key in one is always a key in the other.
    expect(deps.claudeBusyKeys.size).toBe(0)
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
      claudeBusyKeys: new Set<string>(['real-turn:thr:msg']),
      claudeBusyKeySince: new Map<string, number>([['real-turn:thr:msg', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
      onDanglingTurnsSwept,
      log: vi.fn(),
    }

    flushOnAgentDisconnect(deps)

    // Anonymous disconnect: turn state preserved, sweep callback not fired.
    expect(deps.activeTurnStartedAt.size).toBe(1)
    expect(onDanglingTurnsSwept).not.toHaveBeenCalled()
  })

  // PR3b orphan-sweep regression: synthetic-inbound deliveries
  // (cron, reactions, vault, button-callback) bypass handleInbound's
  // fresh-turn branch and so never stamp activeTurnStartedAt. They
  // DO mark claudeBusyKeys. If their turn dies without turn_end, the
  // activeTurnStartedAt-keyed dangling sweep misses them — orphan
  // persists in claudeBusyKeys → fleet gate wedges. This test pins
  // the post-sweep claudeBusyKeys.clear() fix.
  it('sweeps claudeBusyKeys orphans that have NO activeTurnStartedAt entry (PR3b follow-up)', () => {
    const onDanglingTurnsSwept = vi.fn()
    const log = vi.fn()
    const deps = {
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>(),
      activeTurnStartedAt: new Map<string, number>(),
      // The orphan scenario: claude was handed a turn (e.g. cron
      // synthetic delivered), so claudeBusyKeys has it, but
      // activeTurnStartedAt was never set because cron bypasses
      // handleInbound's fresh-turn branch.
      claudeBusyKeys: new Set<string>(['cron-only-key:_']),
      claudeBusyKeySince: new Map<string, number>([['cron-only-key:_', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
      onDanglingTurnsSwept,
      log,
    }

    flushOnAgentDisconnect(deps)

    // The orphan is cleared even though it never had an
    // activeTurnStartedAt entry.
    expect(deps.claudeBusyKeys.size).toBe(0)
    // The activeTurnStartedAt-keyed sweep wasn't fired (nothing in
    // that map to sweep) — so onDanglingTurnsSwept shouldn't fire
    // either. The orphan sweep is a separate observation.
    expect(onDanglingTurnsSwept).not.toHaveBeenCalled()
    // But it logs the orphan-clear so operators can see it.
    expect(
      log.mock.calls.some((c: unknown[]) =>
        typeof c[0] === 'string' && /orphan claudeBusyKeys/.test(c[0]),
      ),
    ).toBe(true)
  })

  it('orphan-sweep singular vs plural log message agrees with count', () => {
    // Tiny grammar regression: "1 entry" vs "2 entries".
    const log = vi.fn()
    const baseDeps = {
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>(),
      activeTurnStartedAt: new Map<string, number>(),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
    }
    // Singular form.
    flushOnAgentDisconnect({
      ...baseDeps,
      claudeBusyKeys: new Set<string>(['k1:_']),
      claudeBusyKeySince: new Map<string, number>([['k1:_', 100]]),
      log,
    })
    expect(log.mock.calls.some((c: unknown[]) =>
      typeof c[0] === 'string' && / 1 orphan claudeBusyKeys entry /.test(c[0]),
    )).toBe(true)
    // Plural form.
    log.mockClear()
    flushOnAgentDisconnect({
      ...baseDeps,
      claudeBusyKeys: new Set<string>(['k1:_', 'k2:1']),
      claudeBusyKeySince: new Map<string, number>([['k1:_', 100], ['k2:1', 100]]),
      log,
    })
    expect(log.mock.calls.some((c: unknown[]) =>
      typeof c[0] === 'string' && / 2 orphan claudeBusyKeys entries /.test(c[0]),
    )).toBe(true)
  })

  it('does NOT fire orphan-sweep log when claudeBusyKeys is empty', () => {
    // Zero-noise discipline: every disconnect for a healthy idle
    // agent shouldn't produce a "0 orphan claudeBusyKeys" line.
    const log = vi.fn()
    flushOnAgentDisconnect({
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>(),
      activeTurnStartedAt: new Map<string, number>(),
      claudeBusyKeys: new Set<string>(),
      claudeBusyKeySince: new Map<string, number>(),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
      log,
    })
    expect(log.mock.calls.some((c: unknown[]) =>
      typeof c[0] === 'string' && /orphan claudeBusyKeys/.test(c[0]),
    )).toBe(false)
  })

  it('omitting onDanglingTurnsSwept is safe (optional callback)', () => {
    // Backward-compat guard — existing callers that don't pass the new
    // callback still work without runtime error.
    const deps = {
      agentName: 'clerk',
      activeStatusReactions: new Map<string, FakeCtrl>(),
      activeReactionMsgIds: new Map<string, { chatId: string; messageId: number }>(),
      activeTurnStartedAt: new Map<string, number>([['ghost:thr:msg', 100]]),
      claudeBusyKeys: new Set<string>(['ghost:thr:msg']),
      claudeBusyKeySince: new Map<string, number>([['ghost:thr:msg', 100]]),
      activeDraftStreams: new Map<string, FakeStream>(),
      clearActiveReactions: vi.fn(),
      disposeProgressDriver: vi.fn(),
      // onDanglingTurnsSwept intentionally omitted.
      log: vi.fn(),
    }

    expect(() => flushOnAgentDisconnect(deps)).not.toThrow()
    // The sweep still happens, just without the callback observation.
    expect(deps.activeTurnStartedAt.size).toBe(0)
  })
})
