/**
 * Pin the gateway trace verbosity gate (#3025): zero-signal per-poll
 * heartbeats are suppressed by default and the full firehose is restored
 * only when SWITCHROOM_GW_TRACE is truthy. Error lines and real
 * (non-poll / non-idle-tick) activity ALWAYS emit regardless of the flag.
 *
 * The gate reads the env flag once at module init, so each state is
 * exercised via vi.resetModules() + a fresh dynamic import with the env
 * set — mirroring how the module is loaded in the running gateway.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Gate = typeof import('../shared/gw-trace-gate.js')

async function loadGate(flag: string | undefined): Promise<Gate> {
  vi.resetModules()
  if (flag === undefined) delete process.env.SWITCHROOM_GW_TRACE
  else process.env.SWITCHROOM_GW_TRACE = flag
  return import('../shared/gw-trace-gate.js')
}

const savedFlag = process.env.SWITCHROOM_GW_TRACE

beforeEach(() => {
  delete process.env.SWITCHROOM_GW_TRACE
})

afterEach(() => {
  if (savedFlag === undefined) delete process.env.SWITCHROOM_GW_TRACE
  else process.env.SWITCHROOM_GW_TRACE = savedFlag
})

describe('shouldEmitTgPost — default (flag unset): suppress poll heartbeats', () => {
  it('suppresses status=ok for getUpdates and getMe', async () => {
    const gate = await loadGate(undefined)
    expect(gate.gwTraceVerbose).toBe(false)
    expect(gate.shouldEmitTgPost('getUpdates', 'ok')).toBe(false)
    expect(gate.shouldEmitTgPost('getMe', 'ok')).toBe(false)
  })

  it('ALWAYS emits error lines, even for the poll methods', async () => {
    const gate = await loadGate(undefined)
    expect(gate.shouldEmitTgPost('getUpdates', 'err')).toBe(true)
    expect(gate.shouldEmitTgPost('getMe', 'err')).toBe(true)
  })

  it('keeps status=ok for real outbound methods', async () => {
    const gate = await loadGate(undefined)
    for (const m of ['sendMessage', 'editMessageText', 'sendChatAction', 'answerCallbackQuery']) {
      expect(gate.shouldEmitTgPost(m, 'ok')).toBe(true)
    }
  })
})

describe('shouldEmitShadowTrace — default (flag unset): suppress idle no-op ticks', () => {
  it('suppresses a tick with no effects in an idle global state', async () => {
    const gate = await loadGate(undefined)
    expect(gate.shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle')).toBe(false)
    expect(gate.shouldEmitShadowTrace('tick', 0, 'bridge_dead')).toBe(false)
  })

  it('emits a tick that produced effects (e.g. a TTL turn expiry)', async () => {
    const gate = await loadGate(undefined)
    expect(gate.shouldEmitShadowTrace('tick', 1, 'bridge_alive_idle')).toBe(true)
  })

  it('emits a tick while a turn is in flight', async () => {
    const gate = await loadGate(undefined)
    expect(gate.shouldEmitShadowTrace('tick', 0, 'bridge_alive_in_turn')).toBe(true)
  })

  it('ALWAYS emits non-tick events (real inbound/turn/bridge activity)', async () => {
    const gate = await loadGate(undefined)
    for (const ev of ['inbound', 'turnStart', 'turnEnd', 'bridgeUp', 'bridgeDown', 'permVerdict']) {
      expect(gate.shouldEmitShadowTrace(ev, 0, 'bridge_alive_idle')).toBe(true)
    }
  })
})

describe('SWITCHROOM_GW_TRACE truthy — full firehose restored', () => {
  for (const flag of ['1', 'true']) {
    it(`emits every line when flag=${flag}`, async () => {
      const gate = await loadGate(flag)
      expect(gate.gwTraceVerbose).toBe(true)
      // The two lines suppressed by default are now emitted.
      expect(gate.shouldEmitTgPost('getUpdates', 'ok')).toBe(true)
      expect(gate.shouldEmitTgPost('getMe', 'ok')).toBe(true)
      expect(gate.shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle')).toBe(true)
      expect(gate.shouldEmitShadowTrace('tick', 0, 'bridge_dead')).toBe(true)
    })
  }

  it('leaves the gate OFF for falsey/unrecognized values', async () => {
    for (const flag of ['0', 'false', '', 'yes', 'on']) {
      const gate = await loadGate(flag)
      expect(gate.gwTraceVerbose).toBe(false)
      expect(gate.shouldEmitTgPost('getUpdates', 'ok')).toBe(false)
      expect(gate.shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle')).toBe(false)
    }
  })
})
