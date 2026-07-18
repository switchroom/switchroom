/**
 * Emission-determinism wiring — structural (source-read) assertions for the
 * deterministic activity-card OPEN gating + reply-is-last ordering changes
 * (design `docs/message-emission-determinism.md` §9 levers 1, 2, 5; #2556).
 *
 * The gateway IIFE can't be instantiated in-process, so these pin the
 * load-bearing wiring by reading gateway.ts source — same pattern as
 * activity-ever-opened-sticky.test.ts / feed-heartbeat-liveness-open.test.ts.
 * The pure decision logic (mayOpenActivityCard) is exercised behaviourally in
 * feed-open-gate.test.ts; this file guards that the gateway is wired to it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)
// #2996 P2: executeReply's body (incl. the lever-2 finalize + the latch sets)
// moved VERBATIM to outbound-send-path.ts `sendReply()`; the assertions that
// pinned that body now read it there. The wiring contract is unchanged.
const sendPathSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'outbound-send-path.ts'),
  'utf-8',
)
// #2996 P4-A: the per-turn CurrentTurn object literal (which initialises the
// sticky `finalAnswerEverDelivered: false` latch) is constructed in
// handleSessionEvent's `enqueue` branch, which moved VERBATIM to
// stream-render.ts. The init-latch assertions scan gateway.ts + that module.
const streamSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'stream-render.ts'),
  'utf-8',
)
// #2996 P4-B: the narrative/activity lane (drainActivitySummary,
// showNarrativeStep, feedHeartbeatTick, clearActivitySummary) moved VERBATIM
// into narrative-lane.ts (factory scope, bodies indented +2); gateway keeps
// thin same-name wrappers. Lane-body windows read the module source.
const laneSrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'narrative-lane.ts'),
  'utf-8',
)
const gatewayAndStreamSrc = gatewaySrc + '\n' + streamSrc + '\n' + laneSrc

/** Source of `drainActivitySummary` up to the next top-level function. */
function drainSrc(): string {
  // #2996 P4-B: reads the lane module (factory scope — next fn at 2-space indent).
  const after = laneSrc.split('async function drainActivitySummary(')[1] ?? ''
  return after.split('\n  async function ')[0]?.split('\n  function ')[0] ?? after
}

describe('sticky finalAnswerEverDelivered latch (lever 1 precondition / R0)', () => {
  it('is initialised false in the turn object literal (per-turn reset at turn start)', () => {
    expect(gatewayAndStreamSrc).toMatch(/finalAnswerEverDelivered:\s*false/)
  })

  it('is reset to false in exactly ONE place — the turn initialiser (never cleared by reopen)', () => {
    // Mirrors activityEverOpened's sticky-true contract: the only `false` is the
    // per-turn init. A standalone `= false` reassignment would let reopen clear
    // the latch and reintroduce the reorder (the R0 correction).
    const initFalse = [...gatewayAndStreamSrc.matchAll(/finalAnswerEverDelivered:\s*false/g)]
    expect(initFalse).toHaveLength(1)
    const resetFalse = [...gatewayAndStreamSrc.matchAll(/finalAnswerEverDelivered\s*=\s*false/g)]
    expect(resetFalse).toHaveLength(0)
  })

  it('feed-reopen-gate.ts resets only the MUTABLE flag, never the sticky latch (#2141 preserved)', () => {
    const reopenSrc = readFileSync(
      resolve(__dirname, '..', 'gateway', 'feed-reopen-gate.ts'),
      'utf-8',
    )
    expect(reopenSrc).toMatch(/finalAnswerDelivered:\s*false/)
    expect(reopenSrc).not.toMatch(/finalAnswerEverDelivered/)
  })

  it('every site that sets the sticky latch true gates on finalAnswerSubstantive', () => {
    // The latch is set true only at the points that set finalAnswerDelivered=true,
    // and only when the reply was substantive — so an ack never latches it.
    // #2996 P2: all three latch-set sites live in the extracted sendReply body.
    const setTrue = [...sendPathSrc.matchAll(/finalAnswerEverDelivered\s*=\s*true/g)]
    // sendReply post-send, silent-anchor merge, + the lever-2 finalize block
    // (which is itself substantive-gated).
    expect(setTrue.length).toBeGreaterThanOrEqual(3)
    // And gateway.ts has none left (the wrapper delegates).
    expect(gatewaySrc).not.toMatch(/finalAnswerEverDelivered\s*=\s*true/)
    // Each `finalAnswerEverDelivered = true` must sit in a substantive context:
    // either guarded by `if (turn.finalAnswerSubstantive)` or inside an
    // `isSubstantiveFinalReply(...)` branch. Assert the substantive-gating
    // token co-occurs (no bare unconditional latch set).
    const bareUnconditional = [
      ...sendPathSrc.matchAll(/\n\s*(?:turn|finalizeTurn)\.finalAnswerEverDelivered\s*=\s*true/g),
    ]
    for (const m of bareUnconditional) {
      const idx = m.index ?? 0
      const window = sendPathSrc.slice(Math.max(0, idx - 600), idx)
      expect(
        /finalAnswerSubstantive/.test(window) || /isSubstantiveFinalReply/.test(window),
      ).toBe(true)
    }
  })
})

