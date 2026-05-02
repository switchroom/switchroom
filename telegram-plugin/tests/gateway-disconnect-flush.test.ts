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
  setDone: () => void
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
    ['chat1:thr1:msg1', { setDone: setDoneA }],
    ['chat2:thr2:msg2', { setDone: setDoneB }],
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
  const activeDraftParseModes = new Map<string, 'HTML' | 'MarkdownV2' | undefined>([
    ['chat1:thr1:r1', 'HTML'],
    ['chat2:thr2:r2', undefined],
  ])

  return {
    spies: { setDoneA, setDoneB, finalizeA, finalizeB, clearActiveReactions, disposeProgressDriver, log },
    deps: {
      agentName,
      activeStatusReactions,
      activeReactionMsgIds,
      activeTurnStartedAt,
      activeDraftStreams,
      activeDraftParseModes,
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
    expect(deps.activeDraftParseModes.size).toBe(2)

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
    expect(deps.activeDraftParseModes.size).toBe(0)
  })
})
