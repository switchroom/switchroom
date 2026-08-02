/**
 * PR A — answer-ready quiescence flush (late-delivery fix).
 *
 * The gateway delivers a toolless terminal-text answer either on claude's
 * (unreliable) `turn_duration`/turn_end, or — when that never lands — on the
 * orphaned-reply backstop, which the answer text itself keeps re-arming across
 * a ~150 s window. PR A adds a DETERMINISTIC ~1 s quiescence flush.
 *
 * Two layers of coverage:
 *   1. The pure predicate `shouldArmAnswerReadyFlush` (which calls the REAL
 *      `decideTurnFlush` classifier + a REAL `ToolFlightTracker`).
 *   2. An INTEGRATION harness that drives the REAL orchestration —
 *      `AnswerReadyFlushController` (the exact arm / debounce / rollover-guard /
 *      fire-time-re-verify / disarm code the gateway runs, extracted so it is
 *      testable, mirroring how `turn-end-gate-backstop.test.ts` drives the real
 *      `withTurnEndGateBackstop`). The harness supplies a faithful gateway world
 *      (a mutable `currentTurn`, a real `ToolFlightTracker`, and an
 *      `endCurrentTurnAtomic` that — like the real one — disarms via
 *      `controller.clear(turn)` and NULLS the atom) plus a send-sink that models
 *      `handleSessionEvent({turn_end})` short-circuiting on a null atom.
 *
 * The oracle asserts OUTCOMES on real code: the flush fires at the ~1 s debounce
 * (not ~150 s), re-arms per text chunk, and delivers EXACTLY ONCE across both
 * turn_end race orderings. It is designed to go RED if the controller's
 * rollover guard, fire-time re-verify, or disarm were removed (see the
 * red-when-removed proofs in the handback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  shouldArmAnswerReadyFlush,
  resolveAnswerReadyFlushMs,
  resolveAnswerStageMs,
  ANSWER_READY_FLUSH_MS,
  ANSWER_STAGE_MS,
  AnswerReadyFlushController,
  type AnswerReadyArmInput,
  type FlushTimerHandle,
} from '../answer-ready-flush.js'
import { decideTurnFlush } from '../turn-flush-safety.js'
import { ToolFlightTracker } from '../gateway/interrupt-defer.js'

const CHAT = '12345'
const WINDOW = 1000
// The orphaned-reply backstop's real dead-wait ceiling — the wall-clock the
// flush must beat. Used to prove the flush fires ~1 s, not ~150 s.
const BACKSTOP_MS = 150_000

function armInput(over: Partial<AnswerReadyArmInput> = {}): AnswerReadyArmInput {
  return {
    flush: {
      chatId: CHAT,
      replyCalled: false,
      capturedText: ['Here is the composed final answer to your question.'],
      flushEnabled: true,
    },
    inFlightToolCount: 0,
    hasPendingAsyncDispatch: false,
    flushWindowMs: WINDOW,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Pure predicate: shouldArmAnswerReadyFlush (real decideTurnFlush classifier)
// ---------------------------------------------------------------------------

describe('shouldArmAnswerReadyFlush (arm/fire predicate)', () => {
  it('arms on a genuine composed terminal answer that is quiescent', () => {
    expect(shouldArmAnswerReadyFlush(armInput())).toBe(true)
  })

  it('does NOT arm while a tool is in flight (not quiescent)', () => {
    expect(shouldArmAnswerReadyFlush(armInput({ inFlightToolCount: 1 }))).toBe(false)
  })

  it('does NOT arm while a background/async dispatch is pending', () => {
    expect(shouldArmAnswerReadyFlush(armInput({ hasPendingAsyncDispatch: true }))).toBe(false)
  })

  it('does NOT arm once the reply tool has served the turn (reply-called)', () => {
    expect(
      shouldArmAnswerReadyFlush(armInput({ flush: { chatId: CHAT, replyCalled: true, capturedText: ['x'], flushEnabled: true } })),
    ).toBe(false)
  })

  it('does NOT arm on a genuine NO_REPLY turn (silent marker → no spurious flush)', () => {
    expect(
      shouldArmAnswerReadyFlush(armInput({ flush: { chatId: CHAT, replyCalled: false, capturedText: ['NO_REPLY'], flushEnabled: true } })),
    ).toBe(false)
  })

  it('does NOT arm on an empty terminal turn (nothing to send)', () => {
    expect(
      shouldArmAnswerReadyFlush(armInput({ flush: { chatId: CHAT, replyCalled: false, capturedText: [], flushEnabled: true } })),
    ).toBe(false)
  })

  it('does NOT arm on prose that ends with a trailing silent marker', () => {
    expect(
      shouldArmAnswerReadyFlush(
        armInput({ flush: { chatId: CHAT, replyCalled: false, capturedText: ['Some prose the model wrote.', 'NO_REPLY'], flushEnabled: true } }),
      ),
    ).toBe(false)
  })

  it('does NOT arm for a system/sub-agent turn (no inbound chat)', () => {
    expect(
      shouldArmAnswerReadyFlush(armInput({ flush: { chatId: null, replyCalled: false, capturedText: ['answer'], flushEnabled: true } })),
    ).toBe(false)
  })

  it('does NOT arm when the kill-switch disables the flush (window <= 0)', () => {
    expect(shouldArmAnswerReadyFlush(armInput({ flushWindowMs: 0 }))).toBe(false)
    expect(shouldArmAnswerReadyFlush(armInput({ flushWindowMs: -1 }))).toBe(false)
  })

  it('does NOT arm when the turn-flush safety flag is off', () => {
    expect(
      shouldArmAnswerReadyFlush(armInput({ flush: { chatId: CHAT, replyCalled: false, capturedText: ['answer'], flushEnabled: false } })),
    ).toBe(false)
  })
})

describe('resolveAnswerReadyFlushMs', () => {
  it('defaults to ANSWER_READY_FLUSH_MS when unset', () => {
    expect(resolveAnswerReadyFlushMs({})).toBe(ANSWER_READY_FLUSH_MS)
    expect(resolveAnswerReadyFlushMs({ SWITCHROOM_ANSWER_READY_FLUSH_MS: '' })).toBe(ANSWER_READY_FLUSH_MS)
  })

  it('parses a positive override', () => {
    expect(resolveAnswerReadyFlushMs({ SWITCHROOM_ANSWER_READY_FLUSH_MS: '1500' })).toBe(1500)
  })

  it('treats 0 (and negatives) as the kill-switch → disabled (0)', () => {
    expect(resolveAnswerReadyFlushMs({ SWITCHROOM_ANSWER_READY_FLUSH_MS: '0' })).toBe(0)
    expect(resolveAnswerReadyFlushMs({ SWITCHROOM_ANSWER_READY_FLUSH_MS: '-5' })).toBe(0)
  })

  it('fails safe to the default on an unparseable value', () => {
    expect(resolveAnswerReadyFlushMs({ SWITCHROOM_ANSWER_READY_FLUSH_MS: 'nonsense' })).toBe(ANSWER_READY_FLUSH_MS)
  })

  it('ANSWER_READY_FLUSH_MS is ~1 s ("immediate")', () => {
    expect(ANSWER_READY_FLUSH_MS).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// Integration harness — drives the REAL AnswerReadyFlushController. Only the
// gateway world (currentTurn storage, the send sink, endCurrentTurnAtomic) is
// modeled; the arm / debounce / rollover-guard / fire-time-re-verify / disarm
// is the controller's REAL code. Mirrors turn-end-gate-backstop.test.ts driving
// the real withTurnEndGateBackstop.
// ---------------------------------------------------------------------------

interface FakeTurn {
  capturedText: string[]
  replyCalled: boolean
  answerReadyFlushTimeoutId: FlushTimerHandle | null
}

/**
 * A faithful gateway world around the REAL controller. `sends` / `records`
 * count what actually reached the user / turns.jsonl. `endCurrentTurnAtomic`
 * mirrors the real one: it DISARMS via `controller.clear(turn)` and NULLS the
 * atom. `dispatchTurnEnd` mirrors `handleSessionEvent({turn_end})`: it
 * short-circuits when the atom is already gone (the exactly-once guarantee),
 * else delivers once and runs `endCurrentTurnAtomic`.
 */
