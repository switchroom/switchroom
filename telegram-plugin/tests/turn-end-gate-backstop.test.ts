/**
 * #2094 finding 1 — turn_end gate-wedge backstop.
 *
 * Outcome contract: if a pre-purge op in the turn_end handler body THROWS
 * before the canonical purge (endCurrentTurnAtomic → purgeReactionTracking)
 * runs, the guarded finally must still clear this turn's gate state
 * (activeTurnStartedAt + the mirrored claudeBusyKeys) so the #1556 inbound
 * gate re-opens for the next inbound. On the happy path — where the body
 * clears the key itself — the backstop must be a no-op (no double purge), and
 * the original error must always propagate.
 */
import { describe, it, expect } from 'vitest'
import { withTurnEndGateBackstop } from '../gateway/turn-end-gate-backstop.js'

interface Turn {
  sessionChatId: string
  sessionThreadId?: number
}

function statusKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

/** Mirror of the production gate state + a purge that clears it, as
 * purgeReactionTracking does (activeTurnStartedAt.delete + claudeBusyKeys
 * drain for the key). */
function freshGate(turn: Turn) {
  const key = statusKey(turn.sessionChatId, turn.sessionThreadId)
  const activeTurnStartedAt = new Map<string, number>([[key, Date.now()]])
  const claudeBusyKeys = new Set<string>([key])
  const purgeCalls: Array<{ key: string; endingTurn: Turn | undefined }> = []
  const purge = (k: string, endingTurn: Turn | undefined) => {
    purgeCalls.push({ key: k, endingTurn })
    activeTurnStartedAt.delete(k)
    claudeBusyKeys.delete(k)
  }
  return { key, activeTurnStartedAt, claudeBusyKeys, purge, purgeCalls }
}

function deps(gate: ReturnType<typeof freshGate>) {
  return {
    hasActiveTurn: (k: string) => gate.activeTurnStartedAt.has(k),
    purge: gate.purge,
    log: () => {},
  }
}

describe('withTurnEndGateBackstop (#2094 finding 1)', () => {
  it('a throw in a pre-purge op still clears the gate for the next inbound', () => {
    const turn: Turn = { sessionChatId: '12345' }
    const gate = freshGate(turn)

    // The body throws BEFORE it reaches endCurrentTurnAtomic → purge (models
    // a throw in redactOutboundText / progressDriver?.takeOverCard).
    expect(() =>
      withTurnEndGateBackstop(gate.key, turn, () => {
        throw new Error('redactOutboundText blew up')
      }, deps(gate)),
    ).toThrow('redactOutboundText blew up')

    // Outcome: gate is OPEN again — both maps cleared, so the #1556 inbound
    // gate no longer wedges the next inbound.
    expect(gate.activeTurnStartedAt.has(gate.key)).toBe(false)
    expect(gate.claudeBusyKeys.has(gate.key)).toBe(false)
    // The backstop fired exactly once, forwarding the ending turn.
    expect(gate.purgeCalls).toEqual([{ key: gate.key, endingTurn: turn }])
  })

  it('is a no-op on the happy path (body already purged) — no double purge', () => {
    const turn: Turn = { sessionChatId: '12345', sessionThreadId: 7 }
    const gate = freshGate(turn)

    withTurnEndGateBackstop(gate.key, turn, () => {
      // Model the canonical clean branch: endCurrentTurnAtomic → purge ran.
      gate.purge(gate.key, turn)
    }, deps(gate))

    // Purge happened exactly once (the canonical one); the finally saw the
    // key already gone and did NOT re-fire the inconsistent shadow trace.
    expect(gate.purgeCalls).toHaveLength(1)
    expect(gate.activeTurnStartedAt.has(gate.key)).toBe(false)
  })

  it('does nothing when there was no live turn (null key)', () => {
    const gate = freshGate({ sessionChatId: '12345' })
    // A different, unrelated gate state; null key means no turn to end.
    let ran = false
    withTurnEndGateBackstop(null, null, () => { ran = true }, deps(gate))
    expect(ran).toBe(true)
    expect(gate.purgeCalls).toHaveLength(0)
  })
})
