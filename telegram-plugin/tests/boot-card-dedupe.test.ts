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

// ---------------------------------------------------------------------------
// In-flight race window (issue #489)
//
// Before #489, the gate only saw activeBootCard, which is only assigned
// AFTER the boot path's `await startBootCard(...)` resolved. If the agent's
// IPC client connected during that 1–2s sendMessage round-trip,
// onClientRegistered would dedupe-check, see activeBootCard = null, and
// fire its own boot card. Klanker on 2026-05-01 10:13:15 produced msgId
// 4715 + 4716 from the same gateway PID via this race. The bootCardPending
// flag is set synchronously before the await so the dedupe sees in-flight.
// ---------------------------------------------------------------------------

describe('shouldSkipDuplicateBootCard — in-flight (race window, #489)', () => {
  it('skips bridge-reconnect when boot path is still awaiting sendMessage', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null, bootCardPending: true },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toMatch(/in-flight/i)
  })

  it('skips bridge-reconnect when both pending and active are set (post-resolution overlap)', () => {
    // A bridge-reconnect can fire after activeBootCard was assigned but
    // before the finally-clears bootCardPending — both true is legal.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 4715 }, bootCardPending: true },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    // In-flight wins because it's checked first; either reason is fine
    // for observability — the card is correctly skipped either way.
    expect(decision.reason).toBeDefined()
  })

  it('does not skip boot path even when something else is in-flight', () => {
    // The boot path is the primary site — it's the only thing that should
    // ever set bootCardPending=true in the first place. Defensive check.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null, bootCardPending: true },
      'boot',
    )
    expect(decision.skip).toBe(false)
  })

  it('treats undefined bootCardPending as "not pending" for backward compat', () => {
    // Callers that pre-date the flag still pass { activeBootCard } only.
    // Their behaviour must not change.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(false)
  })
})