class GatewayWorld {
  currentTurn: FakeTurn | null
  flight = new ToolFlightTracker()
  pendingAsync = false
  sends = 0
  records = 0
  window = WINDOW
  readonly controller: AnswerReadyFlushController<FakeTurn>

  constructor(stageMs = 0) {
    this.currentTurn = { capturedText: [], replyCalled: false, answerReadyFlushTimeoutId: null }
    this.controller = new AnswerReadyFlushController<FakeTurn>({
      stageWindowMs: stageMs,
      getCurrentTurn: () => this.currentTurn,
      getArmInput: (turn) => ({
        flush: { chatId: CHAT, replyCalled: turn.replyCalled, capturedText: turn.capturedText, flushEnabled: true },
        inFlightToolCount: this.flight.inFlightCount(),
        hasPendingAsyncDispatch: this.pendingAsync,
        flushWindowMs: this.window,
      }),
      getTimerHandle: (turn) => turn.answerReadyFlushTimeoutId,
      setTimerHandle: (turn, handle) => {
        turn.answerReadyFlushTimeoutId = handle
      },
      // The controller's single delivery action routes into the world's
      // turn_end dispatch — exactly as the gateway's onFlush dispatches a
      // synthetic turn_end into handleSessionEvent.
      onFlush: () => this.dispatchTurnEnd(),
    })
  }

