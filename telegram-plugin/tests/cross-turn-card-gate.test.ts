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
import {
  mayOpenActivityCard,
  computeCrossTurnAnswerDelivered as realComputeCrossTurnAnswerDelivered,
  computeFeedOpenVerdict,
  type FeedOpenGateView,
  type FeedOpenGateDeps,
  type FeedOpenProducer,
} from '../gateway/feed-open-gate.js'
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
 * PR-4b: drive the REAL extracted helper (`computeCrossTurnAnswerDelivered` in
 * feed-open-gate.ts) — the same pure function the gateway drain AND the
 * emission-authority façade now call — rather than a parallel local mirror.
 * Maps this test's scenario shape onto the helper's `(view, deps)` signature:
 * `aboutToOpen` ⇒ `activityMessageId == null`, `hasCrossTurnGate` ⇒ the
 * `crossTurnGate` presence, `openedAt` ⇒ `crossTurnGate.sinceMs` (the
 * obligation cutoff). Deps inject the SAME `hasOutboundDeliveredSince` predicate
 * + the substantive 200-char floor the gateway centralizes.
 */
function computeCrossTurnAnswerDelivered(opts: {
  aboutToOpen: boolean
  hasCrossTurnGate: boolean
  openedAt: number
  threadId?: number
}): boolean {
  return realComputeCrossTurnAnswerDelivered(
    {
      activityMessageId: opts.aboutToOpen ? null : 1,
      finalAnswerEverDelivered: false,
      labeledToolCount: 0,
      crossTurnGate: opts.hasCrossTurnGate ? { sinceMs: opts.openedAt } : undefined,
      sessionChatId: CHAT,
      sessionThreadId: opts.threadId,
    },
    {
      hasOutboundDeliveredSince,
      historyEnabled: true,
      finalAnswerMinChars: FINAL_ANSWER_MIN_CHARS,
    },
  )
}

/**
 * Mirror the gateway's per-turn identity (`deriveTurnId`) and the
 * `pendingCrossTurnGate` arm/consume keying. The gate is keyed on the
 * obligation's `originTurnId` — which equals `deriveTurnId(chat, thread, msgId)`
 * for the originating inbound, and which the represent inbound reconstructs
 * (it reuses the original chat/thread/messageId). The consume side looks the
 * gate up by the ENQUEUE-time turn id of whatever turn is starting, deleting
 * on read. So a turn consumes (and thus carries) the gate iff its own
 * derived turn id equals the armed obligation's `originTurnId` — which is true
 * for the matching represent turn and false for any unrelated foreground turn.
 */
function deriveTurnIdMirror(
  chatId: string,
  threadId: number | null | undefined,
  messageId: string | number | null | undefined,
): string | null {
  if (messageId == null || messageId === '' || String(messageId) === '0') return null
  return `${chatId}:${threadId ?? '_'}#${messageId}`
}

/** Arm side (`obligationSweep`): key by the obligation's originTurnId. */
function armGate(
  gate: Map<string, { sinceMs: number }>,
  originTurnId: string,
  openedAt: number,
): void {
  gate.set(originTurnId, { sinceMs: openedAt })
}

/**
 * Consume side (enqueue / turn ctor): look up + delete by the STARTING turn's
 * own derived turn id. Returns whether this turn carries a cross-turn gate.
 */
