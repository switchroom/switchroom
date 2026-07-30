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
 *   1. `activityEverOpened = true` is set only at legitimate feed-OPEN signal
 *      sites — the send-message success site in drainActivitySummary, the
 *      sub-agent-handback pre-turn ADOPTION site (#3268), AND the queued-card
 *      ADOPTION site (#3927 Part B). The two adoption sites are the same shape:
 *      an adopted turn inherits an ALREADY-OPEN, user-visible card via a seeded
 *      `activityMessageId`, so it only ever EDITs the feed (never hits the open
 *      branch), and must stamp the flag itself so the turn-end DEGRADED check
 *      doesn't false-flag it as "feed never opened". A parked message's "⏳
 *      Queued" card is a real message the user already sees before the turn
 *      mints, so adopting it on dequeue IS a feed-open — same rationale as the
 *      handback adoption. All three are set-TRUE (never a reset), preserving the
 *      sticky-true invariant.
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
// #2996 P4-A: one sticky-latch set site + the per-turn object-literal init live
// in handleSessionEvent (the tool-label/answer send-success + the `enqueue`
// turn ctor), which moved VERBATIM to stream-render.ts. The population spans
// gateway.ts + that module.
const streamSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'stream-render.ts'),
  'utf-8',
)
// #2996 P4-B: the drain-side set-TRUE site (drainActivitySummary) moved on
// into narrative-lane.ts.
const laneSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'narrative-lane.ts'),
  'utf-8',
)
const gatewayAndStreamSrc = gatewaySrc + '\n' + streamSrc + '\n' + laneSrc

describe('M-2: activityEverOpened sticky-true invariant', () => {
  it('activityEverOpened = true appears only at the three feed-OPEN signal sites', () => {
    // Site 1: drainActivitySummary send-message success. Site 2: the #3268
    // handback pre-turn ADOPTION seed. Site 3: the #3927 Part B queued-card
    // ADOPTION seed (stream-render.ts) — a parked message's "⏳ Queued" card is
    // an already-open, user-visible card the dequeued turn adopts and only
    // EDITs, so it stamps the flag itself, exactly like the handback adoption.
    // All three are set-TRUE; the sticky invariant (no reset to false) is
    // enforced by the next test.
    const setTrueMatches = [...gatewayAndStreamSrc.matchAll(/activityEverOpened\s*=\s*true/g)]
    expect(setTrueMatches).toHaveLength(3)
  })

  it('turn.activityEverOpened = false never appears (no standalone reset)', () => {
    // The only `false` value must be in the object literal initialiser
    // (e.g. `activityEverOpened: false`), never a standalone reassignment.
    const resetMatches = [...gatewayAndStreamSrc.matchAll(/turn\.activityEverOpened\s*=\s*false/g)]
    expect(resetMatches).toHaveLength(0)
  })

  it('activityEverOpened is initialised false in the turn object literal (per-turn reset)', () => {
    // The object literal form `activityEverOpened: false` must exist (per-turn init).
    expect(gatewayAndStreamSrc).toMatch(/activityEverOpened:\s*false/)
  })
})
