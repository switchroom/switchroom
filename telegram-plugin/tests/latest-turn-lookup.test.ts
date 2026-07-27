/**
 * #3725 — the "latest-ended" supersede anchor was the most-recently-STARTED turn.
 *
 * `recentTurnsById` is populated at turn START (`rememberRecentTurn` fires from
 * the `enqueue` lifecycle event in `stream-render.ts`, and the atom is built with
 * `endedAt: null`; `endedAt` is stamped later in `turn-end.ts`). The gateway's
 * lookup had NO `endedAt` filter, so `findLatestEndedTurnForChat` returned the
 * chat's tail entry even when that turn was still RUNNING — its own docstring
 * admitted it ("the most-recently-STARTED turn") while the name and every caller
 * said otherwise. Because the registry is chat-wide and thread-agnostic, a turn
 * running in ANOTHER topic of the same chat was a live route into that state.
 *
 * These tests pin the OUTCOME of the scan (which turn comes back), not the
 * shape of the code.
 */

import { describe, it, expect } from 'vitest'
import { latestTurnForChat, type LatestTurnLookupAtom } from '../gateway/latest-turn-lookup.js'

interface Turn extends LatestTurnLookupAtom {
  turnId: string
  sessionThreadId?: number
}

const CHAT = '12345'
const OTHER_CHAT = '99999'

/** Registry insertion order = turn-START order (what `rememberRecentTurn` does). */
const registry = (...turns: Turn[]): Map<string, Turn> =>
  new Map(turns.map((t) => [t.turnId, t]))

describe('latestTurnForChat — endedOnly (#3725)', () => {
  it('does NOT return a still-running turn as the latest ENDED turn — it falls ' +
    'back to the most recent turn that actually ended', () => {
    // Topic A ended at t=1000; topic B started after and is STILL RUNNING, so it
    // sits at the registry tail. This is the exact incident shape.
    const ended = { turnId: 'A#1', sessionChatId: CHAT, endedAt: 1_000, sessionThreadId: 11 }
    const running = { turnId: 'B#2', sessionChatId: CHAT, endedAt: null, sessionThreadId: 22 }
    const turns = registry(ended, running)
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: true })).toBe(ended)
    // The routing consumer still wants the tail entry (running or not) — it only
    // picks a topic to deliver into and deletes nothing.
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: false })).toBe(running)
  })

  it('returns NULL when the chat has only a running turn — the destructive tier ' +
    'gets no anchor at all rather than an unbounded one (fail closed)', () => {
    const turns = registry({ turnId: 'B#2', sessionChatId: CHAT, endedAt: null })
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: true })).toBeNull()
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: false })).not.toBeNull()
  })

  it('picks the LAST ended turn in insertion order when several have ended', () => {
    const turns = registry(
      { turnId: 'A#1', sessionChatId: CHAT, endedAt: 1_000 },
      { turnId: 'A#2', sessionChatId: CHAT, endedAt: 2_000 },
      { turnId: 'B#3', sessionChatId: CHAT, endedAt: null },
    )
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: true })?.turnId).toBe('A#2')
  })

  it('never crosses chats (the scan is chat-scoped in BOTH modes)', () => {
    const turns = registry(
      { turnId: 'A#1', sessionChatId: CHAT, endedAt: 1_000 },
      { turnId: 'X#1', sessionChatId: OTHER_CHAT, endedAt: 2_000 },
      { turnId: 'X#2', sessionChatId: OTHER_CHAT, endedAt: null },
    )
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: true })?.turnId).toBe('A#1')
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: false })?.turnId).toBe('A#1')
    expect(latestTurnForChat(turns.values(), 'nobody', { endedOnly: false })).toBeNull()
  })

  it('an endedAt of 0 counts as ENDED (null is the only "still running" marker)', () => {
    const turns = registry({ turnId: 'A#1', sessionChatId: CHAT, endedAt: 0 })
    expect(latestTurnForChat(turns.values(), CHAT, { endedOnly: true })?.turnId).toBe('A#1')
  })
})
