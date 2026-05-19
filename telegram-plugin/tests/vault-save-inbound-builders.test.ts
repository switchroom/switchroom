/**
 * Pin the InboundMessage shapes the gateway synthesizes when the
 * operator taps Save / Discard (or the write fails) on a
 * `vault_request_save` card. Before this, `handleVaultRequestSaveCallback`
 * edited the card on every terminal outcome but NEVER woke the agent
 * (no sendToAgent / no pendingInboundBuffer push) — so the secret was
 * stored/discarded but the agent that called `vault_request_save`
 * stayed silently idle. These builders + the gateway wiring close that
 * gap symmetrically with the vra: approve/deny path (#1052/#1150/#1156).
 *
 * The wire shape is load-bearing; a dropped `meta.source` / field would
 * silently regress the wake-up. Cheap regression guard.
 */

import { describe, it, expect } from 'vitest'
import {
  buildVaultSaveCompletedInbound,
  buildVaultSaveFailedInbound,
  buildVaultSaveDiscardedInbound,
  type VaultSaveInboundContext,
} from '../gateway/vault-grant-inbound-builders.js'

const FIXED_NOW = 1_700_000_000_000

const CTX: VaultSaveInboundContext = {
  agent: 'gymbro',
  key: 'garmin/credentials',
  chat_id: '12345',
}

describe('buildVaultSaveCompletedInbound', () => {
  it('emits the canonical vault-broker envelope', () => {
    const msg = buildVaultSaveCompletedInbound({
      ctx: CTX,
      stageId: 'stage-001',
      operatorId: '999',
      nowMs: FIXED_NOW,
    })
    expect(msg.type).toBe('inbound')
    expect(msg.chatId).toBe('12345')
    expect(msg.user).toBe('vault-broker')
    expect(msg.userId).toBe(0)
    expect(msg.ts).toBe(FIXED_NOW)
    expect(msg.messageId).toBe(FIXED_NOW)
  })

  it('carries the load-bearing meta + an actionable resume instruction', () => {
    const msg = buildVaultSaveCompletedInbound({
      ctx: CTX,
      stageId: 'stage-001',
      operatorId: '999',
      nowMs: FIXED_NOW,
    })
    expect(msg.meta).toEqual({
      source: 'vault_save_completed',
      agent: 'gymbro',
      key: 'garmin/credentials',
      stage_id: 'stage-001',
      operator_id: '999',
    })
    expect(msg.text).toContain('vault:garmin/credentials')
    expect(msg.text.toLowerCase()).toContain('resume')
  })
})

describe('buildVaultSaveFailedInbound', () => {
  it('flags NOT stored, carries the reason + failed source', () => {
    const msg = buildVaultSaveFailedInbound({
      ctx: CTX,
      stageId: 'stage-002',
      operatorId: '999',
      reason: 'VAULT-BROKER-DENIED: no operator attestation',
      nowMs: FIXED_NOW,
    })
    expect(msg.meta?.source).toBe('vault_save_failed')
    expect(msg.meta?.key).toBe('garmin/credentials')
    expect(msg.text).toContain('FAILED')
    expect(msg.text).toContain('VAULT-BROKER-DENIED')
    expect(msg.text).toContain('NOT stored')
  })
})

describe('buildVaultSaveDiscardedInbound', () => {
  it('flags NOT stored + steers to a fallback, discarded source', () => {
    const msg = buildVaultSaveDiscardedInbound({
      ctx: CTX,
      stageId: 'stage-003',
      operatorId: '999',
      nowMs: FIXED_NOW,
    })
    expect(msg.meta?.source).toBe('vault_save_discarded')
    expect(msg.meta?.agent).toBe('gymbro')
    expect(msg.text).toContain('discarded')
    expect(msg.text).toContain('NOT stored')
  })
})
