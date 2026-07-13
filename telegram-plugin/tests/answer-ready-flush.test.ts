/**
 * PR A — answer-ready quiescence flush (late-delivery fix).
 *
 * The gateway delivers a toolless terminal-text answer either on claude's
 * (unreliable) `turn_duration`/turn_end, or — when that never lands — on the
 * orphaned-reply backstop, which the answer text itself keeps re-arming across
 * a ~150 s window. PR A adds a DETERMINISTIC ~1 s quiescence flush.
 *
 * These tests exercise the REAL seam (`shouldArmAnswerReadyFlush`, which calls
 * the REAL `decideTurnFlush` classifier + a REAL `ToolFlightTracker`) and a
 * fake-timer harness that models the gateway's arm/fire/disarm orchestration
 * (`resetAnswerReadyFlushTimeout`) using that same predicate — mirroring how
 * `orphaned-reply-rearm.test.ts` tests the inline orphaned timer via the real
 * `LivenessTracker`. The oracle asserts OUTCOMES: the flush fires at the ~1 s
 * debounce (not ~150 s), it re-arms per text chunk, and after it fires a later
 * turn_end delivers NOTHING more (exactly-once).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  shouldArmAnswerReadyFlush,
  resolveAnswerReadyFlushMs,
  ANSWER_READY_FLUSH_MS,
  type AnswerReadyArmInput,
} from '../answer-ready-flush.js'
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
// Timer harness — models the gateway's resetAnswerReadyFlushTimeout +
// exactly-once teardown, driven by the REAL predicate. Asserts OUTCOMES.
// ---------------------------------------------------------------------------

/**
 * Faithful in-test model of the gateway seam. Everything load-bearing (the
 * arm/fire DECISION) delegates to the real `shouldArmAnswerReadyFlush`; the
 * orchestration (per-turn timer id, rollover guard, atom-null teardown) is the
 * same 5 lines the gateway runs. `sends` counts delivered flushes; `dispatch`
 * models `handleSessionEvent({turn_end})` → `endCurrentTurnAtomic` nulling the
 * atom, which is exactly what makes delivery exactly-once.
 */
class FlushHarness {
  turn: { capturedText: string[]; replyCalled: boolean; timerId: ReturnType<typeof setTimeout> | null } | null
  flight = new ToolFlightTracker()
  pendingAsync = false
  sends = 0
  window = WINDOW

  constructor() {
    this.turn = { capturedText: [], replyCalled: false, timerId: null }
  }

  private armInputFor(t: NonNullable<FlushHarness['turn']>): AnswerReadyArmInput {
    return {
      flush: { chatId: CHAT, replyCalled: t.replyCalled, capturedText: t.capturedText, flushEnabled: true },
      inFlightToolCount: this.flight.inFlightCount(),
      hasPendingAsyncDispatch: this.pendingAsync,
      flushWindowMs: this.window,
    }
  }

  /** = endCurrentTurnAtomic: clear the timer for a turn. */
  clear(t: FlushHarness['turn']): void {
    if (t?.timerId != null) {
      clearTimeout(t.timerId)
      t.timerId = null
    }
  }

  /** = the synthetic turn_end dispatch. Short-circuits when the atom is gone
   *  (currentTurn === null), the mechanism that guarantees exactly-once. On the
   *  first live dispatch it delivers and tears the atom down (atom-null). */
  dispatchTurnEnd(): void {
    if (this.turn == null) return // atom already torn down → no second send
    this.clear(this.turn)
    this.sends++
    this.turn = null // endCurrentTurnAtomic: null the atom
  }

  /** = resetAnswerReadyFlushTimeout, called from `case 'text'`. */
  onText(chunk: string): void {
    const turn = this.turn
    this.clear(turn) // clear-before-rearm (debounce)
    if (turn == null) return
    turn.capturedText.push(chunk)
    if (!shouldArmAnswerReadyFlush(this.armInputFor(turn))) return
    turn.timerId = setTimeout(() => {
      const t = this.turn
      if (t == null || t !== turn) return // rollover guard
      t.timerId = null
      if (!shouldArmAnswerReadyFlush(this.armInputFor(t))) return // fire-time re-verify
      this.dispatchTurnEnd()
    }, this.window)
  }

