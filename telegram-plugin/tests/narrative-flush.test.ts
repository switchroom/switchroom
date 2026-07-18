/**
 * narrative-flush.test.ts — the time-boxed narrative early-paint kernel.
 *
 * Pins the deterministic behaviour of NarrativeFlushController (narrative-flush.ts):
 * the timer half of the JSONL-text-narrative primitive. Drives the REAL kernel with
 * a fake scheduler + effect spies (no real timers, no gateway I/O) so every
 * assertion is an outcome, not a code-path.
 *
 * Coverage maps 1:1 to the fix's correctness requirements:
 *   1. Early paint — a parked block SHOWs when the timer fires and NO lookahead
 *      followed (RED on pre-fix: pre-fix never armed a timer, so `show` only ever
 *      fired on the next event — here it fires with no lookahead at all).
 *   2. Fast tool — a tool_use lookahead before the timer fires SHOWs exactly once
 *      and cancels the timer (no double-paint).
 *   3. Anti-double-print, deferred path — a parked block that drafts the reply is
 *      SUPPRESSED (never shown) when the reply lands before the timer.
 *   4. Anti-double-print, TIMER path — a block the timer already painted that
 *      later proves to draft the reply is RETRACTED (the guarantee holds even when
 *      the timer paints ahead of the reply).
 *   5. Leak safety — turn_end and teardown disarm the timer; a stale fire is inert.
 */

import { describe, it, expect, vi } from 'vitest'
import { NarrativeFlushController } from '../narrative-flush.js'

const FLUSH_MS = 250

/** Deterministic stand-in for the real `unref`'d setTimeout wiring. */
class FakeScheduler {
  private fn: (() => void) | null = null
  armCount = 0
  disarmCount = 0
  lastMs: number | null = null

  arm(fn: () => void, ms: number): void {
    // Real scheduler cancels any prior armed callback first (at-most-one).
    this.fn = fn
    this.lastMs = ms
    this.armCount++
  }
  disarm(): void {
    if (this.fn != null) this.disarmCount++
    this.fn = null
  }
  /** Simulate the real timer elapsing. No-op once disarmed (mirrors clearTimeout). */
  fire(): void {
    const fn = this.fn
    this.fn = null // a real one-shot timer is spent after firing
    fn?.()
  }
  get isArmed(): boolean {
    return this.fn != null
  }
}

function makeController() {
  const show = vi.fn<[string], void>()
  const retractShown = vi.fn<[string], void>()
  const scheduler = new FakeScheduler()
  const ctrl = new NarrativeFlushController({ show, retractShown }, scheduler, FLUSH_MS)
  return { ctrl, show, retractShown, scheduler }
}

describe('early paint — parked narration surfaces on the timer with no lookahead', () => {
  it('does NOT paint on stage alone, then paints exactly once when the timer fires', () => {
    const { ctrl, show, scheduler } = makeController()
    ctrl.stage('On it, pulling the logs…')

    // Pre-fix behaviour: nothing shown yet (deferred one lookahead step).
    expect(show).not.toHaveBeenCalled()
    // The fix ARMS a timer for exactly this case.
    expect(scheduler.isArmed).toBe(true)
    expect(scheduler.lastMs).toBe(FLUSH_MS)

    scheduler.fire() // the agent thought past the window before its first tool
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('On it, pulling the logs…')
  })
})

