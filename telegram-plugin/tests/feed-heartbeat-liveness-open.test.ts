/**
 * H-1: feedHeartbeatTick liveness-open threshold — structural assertions.
 *
 * Pins the load-bearing constraints of the "liveness-open" branch AND the
 * restored post-answer background-activity branch inside `feedHeartbeatTick`
 * (gateway.ts):
 *
 *   1. The SWITCHROOM_FEED_LIVENESS_OPEN kill-switch (default ON, i.e. `!== '0'`)
 *      gates the liveness-open path — operators can disable it with =0.
 *   2. FEED_LIVENESS_OPEN_MS is parsed from env with a sane default (12 000 ms).
 *   3. The `age < FEED_LIVENESS_OPEN_MS` return-guard fires BEFORE the feed opens —
 *      a turn that hasn't yet passed the threshold returns early and the liveness
 *      feed stays closed.
 *   4. The post-answer branch gates on `lastToolLabelAt > finalAnswerDeliveredAt`
 *      (deterministic real-activity signal) before opening a card.
 *   5. The post-answer branch routes as producer 'tool' with postAnswerRealActivity
 *      so Lever 1's blanket block is correctly lifted only for real tool work.
 *   6. Idle post-answer liveness (no new tool label since answer) remains suppressed.
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

  it('FEED_LIVENESS_OPEN_ENABLED check precedes the liveness-open drainActivitySummary call in feedHeartbeatTick', () => {
    const body = feedHeartbeatTickSrc()
    const enabledIdx = body.indexOf('FEED_LIVENESS_OPEN_ENABLED')
    // Use the LIVENESS-specific call site (producer 'liveness', mirrorLines path),
    // not a generic indexOf which now finds the post-answer drain call first.
    const drainCallIdx = body.indexOf("drainActivitySummary(turn, 'liveness')")
    expect(enabledIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(enabledIdx)
  })

  it('age < FEED_LIVENESS_OPEN_MS guard precedes the liveness-open drainActivitySummary call (early-return before open)', () => {
    const body = feedHeartbeatTickSrc()
    const guardIdx = body.indexOf('age < FEED_LIVENESS_OPEN_MS')
    // Use the LIVENESS-specific call site (producer 'liveness', mirrorLines path),
    // not a generic indexOf which now finds the post-answer drain call first.
    const drainCallIdx = body.indexOf("drainActivitySummary(turn, 'liveness')")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(guardIdx)
  })
})

describe('H-2: feedHeartbeatTick post-answer real-activity branch (restore #2547 visibility)', () => {
  it('post-answer branch guards on lastToolLabelAt > finalAnswerDeliveredAt (deterministic state delta, not wall-clock)', () => {
    // The branch must use `lastToolLabelAt <= finalAnswerDeliveredAt` (or <=) as
    // the idle-suppression guard — idle thinking-gaps after the answer are
    // suppressed by checking that no new tool label has rendered since the answer.
    const body = feedHeartbeatTickSrc()
    expect(body).toMatch(/turn\.lastToolLabelAt\s*<=\s*turn\.finalAnswerDeliveredAt/)
  })

  it('post-answer drain routes as producer tool with postAnswerRealActivity:true (lifts Lever 1 for real work)', () => {
    // The drain call for post-answer work must pass producer='tool' AND
    // { postAnswerRealActivity: true } so the feed-open-gate exception is applied.
    const body = feedHeartbeatTickSrc()
    expect(body).toMatch(/drainActivitySummary\(turn,\s*'tool',\s*\{\s*postAnswerRealActivity:\s*true\s*\}/)
  })

  it('POST_ANSWER_LIVENESS_MS <= 0 returns early (operator opt-out for silent post-answer)', () => {
    // When POST_ANSWER_LIVENESS_MS is 0 (operator opted out), the post-answer
    // branch must return immediately so no card opens. This preserves the
    // operator kill-switch contract.
    const body = feedHeartbeatTickSrc()
    expect(body).toMatch(/POST_ANSWER_LIVENESS_MS\s*<=\s*0.*return/)
  })

  it('post-answer branch requires finalAnswerDeliveredAt to be non-null (prevents stale pre-answer tick)', () => {
    // The branch must check that finalAnswerDeliveredAt is non-null before
    // comparing it — guards against a race where the tick fires before the
    // latch is set.
    const body = feedHeartbeatTickSrc()
    expect(body).toMatch(/turn\.finalAnswerDeliveredAt\s*==\s*null/)
  })
})
