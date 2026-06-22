/**
 * Property / invariant proof for the turn-liveness primitive (#2527).
 *
 * This is the ANTI-WHACK-A-MOLE test: instead of one scenario per bug, it
 * fuzzes the turn-shape space (timing × tool churn × reply pattern × role ×
 * NESTING × surface) and asserts the primitive's invariants hold for ANY
 * shape — so a turn type nobody enumerated is covered by construction.
 *
 * It drives the REAL `silence-poke` wiring (startTurn → ticks → floorState →
 * onMidTurnFloor → fire-once latch + clock reset) plus the pure terminal
 * decision, and checks each fired floor against an independent oracle.
 *
 * Invariants asserted across the corpus:
 *   I1  liveness:     the floor fires exactly when the oracle says it should
 *                     (a user turn working silently past the floor threshold,
 *                     below the 300s fallback window, undelivered).
 *   I2  fire-once:    at most one floor beat per turn.
 *   I3  role gate:    a system/cron turn never fires a floor beat.
 *   I4  delivered:    a turn that delivered before any silent window fires none.
 *   I5  terminal:     terminal reason = decideTerminalReason(role, delivered).
 *   I6  surface parity: the SAME shape on a DM (threadId null) and a forum
 *                     topic (threadId set) produces identical floor + terminal
 *                     outcomes — parity by construction, not by duplicated code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  startTurn,
  noteOutbound,
  noteToolStart,
  noteToolEnd,
  pokeFloorNow,
  __tickForTests,
  __setDepsForTests,
  __resetAllForTests,
  type SilencePokeMetric,
  type MidTurnFloorContext,
} from '../silence-poke.js'
import {
  decideTerminalReason,
  type LoopRole,
} from '../turn-liveness-floor.js'

const ORIGINAL_KILL = process.env.SWITCHROOM_DISABLE_SILENCE_POKE
const ORIGINAL_FLOOR_KILL = process.env.SWITCHROOM_TG_LIVENESS_FLOOR

const FLOOR_MS = 45_000
const FALLBACK_MS = 300_000
const TICK_MS = 5_000

/** Deterministic LCG so the corpus is reproducible (Math.random would make
 *  failures un-repeatable). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

type Surface = 'dm' | 'topic'
interface Ev { t: number; kind: 'tool_start' | 'tool_end' | 'reply_substantive' | 'reply_ack' }
interface Shape {
  role: LoopRole
  events: Ev[]
  totalMs: number
}

/** Generate a random turn shape — varied timing, churn, reply pattern, role,
 *  and nesting (overlapping tool calls model nested/parallel sub-agents). */
function genShape(rng: () => number): Shape {
  const roleRoll = rng()
  // mostly user (the case that owes liveness), some system, some sub-agent.
  const role: LoopRole = roleRoll < 0.7 ? 'user' : roleRoll < 0.85 ? 'system' : 'sub-agent'
  const totalMs = 10_000 + Math.floor(rng() * 600_000) // up to 10 min
  const events: Ev[] = []

  // Tool churn — 0..8 (possibly overlapping → nesting / fan-out).
  const nTools = Math.floor(rng() * 9)
  for (let i = 0; i < nTools; i++) {
    const start = Math.floor(rng() * totalMs)
    const dur = 1_000 + Math.floor(rng() * 120_000)
    events.push({ t: start, kind: 'tool_start' })
    events.push({ t: Math.min(totalMs, start + dur), kind: 'tool_end' })
  }

  // Reply pattern — none / one ack / one substantive / ack-then-substantive.
  const replyRoll = rng()
  if (replyRoll < 0.25) {
    // none
  } else if (replyRoll < 0.5) {
    events.push({ t: Math.floor(rng() * totalMs), kind: 'reply_ack' })
  } else if (replyRoll < 0.8) {
    events.push({ t: Math.floor(rng() * totalMs), kind: 'reply_substantive' })
  } else {
    const a = Math.floor(rng() * totalMs)
    events.push({ t: a, kind: 'reply_ack' })
    events.push({ t: Math.min(totalMs, a + Math.floor(rng() * 60_000)), kind: 'reply_substantive' })
  }
  events.sort((x, y) => x.t - y.t)
  return { role, events, totalMs }
}

interface RunResult {
  floors: MidTurnFloorContext[]
  /** oracle fire times (independent reference model). */
  oracleFires: number[]
  deliveredAtEnd: boolean
  terminal: 'done' | 'undelivered'
}

