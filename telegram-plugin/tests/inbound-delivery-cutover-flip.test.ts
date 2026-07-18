/**
 * Machine-authoritative inbound routing (#2794 cutover; kill switch
 * removed in #2996 P1).
 *
 * `handleInbound` dispatches the machine's captured `inbound` effects
 * through `dispatchEffects` as the AUTHORITATIVE deliver-vs-buffer routing.
 * These tests pin the delivery outcomes that routing rests on: fresh turn →
 * setTurnStarted + deliverToBridge (real send); mid-turn → buffer (no send,
 * drainable); steer mid-turn → deliverToBridge without setTurnStarted.
 *
 * Plus the `onDeliverResult` observer: the gateway's machine-deliver path
 * branches on the send outcome (delivered → steer-ack + delivery-confirm
 * tracking; miss → durable-buffer + restart notice), so the callback
 * contract (fires once per deliverToBridge, with the real ok, and never
 * breaks delivery when the observer throws) is load-bearing.
 *
 * The `SWITCHROOM_DELIVERY_MACHINE_CUTOVER=0` kill-switch subprocess suite
 * and its fixture probe were deleted in #2996 P1 with the switch itself.
 */

import { describe, expect, it, vi } from 'vitest'
import { dispatchEffects } from '../gateway/inbound-delivery-machine-dispatch'
import type { DispatchCtx } from '../gateway/inbound-delivery-machine-dispatch'
import { createPendingInboundBuffer } from '../gateway/pending-inbound-buffer'
import { createPendingPermissionBuffer } from '../gateway/pending-permission-decisions'
import {
  initialState,
  transition,
  type ChatKey,
  type State,
} from '../gateway/inbound-delivery-machine'

const KEY = '111:_' as ChatKey

function machineMsg(payload: unknown, isSteering = false) {
  return { msgId: 42, isSteering, payload }
}

function ipcMsg(): Record<string, unknown> {
  return {
    type: 'inbound',
    chatId: '111',
    messageId: 42,
    text: 'hello',
    meta: undefined,
  }
}

function makeCtx(overrides?: Partial<DispatchCtx>): {
  ctx: DispatchCtx
  logs: string[]
  sendToAgent: ReturnType<typeof vi.fn>
  inbound: ReturnType<typeof createPendingInboundBuffer>
} {
  const logs: string[] = []
  const sendToAgent = vi.fn(() => true)
  const inbound = createPendingInboundBuffer()
  const ctx: DispatchCtx = {
    selfAgent: 'test-agent',
    ipcServer: { sendToAgent } as never,
    pendingInboundBuffer: inbound,
    inboundSpool: null,
    pendingPermissionBuffer: createPendingPermissionBuffer(),
    log: (line: string) => logs.push(line),
    ...overrides,
  }
  return { ctx, logs, sendToAgent, inbound }
}

/** Drive the pure machine to bridge-alive-idle. */
function aliveIdle(): State {
  return transition(initialState(), { kind: 'bridgeUp', at: 1000 }).state
}

describe('machine-authoritative routing — delivery outcomes', () => {
  it('fresh-turn inbound: machine effects execute setTurnStarted + deliverToBridge', () => {
    const state = aliveIdle()
    const msg = ipcMsg()
    const { effects } = transition(state, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(msg),
      at: 2000,
    })
    expect(effects.map((e) => e.kind)).toEqual([
      'setTurnStarted',
      'deliverToBridge',
      'logTrace',
    ])

    const { ctx, sendToAgent } = makeCtx()
    const marked: Array<[ChatKey, number]> = []
    let deliveredOk: boolean | null = null
    dispatchEffects(effects, {
      ...ctx,
      onSetTurnStarted: (k, at) => marked.push([k, at]),
      onDeliverResult: (_k, ok) => {
        deliveredOk = ok
      },
    })
    // Busy-key mirror stamped BEFORE the send (machine effect order).
    expect(marked).toEqual([[KEY, 2000]])
    expect(sendToAgent).toHaveBeenCalledTimes(1)
    expect(sendToAgent).toHaveBeenCalledWith('test-agent', msg)
    expect(deliveredOk).toBe(true)
  })

  it('mid-turn non-steering inbound: machine effects buffer (no bridge send)', () => {
    // idle → fresh turn for KEY, then a second non-steering inbound mid-turn.
    const s1 = transition(aliveIdle(), {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    }).state
    const held = ipcMsg()
    const { effects } = transition(s1, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(held),
      at: 3000,
    })
    expect(effects.map((e) => e.kind)).toEqual([
      'bufferInbound',
      'persistInbound',
      'logTrace',
    ])

    const { ctx, sendToAgent, inbound } = makeCtx()
    dispatchEffects(effects, ctx)
    expect(sendToAgent).not.toHaveBeenCalled()
    const drained = inbound.drain('test-agent')
    expect(drained).toHaveLength(1)
    expect(drained[0]).toBe(held)
  })

  it('steering inbound mid-turn: delivered to bridge, NO setTurnStarted', () => {
    const s1 = transition(aliveIdle(), {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    }).state
    const steer = ipcMsg()
    const { effects } = transition(s1, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(steer, true),
      at: 3000,
    })
    expect(effects.map((e) => e.kind)).toEqual(['deliverToBridge', 'logTrace'])

    const { ctx, sendToAgent } = makeCtx()
    const marked: unknown[] = []
    dispatchEffects(effects, { ...ctx, onSetTurnStarted: (k) => marked.push(k) })
    expect(sendToAgent).toHaveBeenCalledWith('test-agent', steer)
    expect(marked).toEqual([])
  })
})

