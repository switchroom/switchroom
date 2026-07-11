/**
 * Pin the gateway trace verbosity gate (#3025): zero-signal per-poll
 * heartbeats are suppressed by default and the full firehose is restored
 * only when SWITCHROOM_GW_TRACE is truthy. Error lines and real
 * (non-poll / non-idle-tick) activity ALWAYS emit regardless of the flag.
 *
 * DUAL-RUNNER NOTE (vitest + bun): this file runs under BOTH runners, and
 * bun's vitest shim does not honor `vi.resetModules()` — a re-import
 * returns the originally-cached module, so flag variants CANNOT be tested
 * via env + fresh import. Instead the gate exposes pure paths: the env
 * parse is `computeGwTraceVerbose(flag)` and both should-emit functions
 * take an explicit `verbose` argument (defaulting to the module-init
 * read). Tests pass verbosity explicitly.
 */

import { describe, it, expect } from 'vitest'
import {
  computeGwTraceVerbose,
  shouldEmitTgPost,
  shouldEmitShadowTrace,
} from '../shared/gw-trace-gate.js'

describe('computeGwTraceVerbose — env flag parsing', () => {
  it('is OFF when unset', () => {
    expect(computeGwTraceVerbose(undefined)).toBe(false)
  })

  it('opts IN on the truthy set, case-insensitively (1/true/yes/on)', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'Yes', 'YES', 'on', 'ON', 'On', ' 1', 'true ']) {
      expect(computeGwTraceVerbose(v)).toBe(true)
    }
  })

  it('stays OFF for falsey / unrecognized values', () => {
    for (const v of ['', '0', 'false', 'FALSE', 'off', 'No', 'x', 'enabled']) {
      expect(computeGwTraceVerbose(v)).toBe(false)
    }
  })
})

describe('shouldEmitTgPost — default (verbose=false): suppress poll heartbeats', () => {
  it('suppresses status=ok for getUpdates and getMe', () => {
    expect(shouldEmitTgPost('getUpdates', 'ok', false)).toBe(false)
    expect(shouldEmitTgPost('getMe', 'ok', false)).toBe(false)
  })

  it('ALWAYS emits error lines, even for the poll methods', () => {
    expect(shouldEmitTgPost('getUpdates', 'err', false)).toBe(true)
    expect(shouldEmitTgPost('getMe', 'err', false)).toBe(true)
  })

  it('keeps status=ok for real outbound methods', () => {
    for (const m of ['sendMessage', 'editMessageText', 'sendChatAction', 'answerCallbackQuery']) {
      expect(shouldEmitTgPost(m, 'ok', false)).toBe(true)
    }
  })
})

describe('shouldEmitShadowTrace — default (verbose=false): suppress idle no-op ticks', () => {
  it('suppresses a tick with no effects in an idle global state', () => {
    expect(shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle', false)).toBe(false)
    expect(shouldEmitShadowTrace('tick', 0, 'bridge_dead', false)).toBe(false)
  })

  it('emits a tick that produced effects (e.g. a TTL turn expiry)', () => {
    expect(shouldEmitShadowTrace('tick', 1, 'bridge_alive_idle', false)).toBe(true)
  })

  it('emits a tick while a turn is in flight', () => {
    expect(shouldEmitShadowTrace('tick', 0, 'bridge_alive_in_turn', false)).toBe(true)
  })

  it('ALWAYS emits non-tick events (real inbound/turn/bridge activity)', () => {
    for (const ev of ['inbound', 'turnStart', 'turnEnd', 'bridgeUp', 'bridgeDown', 'permVerdict']) {
      expect(shouldEmitShadowTrace(ev, 0, 'bridge_alive_idle', false)).toBe(true)
    }
  })
})

describe('verbose=true — full firehose restored', () => {
  it('emits every line, including the two suppressed-by-default families', () => {
    expect(shouldEmitTgPost('getUpdates', 'ok', true)).toBe(true)
    expect(shouldEmitTgPost('getMe', 'ok', true)).toBe(true)
    expect(shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle', true)).toBe(true)
    expect(shouldEmitShadowTrace('tick', 0, 'bridge_dead', true)).toBe(true)
  })
})

describe('default verbose argument wiring', () => {
  it('the defaulted call form works and matches the module-init env read', () => {
    // Env-agnostic assertion: the defaulted form must agree with the
    // explicit form using the parsed CURRENT env — proving the default
    // parameter is wired to the module-init flag, whatever its value in
    // the test process.
    const envVerbose = computeGwTraceVerbose(process.env.SWITCHROOM_GW_TRACE)
    expect(shouldEmitTgPost('getUpdates', 'ok')).toBe(
      shouldEmitTgPost('getUpdates', 'ok', envVerbose),
    )
    expect(shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle')).toBe(
      shouldEmitShadowTrace('tick', 0, 'bridge_alive_idle', envVerbose),
    )
    // Regardless of the flag, an error line always emits via the default form.
    expect(shouldEmitTgPost('getUpdates', 'err')).toBe(true)
  })
})
