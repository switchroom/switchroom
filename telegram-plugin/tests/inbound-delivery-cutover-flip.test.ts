/**
 * PR3c cutover flip (#2794 / #2996 item 1) — the inbound-routing flip.
 *
 * `handleInbound` now dispatches the machine's captured `inbound` effects
 * through `dispatchEffects` as the AUTHORITATIVE deliver-vs-buffer routing.
 * These tests pin the two contract halves the flip rests on:
 *
 *   1. DEFAULT ON — with no env override, both the cutover gate
 *      (`isDeliveryCutoverEnabled`) and the dispatcher (`isDispatchEnabled`)
 *      are enabled, and the machine's effect sequences execute real I/O
 *      (fresh turn → setTurnStarted + deliverToBridge; mid-turn → buffer).
 *
 *   2. KILL SWITCH — `SWITCHROOM_DELIVERY_MACHINE_CUTOVER=0` restores
 *      legacy behavior: the gate reads legacy claudeBusyKeys (gate returns
 *      false from `isDeliveryCutoverEnabled`) and `dispatchEffects` is a
 *      total no-op, so the imperative twin in gateway.ts is the only
 *      executor. Env is read at module load, so the kill-switch tests use
 *      vi.resetModules + a fresh dynamic import.
 *
 * Plus the `onDeliverResult` observer added for the flip: the gateway's
 * machine-deliver path branches on the send outcome (delivered → busy-mark
 * + delivery-confirm tracking; miss → release + durable-buffer + restart
 * notice), so the callback contract (fires once per deliverToBridge, with
 * the real ok, and never breaks delivery when the observer throws) is
 * load-bearing.
 */

import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  dispatchEffects,
  isDispatchEnabled,
} from '../gateway/inbound-delivery-machine-dispatch'
import type { DispatchCtx } from '../gateway/inbound-delivery-machine-dispatch'
import { createPendingInboundBuffer } from '../gateway/pending-inbound-buffer'
import { createPendingPermissionBuffer } from '../gateway/pending-permission-decisions'
import {
  initialState,
  transition,
  type ChatKey,
  type State,
} from '../gateway/inbound-delivery-machine'
import {
  isDeliveryCutoverEnabled,
} from '../gateway/inbound-delivery-machine-shadow'

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

