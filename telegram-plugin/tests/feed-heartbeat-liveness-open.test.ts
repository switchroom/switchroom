/**
 * H-1: feedHeartbeatTick structural assertions.
 *
 * Pins load-bearing constraints of the branches inside `feedHeartbeatTick`
 * (gateway.ts):
 *
 * Post-answer branch (Fix 2 / #2587 supersede):
 *   - `turn.subagentActivityAt` is the signal (NOT `lastToolLabelAt`) that
 *     drives post-answer liveness — the watcher updates this independently of
 *     the tool_label / drop-guard path.
 *   - Idle-gap suppression: `subagentActivityAt <= finalAnswerDeliveredAt` → silent.
 *
 * Pre-answer liveness-open branch:
 *   1. The SWITCHROOM_FEED_LIVENESS_OPEN kill-switch (default ON, i.e. `!== '0'`)
 *      gates the liveness-open path — operators can disable it with =0.
 *   2. FEED_LIVENESS_OPEN_MS is parsed from env with a sane default (12 000 ms).
 *   3. The `age < FEED_LIVENESS_OPEN_MS` return-guard fires BEFORE the 0-tool
 *      feed opens — a turn that hasn't yet passed the threshold returns early.
 *
 * These are STRUCTURAL (source-read) assertions; the gateway IIFE can't be
 * instantiated in-process. Pattern matches silence-liveness-wiring.test.ts.
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

/**
 * Extract the 0-tool liveness-open branch: the section from
 * `if (turn.mirrorLines.length === 0)` to its closing `return`. This scopes
 * the FEED_LIVENESS_OPEN_ENABLED and age-guard assertions to the correct branch
 * (the post-answer Fix-2 block now precedes it and also has a drain call).
 */
function liveness0ToolBranchSrc(): string {
  const body = feedHeartbeatTickSrc()
  const start = body.indexOf('if (turn.mirrorLines.length === 0)')
  if (start === -1) return ''
  // Capture until the closing `return\n  }` of this if-block (the next blank-line-terminated return).
  const after = body.slice(start)
  // Take up to the labelled-feed heartbeat comment that follows.
  const end = after.indexOf('// Labelled-feed heartbeat')
  return end === -1 ? after : after.slice(0, end)
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

  it('age < FEED_LIVENESS_OPEN_MS return-guard exists inside the 0-tool liveness branch', () => {
    const branch = liveness0ToolBranchSrc()
    expect(branch).toMatch(/if\s*\(age\s*<\s*FEED_LIVENESS_OPEN_MS\)\s*return/)
  })

  it('FEED_LIVENESS_OPEN_ENABLED check precedes the drain call in the 0-tool liveness branch', () => {
    const branch = liveness0ToolBranchSrc()
    const enabledIdx = branch.indexOf('FEED_LIVENESS_OPEN_ENABLED')
    // Use the actual call site (assignment to activityInFlight) not the comment mention.
    const drainCallIdx = branch.indexOf('turn.activityInFlight = drainActivitySummary')
    expect(enabledIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(enabledIdx)
  })

  it('age < FEED_LIVENESS_OPEN_MS guard precedes the drain call in the 0-tool branch (early-return)', () => {
    const branch = liveness0ToolBranchSrc()
    const guardIdx = branch.indexOf('age < FEED_LIVENESS_OPEN_MS')
    // Use the actual call site (assignment to activityInFlight) not the comment mention.
    const drainCallIdx = branch.indexOf('turn.activityInFlight = drainActivitySummary')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(guardIdx)
  })
})

describe('H-2: feedHeartbeatTick post-answer background-agent liveness (Fix 2 / #2587 supersede)', () => {
  // Structural assertions pinning Fix 2: the post-answer branch reads
  // `turn.subagentActivityAt` (not `lastToolLabelAt`) and guards on
  // `subagentActivityAt <= finalAnswerDeliveredAt` for idle-gap suppression.

  it('post-answer branch reads subagentActivityAt (the watcher signal)', () => {
    const body = feedHeartbeatTickSrc()
    // The post-answer block starts with `if (turn.finalAnswerDelivered)`
    const afterPostAnswer = body.split('if (turn.finalAnswerDelivered)')[1] ?? ''
    // Extract up to the closing return of that block
    const postAnswerBlock = afterPostAnswer.split('\n  }\n')[0] ?? ''
    // subagentActivityAt must appear as a live variable (not just in a comment)
    // — verified by the `const subagentAt = turn.subagentActivityAt` assignment.
    expect(postAnswerBlock).toMatch(/const\s+subagentAt\s*=\s*turn\.subagentActivityAt/)
  })

  it('idle-gap suppression: no post-answer card when subagentActivityAt is null/before answer', () => {
    const body = feedHeartbeatTickSrc()
    const afterPostAnswer = body.split('if (turn.finalAnswerDelivered)')[1] ?? ''
    const postAnswerBlock = afterPostAnswer.split('\n  }\n')[0] ?? ''
    // Must guard: subagentAt == null || subagentAt <= answeredAt → return (silent)
    expect(postAnswerBlock).toMatch(/subagentAt\s*==\s*null\s*\|\|\s*subagentAt\s*<=\s*answeredAt/)
  })

  it('post-answer drain uses tool producer + postAnswerSubagentActivity flag', () => {
    const body = feedHeartbeatTickSrc()
    const afterPostAnswer = body.split('if (turn.finalAnswerDelivered)')[1] ?? ''
    const postAnswerBlock = afterPostAnswer.split('\n  }\n')[0] ?? ''
    // Must pass postAnswerSubagentActivity: true to drainActivitySummary
    expect(postAnswerBlock).toMatch(/postAnswerSubagentActivity:\s*true/)
    // Must use 'tool' producer for the Lever 1 exception
    expect(postAnswerBlock).toMatch(/'tool'/)
  })
})
