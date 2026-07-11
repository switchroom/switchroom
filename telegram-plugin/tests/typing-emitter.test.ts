/**
 * #3084 — the typing indicator must be structurally incapable of earning a
 * per-bot flood ban.
 *
 * On 2026-07-11 `overlord` emitted 8,729 sendChatAction calls (55% of ALL
 * outbound volume, bursting 200-300/min into ONE DM) to deliver 203 messages,
 * and Telegram banned the bot token for 4.6 hours (429 retry_after=16739s).
 * Root cause: both typing loops fire an action IMMEDIATELY on (re)start, and
 * the tool-use wrapper restarts the loop on every tool call — so the ping rate
 * equalled the agent's TOOL-CALL rate and the "4 s interval" was decorative.
 *
 * These tests assert the OUTCOME the fix owes: no matter how the loops are
 * driven, at most ~one chat action per chat key per refresh window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTypingEmitter,
  TYPING_FLOOR_MS,
  TYPING_REFRESH_MS,
} from '../typing-emitter.js'
import { createTurnTypingLoop } from '../gateway/turn-typing-loop.js'
import { createRetryApiCall, isFloodWaitActiveError } from '../retry-api-call.js'
import {
  floodStatePath,
  makeFloodWaitRecorder,
  suppressNonEssentialSendMs,
} from '../flood-circuit-breaker.js'
import { errors } from './fake-bot-api.js'

const chatKey = (chatId: string, threadId: number | null) =>
  `${chatId}:${threadId ?? '_'}`

/** Deterministic clock — no real timers anywhere in the emitter tests. */
function fakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
  }
}

interface Sent {
  chatId: string
  threadId: number | null
  action: string
  at: number
}

function harness(opts: { suppressed?: () => boolean } = {}) {
  const clock = fakeClock()
  const sent: Sent[] = []
  const emitter = createTypingEmitter({
    chatKey,
    now: clock.now,
    isSuppressed: opts.suppressed ?? (() => false),
    send: (chatId, threadId, action) =>
      sent.push({ chatId, threadId, action, at: clock.now() }),
  })
  return { clock, sent, emitter }
}

/** The invariant the ban owes us: no two emissions on one key inside the floor. */
function assertFloorHeld(sent: Sent[], floorMs = TYPING_FLOOR_MS): void {
  const lastByKey = new Map<string, number>()
  for (const s of sent) {
    const k = chatKey(s.chatId, s.threadId)
    const prev = lastByKey.get(k)
    if (prev != null) {
      expect(s.at - prev).toBeGreaterThanOrEqual(floorMs)
    }
    lastByKey.set(k, s.at)
  }
}

