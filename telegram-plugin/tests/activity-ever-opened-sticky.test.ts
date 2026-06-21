/**
 * M-2: `activityEverOpened` sticky-true invariant — structural assertion.
 *
 * `activityEverOpened` is set to `true` exactly once, when the activity feed
 * posts its first message (the `sendMessage` path in `drainActivitySummary`).
 * It must NEVER be reset to false or cleared — unlike `activityMessageId`, which
 * is nulled by `clearActivitySummary` to indicate that the persistent message was
 * finalized/deleted. The sticky-true invariant lets the turn-end DEGRADED check
 * (`detectStatusSurfaceDegraded`) distinguish "feed never opened" (the
 * resume-400 signature) from "feed opened + finalized".
 *
 * Load-bearing constraints:
 *   1. `activityEverOpened = true` is set exactly ONCE in gateway.ts (at the
 *      send-message success site in drainActivitySummary).
 *   2. `turn.activityEverOpened = false` NEVER appears in gateway.ts (it is only
 *      initialised to `false` in the turn-initialiser object literal, never reset
 *      via a standalone assignment).
 *
 * These are STRUCTURAL (source-read) assertions. Pattern: silence-liveness-wiring.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('M-2: activityEverOpened sticky-true invariant', () => {
  it('activityEverOpened = true appears exactly once (set at send-message success)', () => {
    const setTrueMatches = [...gatewaySrc.matchAll(/activityEverOpened\s*=\s*true/g)]
    expect(setTrueMatches).toHaveLength(1)
  })

  it('turn.activityEverOpened = false never appears (no standalone reset)', () => {
    // The only `false` value must be in the object literal initialiser
    // (e.g. `activityEverOpened: false`), never a standalone reassignment.
    const resetMatches = [...gatewaySrc.matchAll(/turn\.activityEverOpened\s*=\s*false/g)]
    expect(resetMatches).toHaveLength(0)
  })

  it('activityEverOpened is initialised false in the turn object literal (per-turn reset)', () => {
    // The object literal form `activityEverOpened: false` must exist (per-turn init).
    expect(gatewaySrc).toMatch(/activityEverOpened:\s*false/)
  })
})
