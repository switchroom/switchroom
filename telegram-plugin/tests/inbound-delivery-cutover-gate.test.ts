/**
 * The turn-in-flight GATE reads the delivery state machine
 * (`isMachineInTurn`) — since #2996 P1 the machine is the SOLE authority
 * (the legacy `claudeBusyKeys` set was deleted).
 *
 * The bug the machine gate closes (gymbro/clerk, 2026-05-28): the legacy
 * set was per-delivery — every delivery `.add`ed a key, but turn-end
 * `.delete`d exactly one. When a turn-end was missed (or fired under a
 * non-matching key) the set kept an orphan, `size > 0` read true forever,
 * and EVERY subsequent inbound buffered as "held mid-turn" until the 5-min
 * framework-fallback force-drained it.
 *
 * The machine cannot accumulate orphans: global state holds ONE
 * `activeTurn`, so any matching turnEnd returns it to idle, and the TTL
 * `tick` self-heals a missed turnEnd. These tests pin both the normal
 * reopen and the dangle-recovery path on the accessors the gate reads.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  shadowEmit,
  isMachineInTurn,
  __shadowResetForTests,
} from '../gateway/inbound-delivery-machine-shadow.js'
import { TURN_TTL_MS, type ChatKey } from '../gateway/inbound-delivery-machine.js'

const KEY_A = '111:_' as ChatKey
const KEY_B = '222:_' as ChatKey

function inbound(key: ChatKey, at: number, msgId = 1) {
  shadowEmit({ kind: 'inbound', key, msg: { msgId, isSteering: false, payload: null }, at })
}

describe('machine turn-in-flight gate accessors (sole authority, #2996 P1)', () => {
  beforeEach(() => __shadowResetForTests())

  it('reads idle before any turn (bridge alive)', () => {
    shadowEmit({ kind: 'bridgeUp', at: 1000 })
    expect(isMachineInTurn()).toBe(false)
  })

  it('flips in-turn on a fresh inbound and reopens on turnEnd (the gate reopen)', () => {
    shadowEmit({ kind: 'bridgeUp', at: 1000 })
    inbound(KEY_A, 2000)
    expect(isMachineInTurn()).toBe(true)
    shadowEmit({ kind: 'turnEnd', key: KEY_A, at: 3000, outboundEmitted: true })
    // Gate reopens immediately — this is the path claudeBusyKeys danged on.
    expect(isMachineInTurn()).toBe(false)
  })

  it('self-heals a MISSED turnEnd via the TTL tick (the dangle the fix kills)', () => {
    shadowEmit({ kind: 'bridgeUp', at: 1000 })
    // Turn A starts via enqueue (turnStart), then turn B starts before A's
    // turnEnd ever lands — the orphan scenario. The machine keeps
    // activeTurn=A (turnStart is a no-op on global when already in_turn),
    // so a later turnEnd(B) does NOT match and would leave A dangling.
    shadowEmit({ kind: 'turnStart', key: KEY_A, at: 2000 })
    shadowEmit({ kind: 'turnStart', key: KEY_B, at: 3000 })
    shadowEmit({ kind: 'turnEnd', key: KEY_B, at: 4000, outboundEmitted: true })
    // Without tick, the gate would still read in-turn (activeTurn=A stuck).
    expect(isMachineInTurn()).toBe(true)
    // TTL tick past A's start clears the orphan and reopens the gate —
    // the structural guarantee claudeBusyKeys lacked.
    shadowEmit({ kind: 'tick', now: 2000 + TURN_TTL_MS + 1 })
    expect(isMachineInTurn()).toBe(false)
  })

  it('does NOT clear a long-but-ACTIVE turn (modelOutbound suppression)', () => {
    shadowEmit({ kind: 'bridgeUp', at: 1000 })
    shadowEmit({ kind: 'turnStart', key: KEY_A, at: 2000 })
    // Model is still streaming just before the TTL boundary.
    const justBeforeTtl = 2000 + TURN_TTL_MS - 5_000
    shadowEmit({ kind: 'modelOutbound', key: KEY_A, at: justBeforeTtl })
    // Tick past TTL — but recent outbound is within the suppression window,
    // so the turn is NOT cleared (parity with the imperative silence-poke).
    shadowEmit({ kind: 'tick', now: 2000 + TURN_TTL_MS + 1 })
    expect(isMachineInTurn()).toBe(true)
  })

  it('a buffered sibling inbound does not change the active turn', () => {
    shadowEmit({ kind: 'bridgeUp', at: 1000 })
    inbound(KEY_A, 2000) // fresh turn A
    inbound(KEY_B, 2500) // mid-turn — buffered, must NOT start a new turn
    expect(isMachineInTurn()).toBe(true)
    shadowEmit({ kind: 'turnEnd', key: KEY_A, at: 3000, outboundEmitted: true })
    // A ended; nothing else active → gate reopens so B can drain.
    expect(isMachineInTurn()).toBe(false)
  })
})