/** Run one shape on one surface through the REAL silence-poke + an oracle. */
function runShape(shape: Shape, surface: Surface): RunResult {
  const threadId = surface === 'topic' ? 99 : null
  const key = threadId == null ? 'chat' : `chat:${threadId}`

  // Sim state (also feeds the oracle).
  let delivered = false
  let inFlight = 0
  let lastOutbound: number | null = null
  let oracleFloorFired = false
  const oracleFires: number[] = []
  const floors: MidTurnFloorContext[] = []
  const emitted: SilencePokeMetric[] = []

  __setDepsForTests({
    emitMetric: (e) => emitted.push(e),
    onFrameworkFallback: () => { /* not under test here */ },
    isLegitimatelyWorking: () => inFlight > 0,
    floorState: () => ({ role: shape.role, finalAnswerDelivered: delivered }),
    onMidTurnFloor: (ctx) => { floors.push(ctx) },
    thresholdsMs: { fallback: FALLBACK_MS, floor: FLOOR_MS },
  })

  startTurn(key, 0)

  let evIdx = 0
  const applyEventsUpTo = (t: number) => {
    while (evIdx < shape.events.length && shape.events[evIdx].t <= t) {
      const ev = shape.events[evIdx++]
      switch (ev.kind) {
        case 'tool_start':
          inFlight++
          noteToolStart(key, `tool-${evIdx}`, 'Bash', 'doing a thing', ev.t)
          break
        case 'tool_end':
          if (inFlight > 0) inFlight--
          noteToolEnd(key, `tool-${evIdx}`, ev.t)
          break
        case 'reply_ack':
          noteOutbound(key, ev.t)
          lastOutbound = ev.t
          break
        case 'reply_substantive':
          noteOutbound(key, ev.t)
          lastOutbound = ev.t
          delivered = true
          break
      }
    }
  }

  for (let t = 0; t <= shape.totalMs; t += TICK_MS) {
    applyEventsUpTo(t)
    // Oracle: mirror the floor gate against the same pre-tick state.
    const silence = t - (lastOutbound ?? 0)
    if (
      !oracleFloorFired &&
      shape.role === 'user' &&
      !delivered &&
      inFlight > 0 &&
      silence >= FLOOR_MS &&
      silence < FALLBACK_MS
    ) {
      oracleFloorFired = true
      oracleFires.push(t)
    }
    __tickForTests(t)
  }
  applyEventsUpTo(shape.totalMs)

  return {
    floors,
    oracleFires,
    deliveredAtEnd: delivered,
    terminal: decideTerminalReason({ enabled: true, role: shape.role, finalAnswerDelivered: delivered }),
  }
}

beforeEach(() => {
  __resetAllForTests()
  delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
  delete process.env.SWITCHROOM_TG_LIVENESS_FLOOR
})
afterEach(() => {
  __resetAllForTests()
  if (ORIGINAL_KILL != null) process.env.SWITCHROOM_DISABLE_SILENCE_POKE = ORIGINAL_KILL
  else delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
  if (ORIGINAL_FLOOR_KILL != null) process.env.SWITCHROOM_TG_LIVENESS_FLOOR = ORIGINAL_FLOOR_KILL
  else delete process.env.SWITCHROOM_TG_LIVENESS_FLOOR
})