  /** = endCurrentTurnAtomic: DISARM (real controller.clear) + NULL the atom. */
  private endCurrentTurnAtomic(turn: FakeTurn): void {
    this.controller.clear(turn) // ← the load-bearing disarm (gateway.ts:~4818)
    this.records++
    this.currentTurn = null // ← the load-bearing atom-null (#1067)
  }

  /** = handleSessionEvent({turn_end}). A null atom short-circuits (no second
   *  send); otherwise the turn-flush branch runs the REAL `decideTurnFlush`
   *  classifier (exactly as stream-render does at turn_end): a reply-served
   *  turn tears down without a flush send; a captured-answer turn delivers
   *  once. Then tear the turn down. */
  dispatchTurnEnd(): void {
    const turn = this.currentTurn
    if (turn == null) return // atom already gone → exactly-once
    const d = decideTurnFlush({
      chatId: CHAT,
      replyCalled: turn.replyCalled,
      capturedText: turn.capturedText,
      flushEnabled: true,
    })
    if (d.kind === 'flush') this.sends++
    this.endCurrentTurnAtomic(turn)
  }

  /** = the model's `reply` tool call landing on the live turn: the canonical
   *  answer message is sent on the normal reply path and the turn is marked
   *  reply-served (turn teardown waits for the real turn_end). */
  onReply(): void {
    if (this.currentTurn == null) return
    this.currentTurn.replyCalled = true
    this.sends++ // the ONE canonical user-visible message
  }

  /** = case 'text': push the chunk, then (re)arm via the REAL controller. */
  onText(chunk: string): void {
    if (this.currentTurn != null) this.currentTurn.capturedText.push(chunk)
    this.controller.reset()
  }

  /** = case 'tool_use' / 'tool_label': disarm (real controller.clear) then track. */
  onToolUse(id: string): void {
    this.controller.clear(this.currentTurn)
    this.flight.onEvent({ kind: 'tool_use', toolUseId: id })
  }

  onToolResult(id: string): void {
    this.flight.onEvent({ kind: 'tool_result', toolUseId: id })
  }
}

