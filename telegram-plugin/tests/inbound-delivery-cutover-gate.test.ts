/**
 * PR3b cutover — the turn-in-flight GATE now reads the delivery state
 * machine (`isMachineInTurn`) instead of the PR3b `claudeBusyKeys` set.
 *
 * The bug this closes (gymbro/clerk, 2026-05-28): `claudeBusyKeys` is a
 * per-delivery Set — every delivery `.add`s a key, but turn-end `.delete`s
 * exactly one. When a turn-end is missed (or fires under a non-matching
 * key) the set keeps an orphan, `size > 0` reads true forever, and EVERY
 * subsequent inbound buffers as "held mid-turn" until the 5-min
 * framework-fallback force-drains it.
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
  isDeliveryCutoverEnabled,
  __shadowResetForTests,
} from '../gateway/inbound-delivery-machine-shadow.js'
import { TURN_TTL_MS, type ChatKey } from '../gateway/inbound-delivery-machine.js'

const KEY_A = '111:_' as ChatKey
const KEY_B = '222:_' as ChatKey

function inbound(key: ChatKey, at: number, msgId = 1) {
  shadowEmit({ kind: 'inbound', key, msg: { msgId, isSteering: false, payload: null }, at })
}

describe('PR3b cutover gate accessors', () => {
  beforeEach(() => __shadowResetForTests())

  it('enabled by default (shadow on, no kill-switch in test env)', () => {
    expect(isDeliveryCutoverEnabled()).toBe(true)
  })

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
