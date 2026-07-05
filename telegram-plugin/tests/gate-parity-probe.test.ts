/**
 * Drift-catching scaffolding for the inbound-delivery state-machine
 * cutover (#2794). The turn-in-flight gate is now machine-authoritative
 * (`isMachineInTurn`), but the legacy imperative `claudeBusyKeys` set is
 * still maintained in parallel. These tests assert the two AGREE on every
 * well-formed turn schedule, and pin the ONE intended divergence (the
 * orphan-dangle the machine self-heals) so future edits can't silently
 * introduce a dangerous `machine_over_holds` drift without turning a test
 * red.
 *
 * This is the "assertion that machine and shadow agree" from the #2794
 * time-box plan: it turns the standing triple-maintenance drift risk into
 * a CI gate.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  shadowEmit,
  isMachineInTurn,
  __shadowResetForTests,
} from '../gateway/inbound-delivery-machine-shadow.js'
import { TURN_TTL_MS, type ChatKey } from '../gateway/inbound-delivery-machine.js'
import {
  gateParityDivergence,
  isDangerousGateDivergence,
  probeGateParity,
} from '../gateway/gate-parity-probe.js'

const KEY_A = '111:_' as ChatKey
const KEY_B = '222:_' as ChatKey

/**
 * Reference model of the imperative `claudeBusyKeys` set — a per-delivery
 * Set stamped on a fresh-turn delivery and deleted on the matching
 * turnEnd. This mirrors gateway.ts's markBusyKeyLockstep / claudeBusyKeys.delete
 * lifecycle closely enough to detect real drift in the gate view.
 */
class BusyKeysModel {
  private readonly keys = new Set<string>()
  stampFreshTurn(key: string) {
    this.keys.add(key)
  }
  endTurn(key: string) {
    this.keys.delete(key)
  }
  get size() {
    return this.keys.size
  }
}

describe('gateParityDivergence classifier', () => {
  it('agree → none (both idle, both busy)', () => {
    expect(gateParityDivergence(false, 0)).toBe('none')
    expect(gateParityDivergence(true, 1)).toBe('none')
    expect(gateParityDivergence(true, 3)).toBe('none')
  })

  it('machine idle, busyKeys held → busykeys_dangle (benign self-heal)', () => {
    expect(gateParityDivergence(false, 1)).toBe('busykeys_dangle')
    expect(isDangerousGateDivergence('busykeys_dangle')).toBe(false)
  })

  it('machine in-flight, busyKeys empty → machine_over_holds (dangerous)', () => {
    expect(gateParityDivergence(true, 0)).toBe('machine_over_holds')
    expect(isDangerousGateDivergence('machine_over_holds')).toBe(true)
  })

  it('probeGateParity returns the machine value unchanged (no behaviour change)', () => {
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    expect(probeGateParity(true, 1, log)).toBe(true)
    expect(probeGateParity(false, 0, log)).toBe(false)
    expect(probeGateParity(false, 1, log)).toBe(false)
    expect(probeGateParity(true, 0, log)).toBe(true)
    // Only the dangerous over-hold emits a drift line.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('gw-trace gate-drift kind=machine_over_holds')
  })
})

describe('machine ↔ claudeBusyKeys parity on well-formed schedules', () => {
  beforeEach(() => __shadowResetForTests())

  it('single turn: agree at every step', () => {
    const busy = new BusyKeysModel()
    shadowEmit({ kind: 'bridgeUp', at: 1000 })
    expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')

    // Fresh inbound → machine goes in_turn; imperative stamps the key.
    shadowEmit({ kind: 'inbound', key: KEY_A, msg: { msgId: 1, isSteering: false, payload: null }, at: 2000 })
    busy.stampFreshTurn(KEY_A)
    expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')
    expect(isMachineInTurn()).toBe(true)

    // turnEnd → both reopen.
    shadowEmit({ kind: 'turnEnd', key: KEY_A, at: 3000, outboundEmitted: true })
    busy.endTurn(KEY_A)
    expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')
    expect(isMachineInTurn()).toBe(false)
  })

  it('sequential turns across two chats: no drift', () => {
    const busy = new BusyKeysModel()
    shadowEmit({ kind: 'bridgeUp', at: 1000 })

    const schedule: Array<[ChatKey, number]> = [
      [KEY_A, 2000],
      [KEY_B, 4000],
      [KEY_A, 6000],
    ]
    let t = 2000
    for (const [key, start] of schedule) {
      shadowEmit({ kind: 'inbound', key, msg: { msgId: t, isSteering: false, payload: null }, at: start })
      busy.stampFreshTurn(key)
      expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')
      shadowEmit({ kind: 'turnEnd', key, at: start + 500, outboundEmitted: true })
      busy.endTurn(key)
      expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')
      t = start + 500
    }
  })

  it('mid-turn sibling inbound is buffered, not a new turn: parity holds', () => {
    const busy = new BusyKeysModel()
    shadowEmit({ kind: 'bridgeUp', at: 1000 })

    shadowEmit({ kind: 'inbound', key: KEY_A, msg: { msgId: 1, isSteering: false, payload: null }, at: 2000 })
    busy.stampFreshTurn(KEY_A)
    // Sibling arrives mid-turn: machine buffers (no new activeTurn); the
    // imperative gate is already busy so it does NOT stamp a fresh key.
    shadowEmit({ kind: 'inbound', key: KEY_B, msg: { msgId: 2, isSteering: false, payload: null }, at: 2500 })
    expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')

    shadowEmit({ kind: 'turnEnd', key: KEY_A, at: 3000, outboundEmitted: true })
    busy.endTurn(KEY_A)
    expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')
  })
})

describe('the ONE intended divergence: orphaned turnStart', () => {
  beforeEach(() => __shadowResetForTests())

  it('machine self-heals the dangle; imperative set holds the orphan (busykeys_dangle, benign)', () => {
    const busy = new BusyKeysModel()
    shadowEmit({ kind: 'bridgeUp', at: 1000 })

    // Turn A opens; turn B opens before A's turnEnd ever lands. The
    // imperative set stamps BOTH; only B's turnEnd arrives, leaving A as
    // an orphan key — the gymbro/clerk 5-min dangle.
    shadowEmit({ kind: 'turnStart', key: KEY_A, at: 2000 })
    busy.stampFreshTurn(KEY_A)
    shadowEmit({ kind: 'turnStart', key: KEY_B, at: 3000 })
    busy.stampFreshTurn(KEY_B)
    shadowEmit({ kind: 'turnEnd', key: KEY_B, at: 4000, outboundEmitted: true })
    busy.endTurn(KEY_B)

    // Machine still holds activeTurn=A (single-activeTurn); imperative
    // holds A too → they agree here.
    expect(gateParityDivergence(isMachineInTurn(), busy.size)).toBe('none')

    // TTL tick past A's start: the machine self-heals to idle, but the
    // imperative set NEVER gets A's turnEnd → orphan dangles forever.
    shadowEmit({ kind: 'tick', now: 2000 + TURN_TTL_MS + 1 })
    expect(isMachineInTurn()).toBe(false)
    const d = gateParityDivergence(isMachineInTurn(), busy.size)
    expect(d).toBe('busykeys_dangle')
    // Benign: this is exactly the wedge the machine was made authoritative
    // to kill — it must NOT trip the drift alarm.
    expect(isDangerousGateDivergence(d)).toBe(false)
  })
})