describe('fast tool — a lookahead before the window cancels the timer, paints once', () => {
  it('SHOWs the working preamble once and disarms; a later stale fire is inert', () => {
    const { ctrl, show, scheduler } = makeController()
    ctrl.stage('Let me check the build…')
    expect(scheduler.isArmed).toBe(true)

    ctrl.resolveOnTool('Bash', { command: 'npm test' }) // real tool → SHOW
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('Let me check the build…')
    expect(scheduler.isArmed).toBe(false) // timer cancelled
    expect(scheduler.disarmCount).toBeGreaterThan(0)

    scheduler.fire() // stale — must not double-paint
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('anti-double-print (deferred path) — a draft-then-send reply is suppressed', () => {
  it('never SHOWs a parked block that drafts the reply landing before the timer', () => {
    const { ctrl, show, retractShown, scheduler } = makeController()
    const answer = 'The build is green — all 412 tests pass.'
    ctrl.stage(answer) // the model drafting its answer just before reply()

    // #3231: feed the PREFIXED prod wire shape (mcp__…__reply). Before the
    // isReplyTool fix a bare REPLY_TOOLS.has() missed this and the draft was
    // WRONGLY shown — the suppression path was inert on the real wire shape.
    ctrl.resolveOnTool('mcp__switchroom-telegram__reply', { text: answer }) // draft-then-send → SUPPRESS
    expect(show).not.toHaveBeenCalled()
    expect(retractShown).not.toHaveBeenCalled() // nothing was shown to retract
    expect(scheduler.isArmed).toBe(false)
  })

  it('SHOWs a working preamble whose text DIFFERS from the reply', () => {
    const { ctrl, show } = makeController()
    ctrl.stage('Looking into it…')
    ctrl.resolveOnTool('reply', { text: 'The answer is 42.' })
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('Looking into it…')
  })
})

describe('anti-double-print (TIMER path) — a timer-painted draft is retracted', () => {
  it('RETRACTS a block the timer already painted when the reply proves it a draft', () => {
    const { ctrl, show, retractShown, scheduler } = makeController()
    const answer = 'Done — deployed v0.16.51 to production, health checks green.'
    ctrl.stage(answer)

    scheduler.fire() // timer paints it EARLY (the reply hadn't arrived yet)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith(answer)

    // The reply finally lands and IS that block → must be retracted, not left
    // on the card to double-print against the canonical reply.
    // #3231: prefixed prod wire shape.
    ctrl.resolveOnTool('mcp__switchroom-telegram__stream_reply', { text: answer })
    expect(retractShown).toHaveBeenCalledTimes(1)
    expect(retractShown).toHaveBeenCalledWith(answer)
    expect(show).toHaveBeenCalledTimes(1) // not re-shown
  })

  it('does NOT retract a timer-painted block when the reply differs (genuine narration)', () => {
    const { ctrl, show, retractShown, scheduler } = makeController()
    ctrl.stage('Still working — compiling the worker…')
    scheduler.fire()
    ctrl.resolveOnTool('reply', { text: 'Here are your results: …' })
    expect(show).toHaveBeenCalledTimes(1)
    expect(retractShown).not.toHaveBeenCalled()
  })

  it('retracts a timer-painted draft even when the reply only lands at turn_end', () => {
    const { ctrl, show, retractShown, scheduler } = makeController()
    const answer = 'All set — the migration ran cleanly.'
    ctrl.stage(answer)
    scheduler.fire()
    ctrl.flushAtTurnEnd(answer) // reply delivered; trailing block is its draft
    expect(retractShown).toHaveBeenCalledTimes(1)
    expect(retractShown).toHaveBeenCalledWith(answer)
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('turn_end — trailing narration is shown or suppressed, timer disarmed', () => {
  it('SHOWs genuine trailing narration and disarms the timer', () => {
    const { ctrl, show, scheduler } = makeController()
    ctrl.stage('Done — all green.')
    ctrl.flushAtTurnEnd('') // no reply delivered → genuine trailing narration
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('Done — all green.')
    expect(scheduler.isArmed).toBe(false)
  })

  it('SUPPRESSes a trailing block that drafts the delivered answer', () => {
    const { ctrl, show } = makeController()
    const answer = 'The total came to $1,240.50 across the three invoices.'
    ctrl.stage(answer)
    ctrl.flushAtTurnEnd(answer)
    expect(show).not.toHaveBeenCalled()
  })
})

describe('leak safety — teardown and turn_end can never leave a live timer', () => {
  it('teardown disarms; a stale fire after teardown is inert', () => {
    const { ctrl, show, scheduler } = makeController()
    ctrl.stage('Working…')
    expect(scheduler.isArmed).toBe(true)

    ctrl.teardown()
    expect(scheduler.isArmed).toBe(false)
    expect(scheduler.disarmCount).toBeGreaterThan(0)

    scheduler.fire() // must not paint against a torn-down turn
    expect(show).not.toHaveBeenCalled()
  })

  it('flushAtTurnEnd disarms the timer so it cannot fire post-turn', () => {
    const { ctrl, show, scheduler } = makeController()
    ctrl.stage('Half-done…')
    ctrl.flushAtTurnEnd('') // shows it, and disarms
    show.mockClear()
    scheduler.fire() // stale
    expect(show).not.toHaveBeenCalled()
  })

  it('re-staging cancels the prior block’s timer (at-most-one armed)', () => {
    const { ctrl, show, scheduler } = makeController()
    ctrl.stage('first line…')
    ctrl.stage('second line…') // the new block is the lookahead for the first
    // The first (pure narration) is shown immediately by the stage lookahead.
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('first line…')
    // Exactly one live timer remains (for the second block).
    expect(scheduler.isArmed).toBe(true)
    scheduler.fire()
    expect(show).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenLastCalledWith('second line…')
  })
})