function consumeGate(
  gate: Map<string, { sinceMs: number }>,
  turnId: string,
): { sinceMs: number } | undefined {
  const hit = gate.get(turnId)
  if (hit != null) gate.delete(turnId)
  return hit
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

  it('originTurnId-keyed: an UNRELATED foreground turn does NOT consume a gate armed for another obligation — its card opens even after a substantive answer', () => {
    const openedAt = 1_000_000 * 1000 // ms — some obligation raised
    // A substantive answer landed in this chat since that obligation's openedAt.
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [42],
      texts: [SUBSTANTIVE],
      ts: 1_000_001,
    })

    const gate = new Map<string, { sinceMs: number }>()
    // obligationSweep armed the gate for obligation whose origin was message 100.
    const armedOriginTurnId = deriveTurnIdMirror(CHAT, null, 100)!
    armGate(gate, armedOriginTurnId, openedAt)

    // The MATCHING represent turn reconstructs the same id (reuses message 100)
    // → consumes the gate → carries it.
    const representTurnId = deriveTurnIdMirror(CHAT, null, 100)!
    expect(representTurnId).toBe(armedOriginTurnId)

    // But FIRST an unrelated foreground turn (different message 200, same chat)
    // enqueues. Under the old chat/thread keying its statusKey would collide with
    // the armed gate and wrongly consume it. Under originTurnId keying its derived
    // turn id differs → no entry → it carries NO gate.
    const foregroundTurnId = deriveTurnIdMirror(CHAT, null, 200)!
    expect(foregroundTurnId).not.toBe(armedOriginTurnId)
    const foregroundConsumed = consumeGate(gate, foregroundTurnId)
    expect(foregroundConsumed).toBeUndefined()

    // → the foreground turn has no cross-turn gate → its card OPENS even though a
    // ≥200-char answer landed since the OTHER obligation's openedAt (correct: that
    // answer is not evidence THIS unrelated turn was already answered).
    const fgCrossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: foregroundConsumed != null,
      openedAt,
    })
    expect(fgCrossTurnAnswerDelivered).toBe(false)
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered: fgCrossTurnAnswerDelivered,
      }),
    ).toBe(true)

    // The armed gate is still intact (the foreground turn did NOT eat it), so the
    // matching represent turn can still consume it and suppress ITS card.
    const representConsumed = consumeGate(gate, representTurnId)
    expect(representConsumed).toEqual({ sinceMs: openedAt })
    const reCrossTurnAnswerDelivered = computeCrossTurnAnswerDelivered({
      aboutToOpen: true,
      hasCrossTurnGate: representConsumed != null,
      openedAt,
    })
    expect(reCrossTurnAnswerDelivered).toBe(true)
    expect(
      mayOpenActivityCard({
        producer: 'tool',
        finalAnswerEverDelivered: false,
        labeledToolCount: 1,
        crossTurnAnswerDelivered: reCrossTurnAnswerDelivered,
      }),
    ).toBe(false)

    // Consume-once: the gate is now drained.
    expect(gate.size).toBe(0)
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

/**
 * PR-4b verdict-equivalence — the CORE flag-parity proof at the pure layer.
 *
 * `computeFeedOpenVerdict` (the function the emission-authority façade calls in
 * its enabled branch) MUST return exactly the same `mayOpen` a DIRECT
 * `mayOpenActivityCard(...)` call would — over the full cross-product of every
 * input that feeds the OPEN decision, against the REAL history DB. If these ever
 * diverge, flag-ON would emit a different card set than flag-OFF, which is the
 * one thing 4b must not do. `isOpen` must equal `activityMessageId != null`.
 */
describe('computeFeedOpenVerdict ≡ direct mayOpenActivityCard (full cross-product, real history)', () => {
  const deps: FeedOpenGateDeps = {
    hasOutboundDeliveredSince,
    historyEnabled: true,
    finalAnswerMinChars: FINAL_ANSWER_MIN_CHARS,
  }
  const OPENED_AT_MS = 1_000_000 * 1000

  // crossTurnAnswerDelivered is driven by the DB row, not a raw boolean, so we
  // seed each value: a substantive row (since openedAt) → true; no row → false.
  for (const crossTurnTrue of [false, true]) {
    for (const finalAnswerEverDelivered of [false, true]) {
      for (const producer of ['narrative', 'tool', 'liveness'] as FeedOpenProducer[]) {
        for (const labeledToolCount of [0, 1]) {
          for (const activityMessageId of [null, 123] as (number | null)[]) {
            const label =
              `crossTurn=${crossTurnTrue} final=${finalAnswerEverDelivered} ` +
              `producer=${producer} tools=${labeledToolCount} ` +
              `msgId=${activityMessageId ?? 'null'}`
            it(`matches direct mayOpenActivityCard — ${label}`, () => {
              if (crossTurnTrue) {
                // Seed a substantive answer AFTER the obligation openedAt so the
                // real predicate returns true (only meaningful when about to OPEN
                // on a gated cross-turn surface — exercised below).
                recordOutbound({
                  chat_id: CHAT,
                  thread_id: null,
                  message_ids: [42],
                  texts: [SUBSTANTIVE],
                  ts: 1_000_001,
                })
              }
              // A cross-turn surface always carries the gate; the helper's own
              // `activityMessageId == null` conjunct gates it to the OPEN case.
              const view: FeedOpenGateView = {
                activityMessageId,
                finalAnswerEverDelivered,
                labeledToolCount,
                crossTurnGate: { sinceMs: OPENED_AT_MS },
                sessionChatId: CHAT,
                sessionThreadId: null,
              }
              const verdict = computeFeedOpenVerdict(view, producer, deps)
              // Recompute the cross-turn flag the SAME way the helper does, then
              // call mayOpenActivityCard directly — the oracle.
              const crossTurnAnswerDelivered = realComputeCrossTurnAnswerDelivered(view, deps)
              const direct = mayOpenActivityCard({
                producer,
                finalAnswerEverDelivered,
                labeledToolCount,
                crossTurnAnswerDelivered,
              })
              expect(verdict.mayOpen).toBe(direct)
              expect(verdict.isOpen).toBe(activityMessageId != null)
            })
          }
        }
      }
    }
  }
})
