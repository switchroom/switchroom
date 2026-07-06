/**
 * H-1: feedHeartbeatTick structural assertions.
 *
 * Pins load-bearing constraints of the branches inside `feedHeartbeatTick`
 * (gateway.ts):
 *
 * Post-answer branch (Fix 2 / #2587 supersede, concern 3 staleness cap):
 *   - `turn.subagentActivityAt` is the signal (NOT `lastToolLabelAt`) that
 *     drives post-answer liveness — the watcher updates this independently of
 *     the tool_label / drop-guard path.
 *   - The idle-gap suppression AND the staleness cap are a single pure decision
 *     `evaluatePostAnswerLiveness(...)` consulted each tick, with the cap fed
 *     from `POST_ANSWER_LIVENESS_STALE_MS`.
 *
 * Pre-answer liveness-open path (`openLivenessFeedIfDue`, the shared helper the
 * heartbeat AND the enqueue-time early-open timer both call — early-card-open
 * change):
 *   1. The SWITCHROOM_FEED_LIVENESS_OPEN kill-switch (default ON, i.e. `!== '0'`)
 *      gates the liveness-open path — operators can disable it with =0. The
 *      WHEN-gate (`shouldEarlyOpenLiveness`, feed-open-gate.ts) reads it.
 *   2. FEED_LIVENESS_OPEN_MS is parsed from env with a sane default of ~1.2 s
 *      (dropped from 12 s to kill the dead-air gap before the card opens).
 *   3. The age-vs-threshold + already-open return-guards live in the pure
 *      `shouldEarlyOpenLiveness` decision, consulted at the top of
 *      `openLivenessFeedIfDue` BEFORE the drain — a turn that hasn't passed the
 *      threshold, or one whose card is already open, returns early (no
 *      double-open).
 *   4. The 0-tool branch of `feedHeartbeatTick` OPENS via that one shared helper
 *      (so the heartbeat and the enqueue-time timer can never double-open) AND,
 *      once a card is open, CLIMBS it every tick via `silentTurnClimbRender`
 *      (deterministic-turn-liveness.md Phase 1) — the freeze this test used to
 *      enshrine is inverted. The outcome-based proof is the transport test
 *      `silent-turn-climb-transport.test.ts`.
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

/** Return the source text of `openLivenessFeedIfDue` (the shared open helper). */
function openLivenessFeedIfDueSrc(): string {
  const after = gatewaySrc.split('function openLivenessFeedIfDue(turn: CurrentTurn): void {')[1] ?? ''
  return after.split('\nfunction ')[0] ?? after
}

