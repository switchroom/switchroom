/**
 * Regression tests for the single-writer election (duplicate-message fix).
 *
 * RCA: when a turn ends with its final answer as PLAIN TRANSCRIPT TEXT (no
 * `reply` tool call), two uncoordinated recovery paths both fired — (A) the
 * gateway turn-end flush (`decideTurnFlush`) delivered the captured prose, and
 * (B) this Stop hook blocked and re-prompted, regenerating a REWORDED reply
 * that defeated the exact-match dedup. The user got two near-identical
 * messages.
 *
 * Fix: the Stop hook is the single elector (`decideStopHookDisposition`). On a
 * would-BLOCK scan it ALLOWS the stop — handing delivery to the gateway's
 * flush / captured-prose bridge — IFF four never-drop gates all hold; otherwise
 * it BLOCKS exactly as today. These tests pin the whole verdict matrix and
 * prove every allow path has a delivery machine and every guard forces BLOCK.
 */

import { describe, it, expect } from 'vitest'
import {
  decideStopHookDisposition,
  isTurnFlushSafetyEnabledEnv,
  isCapturedProseDeliveryEnabledEnv,
  isGatewayHeartbeatFresh,
  GATEWAY_HEARTBEAT_FRESH_MS,
} from '../hooks/silent-end-scan.mjs'
import {
  mkdtempSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Scan fixtures — the shapes `scanTurnForFinalReply` returns on a would-block.
const ZERO_REPLY_LONG = {
  decided: 'block' as const,
  reason: 'no-final-reply',
  turnKey: 'c:_',
  hasTrailingProse: true,
  pendingText: 'A'.repeat(300),
}
const ZERO_REPLY_SHORT = {
  decided: 'block' as const,
  reason: 'no-final-reply',
  turnKey: 'c:_',
  hasTrailingProse: true,
  pendingText: 'ok done',
}
const ZERO_REPLY_NO_PROSE = {
  decided: 'block' as const,
  reason: 'no-final-reply',
  turnKey: 'c:_',
  // hasTrailingProse absent — tool-calls-only turn, nothing for a machine to send.
}
const INTERIM_ACK_LONG = {
  decided: 'block' as const,
  reason: 'trailing-text-after-reply',
  turnKey: 'c:_',
  hasTrailingProse: true,
  pendingText: 'B'.repeat(300),
}
const INTERIM_ACK_SHORT = {
  decided: 'block' as const,
  reason: 'trailing-text-after-reply',
  turnKey: 'c:_',
  hasTrailingProse: true,
  pendingText: 'thanks!',
}

const ALL_ON = {
  retryCount: 0,
  turnFlushSafetyEnabled: true,
  capturedProseDeliveryEnabled: true,
  gatewayLive: true,
}

describe('decideStopHookDisposition — duplicate repro (#1: zero-reply ≥200)', () => {
  it('zero-reply long answer, flags on, retry 0, live → ALLOW-elected (today it blocks → duplicate)', () => {
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON })
    expect(d.action).toBe('allow-elected')
    expect(d.reason).toBe('flush-will-deliver')
  })
})

describe('decideStopHookDisposition — short-answer repro (#2: zero-reply <200)', () => {
  it('zero-reply SHORT answer, flags on, retry 0, live → ALLOW-elected (flush has no length floor)', () => {
    // Today this BLOCKS *and* the flush fires → duplicate. Exactly one machine
    // must win: the flush. The election allows the stop so the hook does not
    // also re-prompt.
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_SHORT, ...ALL_ON })
    expect(d.action).toBe('allow-elected')
  })
})

