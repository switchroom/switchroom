/**
 * Machine→dispatcher coverage + self-consistency harness for the
 * inbound-delivery state-machine cutover (#2794 / #2996 Phase 1).
 *
 * SCOPE — what this file proves, and what it deliberately does NOT:
 *
 * It drives realistic event schedules (the same shapes the gateway's
 * `shadowEmit` call sites feed the machine — bridge flap, fresh turn,
 * mid-turn buffering, steering, turn-end drain, permission verdicts
 * across a bridge outage, stale-turn fallback) through the PURE
 * `transition()` function, collects the returned effect sequence, then
 * replays that sequence through the REAL `dispatchEffects()` against a
 * recording fake-deps object. It asserts:
 *
 *   1. Every effect kind the machine can emit is handled by the
 *      dispatcher (no silent no-op, no `unwired`/`not-yet-cutover` gap).
 *   2. The observable side-effects fire in the machine's returned order.
 *   3. Invariant #1 at the dispatch layer: an inbound is delivered XOR
 *      (buffered AND persisted) — never both, never neither.
 *
 * It does NOT invoke the remaining imperative delivery body (the twin
 * carve-outs for `!`-interrupt / bridge_dead, `dispatchPermissionVerdict`,
 * the silence-poke ladder), so it is NOT a proof that machine path and
 * imperative path produce identical I/O. (#2996 P1 deleted the legacy
 * gate/claudeBusyKeys twins after the cutover bake; the carve-out body's
 * eventual deletion — the #2794 PR4 remainder — needs its own evidence.)
 *
 * What it DOES gate: if a future edit adds an effect kind the
 * dispatcher doesn't execute, the "no unhandled effect" assertion fails
 * loudly — keeping PR3c's live call-site flip a one-liner.
 */

import { describe, expect, it } from 'vitest'
import {
  transition,
  initialState,
  type Effect,
  type Event,
  type State,
  type ChatKey,
  type InboundMessage as MachineInbound,
} from '../gateway/inbound-delivery-machine'
import {
  dispatchEffects,
  type DispatchCtx,
} from '../gateway/inbound-delivery-machine-dispatch'
import { createPendingInboundBuffer } from '../gateway/pending-inbound-buffer'
import { createPendingPermissionBuffer } from '../gateway/pending-permission-decisions'

// ── Recording fake deps ──────────────────────────────────────────────
// Records every observable dispatcher action in call order so the test
// can assert the effect→I/O mapping and its ordering.

interface Recorder {
  ctx: DispatchCtx
  ops: string[]
}

function makeRecorder(): Recorder {
  const ops: string[] = []
  const inbound = createPendingInboundBuffer()
  const perm = createPendingPermissionBuffer()
  const client = {
    id: 'c1',
    agentName: 'test-agent',
    send: (m: unknown) => {
      const msg = m as { type?: string; id?: string; requestId?: string }
      if (msg.type === 'permission_decision') ops.push(`send:perm:${msg.requestId}`)
      else ops.push(`send:inbound:${msg.id}`)
    },
  }
  const spoolPuts: string[] = []
  const ctx: DispatchCtx = {
    selfAgent: 'test-agent',
    ipcServer: { sendToAgent: () => true } as never,
    pendingInboundBuffer: inbound,
    inboundSpool: {
      put: (_agent: string, m: { id?: string }) => {
        spoolPuts.push(m.id ?? '?')
        ops.push(`persist:${m.id}`)
        return true
      },
      ack: () => {},
      liveEntries: () => [],
    } as never,
    pendingPermissionBuffer: perm,
    client: client as never,
    log: () => {},
    onUserInboundDelivered: (m) => ops.push(`enrol:${(m as { id?: string }).id}`),
    onSetTurnStarted: (key, at) => ops.push(`setTurn:${key}:${at}`),
    onClearTurnStarted: (key) => ops.push(`clearTurn:${key}`),
    onNoteOutbound: (key) => ops.push(`noteOutbound:${key}`),
    onFirePoke: (key, level) => ops.push(`poke:${key}:${level}`),
  }
  // bufferInbound goes through the real buffer; record via a wrapper.
  const origPush = inbound.push.bind(inbound)
  ;(inbound as { push: typeof inbound.push }).push = (agent, m) => {
    ops.push(`buffer:${(m as { id?: string }).id}`)
    return origPush(agent, m)
  }
  return { ctx, ops }
}

// A logging deps object that records the raw effect kinds a dispatch
// pass would execute, so we can assert "no unhandled effect kind".
function makeEffectKindProbe(): { ctx: DispatchCtx; seen: string[] } {
  const seen: string[] = []
  const ctx: DispatchCtx = {
    selfAgent: 'test-agent',
    ipcServer: { sendToAgent: () => true } as never,
    pendingInboundBuffer: createPendingInboundBuffer(),
    inboundSpool: { put: () => true, ack: () => {}, liveEntries: () => [] } as never,
    pendingPermissionBuffer: createPendingPermissionBuffer(),
    client: { id: 'c1', agentName: 'test-agent', send: () => {} } as never,
    log: (line: string) => {
      // The dispatcher must NEVER leave an effect unhandled. Two gap
      // markers exist in the code; both are failures for a live cutover.
      if (line.includes('not-yet-cutover') || line.includes('unwired')) {
        seen.push(`GAP:${line.trim()}`)
      }
    },
    onSetTurnStarted: () => {},
    onClearTurnStarted: () => {},
    onNoteOutbound: () => {},
    onFirePoke: () => {},
  }
  return { ctx, seen }
}

