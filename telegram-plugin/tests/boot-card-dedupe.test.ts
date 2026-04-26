/**
 * Unit tests for `shouldSkipDuplicateBootCard` — the helper that prevents
 * the boot path AND the bridge-reconnect path from BOTH posting a boot
 * card on a single gateway lifetime.
 *
 * Regression for the duplicate-post observed in klanker's journal at
 * 2026-04-26 11:19:47, where msgId 2245 was posted by the boot path and
 * msgId 2248 by the bridge-reconnect path within 5 seconds.
 */

import { describe, it, expect } from 'bun:test'
import { shouldSkipDuplicateBootCard } from '../gateway/boot-card.js'

describe('shouldSkipDuplicateBootCard — boot path', () => {
  it('never skips on the boot path, even when a card is already active', () => {
    // Edge case: stale activeBootCard from a previous lifetime should not
    // affect the boot path (it ran first; if anything's set, that's a bug).
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 42 } },
      'boot',
    )
    expect(decision.skip).toBe(false)
  })

  it('does not skip on the boot path with no active card', () => {
    const decision = shouldSkipDuplicateBootCard({ activeBootCard: null }, 'boot')
    expect(decision.skip).toBe(false)
  })
})

describe('shouldSkipDuplicateBootCard — bridge-reconnect path', () => {
  it('skips when the boot path already posted (active card present)', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 2245 } },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toBeDefined()
    expect(decision.reason).toContain('2245')
  })

  it('does not skip when the boot path produced no card', () => {
    // Plausible scenario: boot path skipped due to no chat_id known yet,
    // and bridge-reconnect arrives later with a chat_id from the IPC client.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(false)
  })
})

describe('shouldSkipDuplicateBootCard — reason format', () => {
  it('includes the active messageId in the reason for observability', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 9999 } },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toMatch(/msgId.*9999/)
  })

  it('omits reason when not skipping', () => {
    const decision = shouldSkipDuplicateBootCard({ activeBootCard: null }, 'boot')
    expect(decision.skip).toBe(false)
    expect(decision.reason).toBeUndefined()
  })
})
