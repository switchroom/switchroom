/**
 * H-1: feedHeartbeatTick liveness-open threshold — structural assertions.
 *
 * Pins three load-bearing constraints of the "liveness-open" branch inside
 * `feedHeartbeatTick` (gateway.ts):
 *
 *   1. The SWITCHROOM_FEED_LIVENESS_OPEN kill-switch (default ON, i.e. `!== '0'`)
 *      gates the liveness-open path — operators can disable it with =0.
 *   2. FEED_LIVENESS_OPEN_MS is parsed from env with a sane default (12 000 ms).
 *   3. The `age < FEED_LIVENESS_OPEN_MS` return-guard fires BEFORE the feed opens —
 *      a turn that hasn't yet passed the threshold returns early and the liveness
 *      feed stays closed.
 *
 * These are STRUCTURAL (source-read) assertions; the gateway IIFE can't be
 * instantiated in-process.  Pattern matches silence-liveness-wiring.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

/** Return the source text of `feedHeartbeatTick` (everything up to the next top-level function). */
function feedHeartbeatTickSrc(): string {
  const after = gatewaySrc.split('function feedHeartbeatTick(): void {')[1] ?? ''
  // Stop at the next top-level function definition.
  return after.split('\nfunction ')[0] ?? after
}

describe('H-1: feedHeartbeatTick liveness-open threshold', () => {
  it('SWITCHROOM_FEED_LIVENESS_OPEN kill-switch uses !== "0" semantic (default ON)', () => {
    // Must be defined as `!== '0'` so that an unset env var is truthy (default on).
    expect(gatewaySrc).toMatch(
      /FEED_LIVENESS_OPEN_ENABLED\s*=\s*process\.env\.SWITCHROOM_FEED_LIVENESS_OPEN\s*!==\s*'0'/,
    )
  })

  it('FEED_LIVENESS_OPEN_MS defaults to 12_000 ms when env is unset', () => {
    // The IIFE initialiser `const FEED_LIVENESS_OPEN_MS = (() => { ... })()` must
    // contain the fallback 12_000. Split on the const definition (not the comment).
    const afterConst = gatewaySrc.split('const FEED_LIVENESS_OPEN_MS')[1] ?? ''
    // The IIFE closes with `})()` — take everything before that.
    const initBlock = afterConst.split('})()')[0] ?? ''
    expect(initBlock).toMatch(/12[_]?000/)
  })

  it('age < FEED_LIVENESS_OPEN_MS return-guard exists inside feedHeartbeatTick', () => {
    const body = feedHeartbeatTickSrc()
    expect(body).toMatch(/if\s*\(age\s*<\s*FEED_LIVENESS_OPEN_MS\)\s*return/)
  })

  it('FEED_LIVENESS_OPEN_ENABLED check precedes the drainActivitySummary call in feedHeartbeatTick', () => {
    const body = feedHeartbeatTickSrc()
    const enabledIdx = body.indexOf('FEED_LIVENESS_OPEN_ENABLED')
    // Use the actual call site (assignment to activityInFlight) not the comment mention.
    const drainCallIdx = body.indexOf('turn.activityInFlight = drainActivitySummary')
    expect(enabledIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(enabledIdx)
  })

  it('age < FEED_LIVENESS_OPEN_MS guard precedes the drainActivitySummary call (early-return before open)', () => {
    const body = feedHeartbeatTickSrc()
    const guardIdx = body.indexOf('age < FEED_LIVENESS_OPEN_MS')
    // Use the actual call site (assignment to activityInFlight) not the comment mention.
    const drainCallIdx = body.indexOf('turn.activityInFlight = drainActivitySummary')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(guardIdx)
  })
})