describe('decideStopHookDisposition — never-drop matrix (#3)', () => {
  it('every ALLOW verdict is backed by a delivery machine', () => {
    // Zero-reply → the turn-flush delivers (no length floor); interim-ack ≥200 →
    // the captured-prose bridge delivers. Both are allow.
    expect(decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON }).action).toBe('allow-elected')
    expect(decideStopHookDisposition({ scan: ZERO_REPLY_SHORT, ...ALL_ON }).action).toBe('allow-elected')
    expect(decideStopHookDisposition({ scan: INTERIM_ACK_LONG, ...ALL_ON }).action).toBe('allow-elected')
  })

  it('turn-flush flag OFF (zero-reply) → BLOCK (the flush will not fire)', () => {
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON, turnFlushSafetyEnabled: false })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('turn-flush-flag-disabled')
  })

  it('captured-prose flag OFF (interim-ack) → BLOCK (the bridge will not fire)', () => {
    const d = decideStopHookDisposition({ scan: INTERIM_ACK_LONG, ...ALL_ON, capturedProseDeliveryEnabled: false })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('captured-prose-flag-disabled')
  })

  it('captured-prose flag OFF (zero-reply) → BLOCK (bridge is the capture-divergence backstop)', () => {
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON, capturedProseDeliveryEnabled: false })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('captured-prose-flag-disabled')
  })

  it('retryCount > 0 → BLOCK (a prior failed delivery keeps the #3228 recovery net)', () => {
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON, retryCount: 1 })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('retry-ladder-in-flight')
  })

  it('gateway NOT live → BLOCK (never allow into a possibly-dead gateway)', () => {
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON, gatewayLive: false })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('gateway-liveness-not-fresh')
  })

  it('interim-ack SHORT (<200) → BLOCK (bridge floor is 200; no duplicate exists today)', () => {
    const d = decideStopHookDisposition({ scan: INTERIM_ACK_SHORT, ...ALL_ON })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('short-trailing-after-reply')
  })

  it('zero-reply with NO trailing prose (tool-calls only) → BLOCK (nothing to deliver)', () => {
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_NO_PROSE, ...ALL_ON })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('no-trailing-prose')
  })

  it('a non-block scan (allow/unknown) is passed straight through as allow-scan', () => {
    expect(decideStopHookDisposition({ scan: { decided: 'allow', reason: 'final-reply' }, ...ALL_ON }).action).toBe('allow-scan')
    expect(decideStopHookDisposition({ scan: { decided: 'unknown', reason: 'no-turn-start' }, ...ALL_ON }).action).toBe('allow-scan')
  })

  it('gateway-liveness gate is checked BEFORE the flag/prose gates (dead gateway always blocks)', () => {
    // Even with an otherwise-perfect zero-reply allow, a dead gateway forces block.
    const d = decideStopHookDisposition({ scan: ZERO_REPLY_LONG, ...ALL_ON, gatewayLive: false, retryCount: 0 })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('gateway-liveness-not-fresh')
  })
})

describe('env-flag mirrors stay in sync with the TS source', () => {
  it('turn-flush-safety: default ON; 0/false/off/no disable', () => {
    expect(isTurnFlushSafetyEnabledEnv({})).toBe(true)
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      expect(isTurnFlushSafetyEnabledEnv({ SWITCHROOM_TG_TURN_FLUSH_SAFETY: v })).toBe(false)
    }
    expect(isTurnFlushSafetyEnabledEnv({ SWITCHROOM_TG_TURN_FLUSH_SAFETY: '1' })).toBe(true)
  })
  it('captured-prose: default ON; only exact "0" disables', () => {
    expect(isCapturedProseDeliveryEnabledEnv({})).toBe(true)
    expect(isCapturedProseDeliveryEnabledEnv({ SWITCHROOM_TG_CAPTURED_PROSE_DELIVERY: '0' })).toBe(false)
    expect(isCapturedProseDeliveryEnabledEnv({ SWITCHROOM_TG_CAPTURED_PROSE_DELIVERY: '1' })).toBe(true)
  })
})

describe('isGatewayHeartbeatFresh — liveness gate IO', () => {
  it('fresh heartbeat → true; stale → false; missing → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-hb-'))
    try {
      // Missing file → not fresh.
      expect(isGatewayHeartbeatFresh(dir)).toBe(false)
      const path = join(dir, 'gateway-heartbeat')
      writeFileSync(path, 'x')
      // Just-written → fresh.
      expect(isGatewayHeartbeatFresh(dir)).toBe(true)
      // Age it past the freshness bound → stale.
      const old = new Date(Date.now() - GATEWAY_HEARTBEAT_FRESH_MS - 10_000)
      utimesSync(path, old, old)
      expect(isGatewayHeartbeatFresh(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