describe('H-1: feedHeartbeatTick liveness-open threshold', () => {
  it('SWITCHROOM_FEED_LIVENESS_OPEN kill-switch uses !== "0" semantic (default ON)', () => {
    // Must be defined as `!== '0'` so that an unset env var is truthy (default on).
    expect(gatewaySrc).toMatch(
      /FEED_LIVENESS_OPEN_ENABLED\s*=\s*process\.env\.SWITCHROOM_FEED_LIVENESS_OPEN\s*!==\s*'0'/,
    )
  })

  it('FEED_LIVENESS_OPEN_MS defaults to ~1.2 s (dropped from 12 s to kill the dead-air gap)', () => {
    // The IIFE initialiser `const FEED_LIVENESS_OPEN_MS = (() => { ... })()` must
    // contain the new fallback 1_200. Split on the const definition (not the comment).
    const afterConst = gatewaySrc.split('const FEED_LIVENESS_OPEN_MS')[1] ?? ''
    // The IIFE closes with `})()` — take everything before that.
    const initBlock = afterConst.split('})()')[0] ?? ''
    expect(initBlock).toMatch(/1[_]?200/)
  })

  it('the 0-tool liveness branch OPENS via the shared helper AND CLIMBS an already-open card', () => {
    // deterministic-turn-liveness.md Phase 1 + Phase 4(d): the prior version of
    // this test enshrined the freeze — it asserted only that the branch delegates
    // to `openLivenessFeedIfDue` (which no-ops once a card is open), which is
    // exactly why a busy-but-silent 0-label card used to freeze. The property is
    // now INVERTED: on an already-open card the branch must CLIMB on each tick.
    //
    // Structural cross-check only; the load-bearing proof is the outcome-based
    // transport test (tests/silent-turn-climb-transport.test.ts) which asserts
    // >=4 climbing edits reach the transport during a 40s silent tool.
    const body = feedHeartbeatTickSrc()
    const start = body.indexOf('if (turn.mirrorLines.length === 0)')
    expect(start).toBeGreaterThan(-1)
    const branch = body.slice(start)
    const end = branch.indexOf('// Labelled-feed heartbeat')
    const scoped = end === -1 ? branch : branch.slice(0, end)
    // OPEN path: still routed through the one shared helper (no double-open).
    expect(scoped).toMatch(/openLivenessFeedIfDue\(turn\)/)
    // CLIMB path: an already-open card is re-rendered every tick via
    // silentTurnClimbRender and edited through the drain gate — no longer a freeze.
    expect(scoped).toMatch(/silentTurnClimbRender\(/)
    expect(scoped).toMatch(/turn\.activityMessageId == null/)
    expect(scoped).toMatch(/drainActivitySummary\(turn, 'liveness'\)/)
  })

  it('the WHEN-gate (shouldEarlyOpenLiveness) precedes the drain call inside openLivenessFeedIfDue', () => {
    const body = openLivenessFeedIfDueSrc()
    const gateIdx = body.indexOf('shouldEarlyOpenLiveness(')
    // Use the actual call site (assignment to activityInFlight) not a comment mention.
    const drainCallIdx = body.indexOf('turn.activityInFlight = drainActivitySummary')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(drainCallIdx).toBeGreaterThan(gateIdx)
  })

  it('the early-open timer is scheduled at turn enqueue and torn down at turn-end', () => {
    // The enqueue-time early-open (the dead-air fix): a one-shot timer fires the
    // shared open helper at turn start, and it is cancelled at the canonical
    // turn-end so a leaked timer can never fire against a successor turn.
    expect(gatewaySrc).toMatch(/scheduleEarlyLivenessOpen\(next\)/)
    expect(gatewaySrc).toMatch(/stopEarlyLivenessOpen\(key as string\)/)
  })
})

describe('H-2: feedHeartbeatTick post-answer background-agent liveness (Fix 2 / #2587 supersede, concern 3 cap)', () => {
  // Structural assertions pinning Fix 2: the post-answer branch reads
  // `turn.subagentActivityAt` (not `lastToolLabelAt`) and routes the idle-gap +
  // staleness decision through the pure `evaluatePostAnswerLiveness` helper.

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

  it('idle-gap + staleness cap routed through evaluatePostAnswerLiveness with the stale cap', () => {
    const body = feedHeartbeatTickSrc()
    const afterPostAnswer = body.split('if (turn.finalAnswerDelivered)')[1] ?? ''
    const postAnswerBlock = afterPostAnswer.split('\n  }\n')[0] ?? ''
    // The single pure decision is consulted, fed the staleness cap, and a
    // non-'emit' verdict returns early (silent).
    expect(postAnswerBlock).toMatch(/evaluatePostAnswerLiveness\(/)
    expect(postAnswerBlock).toMatch(/staleCapMs:\s*POST_ANSWER_LIVENESS_STALE_MS/)
    expect(postAnswerBlock).toMatch(/livenessVerdict\s*!==\s*'emit'/)
  })

  it('staleness cap (concern 3) is parsed default-ON (30s) from SWITCHROOM_POST_ANSWER_LIVENESS_STALE_MS', () => {
    // The cap const must default to 30_000 when the env is unset (the `|| 30_000`
    // fallback over the positive-or-0 parse) so the post-answer card stops
    // climbing once the worker goes stale, even with no operator config.
    const afterConst = gatewaySrc.split('const POST_ANSWER_LIVENESS_STALE_MS')[1] ?? ''
    const initBlock = afterConst.split('\n')[0] + (afterConst.split('||')[1] ?? '')
    expect(afterConst).toMatch(/SWITCHROOM_POST_ANSWER_LIVENESS_STALE_MS/)
    expect(afterConst).toMatch(/\|\|\s*30[_]?000/)
    expect(initBlock).toBeTruthy()
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