// ── Event-schedule fixtures (mirror gateway shadowEmit call sites) ────

const K = (chat: string, thread?: string): ChatKey => `${chat}:${thread ?? '_'}` as ChatKey
const inMsg = (id: number, steer = false): MachineInbound => ({
  msgId: id,
  isSteering: steer,
  payload: { type: 'inbound', id: `m${id}`, chat_id: '1', text: `t${id}`, meta: { source: 'telegram' } },
})
// Real user inbound — NO meta.source. This is the primary live case:
// shouldTrackDelivery (inbound-delivery-confirm.ts) only tracks
// no-source messages, so fixtures that all carry a source would mask a
// broken enrolment guard (the exact HIGH found in review of PR #3006).
const userMsg = (id: number): MachineInbound => ({
  msgId: id,
  isSteering: false,
  payload: { type: 'inbound', id: `m${id}`, chat_id: '1', text: `t${id}`, meta: {} },
})
const verdict = (r: string) => ({
  requestId: r,
  behavior: 'allow' as const,
  payload: { type: 'permission_decision', requestId: r, behavior: 'allow', updatedInput: {}, timestamp: 0 },
})

/** Named schedules that exercise every transition branch. */
const SCHEDULES: Record<string, Event[]> = {
  fresh_turn_then_end: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'inbound', key: K('1'), msg: inMsg(1), at: 10 },
    { kind: 'turnEnd', key: K('1'), at: 20, outboundEmitted: true },
  ],
  mid_turn_buffer: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'inbound', key: K('1'), msg: inMsg(1), at: 10 },
    { kind: 'inbound', key: K('1'), msg: inMsg(2), at: 15 }, // buffered
    { kind: 'turnEnd', key: K('1'), at: 20, outboundEmitted: true },
  ],
  steering_mid_turn: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'inbound', key: K('1'), msg: inMsg(1), at: 10 },
    { kind: 'inbound', key: K('1'), msg: inMsg(2, true), at: 15 }, // steer → deliver
  ],
  bridge_dead_buffer_then_recover: [
    { kind: 'inbound', key: K('1'), msg: inMsg(1), at: 10 }, // bridge dead → buffer+persist
    { kind: 'bridgeUp', at: 20 }, // drain
  ],
  perm_verdict_alive: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'permVerdict', verdict: verdict('rA'), at: 5 },
  ],
  perm_verdict_dead_then_recover: [
    { kind: 'permVerdict', verdict: verdict('rB'), at: 5 }, // dead → persist
    { kind: 'bridgeUp', at: 10 }, // redeliver
  ],
  stale_turn_fallback: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'inbound', key: K('1'), msg: inMsg(1), at: 10 },
    { kind: 'tick', now: 10 + 300_001 }, // past TURN_TTL, no outbound → firePoke
  ],
  fresh_turn_user_no_source: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'inbound', key: K('1'), msg: userMsg(1), at: 10 }, // real user inbound, no meta.source
  ],
  overlapping_turn_no_spurious_fallback: [
    { kind: 'bridgeUp', at: 0 },
    { kind: 'inbound', key: K('1'), msg: inMsg(1), at: 10 },
    { kind: 'modelOutbound', key: K('1'), at: 10 + 300_000 }, // recent outbound
    { kind: 'tick', now: 10 + 300_001 }, // suppressed by invariant #5
  ],
}

// Run a schedule through the machine, returning the concatenated effect
// stream in machine order.
function runMachine(events: Event[]): { effects: Effect[]; finalState: State } {
  let state = initialState()
  const effects: Effect[] = []
  for (const ev of events) {
    const r = transition(state, ev)
    state = r.state
    effects.push(...r.effects)
  }
  return { effects, finalState: state }
}