  /** = case 'tool_use' / 'tool_label': disarm on tool activity. */
  onToolUse(id: string): void {
    if (this.turn != null) this.clear(this.turn)
    this.flight.onEvent({ kind: 'tool_use', toolUseId: id })
  }

  onToolResult(id: string): void {
    this.flight.onEvent({ kind: 'tool_result', toolUseId: id })
  }
}

describe('answer-ready quiescence flush — timer outcomes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes the composed answer at the ~1 s debounce, NOT at the ~150 s backstop', () => {
    const h = new FlushHarness()
    h.onText('The composed final answer.')
    // Nothing before the debounce elapses.
    vi.advanceTimersByTime(WINDOW - 1)
    expect(h.sends).toBe(0)
    // Fires deterministically at the debounce.
    vi.advanceTimersByTime(1)
    expect(h.sends).toBe(1)
    // And it did NOT wait for the multi-minute backstop.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(h.sends).toBe(1) // still exactly one — proves it beat ~150 s
  })

  it('each text chunk re-arms the debounce (only fires 1 s after the LAST chunk)', () => {
    const h = new FlushHarness()
    h.onText('Part one. ')
    vi.advanceTimersByTime(500)
    expect(h.sends).toBe(0)
    h.onText('Part two — the rest of the answer.') // re-arms
    vi.advanceTimersByTime(999)
    expect(h.sends).toBe(0) // debounce reset by the 2nd chunk
    vi.advanceTimersByTime(1)
    expect(h.sends).toBe(1)
  })

  it('EXACTLY-ONCE: a later turn_end after a quiescence flush sends nothing more', () => {
    const h = new FlushHarness()
    h.onText('Answer text.')
    vi.advanceTimersByTime(WINDOW)
    expect(h.sends).toBe(1) // quiescence flushed + nulled the atom
    // The real turn_end finally lands — it must short-circuit (atom gone).
    h.dispatchTurnEnd()
    expect(h.sends).toBe(1)
  })

  it('EXACTLY-ONCE: a real turn_end BEFORE the debounce disarms the pending flush', () => {
    const h = new FlushHarness()
    h.onText('Answer text.')
    vi.advanceTimersByTime(WINDOW - 100)
    // turn_end arrives first → delivers once and clears the pending timer.
    h.dispatchTurnEnd()
    expect(h.sends).toBe(1)
    expect(vi.getTimerCount()).toBe(0) // pending quiescence timer was cleared
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(h.sends).toBe(1) // the stale timer never fired a second send
  })

  it('does NOT flush while a tool call is in flight (only on genuine quiescence)', () => {
    const h = new FlushHarness()
    h.onText('Interim thought before a tool.')
    // A tool starts within the window → disarm.
    vi.advanceTimersByTime(400)
    h.onToolUse('bash_1')
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(h.sends).toBe(0) // never fired while (and after) the tool was open
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arms and flushes once the tool completes and new answer text settles', () => {
    const h = new FlushHarness()
    h.onText('Working on it.')
    h.onToolUse('bash_1') // disarm
    vi.advanceTimersByTime(2000)
    expect(h.sends).toBe(0)
    h.onToolResult('bash_1') // tool done → quiescent again
    h.onText(' Here is the final composed answer.') // new text re-arms
    vi.advanceTimersByTime(WINDOW)
    expect(h.sends).toBe(1)
  })

  it('a fire-time tool in flight cancels the flush even if disarm was missed', () => {
    const h = new FlushHarness()
    h.onText('Answer text.')
    // Simulate a missed explicit disarm: a tool becomes in-flight directly.
    h.flight.onEvent({ kind: 'tool_use', toolUseId: 'sneaky' })
    vi.advanceTimersByTime(WINDOW)
    expect(h.sends).toBe(0) // fire-time re-verification saw inFlight > 0 → no send
  })

  it('a NO_REPLY turn never arms, so it flushes nothing (records no_reply upstream)', () => {
    const h = new FlushHarness()
    h.onText('NO_REPLY')
    vi.advanceTimersByTime(BACKSTOP_MS)
    expect(h.sends).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