describe('typing emitter — per-chat-key emission floor (#3084)', () => {
  it('50 loop restarts in 2 s emit exactly ONE chat action (the regression)', () => {
    const { clock, sent, emitter } = harness()

    // Mirrors the production driver: the tool-use typing wrapper restarts the
    // loop on every tool call, and each restart fired an immediate ping.
    for (let i = 0; i < 50; i++) {
      emitter.emit('chat-1', null, 'typing')
      clock.advance(40) // 50 restarts across 2 s — the observed burst shape
    }

    expect(sent).toHaveLength(1)
    expect(sent[0]?.at).toBe(1_000_000)
    assertFloorHeld(sent)
  })

  it('a cold start still pings IMMEDIATELY — the UX intent survives', () => {
    const { sent, emitter } = harness()
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('the floor releases after the window, so the indicator stays lit', () => {
    const { clock, sent, emitter } = harness()
    emitter.emit('chat-1')
    clock.advance(TYPING_FLOOR_MS - 1)
    expect(emitter.emit('chat-1')).toBe(false)
    clock.advance(1)
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('the floor is UNDER the refresh cadence, so an on-time refresh is never eaten', () => {
    const { clock, sent, emitter } = harness()
    // A loop refreshing on its own 4 s cadence must never be dropped, or the
    // chat goes dark (Telegram's typing action expires at ~5 s).
    for (let i = 0; i < 15; i++) {
      expect(emitter.emit('chat-1')).toBe(true)
      clock.advance(TYPING_REFRESH_MS)
    }
    expect(sent).toHaveLength(15)
    expect(TYPING_FLOOR_MS).toBeLessThan(TYPING_REFRESH_MS)
  })

  it('two chats (and two topics in one chat) are independent lanes', () => {
    const { sent, emitter } = harness()
    expect(emitter.emit('chat-1', null)).toBe(true)
    expect(emitter.emit('chat-2', null)).toBe(true)
    expect(emitter.emit('chat-1', 77)).toBe(true) // supergroup topic = own lane
    expect(emitter.emit('chat-1', null)).toBe(false) // same lane, inside floor
    expect(sent).toHaveLength(3)
  })

  it('emits NOTHING while a flood window is open (typing is non-essential)', () => {
    let floodOpen = true
    const { clock, sent, emitter } = harness({ suppressed: () => floodOpen })

    for (let i = 0; i < 40; i++) {
      expect(emitter.emit('chat-1')).toBe(false)
      clock.advance(1000)
    }
    expect(sent).toHaveLength(0)

    floodOpen = false
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('checks the flood state at most once per floor per chat (no read storm)', () => {
    const suppressed = vi.fn(() => false)
    const clock = fakeClock()
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      isSuppressed: suppressed,
      send: () => {},
    })
    for (let i = 0; i < 50; i++) {
      emitter.emit('chat-1')
      clock.advance(40)
    }
    // 2 s of restarts, floor 3.5 s → one window claimed → one flood check.
    expect(suppressed).toHaveBeenCalledTimes(1)
  })

  it('a backwards clock step does not wedge the indicator off', () => {
    const { clock, sent, emitter } = harness()
    emitter.emit('chat-1')
    clock.set(500) // NTP step backwards
    expect(emitter.emit('chat-1')).toBe(true)
    expect(sent).toHaveLength(2)
  })
})

/**
 * A 60 s turn, the REAL `createTurnTypingLoop`, and a faithful reproduction of
 * the tool-use loop as gateway.ts drives it (stop → restart → fire immediately
 * → re-arm a fixed interval), both emitting through ONE emitter.
 *
 * The bounds below are ABSOLUTE — derived from the incident and from Telegram's
 * action expiry, never from the implementation constants. A test whose bound is
 * expressed in terms of the thing it tests cannot fail when that thing is
 * removed: with the floor disabled, `ceil(60_000 / floorMs)` is Infinity. These
 * numbers go red on the unfixed code (~135 emissions in 60 s), which is the
 * only property that makes them worth having.
 */
const TURN_MS = 60_000
/** 60 s at the enforced floor is ~17 emissions. 20 is the slack-adjusted cap;
 *  the pre-fix code emits ~135 (one per tool call) and fails this loudly. */
const MAX_EMISSIONS_PER_TURN = 20
/** Telegram's `typing` chat action expires at ~5 s. A longer gap = a DARK chat
 *  mid-turn, which breaches know-what-my-agent-is-doing ("stays present from
 *  receipt to turn end"). This is the assertion the catch-up timer exists for. */
const MAX_DARK_MS = 5000

interface Schedule {
  /** ms into the turn before the first tool call fires. */
  phase: number
  /** how long each tool call runs (loop stops on the tool result). */
  dur: number
  /** quiet gap between tool calls (agent thinking / streaming text). */
  gap: number
  /** number of serial tool calls. */
  count: number
}

/**
 * A VIRTUAL CLOCK + event queue — no `vi` fake timers anywhere in this file.
 *
 * This suite is DUAL-RUN: CI's `bun-test-run` executes the whole
 * `telegram-plugin/tests` directory, and bun's `vi` shim has no
 * `setSystemTime` / `useFakeTimers` (CLAUDE.md: dual-run files must avoid
 * bun-incompatible vitest APIs). A test that throws on startup is not a weaker
 * test, it is NOT A TEST — and this file is the entire guard for #3084, so it
 * has to bite in BOTH runners.
 *
 * The emitter already takes injected `now` / `schedule` / `cancel`, so it needs
 * no timer mocking at all. `createTurnTypingLoop` reaches for the global
 * `setInterval`, so `withVirtualTimers` swaps the global for the queue below for
 * the duration of one simulation and restores it after. Fully deterministic and
 * runner-agnostic.
 */
interface VTimer {
  id: number
  at: number
  fn: () => void
  every: number | null
}

function createVirtualClock(start = 0) {
  let t = start
  let seq = 1
  const timers = new Map<number, VTimer>()

  function schedule(fn: () => void, ms: number, every: number | null = null): number {
    const id = seq++
    timers.set(id, { id, at: t + Math.max(0, ms), fn, every })
    return id
  }

  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => schedule(fn, ms),
    scheduleEvery: (fn: () => void, ms: number) => schedule(fn, ms, ms),
    cancel: (h: unknown) => {
      timers.delete(h as number)
    },
    /** Run every timer due at or before `target`, in (time, insertion) order. */
    advanceTo(target: number): void {
      for (;;) {
        let next: VTimer | null = null
        for (const tm of timers.values()) {
          if (tm.at > target) continue
          if (next === null || tm.at < next.at || (tm.at === next.at && tm.id < next.id)) {
            next = tm
          }
        }
        if (next === null) break
        t = next.at
        if (next.every != null) next.at = t + next.every
        else timers.delete(next.id)
        next.fn()
      }
      t = target
    },
    advanceBy(ms: number): void {
      this.advanceTo(t + ms)
    },
    pending: () => timers.size,
  }
}

type VirtualClock = ReturnType<typeof createVirtualClock>

/** Run `body` with the GLOBAL setInterval/clearInterval bound to `clock`. */
function withVirtualTimers<T>(clock: VirtualClock, body: () => T): T {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((fn: () => void, ms: number) =>
    clock.scheduleEvery(fn, ms)) as unknown as typeof globalThis.setInterval
  globalThis.clearInterval = ((h: unknown) =>
    clock.cancel(h)) as unknown as typeof globalThis.clearInterval
  try {
    return body()
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

/** Run one schedule; return the emission times over the turn. */
function simulateTurn(sch: Schedule): number[] {
  const clock = createVirtualClock(0)
  const sent: number[] = []

  return withVirtualTimers(clock, () => {
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      send: () => sent.push(clock.now()),
    })

    // Loop A — the turn-level loop: fixed cadence for the WHOLE turn. The REAL
    // factory, driving the REAL global setInterval (bound to the virtual clock).
    const turnLoop = createTurnTypingLoop({
      chatKey,
      sendChatAction: (chatId, threadId) => {
        emitter.emit(chatId, threadId, 'typing')
      },
      refreshMs: TYPING_REFRESH_MS,
    })

    // Loop B — the tool-use loop, as gateway.ts drives it: restarts (and fires
    // immediately) per serial tool call, stops on the tool result when the
    // ref-count hits zero.
    let toolInterval: unknown = null
    const startToolLoop = () => {
      if (toolInterval != null) clearInterval(toolInterval as ReturnType<typeof setInterval>)
      const send = () => emitter.emit('chat-1', null, 'typing')
      send()
      toolInterval = setInterval(send, TYPING_REFRESH_MS)
    }
    const stopToolLoop = () => {
      if (toolInterval != null) clearInterval(toolInterval as ReturnType<typeof setInterval>)
      toolInterval = null
    }

    // Build the tool start/stop timeline, then advance the clock through it.
    const events: Array<{ at: number; fn: () => void }> = []
    let cursor = sch.phase
    for (let i = 0; i < sch.count && cursor < TURN_MS; i++) {
      const start = cursor
      const end = Math.min(start + sch.dur, TURN_MS)
      events.push({ at: start, fn: startToolLoop })
      events.push({ at: end, fn: stopToolLoop })
      cursor = end + sch.gap
    }
    events.sort((a, b) => a.at - b.at)

    turnLoop.start('chat-1', null) // turn enqueue — the cold-start ping
    for (const ev of events) {
      clock.advanceTo(ev.at)
      ev.fn()
    }
    clock.advanceTo(TURN_MS)

    turnLoop.stop('chat-1', null) // canonical turn-end
    emitter.cancelPending('chat-1', null) // …as the gateway does
    stopToolLoop()

    // Nothing may fire after the turn ends — no zombie "typing…" on a dead turn.
    const afterTurn = sent.length
    clock.advanceTo(TURN_MS + 30_000)
    expect(sent.length).toBe(afterTurn)

    return sent
  })
}

/** Longest stretch of the turn with no live "typing…", including the head. */
function maxDarkMs(sent: number[]): number {
  let worst = sent.length > 0 ? sent[0]! : TURN_MS
  for (let i = 1; i < sent.length; i++) worst = Math.max(worst, sent[i]! - sent[i - 1]!)
  return worst
}

describe('typing emitter — BOTH loops share one floor (#3084)', () => {
  it('the reviewer counterexample (phase=3500 dur=3400 n=6) never goes dark', () => {
    // Before the catch-up timer this schedule left a 7000 ms gap (emissions at
    // 21000 → 28000): a tool ping eats the turn loop's tick, the tool loop then
    // stops, and the turn loop's NEXT fixed tick is floor+refresh away. ~2 s of
    // a dead indicator mid-turn. Red before the fix, green after.
    const sent = simulateTurn({ phase: 3500, dur: 3400, gap: 300, count: 6 })
    expect(maxDarkMs(sent)).toBeLessThanOrEqual(MAX_DARK_MS)
    expect(sent.length).toBeLessThanOrEqual(MAX_EMISSIONS_PER_TURN)
  })

  it('a 120-tool-call storm over 60 s emits <=20 actions (the ban shape)', () => {
    // The incident shape: serial tool calls firing every ~500 ms into ONE DM for
    // a whole minute. Pre-fix this emitted ~136 actions (one per tool call, the
    // 8,729-pings-for-203-messages ratio). The cap is absolute, so it goes red
    // the moment the floor stops holding.
    const sent = simulateTurn({ phase: 0, dur: 250, gap: 250, count: 120 })
    expect(sent.length).toBeLessThanOrEqual(MAX_EMISSIONS_PER_TURN)
    expect(sent.length).toBeGreaterThan(10) // still lit for the whole minute
    expect(maxDarkMs(sent)).toBeLessThanOrEqual(MAX_DARK_MS)
  })

  it('ADVERSARIAL sweep: no schedule floods, and no schedule goes dark', () => {
    // Sweep the tool-call phase/duration/gap/count space — the point is that the
    // bound holds across schedules, not on one hand-picked one.
    let worstDark = 0
    let worstDarkSch: Schedule | null = null
    let worstCount = 0
    let worstCountSch: Schedule | null = null
    let schedules = 0

    for (let phase = 0; phase <= 4000; phase += 250) {
      for (let dur = 200; dur <= 4200; dur += 400) {
        for (const gap of [150, 900, 2600]) {
          for (const count of [3, 6, 12]) {
            const sch: Schedule = { phase, dur, gap, count }
            const sent = simulateTurn(sch)
            schedules++

            const dark = maxDarkMs(sent)
            if (dark > worstDark) {
              worstDark = dark
              worstDarkSch = sch
            }
            if (sent.length > worstCount) {
              worstCount = sent.length
              worstCountSch = sch
            }
            // Floor still holds under every schedule — the flood cap is intact.
            assertFloorHeld(
              sent.map((at) => ({ chatId: 'chat-1', threadId: null, action: 'typing', at })),
            )
          }
        }
      }
    }

    expect(schedules).toBeGreaterThan(500)
    // The two outcomes, both absolute — neither is expressed in terms of the
    // constants under test, so both go red when the mechanism is removed.
    expect(
      worstDark,
      `worst dark gap ${worstDark}ms on ${JSON.stringify(worstDarkSch)}`,
    ).toBeLessThanOrEqual(MAX_DARK_MS) // never a dark chat
    expect(
      worstCount,
      `worst emission count ${worstCount} on ${JSON.stringify(worstCountSch)}`,
    ).toBeLessThanOrEqual(MAX_EMISSIONS_PER_TURN) // never a flood
    // …and the indicator is genuinely live, not merely "not flooding".
    expect(worstCount).toBeGreaterThan(10)
  })

  it('a dropped tick arms exactly ONE coalesced catch-up, and never leaks', () => {
    const clock = createVirtualClock(0)
    const sent: Sent[] = []
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      send: (chatId, threadId, action) =>
        sent.push({ chatId, threadId, action, at: clock.now() }),
    })

    emitter.emit('chat-1') // t=0, sent
    for (let i = 0; i < 20; i++) emitter.emit('chat-1') // 20 drops, ONE window
    expect(emitter.pendingCatchUps()).toBe(1) // coalesced — never 20 timers

    clock.advanceBy(TYPING_FLOOR_MS)
    expect(sent.map((s) => s.at)).toEqual([0, TYPING_FLOOR_MS]) // catch-up fired
    expect(emitter.pendingCatchUps()).toBe(0) // …and did not re-arm itself

    // Turn-end cancellation: a drop in the last moments of a turn must not
    // resurrect "typing…" after the reply has landed.
    emitter.emit('chat-1')
    expect(emitter.pendingCatchUps()).toBe(1)
    emitter.cancelPending('chat-1')
    expect(emitter.pendingCatchUps()).toBe(0)
    clock.advanceBy(10_000)
    expect(sent).toHaveLength(2) // nothing fired after the turn ended
    expect(clock.pending()).toBe(0) // no timer leaked
  })

  it('a flood window cancels the catch-up instead of deferring a ping into the ban', () => {
    const clock = createVirtualClock(0)
    let floodOpen = false
    const sent: Sent[] = []
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      isSuppressed: () => floodOpen,
      schedule: clock.schedule,
      cancel: clock.cancel,
      send: (chatId, threadId, action) =>
        sent.push({ chatId, threadId, action, at: clock.now() }),
    })

    emitter.emit('chat-1')
    emitter.emit('chat-1') // dropped by the floor → catch-up armed
    expect(emitter.pendingCatchUps()).toBe(1)

    floodOpen = true
    clock.advanceBy(TYPING_FLOOR_MS) // catch-up fires INTO the ban…
    expect(sent).toHaveLength(1) // …and is suppressed, not sent
    expect(emitter.pendingCatchUps()).toBe(0)

    clock.advanceBy(60_000)
    expect(sent).toHaveLength(1)
  })
})