describe('drainActivitySummary OPEN gate (levers 1 + 5, heartbeat-covered)', () => {
  it('consults mayOpenActivityCard in the OPEN branch (activityMessageId == null)', () => {
    const src = drainSrc()
    expect(src).toMatch(/mayOpenActivityCard\(/)
    // The gate is keyed on the sticky latch + labeledToolCount + producer.
    expect(src).toMatch(/finalAnswerEverDelivered:\s*turn\.finalAnswerEverDelivered/)
    expect(src).toMatch(/labeledToolCount:\s*turn\.labeledToolCount/)
    expect(src).toMatch(/producer/)
  })

  it('refusing an OPEN does NOT advance activityLastSentRender (break, not mark-sent)', () => {
    // The gate check must `break` out of the drain loop when an OPEN is refused,
    // BEFORE the activityLastSentRender = target write — otherwise the
    // accumulated render is marked sent and a later OPEN-eligible producer
    // (a tool label) skips it via the `pending !== lastSent` guard.
    const src = drainSrc()
    const gateIdx = src.indexOf('mayOpenActivityCard(')
    const lastSentIdx = src.indexOf('activityLastSentRender = target')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(lastSentIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(lastSentIdx)
    // A `break` follows the gate check.
    const afterGate = src.slice(gateIdx, lastSentIdx)
    expect(afterGate).toMatch(/break/)
  })

  it('the gate only applies to the OPEN branch — guarded on activityMessageId == null', () => {
    const src = drainSrc()
    const gateIdx = src.indexOf('mayOpenActivityCard(')
    const window = src.slice(Math.max(0, gateIdx - 200), gateIdx)
    expect(window).toMatch(/activityMessageId == null/)
  })
})

describe('drain producers — narrative may not OPEN, liveness + tool may', () => {
  it('showNarrativeStep drains with producer "narrative" (lever 5 base case)', () => {
    const after = laneSrc.split('function showNarrativeStep(')[1] ?? ''
    const body = after.split('\n  function ')[0] ?? after
    expect(body).toMatch(/drainActivitySummary\(turn,\s*'narrative'\)/)
  })

  it('the liveness-open path drains with producer "liveness" (producer C preserved)', () => {
    const after = laneSrc.split('function feedHeartbeatTick(')[1] ?? ''
    const body = after.split('\n  function ')[0] ?? after
    expect(body).toMatch(/drainActivitySummary\(turn,\s*'liveness'\)/)
  })

  it('the tool_label path drains with producer "tool" (always OPEN-eligible)', () => {
    expect(gatewaySrc).toMatch(/drainActivitySummary\(turn,\s*'tool'\)/)
  })
})

describe('lever 2 — finalize the card BEFORE a substantive reply send', () => {
  /** The extracted reply-orchestration body (#2996 P2): the sendReply window
   *  in outbound-send-path.ts, up to the next export. */
  function executeReplySrc(): string {
    const after = sendPathSrc.split('export async function sendReply(')[1] ?? ''
    return after.split('\nexport ')[0] ?? after
  }

  // #2996 step 1: the chunk send loop was relocated verbatim from executeReply
  // into outbound-send-path.ts's `sendReplyChunks`, invoked here as
  // `await sendReplyChunks(chunkSendDeps, …)`. This guard's INTENT — the
  // lever-2 card finalize runs BEFORE the reply send — is unchanged; the send
  // marker is now the delegation call rather than the inline `for` loop.
  const SEND_MARKER = 'sendReplyChunks('

  it('executeReply finalizes (clearActivitySummary) before the reply send, gated on substantive', () => {
    const src = executeReplySrc()
    const clearIdx = src.indexOf('clearActivitySummary(')
    const loopIdx = src.indexOf(SEND_MARKER)
    expect(clearIdx).toBeGreaterThan(-1)
    expect(loopIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeLessThan(loopIdx)
    // The finalize is substantive-gated (acks do nothing — R3/#2141).
    const window = src.slice(Math.max(0, clearIdx - 500), clearIdx)
    expect(window).toMatch(/isSubstantiveFinalReply/)
  })

  it('acks do NOT finalize early — no unconditional clearActivitySummary before the reply send', () => {
    // The lever-2 finalize site sits inside an isSubstantiveFinalReply guard.
    // An ack (non-substantive) falls through and never finalizes early, so the
    // reopen path keeps owning the card (the #2141 ack-then-work feed).
    const replySrc = executeReplySrc()
    // The pre-send clearActivitySummary must be the substantive-gated one.
    const preLoop = replySrc.split(SEND_MARKER)[0] ?? ''
    const clears = [...preLoop.matchAll(/clearActivitySummary\(/g)]
    expect(clears).toHaveLength(1)
  })
})
