/**
 * Structural pin: the delivery state machine's `inbound` event MUST be
 * emitted from `handleInbound` only AFTER the intercept/early-return
 * gauntlet — never eagerly at handler entry.
 *
 * The wedge this guards (overlord `/usage` went dead, 2026-07-08). The
 * inbound emit drives the now-AUTHORITATIVE turn-in-flight gate
 * (turnInFlightForGate → isMachineInTurn). When it fired at handler entry
 * — before the permission-reply / `/auth` paste-back / interrupt-empty /
 * secret-detect-drop intercepts — an intercepted message (e.g. an approval
 * reply) drove the machine idle→`bridge_alive_in_turn`, then early-returned
 * as an intercept: no delivery, and critically no `turnEnd`. The machine
 * held the gate closed until the 5-min TTL tick force-cleared it, buffering
 * every inbound (including `/usage`) meanwhile — the dangerous over-hold
 * direction the bake-era gate-parity probe flagged.
 *
 * The behaviour lives inside the un-exported `handleInbound` closure, so —
 * mirroring the other gateway-*.test.ts source-pins — we assert on source
 * structure: the single inbound `shadowEmit` must sit below the intercepts
 * and carry the real `isSteering` classification. Machine self-heal + gate
 * accessors are behaviour-tested in inbound-delivery-cutover-gate.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf8')

/** Byte offset of the sole `shadowEmit({ kind: 'inbound' ... })` call. */
function inboundEmitOffset(): number {
  const m = GATEWAY_SRC.match(/shadowEmit\(\{\s*\n\s*kind:\s*'inbound'/)
  expect(m, 'expected exactly one multi-line inbound shadowEmit').not.toBeNull()
  const idx = GATEWAY_SRC.indexOf(m![0])
  // There must be only ONE such emit — a second eager site would reintroduce
  // the wedge.
  const second = GATEWAY_SRC.indexOf(m![0], idx + 1)
  expect(second, 'a second inbound shadowEmit would reintroduce the eager-emit wedge').toBe(-1)
  return idx
}

describe('gateway: inbound machine-emit is deferred past the intercepts', () => {
  it('carries the DEFERRED_INBOUND_EMIT marker so the intent is greppable', () => {
    expect(GATEWAY_SRC).toContain('DEFERRED_INBOUND_EMIT')
  })

  it('emits the machine `inbound` event AFTER the permission-reply intercept', () => {
    const emitIdx = inboundEmitOffset()
    // The permission-reply intercept is one of the early-return paths that
    // must NOT drive the machine into a turn.
    // P7 PR-4: the intercept body moved to inbound-interceptors.ts; the
    // gateway call site is the ordering anchor now.
    const permIdx = GATEWAY_SRC.indexOf('interceptPermissionReply({ text, chat_id, msgId }')
    expect(permIdx).toBeGreaterThan(0)
    expect(emitIdx).toBeGreaterThan(permIdx)
  })

  it('emits AFTER the `/auth add` paste-back intercept', () => {
    const emitIdx = inboundEmitOffset()
    const authIdx = GATEWAY_SRC.indexOf('pendingAuthAddFlows.get(interceptKey)')
    expect(authIdx).toBeGreaterThan(0)
    expect(emitIdx).toBeGreaterThan(authIdx)
  })

  it('emits AFTER isSteering is classified, and passes the real value (not a hardcoded false)', () => {
    const emitIdx = inboundEmitOffset()
    const steerIdx = GATEWAY_SRC.indexOf('isSteering = priorTurnInFlight && isSteerPrefix')
    expect(steerIdx).toBeGreaterThan(0)
    expect(emitIdx).toBeGreaterThan(steerIdx)
    // The emit's msg object must forward the live `isSteering` binding, so a
    // mid-turn steer is not mis-modelled as a fresh turn.
    const win = GATEWAY_SRC.slice(emitIdx, emitIdx + 260)
    expect(win).toMatch(/msg:\s*\{[\s\S]*?\bisSteering,[\s\S]*?\}/)
  })

  it('emits BEFORE the deliver-or-buffer decision (reserveInboundDelivery)', () => {
    const emitIdx = inboundEmitOffset()
    const gateIdx = GATEWAY_SRC.indexOf('const deliveryGate = reserveInboundDelivery({')
    expect(gateIdx).toBeGreaterThan(0)
    expect(emitIdx).toBeLessThan(gateIdx)
  })
})