describe('turn-liveness primitive — fuzzed invariants (#2527)', () => {
  it('holds the invariants across 2000 random turn shapes × both surfaces', () => {
    const rng = makeRng(0xC0FFEE)
    const N = 2000
    for (let i = 0; i < N; i++) {
      const shape = genShape(rng)
      const dm = runShape(shape, 'dm')
      // Reset between surface runs (same module, fresh state).
      __resetAllForTests()
      const topic = runShape(shape, 'topic')
      __resetAllForTests()

      const ctx = `shape#${i} role=${shape.role} events=${JSON.stringify(shape.events)}`

      // I2 — fire-once per turn.
      expect(dm.floors.length, `I2 fire-once dm ${ctx}`).toBeLessThanOrEqual(1)
      expect(topic.floors.length, `I2 fire-once topic ${ctx}`).toBeLessThanOrEqual(1)

      // I3 — a non-user role never fires a floor beat.
      if (shape.role !== 'user') {
        expect(dm.floors.length, `I3 role-gate ${ctx}`).toBe(0)
        expect(topic.floors.length, `I3 role-gate ${ctx}`).toBe(0)
      }

      // I1 + I4 — the floor fires exactly when the oracle says (which encodes
      // "user + working + silent ≥ floor + < fallback + undelivered").
      expect(dm.floors.length, `I1/I4 oracle-count dm ${ctx}`).toBe(dm.oracleFires.length)
      if (dm.oracleFires.length === 1) {
        expect(dm.floors[0].silenceMs, `I1 oracle-time dm ${ctx}`).toBeGreaterThanOrEqual(FLOOR_MS)
        expect(dm.floors[0].silenceMs, `I1 oracle-time dm ${ctx}`).toBeLessThan(FALLBACK_MS)
      }

      // I5 — terminal honesty: undelivered user turn → 'undelivered', else 'done'.
      const expectedTerminal = shape.role === 'user' && !dm.deliveredAtEnd ? 'undelivered' : 'done'
      expect(dm.terminal, `I5 terminal ${ctx}`).toBe(expectedTerminal)

      // I6 — surface parity: identical floor count + terminal on DM vs topic.
      expect(topic.floors.length, `I6 parity floor-count ${ctx}`).toBe(dm.floors.length)
      expect(topic.terminal, `I6 parity terminal ${ctx}`).toBe(dm.terminal)
      // The fired beat must route to the right surface.
      if (topic.floors.length === 1) {
        expect(topic.floors[0].threadId, `I6 parity thread-route ${ctx}`).toBe(99)
      }
      if (dm.floors.length === 1) {
        expect(dm.floors[0].threadId, `I6 parity dm-route ${ctx}`).toBeNull()
      }
    }
  })

  it('the documented #2527 case: 6-min busy-silent user turn fires exactly one floor beat', () => {
    // role=user, a long tool stretch, no reply — the overlord-on-marko case.
    const shape: Shape = {
      role: 'user',
      events: [
        { t: 2_000, kind: 'tool_start' },
        { t: 360_000, kind: 'tool_end' },
      ],
      totalMs: 365_000,
    }
    const dm = runShape(shape, 'dm')
    __resetAllForTests()
    const topic = runShape(shape, 'topic')

    expect(dm.floors.length).toBe(1)
    expect(dm.floors[0].silenceMs).toBeGreaterThanOrEqual(FLOOR_MS)
    expect(dm.terminal).toBe('undelivered') // never delivered → not a false 👍
    // Parity: the supergroup topic behaves identically.
    expect(topic.floors.length).toBe(1)
    expect(topic.floors[0].threadId).toBe(99)
    expect(topic.terminal).toBe('undelivered')
  })

  it('a cron turn that works silently never fires the floor and keeps 👍', () => {
    const shape: Shape = {
      role: 'system',
      events: [
        { t: 1_000, kind: 'tool_start' },
        { t: 200_000, kind: 'tool_end' },
      ],
      totalMs: 210_000,
    }
    const r = runShape(shape, 'dm')
    expect(r.floors.length).toBe(0)
    expect(r.terminal).toBe('done')
  })
})

describe('pokeFloorNow — "Status?" mid-turn short-circuit (#2527)', () => {
  function setup(role: LoopRole, delivered: boolean) {
    const floors: MidTurnFloorContext[] = []
    let working = false
    __setDepsForTests({
      emitMetric: () => {},
      onFrameworkFallback: () => {},
      isLegitimatelyWorking: () => working,
      floorState: () => ({ role, finalAnswerDelivered: delivered }),
      onMidTurnFloor: (ctx) => { floors.push(ctx) },
      thresholdsMs: { fallback: FALLBACK_MS, floor: FLOOR_MS },
    })
    return { floors, setWorking: (w: boolean) => { working = w } }
  }

  it('fires immediately for a user turn even before the threshold and with no tool in flight', () => {
    const { floors } = setup('user', false)
    startTurn('chat', 0)
    pokeFloorNow('chat', 3_000) // 3s in, not working — the user explicitly asked
    expect(floors.length).toBe(1)
    expect(floors[0].forced).toBe(true)
  })

  it('is fire-once: a second "Status?" within the same turn is a no-op', () => {
    const { floors } = setup('user', false)
    startTurn('chat', 0)
    pokeFloorNow('chat', 3_000)
    pokeFloorNow('chat', 6_000)
    expect(floors.length).toBe(1)
  })

  it('does nothing for a system turn (role gate holds even when forced)', () => {
    const { floors } = setup('system', false)
    startTurn('chat', 0)
    pokeFloorNow('chat', 3_000)
    expect(floors.length).toBe(0)
  })

  it('does nothing once a substantive answer has been delivered', () => {
    const { floors } = setup('user', true)
    startTurn('chat', 0)
    pokeFloorNow('chat', 3_000)
    expect(floors.length).toBe(0)
  })

  it('is a no-op when there is no live turn for the key', () => {
    const { floors } = setup('user', false)
    pokeFloorNow('chat', 3_000) // no startTurn
    expect(floors.length).toBe(0)
  })
})