describe('typing sends record 429s to the flood breaker (#3084 / #2923)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typing-flood-'))
    path = floodStatePath(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The gateway's `nonEssentialApiCall`: records the flood, never retries. */
  const nonEssentialApiCall = () =>
    createRetryApiCall({
      maxRetries: 1,
      sleep: async () => {},
      onFloodWait: makeFloodWaitRecorder(path),
    })

  it('a 429 on a typing ping is RECORDED, not swallowed', async () => {
    const call = nonEssentialApiCall()
    const fn = vi.fn().mockRejectedValue(errors.floodWait(16739))

    await expect(call(fn, { verb: 'sendChatAction' })).rejects.toThrow()

    // Recorded: the breaker now knows the bot is banned — before the fix the
    // typing path called bot.api raw with `.catch(() => {})`, so the breaker
    // was blind to 429s from the LARGEST emitter of them.
    expect(suppressNonEssentialSendMs(path, Date.now())).toBeGreaterThan(0)
  })

  it('a typing ping is NEVER retried (a retry is what feeds the ban)', async () => {
    const call = nonEssentialApiCall()
    const fn = vi.fn().mockRejectedValue(errors.floodWait(16739))
    await expect(call(fn)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('composes with #3094: a long ban surfaces FLOOD_WAIT_ACTIVE, still ONE call', async () => {
    // #3094 bounded the in-process flood sleep: above the ceiling retryApiCall
    // throws the FLOOD_WAIT_ACTIVE marker instead of sleeping out a multi-hour
    // retry_after. For a typing ping that changes nothing that matters — the
    // window is still recorded, the API is still hit exactly once, nothing is
    // slept. The gateway's onRejected handler drops the marker, so a
    // fire-and-forget ping can't surface it as an unhandled rejection.
    const call = nonEssentialApiCall()
    const fn = vi.fn().mockRejectedValue(errors.floodWait(16739))

    const err = await call(fn).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isFloodWaitActiveError(err)).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(suppressNonEssentialSendMs(path, Date.now())).toBeGreaterThan(0)
  })

  it('the recorded window then suppresses further typing end-to-end', async () => {
    const call = nonEssentialApiCall()
    const sent: Sent[] = []
    const clock = fakeClock()
    const emitter = createTypingEmitter({
      chatKey,
      now: clock.now,
      isSuppressed: () => suppressNonEssentialSendMs(path, Date.now()) > 0,
      send: (chatId, threadId, action) =>
        sent.push({ chatId, threadId, action, at: clock.now() }),
    })

    expect(emitter.emit('chat-1')).toBe(true) // healthy: pings

    // The bot earns a flood ban on some other send.
    await expect(
      call(vi.fn().mockRejectedValue(errors.floodWait(600))),
    ).rejects.toThrow()

    clock.advance(TYPING_FLOOR_MS)
    expect(emitter.emit('chat-1')).toBe(false) // banned: silent
    clock.advance(TYPING_FLOOR_MS)
    expect(emitter.emit('chat-1')).toBe(false)
    expect(sent).toHaveLength(1)
  })
})
