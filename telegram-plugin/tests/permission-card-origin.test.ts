/**
 * Unit tests for the pure permission-card origin-recovery helper.
 *
 * Pins the behaviour that fixes the marko Rentals-budget incident
 * (2026-06-17): when the gateway's `currentTurn` was force-closed by the
 * orphaned-reply backstop but the claude session kept running into a
 * permission-gated tool, the card must recover its origin from the most-recent
 * still-fresh turn — so it lands in the forum topic the operator is working in
 * rather than fanning out to operator DMs where it auto-denies on the 10-min
 * TTL.
 */

import { describe, it, expect } from 'vitest'
import {
  pickRecoveredPermissionOrigin,
  type RecoverableTurn,
} from '../gateway/permission-card-origin.js'

const NOW = 1_000_000_000_000
const MAX_AGE = 30 * 60_000 // 30 min, mirrors PERMISSION_CARD_ORIGIN_MAX_AGE_MS

function turn(
  chatId: string,
  threadId: number | undefined,
  ageMs: number,
): RecoverableTurn {
  return { sessionChatId: chatId, sessionThreadId: threadId, startedAt: NOW - ageMs }
}

describe('pickRecoveredPermissionOrigin', () => {
  it('returns null for an empty registry (caller keeps the DM fan-out)', () => {
    expect(pickRecoveredPermissionOrigin([], NOW, MAX_AGE)).toBeNull()
  })

  it('recovers the supergroup chat + topic of the most-recent fresh turn', () => {
    // The marko shape: the force-closed turn was in supergroup topic 3.
    const recovered = pickRecoveredPermissionOrigin(
      [turn('-1003831053471', 3, 11 * 60_000)],
      NOW,
      MAX_AGE,
    )
    expect(recovered).toEqual({ chatId: '-1003831053471', threadId: 3 })
  })

  it('picks the most-recently-started turn when several are fresh', () => {
    const recovered = pickRecoveredPermissionOrigin(
      [
        turn('-100aaa', 1, 20 * 60_000),
        turn('-100bbb', 3, 2 * 60_000), // most recent
        turn('-100ccc', 4, 9 * 60_000),
      ],
      NOW,
      MAX_AGE,
    )
    expect(recovered).toEqual({ chatId: '-100bbb', threadId: 3 })
  })

  it('selects by startedAt, not iteration order (robust to out-of-order inserts)', () => {
    const recovered = pickRecoveredPermissionOrigin(
      [
        turn('-100recent', 1, 1 * 60_000), // freshest, but listed first
        turn('-100older', 2, 15 * 60_000),
      ],
      NOW,
      MAX_AGE,
    )
    expect(recovered).toEqual({ chatId: '-100recent', threadId: 1 })
  })

  it('ignores turns older than the freshness ceiling', () => {
    expect(
      pickRecoveredPermissionOrigin([turn('-100stale', 7, 45 * 60_000)], NOW, MAX_AGE),
    ).toBeNull()
  })

  it('recovers a DM-origin turn thread-less (threadId undefined)', () => {
    const recovered = pickRecoveredPermissionOrigin(
      [turn('8248703757', undefined, 3 * 60_000)],
      NOW,
      MAX_AGE,
    )
    expect(recovered).toEqual({ chatId: '8248703757', threadId: undefined })
  })

  it('keeps the freshest in-window turn even when stale turns are present', () => {
    const recovered = pickRecoveredPermissionOrigin(
      [
        turn('-100stale', 1, 90 * 60_000),
        turn('-100fresh', 3, 5 * 60_000),
        turn('-100ancient', 2, 600 * 60_000),
      ],
      NOW,
      MAX_AGE,
    )
    expect(recovered).toEqual({ chatId: '-100fresh', threadId: 3 })
  })
})