describe('answer-ready quiescence flush — real controller integration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes the composed answer at the ~1 s debounce, NOT at the ~150 s backstop', () => {
    const w = new GatewayWorld()
    w.onText('The composed final answer.')
    // Nothing before the debounce elapses.
    vi.advanceTimersByTime(WINDOW - 1)
    expect(w.sends).toBe(0)
    // Fires deterministically at the debounce.
    vi.advanceTimersByTime(1)
    expect(w.sends).toBe(1)
    expect(w.records).toBe(1) // exactly one turns.jsonl record
    // And it did NOT wait for the multi-minute backstop.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(1) // still exactly one — proves it beat ~150 s
  })

  it('each text chunk re-arms the debounce (only fires 1 s after the LAST chunk)', () => {
    const w = new GatewayWorld()
    w.onText('Part one. ')
    vi.advanceTimersByTime(500)
    expect(w.sends).toBe(0)
    w.onText('Part two — the rest of the answer.') // re-arms
    vi.advanceTimersByTime(999)
    expect(w.sends).toBe(0) // debounce reset by the 2nd chunk
    vi.advanceTimersByTime(1)
    expect(w.sends).toBe(1)
  })

  it('EXACTLY-ONCE (a): quiescence flush, THEN a real turn_end → still one send', () => {
    const w = new GatewayWorld()
    w.onText('Answer text.')
    vi.advanceTimersByTime(WINDOW)
    expect(w.sends).toBe(1) // quiescence flushed + nulled the atom
    // The real turn_end finally lands — it must short-circuit on the null atom.
    // (Goes red if the atom-null in endCurrentTurnAtomic were removed.)
    w.dispatchTurnEnd()
    expect(w.sends).toBe(1)
    expect(w.records).toBe(1)
  })

  it('EXACTLY-ONCE (b): a real turn_end BEFORE the debounce disarms the pending flush', () => {
    const w = new GatewayWorld()
    w.onText('Answer text.')
    vi.advanceTimersByTime(WINDOW - 100)
    // turn_end arrives first → delivers once and (via controller.clear in
    // endCurrentTurnAtomic) cancels the pending flush timer.
    // (Goes red if controller.clear no longer cleared the timer.)
    w.dispatchTurnEnd()
    expect(w.sends).toBe(1)
    expect(vi.getTimerCount()).toBe(0) // the pending quiescence timer was cleared
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(1) // the stale timer never fired a second send
    expect(w.records).toBe(1)
  })

  it('does NOT flush while a tool call is in flight (only on genuine quiescence)', () => {
    const w = new GatewayWorld()
    w.onText('Interim thought before a tool.')
    // A tool starts within the window → disarm.
    vi.advanceTimersByTime(400)
    w.onToolUse('bash_1')
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(0) // never fired while (and after) the tool was open
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arms and flushes once the tool completes and new answer text settles', () => {
    const w = new GatewayWorld()
    w.onText('Working on it.')
    w.onToolUse('bash_1') // disarm
    vi.advanceTimersByTime(2000)
    expect(w.sends).toBe(0)
    w.onToolResult('bash_1') // tool done → quiescent again
    w.onText(' Here is the final composed answer.') // new text re-arms
    vi.advanceTimersByTime(WINDOW)
    expect(w.sends).toBe(1)
  })

  it('fire-time re-verify: a tool in flight at expiry cancels the flush even if disarm was missed', () => {
    const w = new GatewayWorld()
    w.onText('Answer text.')
    // Simulate a missed explicit disarm: a tool becomes in-flight directly,
    // WITHOUT going through onToolUse (which would clear the timer).
    w.flight.onEvent({ kind: 'tool_use', toolUseId: 'sneaky' })
    vi.advanceTimersByTime(WINDOW)
    // (Goes red if the controller's fire-time re-verification were removed.)
    expect(w.sends).toBe(0)
  })

  it('rollover guard: a superseded turn does not fire against a fresh atom', () => {
    const w = new GatewayWorld()
    const armed = w.currentTurn!
    w.onText('Answer for turn A.') // arms A's timer
    // A new turn swaps in before the debounce (turn rollover).
    w.currentTurn = { capturedText: ['Turn B is still working'], replyCalled: false, answerReadyFlushTimeoutId: null }
    expect(w.currentTurn).not.toBe(armed)
    vi.advanceTimersByTime(WINDOW)
    // (Goes red if the controller's rollover guard `live !== armedTurn` were removed.)
    expect(w.sends).toBe(0)
  })

  it('a NO_REPLY turn never arms, so it flushes nothing (records no_reply upstream)', () => {
    const w = new GatewayWorld()
    w.onText('NO_REPLY')
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Stage-don't-send (2026-08-02 live repro — klanker DM, msgs 25843/25844).
// The quiescence flush posted the composed answer at 00:22:02Z; the model's
// `reply` tool call landed 4 s later (delivered 00:22:36Z as msg 25844, a
// REWORDING — not containment-equal) while a background sub-agent was live, so
// the #4176 content-gate hold shipped it FRESH: two near-identical messages.
// With staging, the quiescence expiry HOLDS the answer on the live turn and
// only promotes when the completion window closes with no reply — the
// provisional send (and everything downstream that had to claw it back) never
// happens. These timelines assert OUTCOMES: user-visible messages sent.
// ---------------------------------------------------------------------------

const STAGE = 30_000

describe('answer-ready stage-don\'t-send — completion-window staging', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('LIVE REPRO (msgs 25843/25844): a reply landing inside the stage window → exactly ONE message', () => {
    const w = new GatewayWorld(STAGE)
    // 00:21:30–00:22:00 — the model streams its terminal narration.
    w.onText('Yes, that one\'s done, not pending. …the composed terminal answer…')
    // 00:22:01 — quiescence fires. Pre-fix this SENT msg 25843; staged, it must
    // send NOTHING (the turn stays live — typing hold — awaiting completion).
    vi.advanceTimersByTime(WINDOW)
    expect(w.sends).toBe(0) // ← RED on the immediate-flush behaviour
    expect(w.currentTurn).not.toBeNull() // turn NOT ended by a provisional flush
    // 00:22:06 — the model's `reply` lands (the reworded canonical answer).
    vi.advanceTimersByTime(5_000)
    w.onReply()
    expect(w.sends).toBe(1) // the one canonical message (msg 25844)
    // The stage promotion timer expires → fire-time re-verify sees replyCalled
    // and DISCARDS the staged text. No second message, ever.
    vi.advanceTimersByTime(STAGE)
    expect(w.sends).toBe(1)
    // The real turn_end finally lands: reply-served → teardown, no flush.
    w.dispatchTurnEnd()
    expect(w.sends).toBe(1)
    expect(w.records).toBe(1)
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('promotes the staged answer when the completion window closes with NO reply (delivery preserved)', () => {
    const w = new GatewayWorld(STAGE)
    w.onText('The composed final answer.')
    vi.advanceTimersByTime(WINDOW)
    expect(w.sends).toBe(0) // staged, not sent
    // No reply, no real turn_end (the KNOWN-UNRELIABLE turn_end case PR A was
    // built for): the stage window closes → promote through the same flush path.
    vi.advanceTimersByTime(STAGE - 1)
    expect(w.sends).toBe(0)
    vi.advanceTimersByTime(1)
    expect(w.sends).toBe(1)
    expect(w.records).toBe(1)
    // Exactly once: a late real turn_end short-circuits on the null atom.
    w.dispatchTurnEnd()
    expect(w.sends).toBe(1)
  })

  it('a REAL turn_end during the stage window delivers via the turn-flush branch — no double-send', () => {
    const w = new GatewayWorld(STAGE)
    w.onText('The composed final answer.')
    vi.advanceTimersByTime(WINDOW) // staged
    expect(w.sends).toBe(0)
    vi.advanceTimersByTime(5_000)
    w.dispatchTurnEnd() // the true completion signal lands first
    expect(w.sends).toBe(1) // delivered by the turn-flush branch at turn_end
    // endCurrentTurnAtomic's clear() cancelled the pending promotion timer.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(1)
  })

  it('new text during the stage window re-stages (model still composing) and promotes once', () => {
    const w = new GatewayWorld(STAGE)
    w.onText('First part of the answer. ')
    vi.advanceTimersByTime(WINDOW) // staged
    expect(w.sends).toBe(0)
    vi.advanceTimersByTime(10_000)
    w.onText('Second part — the model was still composing.') // re-arms the debounce
    vi.advanceTimersByTime(WINDOW) // re-staged with a fresh window
    expect(w.sends).toBe(0)
    vi.advanceTimersByTime(STAGE)
    expect(w.sends).toBe(1) // promoted exactly once, with the full text captured
  })

  it('a tool starting during the stage window discards the stage (model resumed work)', () => {
    const w = new GatewayWorld(STAGE)
    w.onText('Interim narration that looked terminal.')
    vi.advanceTimersByTime(WINDOW) // staged
    w.onToolUse('bash_1') // clear() → unstaged + promotion timer cancelled
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(w.sends).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stageMs=0 keeps the legacy immediate flush at quiescence', () => {
    const w = new GatewayWorld(0)
    w.onText('The composed final answer.')
    vi.advanceTimersByTime(WINDOW)
    expect(w.sends).toBe(1) // legacy: delivered at the ~1 s debounce
  })
})

describe('resolveAnswerStageMs', () => {
  it('defaults to ANSWER_STAGE_MS when unset', () => {
    expect(resolveAnswerStageMs({})).toBe(ANSWER_STAGE_MS)
  })
  it('parses a positive override', () => {
    expect(resolveAnswerStageMs({ SWITCHROOM_ANSWER_STAGE_MS: '15000' })).toBe(15_000)
  })
  it('treats 0 (and negatives) as the legacy immediate flush (0)', () => {
    expect(resolveAnswerStageMs({ SWITCHROOM_ANSWER_STAGE_MS: '0' })).toBe(0)
    expect(resolveAnswerStageMs({ SWITCHROOM_ANSWER_STAGE_MS: '-5' })).toBe(0)
  })
  it('fails safe to the default on an unparseable value', () => {
    expect(resolveAnswerStageMs({ SWITCHROOM_ANSWER_STAGE_MS: 'soon' })).toBe(ANSWER_STAGE_MS)
  })
})
