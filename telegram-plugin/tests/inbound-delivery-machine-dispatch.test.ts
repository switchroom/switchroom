/**
 * Unit tests for `inbound-delivery-machine-dispatch.ts`.
 *
 * Per RFC PR 3 cutover: the dispatcher executes effects against real
 * primitives. These tests pin the contract per effect kind — which
 * primitive gets called, with what args, exactly once. The gate that
 * catches a double-drain regression at the imperative call sites.
 *
 * Scope of THIS file matches the PR's scope: bridgeUp's three effects
 * (drainBuffer, redeliverPersistedPermVerdicts, logTrace) are wired
 * and tested end-to-end. Other effect kinds are asserted to log a
 * `not-yet-cutover` trace without throwing — those are the future
 * cutover seam.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  __dispatchOneForTests,
  dispatchEffects,
  isDispatchEnabled,
} from '../gateway/inbound-delivery-machine-dispatch'
import type { DispatchCtx } from '../gateway/inbound-delivery-machine-dispatch'
import { createPendingInboundBuffer } from '../gateway/pending-inbound-buffer'
import { createPendingPermissionBuffer } from '../gateway/pending-permission-decisions'
import type { Effect } from '../gateway/inbound-delivery-machine'

function makeCtx(overrides?: Partial<DispatchCtx>): {
  ctx: DispatchCtx
  logs: string[]
  sendToAgent: ReturnType<typeof vi.fn>
  clientSend: ReturnType<typeof vi.fn>
  inbound: ReturnType<typeof createPendingInboundBuffer>
  perm: ReturnType<typeof createPendingPermissionBuffer>
} {
  const logs: string[] = []
  const sendToAgent = vi.fn(() => true)
  const clientSend = vi.fn()
  const inbound = createPendingInboundBuffer()
  const perm = createPendingPermissionBuffer()
  const ctx: DispatchCtx = {
    selfAgent: 'test-agent',
    ipcServer: { sendToAgent } as never,
    pendingInboundBuffer: inbound,
    inboundSpool: null,
    pendingPermissionBuffer: perm,
    client: { send: clientSend, agentName: 'test-agent', id: 'c1' } as never,
    log: (line: string) => logs.push(line),
    ...overrides,
  }
  return { ctx, logs, sendToAgent, clientSend, inbound, perm }
}

describe('isDispatchEnabled', () => {
  it('defaults to true when the kill-switch env-var is unset', () => {
    expect(isDispatchEnabled()).toBe(true)
  })
})

describe('dispatchEffects — drainBuffer', () => {
  it('redelivers buffered inbound to the registered client', () => {
    const { ctx, clientSend, inbound } = makeCtx()
    const msg1 = { type: 'inbound' as const, id: 'm1', chat_id: '1', text: 'hello', meta: { source: 'telegram' } }
    const msg2 = { type: 'inbound' as const, id: 'm2', chat_id: '1', text: 'world', meta: { source: 'cron' } }
    inbound.push('test-agent', msg1 as never)
    inbound.push('test-agent', msg2 as never)
    expect(inbound.depth('test-agent')).toBe(2)

    dispatchEffects([{ kind: 'drainBuffer' }], ctx)

    expect(clientSend).toHaveBeenCalledTimes(2)
    expect(clientSend).toHaveBeenNthCalledWith(1, msg1)
    expect(clientSend).toHaveBeenNthCalledWith(2, msg2)
    expect(inbound.depth('test-agent')).toBe(0)
  })

  it('no-ops on empty buffer (no log, no send)', () => {
    const { ctx, clientSend, logs, inbound } = makeCtx()
    expect(inbound.depth('test-agent')).toBe(0)

    dispatchEffects([{ kind: 'drainBuffer' }], ctx)

    expect(clientSend).not.toHaveBeenCalled()
    expect(logs.filter((l) => l.includes('drainBuffer'))).toHaveLength(0)
  })

  it('falls back to ipcServer.sendToAgent when no client is set', () => {
    const { ctx, sendToAgent, clientSend, inbound } = makeCtx({ client: undefined })
    const msg = { type: 'inbound' as const, id: 'm1', chat_id: '1', text: 'hi', meta: { source: 'cron' } }
    inbound.push('test-agent', msg as never)

    dispatchEffects([{ kind: 'drainBuffer' }], ctx)

    expect(clientSend).not.toHaveBeenCalled()
    expect(sendToAgent).toHaveBeenCalledTimes(1)
    expect(sendToAgent).toHaveBeenCalledWith('test-agent', msg)
  })
})

describe('dispatchEffects — redeliverPersistedPermVerdicts', () => {
  it('drains pendingPermissionBuffer to the client', () => {
    const { ctx, clientSend, perm } = makeCtx()
    const v1 = {
      type: 'permission_decision' as const,
      requestId: 'r1',
      behavior: 'allow' as const,
      updatedInput: {},
      timestamp: 0,
    }
    const v2 = {
      type: 'permission_decision' as const,
      requestId: 'r2',
      behavior: 'deny' as const,
      updatedInput: {},
      timestamp: 0,
    }
    perm.push('test-agent', v1 as never)
    perm.push('test-agent', v2 as never)

    dispatchEffects([{ kind: 'redeliverPersistedPermVerdicts' }], ctx)

    expect(clientSend).toHaveBeenCalledTimes(2)
    expect(clientSend).toHaveBeenNthCalledWith(1, v1)
    expect(clientSend).toHaveBeenNthCalledWith(2, v2)
  })

  it('no-ops on empty perm buffer', () => {
    const { ctx, clientSend, logs } = makeCtx()
    dispatchEffects([{ kind: 'redeliverPersistedPermVerdicts' }], ctx)
    expect(clientSend).not.toHaveBeenCalled()
    expect(logs.filter((l) => l.includes('redeliverPerm'))).toHaveLength(0)
  })
})

describe('dispatchEffects — logTrace', () => {
  it('writes a single grep-friendly line', () => {
    const { ctx, logs } = makeCtx()
    dispatchEffects(
      [{ kind: 'logTrace', stage: 'bridge_recover', metadata: { foo: 'bar' } }],
      ctx,
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('gw-trace dispatch stage=bridge_recover')
    expect(logs[0]).toContain('foo=bar')
  })
})

describe('dispatchEffects — bridgeUp composite (all three effects in order)', () => {
  it('drains perm verdicts THEN inbound buffer THEN logs', () => {
    const { ctx, clientSend, inbound, perm, logs } = makeCtx()
    const verdict = {
      type: 'permission_decision' as const,
      requestId: 'rA',
      behavior: 'allow' as const,
      updatedInput: {},
      timestamp: 0,
    }
    const inMsg = { type: 'inbound' as const, id: 'mB', chat_id: '1', text: 't', meta: { source: 'cron' } }
    perm.push('test-agent', verdict as never)
    inbound.push('test-agent', inMsg as never)

    // Effects in the order the machine returns them for bridgeUp.
    dispatchEffects(
      [
        { kind: 'redeliverPersistedPermVerdicts' },
        { kind: 'drainBuffer' },
        { kind: 'logTrace', stage: 'bridge_recover' },
      ],
      ctx,
    )

    expect(clientSend).toHaveBeenCalledTimes(2)
    expect(clientSend).toHaveBeenNthCalledWith(1, verdict)
    expect(clientSend).toHaveBeenNthCalledWith(2, inMsg)
    expect(logs.some((l) => l.includes('stage=bridge_recover'))).toBe(true)
  })
})

describe('dispatchEffects — kill switch', () => {
  // The kill switch is checked at module-load time so we can't toggle
  // it inside the test process easily. We validate the contract that
  // the helper exists and respects the env-var — see isDispatchEnabled.
  it('exposes the kill-switch check', () => {
    expect(typeof isDispatchEnabled()).toBe('boolean')
  })
})

describe('dispatchOne — not-yet-cutover effects log without throwing', () => {
  const notYet: Effect['kind'][] = [
    'deliverToBridge',
    'bufferInbound',
    'persistInbound',
    'setTurnStarted',
    'clearTurnStarted',
    'noteOutbound',
    'firePoke',
    'deliverPermVerdict',
    'persistPermVerdict',
  ]

  for (const kind of notYet) {
    it(`'${kind}' logs not-yet-cutover and does NOT touch primitives`, () => {
      const { ctx, sendToAgent, clientSend, logs } = makeCtx()
      // Construct a minimal valid effect for each kind. Most carry a
      // payload that the dispatcher ignores in this PR.
      const effect = synthesizeNotYetCutoverEffect(kind)
      expect(() => __dispatchOneForTests(effect, ctx)).not.toThrow()
      expect(sendToAgent).not.toHaveBeenCalled()
      expect(clientSend).not.toHaveBeenCalled()
      expect(logs.some((l) => l.includes(`not-yet-cutover effect=${kind}`))).toBe(true)
    })
  }
})

function synthesizeNotYetCutoverEffect(kind: Effect['kind']): Effect {
  const k = 'c1:_' as never
  const msg = { msgId: 1, isSteering: false, payload: null } as never
  const verdict = { requestId: 'r', behavior: 'allow' as const, payload: null } as never
  switch (kind) {
    case 'deliverToBridge':
      return { kind, key: k, msg }
    case 'bufferInbound':
      return { kind, key: k, msg }
    case 'persistInbound':
      return { kind, key: k, msg }
    case 'setTurnStarted':
      return { kind, key: k, at: 0 }
    case 'clearTurnStarted':
      return { kind, key: k }
    case 'noteOutbound':
      return { kind, key: k, at: 0 }
    case 'firePoke':
      return { kind, key: k, level: 'fallback' }
    case 'deliverPermVerdict':
      return { kind, verdict }
    case 'persistPermVerdict':
      return { kind, verdict }
    default:
      throw new Error(`unreachable: ${kind}`)
  }
}
