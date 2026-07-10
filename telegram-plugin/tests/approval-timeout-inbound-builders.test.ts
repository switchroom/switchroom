/**
 * Pin the synthetic-inbound shapes the gateway injects when an agent-initiated
 * approval card TTL-expires unanswered (the "wake the parked agent on timeout"
 * half of the durability fix). A regression that drops/changes `meta.source`
 * silently breaks the wake-up: the bridge wouldn't recognize the source and the
 * model wouldn't know its card timed out.
 *
 * The load-bearing wording invariant: each message says TIMEOUT, not a denial,
 * matching the permission-card philosophy so the model degrades gracefully
 * instead of spam-re-requesting into an absent operator.
 */

import { describe, it, expect } from 'vitest'
import {
  buildVaultAccessTimeoutInbound,
  buildVaultSaveTimeoutInbound,
  buildSecretRequestTimeoutInbound,
  buildMentalModelProposeTimeoutInbound,
} from '../gateway/approval-timeout-inbound-builders.js'

const FIXED_NOW = 1_700_000_000_000
const BASE = { agent: 'gymbro', chatId: '12345', stageId: 's1', timeoutMinutes: 60, nowMs: FIXED_NOW }

describe('timeout inbound builders — envelope', () => {
  const cases = [
    buildVaultAccessTimeoutInbound({ ...BASE, key: 'fatsecret/creds', scope: 'read' }),
    buildVaultSaveTimeoutInbound({ ...BASE, key: 'brevo/api-key' }),
    buildSecretRequestTimeoutInbound({ ...BASE, key: 'openai/token' }),
    buildMentalModelProposeTimeoutInbound({ ...BASE, name: 'training-plan-state' }),
  ]

  it('all share the canonical vault-broker envelope', () => {
    for (const m of cases) {
      expect(m.type).toBe('inbound')
      expect(m.chatId).toBe('12345')
      expect(m.user).toBe('vault-broker')
      expect(m.userId).toBe(0)
      expect(m.ts).toBe(FIXED_NOW)
      expect(m.messageId).toBe(FIXED_NOW)
      expect(m.meta?.agent).toBe('gymbro')
      expect(m.meta?.stage_id).toBe('s1')
    }
  })

  it('every message says TIMEOUT, not a denial (degrade-gracefully wording)', () => {
    for (const m of cases) {
      expect(m.text).toMatch(/TIMEOUT, not a denial/)
      expect(m.text).toMatch(/60 min/)
      expect(m.text).toMatch(/Do NOT (re-request|loop|re-propose)/i)
    }
  })
})

describe('timeout inbound builders — distinct sources', () => {
  it('pins each meta.source string (load-bearing for the bridge)', () => {
    expect(buildVaultAccessTimeoutInbound({ ...BASE, key: 'k', scope: 'read' }).meta?.source).toBe('vault_grant_timeout')
    expect(buildVaultSaveTimeoutInbound({ ...BASE, key: 'k' }).meta?.source).toBe('vault_save_timeout')
    expect(buildSecretRequestTimeoutInbound({ ...BASE, key: 'k' }).meta?.source).toBe('secret_request_timeout')
    expect(buildMentalModelProposeTimeoutInbound({ ...BASE, name: 'n' }).meta?.source).toBe('mental_model_propose_timeout')
  })

  it('sources are all disjoint', () => {
    const sources = [
      buildVaultAccessTimeoutInbound({ ...BASE, key: 'k', scope: 'read' }).meta?.source,
      buildVaultSaveTimeoutInbound({ ...BASE, key: 'k' }).meta?.source,
      buildSecretRequestTimeoutInbound({ ...BASE, key: 'k' }).meta?.source,
      buildMentalModelProposeTimeoutInbound({ ...BASE, name: 'n' }).meta?.source,
    ]
    expect(new Set(sources).size).toBe(4)
  })
})

describe('timeout inbound builders — topic routing', () => {
  const THREAD = 4242
  it('threadId set → top-level threadId + meta.message_thread_id (stringified)', () => {
    const m = buildVaultAccessTimeoutInbound({ ...BASE, threadId: THREAD, key: 'k', scope: 'write' })
    expect(m.threadId).toBe(THREAD)
    expect(m.meta?.message_thread_id).toBe(String(THREAD))
    expect(m.meta?.scope).toBe('write')
  })
  it('threadId absent → both omitted (DM stays thread-less)', () => {
    const m = buildVaultSaveTimeoutInbound({ ...BASE, key: 'k' })
    expect(m.threadId).toBeUndefined()
    expect(m.meta?.message_thread_id).toBeUndefined()
  })
  it('defaults nowMs to Date.now() when omitted', () => {
    const before = Date.now()
    const m = buildSecretRequestTimeoutInbound({ agent: 'a', chatId: '1', stageId: 's', timeoutMinutes: 30, key: 'k' })
    const after = Date.now()
    expect(m.ts).toBeGreaterThanOrEqual(before)
    expect(m.ts).toBeLessThanOrEqual(after)
    expect(m.messageId).toBe(m.ts)
  })
})