describe('dispatch-equivalence: machine effects → dispatcher I/O', () => {
  for (const [name, events] of Object.entries(SCHEDULES)) {
    it(`'${name}': every emitted effect is handled by the dispatcher (no gap)`, () => {
      const { effects } = runMachine(events)
      const { ctx, seen } = makeEffectKindProbe()
      dispatchEffects(effects, ctx)
      expect(seen).toEqual([]) // no not-yet-cutover / unwired markers
    })
  }

  it('fresh_turn_then_end replays in machine order: setTurn → send → noteOutbound/clearTurn', () => {
    const { effects } = runMachine(SCHEDULES.fresh_turn_then_end)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    // setTurnStarted precedes the deliver (downstream observer must see
    // the turn marker up first), and turn-end clears + notes outbound.
    expect(ops[0]).toBe('setTurn:1:_:10')
    expect(ops[1]).toBe('send:inbound:m1')
    expect(ops).toContain('clearTurn:1:_')
    expect(ops).toContain('noteOutbound:1:_')
    expect(ops.indexOf('setTurn:1:_:10')).toBeLessThan(ops.indexOf('send:inbound:m1'))
  })

  it('mid_turn_buffer: the second inbound is buffered+persisted, never delivered', () => {
    const { effects } = runMachine(SCHEDULES.mid_turn_buffer)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    // m1 delivered (fresh turn), m2 buffered+persisted (mid-turn).
    expect(ops).toContain('send:inbound:m1')
    expect(ops).toContain('buffer:m2')
    expect(ops).toContain('persist:m2')
    // Invariant #1 at the dispatch layer: buffer implies persist, same msg.
    expect(ops.filter((o) => o === 'buffer:m2')).toHaveLength(1)
    expect(ops.filter((o) => o === 'persist:m2')).toHaveLength(1)
    // m2 is NOT delivered at receipt-time; if it is redelivered at all
    // it happens via the turn-end drainBuffer, i.e. strictly AFTER the
    // turn was cleared — never as an in-turn delivery.
    const m2SendIdx = ops.indexOf('send:inbound:m2')
    if (m2SendIdx !== -1) {
      expect(m2SendIdx).toBeGreaterThan(ops.indexOf('clearTurn:1:_'))
    }
    expect(ops.indexOf('buffer:m2')).toBeLessThan(ops.indexOf('clearTurn:1:_'))
  })

  it('steering_mid_turn: a steer message is delivered mid-turn, not buffered', () => {
    const { effects } = runMachine(SCHEDULES.steering_mid_turn)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    expect(ops).toContain('send:inbound:m1')
    expect(ops).toContain('send:inbound:m2')
    expect(ops).not.toContain('buffer:m2')
  })

  it('bridge_dead_buffer_then_recover: buffer+persist while dead, drain on recover', () => {
    const { effects } = runMachine(SCHEDULES.bridge_dead_buffer_then_recover)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    // Buffered+persisted while dead; the drainBuffer effect at bridgeUp
    // redelivers from the buffer → the recorded buffer push then a send.
    expect(ops).toContain('buffer:m1')
    expect(ops).toContain('persist:m1')
    expect(ops).toContain('send:inbound:m1') // redelivered by drainBuffer
  })

  it('perm_verdict_alive: verdict delivered straight to the bridge', () => {
    const { effects } = runMachine(SCHEDULES.perm_verdict_alive)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    expect(ops).toContain('send:perm:rA')
  })

  it('perm_verdict_dead_then_recover: persisted while dead, redelivered on bridgeUp', () => {
    const { effects } = runMachine(SCHEDULES.perm_verdict_dead_then_recover)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    // Persisted while dead (no direct send at persist time), then the
    // redeliverPersistedPermVerdicts effect at bridgeUp sends it.
    expect(ops).toContain('send:perm:rB')
  })

  it('stale_turn_fallback: fires the fallback poke + clears the turn', () => {
    const { effects } = runMachine(SCHEDULES.stale_turn_fallback)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    expect(ops).toContain('poke:1:_:fallback')
    expect(ops).toContain('clearTurn:1:_')
  })

  it('fresh_turn_user_no_source: a real user inbound (no meta.source) is delivered AND enrolled in the deliver-until-acked sweep', () => {
    const { effects } = runMachine(SCHEDULES.fresh_turn_user_no_source)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    expect(ops).toContain('send:inbound:m1')
    // The enrolment callback MUST fire for no-source user inbounds —
    // shouldTrackDelivery inside the gateway callback is the gate, not
    // a dispatcher-side meta.source pre-filter (review HIGH, PR #3006).
    expect(ops).toContain('enrol:m1')
  })

  it('overlapping_turn_no_spurious_fallback: recent outbound suppresses the poke', () => {
    const { effects } = runMachine(SCHEDULES.overlapping_turn_no_spurious_fallback)
    const { ctx, ops } = makeRecorder()
    dispatchEffects(effects, ctx)
    // Invariant #5: the model broke silence within OUTBOUND_RECENT_MS,
    // so NO fallback poke fires.
    expect(ops.some((o) => o.startsWith('poke:'))).toBe(false)
  })
})

describe('dispatch-equivalence: effect-kind coverage', () => {
  it('the union of all schedule effects covers every machine effect kind that maps to I/O', () => {
    const allKinds = new Set<string>()
    for (const events of Object.values(SCHEDULES)) {
      for (const e of runMachine(events).effects) allKinds.add(e.kind)
    }
    // Every kind produced by the fixtures must be one the dispatcher
    // executes. logTrace is pure telemetry; the rest are I/O.
    const expected = [
      'deliverToBridge',
      'bufferInbound',
      'persistInbound',
      'drainBuffer',
      'setTurnStarted',
      'clearTurnStarted',
      'noteOutbound',
      'firePoke',
      'deliverPermVerdict',
      'persistPermVerdict',
      'redeliverPersistedPermVerdicts',
    ]
    for (const kind of expected) {
      expect(allKinds.has(kind)).toBe(true)
    }
  })
})