describe('onDeliverResult observer contract (the flip’s post-send branch source)', () => {
  it('reports ok=false when sendToAgent returns false (send-miss branch)', () => {
    const state = aliveIdle()
    const { effects } = transition(state, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    })
    const { ctx } = makeCtx({ ipcServer: { sendToAgent: vi.fn(() => false) } as never })
    const results: boolean[] = []
    dispatchEffects(effects, { ...ctx, onDeliverResult: (_k, ok) => results.push(ok) })
    expect(results).toEqual([false])
  })

  it('reports ok=false when the send throws', () => {
    const state = aliveIdle()
    const { effects } = transition(state, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    })
    const { ctx } = makeCtx({
      ipcServer: {
        sendToAgent: vi.fn(() => {
          throw new Error('socket gone')
        }),
      } as never,
    })
    const results: boolean[] = []
    dispatchEffects(effects, { ...ctx, onDeliverResult: (_k, ok) => results.push(ok) })
    expect(results).toEqual([false])
  })

  it('a throwing observer never breaks delivery or enrolment', () => {
    const state = aliveIdle()
    const msg = ipcMsg()
    const { effects } = transition(state, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(msg),
      at: 2000,
    })
    const enrolled: unknown[] = []
    const { ctx, sendToAgent } = makeCtx()
    expect(() =>
      dispatchEffects(effects, {
        ...ctx,
        onDeliverResult: () => {
          throw new Error('observer bug')
        },
        onUserInboundDelivered: (m) => enrolled.push(m),
      }),
    ).not.toThrow()
    expect(sendToAgent).toHaveBeenCalledTimes(1)
    // Enrolment still happened after the observer threw.
    expect(enrolled).toEqual([msg])
  })
})

describe('machine deliver path — steer vs fresh-turn setTurnStarted contract', () => {
  // The gateway's machine-deliver wiring keys "was this a fresh turn?" off
  // the setTurnStarted effect: a mid-turn steer emits deliverToBridge
  // WITHOUT setTurnStarted (it amends the running turn, it does not open
  // one). A machine change that started emitting setTurnStarted for steers
  // would mis-classify steers as fresh turns at the live call site.
  it('steer mid-turn emits NO setTurnStarted even on a send-miss', () => {
    const s1 = transition(aliveIdle(), {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    }).state
    const { effects } = transition(s1, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg(), true),
      at: 3000,
    })
    expect(effects.some((e) => e.kind === 'setTurnStarted')).toBe(false)
    let stamped: string | null = null
    let delivered = true
    const { ctx } = makeCtx({ ipcServer: { sendToAgent: vi.fn(() => false) } as never })
    dispatchEffects(effects, {
      ...ctx,
      onSetTurnStarted: (k) => {
        stamped = k
      },
      onDeliverResult: (_k, ok) => {
        delivered = ok
      },
    })
    expect(stamped).toBeNull()
    expect(delivered).toBe(false)
  })

  it('fresh turn fires setTurnStarted exactly once, before the send', () => {
    const { effects } = transition(aliveIdle(), {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    })
    const order: string[] = []
    const sendToAgent = vi.fn(() => {
      order.push('send')
      return true
    })
    const { ctx } = makeCtx({ ipcServer: { sendToAgent } as never })
    dispatchEffects(effects, {
      ...ctx,
      onSetTurnStarted: () => order.push('setTurnStarted'),
    })
    expect(order).toEqual(['setTurnStarted', 'send'])
  })
})

describe('carve-out routing anchors (gateway keys off these machine facts)', () => {
  it('PIN: bridge-dead inbound emits the exact `inbound_bridge_dead_buffer` trace stage', () => {
    // gateway.ts's machineBridgeDead carve-out matches this string verbatim
    // to route bridge-dead inbounds to the imperative delivery body. A
    // rename here silently reroutes them to the machine's buffer+persist
    // (losing the shouldTrackDelivery drop semantics + restart notice) —
    // this pin makes the rename loud. Deleted with the carve-out when the
    // machine grows bridge_dead send semantics (#2794 PR4 remainder).
    const dead = initialState() // bridge_dead is the initial global state
    const { effects } = transition(dead, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    })
    expect(effects.map((e) => e.kind)).toEqual(['bufferInbound', 'persistInbound', 'logTrace'])
    expect(effects.find((e) => e.kind === 'logTrace')).toMatchObject({
      stage: 'inbound_bridge_dead_buffer',
    })
  })

  it('interrupt-while-in-turn carve-out: a mid-turn non-steering inbound buffers (gateway must reroute interrupts to the twin)', () => {
    // The machine has no interrupt event — a `!`-interrupt body looks like a
    // plain mid-turn inbound and would BUFFER (stranding it: the SIGINT'd
    // turn may never emit turn_complete). gateway.ts's machineAuthoritative
    // predicate therefore excludes `machineBuffers && isInterrupt` and falls
    // back to the twin's deliver carve-out. This pins the machine fact the
    // predicate rests on.
    const s1 = transition(aliveIdle(), {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    }).state
    const { effects } = transition(s1, {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg(), false),
      at: 3000,
    })
    expect(effects.some((e) => e.kind === 'bufferInbound')).toBe(true)
    expect(effects.some((e) => e.kind === 'deliverToBridge')).toBe(false)
  })
})