describe('cutover default — ON without env override', () => {
  it('dispatcher and gate are enabled by default (no kill-switch in test env)', () => {
    expect(process.env.SWITCHROOM_DELIVERY_MACHINE_CUTOVER).toBeUndefined()
    expect(isDispatchEnabled()).toBe(true)
    expect(isDeliveryCutoverEnabled()).toBe(true)
  })

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

describe('machine deliver path — send-miss busy-key handling (review fix, PR #3012)', () => {
  // Mirrors the gateway's machine-deliver wiring: onSetTurnStarted stamps
  // the busy mirror AND records the key; the miss branch releases ONLY a
  // key THIS dispatch stamped. A steer-miss must keep the original turn's
  // key (the twin never reserves for steers), else the wiped key fires a
  // false machine_over_holds parity drift and the pending-restart gate
  // (claudeBusyKeys.size) could green-light a mid-turn restart.
  function runMissHarness(
    effects: ReturnType<typeof transition>['effects'],
    busyKeys: Set<string>,
  ): { stamped: string | null } {
    let stamped: string | null = null
    let delivered = false
    const { ctx } = makeCtx({ ipcServer: { sendToAgent: vi.fn(() => false) } as never })
    dispatchEffects(effects, {
      ...ctx,
      onSetTurnStarted: (k) => {
        stamped = k
        busyKeys.add(k)
      },
      onDeliverResult: (_k, ok) => {
        delivered = ok
      },
    })
    expect(delivered).toBe(false)
    // Gateway miss branch (guarded release):
    if (stamped != null) busyKeys.delete(stamped)
    return { stamped }
  }

  it('fresh-turn miss: the key THIS dispatch stamped is released', () => {
    const busyKeys = new Set<string>()
    const { effects } = transition(aliveIdle(), {
      kind: 'inbound',
      key: KEY,
      msg: machineMsg(ipcMsg()),
      at: 2000,
    })
    const { stamped } = runMissHarness(effects, busyKeys)
    expect(stamped).toBe(KEY)
    expect(busyKeys.has(KEY)).toBe(false)
  })

  it('steer miss: no setTurnStarted fired, the ORIGINAL turn\'s key survives', () => {
    // Original fresh turn holds the busy key.
    const busyKeys = new Set<string>([KEY])
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
    const { stamped } = runMissHarness(effects, busyKeys)
    expect(stamped).toBeNull()
    // The in-flight turn's key was NOT wiped by the steer's send-miss.
    expect(busyKeys.has(KEY)).toBe(true)
  })
})

describe('carve-out routing anchors (gateway keys off these machine facts)', () => {
  it('PIN: bridge-dead inbound emits the exact `inbound_bridge_dead_buffer` trace stage', () => {
    // gateway.ts's machineBridgeDead carve-out matches this string verbatim
    // to route bridge-dead inbounds to the imperative twin. A rename here
    // silently reroutes them to the machine's buffer+persist (losing the
    // twin's shouldTrackDelivery drop semantics + restart notice) — this
    // pin makes the rename loud. Deleted in PR4 with the twin.
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

// The env var is read at MODULE LOAD in the dispatch + shadow modules, and
// bun's `vi` shim has no resetModules/stubEnv — so the kill-switch/default
// assertions run the fixture probe in a SUBPROCESS with a controlled env
// (same pattern as bridge-anonymous-refuse.test.ts).
describe('kill switch — SWITCHROOM_DELIVERY_MACHINE_CUTOVER=0 restores legacy (subprocess)', () => {
  const PROBE = join(__dirname, 'fixtures', 'cutover-killswitch-probe.ts')

  function bunBin(): string | null {
    const r = spawnSync('which', ['bun'], { encoding: 'utf-8' })
    const p = r.status === 0 ? r.stdout.trim() : ''
    return p !== '' ? p : null
  }

  function runProbe(env: Record<string, string | undefined>) {
    const bun = bunBin()
    if (bun == null) return null
    const r = spawnSync(bun, ['run', PROBE], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 30_000,
    })
    expect(r.status).toBe(0)
    const line = r.stdout.trim().split('\n').pop() ?? ''
    return JSON.parse(line) as {
      dispatchEnabled: boolean
      cutoverEnabled: boolean
      shadowEnabled: boolean
      sendCalls: number
      buffered: number
      setTurnStartedCalls: number
      deliverResults: boolean[]
    }
  }

  it('default (no env): machine authoritative — dispatcher executes the deliver', () => {
    const v = runProbe({ SWITCHROOM_DELIVERY_MACHINE_CUTOVER: undefined })
    if (v == null) return // bun not on PATH — covered by the in-process default tests above
    expect(v.dispatchEnabled).toBe(true)
    expect(v.cutoverEnabled).toBe(true)
    expect(v.sendCalls).toBe(1)
    expect(v.setTurnStartedCalls).toBe(1)
    expect(v.deliverResults).toEqual([true])
    expect(v.buffered).toBe(0)
  })

  it('=0: dispatcher is a total no-op and the gate reverts to legacy; shadow stays on', () => {
    const v = runProbe({ SWITCHROOM_DELIVERY_MACHINE_CUTOVER: '0' })
    if (v == null) return
    expect(v.dispatchEnabled).toBe(false)
    expect(v.cutoverEnabled).toBe(false)
    // Shadow trace continues for the bake; only authoritative reads flip off.
    expect(v.shadowEnabled).toBe(true)
    expect(v.sendCalls).toBe(0)
    expect(v.buffered).toBe(0)
    expect(v.setTurnStartedCalls).toBe(0)
    expect(v.deliverResults).toEqual([])
  })

  it('=1 (explicit on): identical to the default', () => {
    const v = runProbe({ SWITCHROOM_DELIVERY_MACHINE_CUTOVER: '1' })
    if (v == null) return
    expect(v.dispatchEnabled).toBe(true)
    expect(v.cutoverEnabled).toBe(true)
    expect(v.sendCalls).toBe(1)
  })
})
