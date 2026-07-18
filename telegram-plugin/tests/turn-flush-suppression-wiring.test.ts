/**
 * S1/S2/S4 WIRING (fable red-team 2026-07-17, fixed in #3299 @ a6e09dfb).
 *
 * The behavioural suite `turn-flush-suppression.test.ts` proves the scoped
 * suppression predicate in isolation, and `answer-ready-flush.test.ts` proves
 * the quiescence controller's reset/re-arm semantics — but neither says
 * whether the GATEWAY actually calls them, or what it does with the answer.
 * That decision-vs-delivery gap is exactly how the original S1 bug shipped:
 * every routine was individually correct while the gateway's call site
 * counted ANY chat-wide outbound and then CLOSED the obligation, silently
 * dropping the user's real answer.
 *
 * gateway.ts is a side-effecting IIFE that cannot be imported in a unit test
 * (same constraint as activity-card-wiring.test.ts /
 * silence-liveness-wiring.test.ts), so these are STRUCTURAL assertions that
 * pin the load-bearing call sites. They COMPLEMENT the behavioural suites —
 * the outcomes are proven at routine level; this guards the wiring those
 * routines depend on. Each test names the regression it would catch.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')
// #2996 P4-A: the turn-flush / turn_end / `thinking`-arm code moved VERBATIM
// into stream-render.ts with handleSessionEvent. Windows that used to live in
// the gateway switch are grepped from the extracted module now.
const streamSrc = readFileSync(resolve(__dirname, '..', 'gateway', 'stream-render.ts'), 'utf-8')
const gatewayAndStreamSrc = gatewaySrc + '\n' + streamSrc

function between(src: string, startMarker: string, endMarker: string): string {
  const after = src.split(startMarker)[1] ?? ''
  return after.split(endMarker)[0] ?? ''
}

/** Strip // comment lines so prose quoting the OLD (buggy) shape can't
 *  satisfy — or trip — an assertion about the CODE. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
}

describe('S1 wiring — turn-flush suppression call site', () => {
  // The whole suppression branch: predicate call through the end of the
  // `if (suppress)` early-return.
  const branch = between(
    streamSrc,
    'const { shouldSuppressTurnFlush }',
    '// #3276 guard 5',
  )

  it('the gateway asks the SCOPED predicate, not a chat-wide outbound count', () => {
    expect(branch.length).toBeGreaterThan(100)
    const code = codeOnly(branch)
    // The oracle is the thread/length-scoped history query…
    expect(code).toMatch(/hasSubstantiveOutbound:\s*hasOutboundDeliveredSince/)
    // …with an EXPLICIT null thread for chat-root turns (undefined would
    // match rows in ANY topic and re-open the cross-topic false positive)…
    expect(code).toMatch(/threadId:\s*backstopThreadId\s*\?\?\s*null/)
    // …and the captured answer's length driving the substantive floor.
    expect(code).toMatch(/answerLength:\s*capturedText\.length/)
    // The OLD chat-wide predicate must never come back anywhere in the branch.
    expect(code).not.toMatch(/getRecentOutboundCount/)
  })

  it('suppression leaves the obligation OPEN (noteTurnEnded) — never closes it', () => {
    const code = codeOnly(branch)
    // A false-positive suppression must stay recoverable: the sweep/liveness
    // floor arbitrates. Closing here made the drop PERMANENT (the S1 bug).
    expect(code).toMatch(/obligationLedger\.noteTurnEnded\(turn\.turnId/)
    expect(code).not.toMatch(/obligationLedger\.close\(/)
  })

  it('the old predicate is gone from the whole gateway turn-flush path', () => {
    // getRecentOutboundCount must not be consulted anywhere in gateway.ts —
    // any reintroduction re-opens the chat-wide suppression class.
    expect(codeOnly(gatewayAndStreamSrc)).not.toMatch(/getRecentOutboundCount/)
  })
})

describe('S2 wiring — thinking events re-arm the answer-ready quiescence flush', () => {
  it("the 'thinking' event arm calls resetAnswerReadyFlushTimeout()", () => {
    // Without this, "prose → >1s thinking pause → trailing NO_REPLY" lets the
    // quiescence timer fire mid-pause and deliver a turn the model intended
    // silent. Scope to the thinking case arm only.
    const arm = between(streamSrc, "case 'thinking': {", "case 'tool_use': {")
    expect(arm.length).toBeGreaterThan(50)
    expect(codeOnly(arm)).toMatch(/resetAnswerReadyFlushTimeout\(\)/)
  })
})

describe('S4 wiring — flushed answers quote-anchor to the inbound they answer', () => {
  it('deliverAnswer anchors the FIRST chunk with reply_parameters + allow_sending_without_reply', () => {
    const sendChunk = between(
      gatewaySrc,
      'const sendChunk = async (chunkIndex: number',
      'buildSendOpts:',
    )
    expect(sendChunk.length).toBeGreaterThan(50)
    const code = codeOnly(sendChunk)
    // First chunk only, and only when the turn has an inbound to anchor to.
    expect(code).toMatch(/chunkIndex === 0 && args\.replyToMessageId != null/)
    // allow_sending_without_reply keeps the send alive if the user deleted
    // their message — without it the whole flush would fail on a dangling id.
    expect(code).toMatch(/allow_sending_without_reply:\s*true/)
    expect(code).toMatch(/reply_parameters/)
  })

  it('the turn-flush call site passes the turn’s inbound id (bare for synthesized turns)', () => {
    // The anchor must be the message this TURN answers — turn.sourceMessageId
    // is null for cron/handback turns, which therefore still send bare.
    expect(codeOnly(gatewayAndStreamSrc)).toMatch(/replyToMessageId:\s*turn\.sourceMessageId/)
  })
})
