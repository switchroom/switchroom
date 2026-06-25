import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordOutbound,
  hasOutboundDeliveredSince,
  _resetForTests,
} from '../history.js'
import { mayOpenActivityCard } from '../gateway/feed-open-gate.js'
import { FINAL_ANSWER_MIN_CHARS } from '../final-answer-detect.js'

/**
 * PR1 — cross-turn stale-card guard (design `docs/message-emission-determinism.md`
 * §9 lever 4 / race C/D).
 *
 * Scenario this pins: a substantive answer is delivered in turn N (the original
 * obligation turn). The obligation does NOT close (its reply routing didn't
 * resolve back to the origin), so `obligationSweep` later RE-PRESENTS it as a
 * synthetic owed-reply turn N+1. That synthetic turn (and the liveness/heartbeat
 * timer firing on it) starts with a CLEARED per-turn `finalAnswerEverDelivered`
 * latch, so lever 1 alone can't see the prior answer. Lever 4 closes the gap by
 * composing, exactly as `drainActivitySummary` does, the
 * `crossTurnAnswerDelivered` flag from the SAME `hasOutboundDeliveredSince`
 * history predicate the represent guard uses — with the obligation's `openedAt`
 * as the cutoff and the SUBSTANTIVE 200-char threshold — and passing it to
 * `mayOpenActivityCard`.
 *
 * This exercises the wired composition (cutoff = obligation openedAt, threshold =
 * FINAL_ANSWER_MIN_CHARS) against a real history DB, the part the pure
 * feed-open-gate unit test cannot cover. The gateway computes the same expression
 * inline in the OPEN branch of `drainActivitySummary`.
 */

let stateDir: string

const SUBSTANTIVE = 'A'.repeat(FINAL_ANSWER_MIN_CHARS) // ≥ 200 chars → counts
const ACK = 'On it.' // < 200 chars → never counts (the #2141 carve-out)

const CHAT = '-100777'

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'cross-turn-card-gate-'))
  initHistory(stateDir, 30)
})

afterEach(() => {
  _resetForTests()
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

/**
 * Mirror the gateway's OPEN-branch computation for a synthetic represent turn:
 * `crossTurnGate.sinceMs` is the obligation's openedAt, the threshold is the
 * substantive 200-char floor. `aboutToOpen` models `activityMessageId == null`.
 */
function computeCrossTurnAnswerDelivered(opts: {
  aboutToOpen: boolean
  hasCrossTurnGate: boolean
  openedAt: number
  threadId?: number
}): boolean {
  return (
    opts.aboutToOpen
    && opts.hasCrossTurnGate
    && hasOutboundDeliveredSince(CHAT, opts.openedAt, opts.threadId, FINAL_ANSWER_MIN_CHARS)
  )
}

describe('cross-turn card gate — synthetic represent turn AFTER a substantive answer', () => {
  it('does NOT open a card when a substantive answer was delivered since the obligation was raised', () => {
    const openedAt = 1_000_000 * 1000 // ms — obligation raised
    // Turn N delivered a substantive answer 1s after the obligation was raised.
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [42],
      texts: [SUBSTANTIVE],
      ts: 1_000_001, // sec — after openedAt
    })

    // Turn N+1 is the synthetic represent turn: fresh latch, about to OPEN.
    const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: true,
      openedAt,
    })
    expect(crossTurnAnswerDelivered).toBe(true)

    // Any producer's OPEN is refused — no "thinking…" card beneath the answer.
    for (const producer of ['tool', 'liveness', 'narrative'] as const) {
      expect(
        mayOpenActivityCard({
          producer,
          finalAnswerEverDelivered: false, // the synthetic turn's own latch is clear
          labeledToolCount: producer === 'narrative' ? 0 : 1,
          crossTurnAnswerDelivered,
        }),
      ).toBe(false)
    }
  })

  it('DOES open a card when the obligation is genuinely unanswered (no reply since it was raised) — represent surface preserved', () => {
    const openedAt = 1_000_000 * 1000
    // No outbound recorded at all → genuinely unanswered.
    const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: true,
      openedAt,
    })
    expect(crossTurnAnswerDelivered).toBe(false)

    // The represent turn's card opens normally (a tool label / liveness OPEN).
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered,
      }),
    ).toBe(true)
  })

  it('does NOT regress #2141: only an ACK was delivered since the obligation was raised → card still opens', () => {
    const openedAt = 1_000_000 * 1000
    // Turn N sent only a short ack ("On it.") — NOT substantive.
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [42],
      texts: [ACK],
      ts: 1_000_001,
    })
    const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: true,
      openedAt,
    })
    // Ack is below the substantive floor → not counted → the feed still opens.
    expect(crossTurnAnswerDelivered).toBe(false)
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered,
      }),
    ).toBe(true)
  })

  it('an answer that PREDATES the obligation does not suppress (cutoff is the obligation openedAt)', () => {
    const openedAt = 1_000_002 * 1000 // ms — obligation raised AFTER the reply
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [42],
      texts: [SUBSTANTIVE],
      ts: 1_000_001, // sec — BEFORE openedAt
    })
    // The reply predates the obligation → it is not evidence THIS obligation was
    // answered → the represent surface is allowed (no false suppression).
    const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: true,
      openedAt,
    })
    expect(crossTurnAnswerDelivered).toBe(false)
  })

  it('is inert on a normal foreground turn (no cross-turn gate) even with a prior substantive answer', () => {
    const openedAt = 1_000_000 * 1000
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [42],
      texts: [SUBSTANTIVE],
      ts: 1_000_001,
    })
    // A foreground turn has NO cross-turn gate, so the gateway never computes the
    // history check (hasCrossTurnGate=false) → the flag is false → its own card
    // opens, governed only by the per-turn lever-1 latch.
    const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: false, // foreground turn: crossTurnGate undefined
      openedAt,
    })
    expect(crossTurnAnswerDelivered).toBe(false)
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered,
      }),
    ).toBe(true)
  })

  it('thread-scoped: an answer in a DIFFERENT topic does not suppress a represent in this topic', () => {
    const openedAt = 1_000_000 * 1000
    // Substantive answer landed in thread 5, but this obligation is in thread 9.
    recordOutbound({
      chat_id: CHAT,
      thread_id: 5,
      message_ids: [42],
      texts: [SUBSTANTIVE],
      ts: 1_000_001,
    })
    const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: true,
      openedAt,
      threadId: 9,
    })
    expect(crossTurnAnswerDelivered).toBe(false)
  })
})
