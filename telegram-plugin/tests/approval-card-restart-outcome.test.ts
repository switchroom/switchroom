/**
 * Outcome-based composition test for the approval/restart continuation
 * contract in `reference/jobs/approve-what-my-agent-can-touch.md`:
 *
 *   - "An approval card survives a gateway restart. A tap on a still-valid
 *      card after a restart works; a card that expired during the outage is
 *      re-offered on the operator's return."
 *   - "Cards time out (60-min default) and the timeout wakes the agent as a
 *      timeout, not a denial ... An expired card is re-offered when the
 *      operator returns."
 *
 * The sibling suites pin each module in isolation (pending-card-store.test.ts,
 * pending-card-expiry.test.ts with mocked deps, approval-timeout-inbound-
 * builders.test.ts) and pending-card-durability-wiring.test.ts pins the
 * gateway wiring at the source-text level. This suite wires the REAL modules
 * together — file-backed durable store + real missed-approvals store + real
 * expiry sweep + real timeout builders — across a simulated gateway bounce
 * (store re-instantiation from the same state dir), asserting the promised
 * OUTCOMES rather than any one module's contract.
 *
 * SCOPE CAVEAT: the expiry predicate / remove / deliver / recordMiss closures
 * below are TEST-SUPPLIED stand-ins for gateway.ts's inline closures (which
 * close over module-level gateway state and can't be imported without a
 * production refactor). This suite therefore proves the modules COMPOSE
 * correctly; that gateway.ts actually wires them this way is pinned
 * separately by pending-card-durability-wiring.test.ts's source greps. The
 * user-visible acceptance twin is
 * `uat/scenarios/vault-card-survives-gateway-restart-dm.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPendingCardStore,
  type PersistedApprovalCard,
  type PersistedVaultAccessCard,
} from '../gateway/pending-card-store.js'
import { createMissedApprovalsStore } from '../gateway/missed-approvals-store.js'
import { expirePendingCard, sweepExpiredEntries } from '../gateway/pending-card-expiry.js'
import { buildVaultAccessTimeoutInbound } from '../gateway/approval-timeout-inbound-builders.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

// Test-local stand-in for the 60-min default the spec names. The production
// TTL comes from approvalTtlMs() in gateway/permission-timeout.ts; this suite
// does NOT assert that config plumbing — only how the modules behave around
// whatever TTL the sweep predicate encodes.
const TTL_MS = 60 * 60_000
const NOW = 1_700_000_000_000

function accessCard(overrides: Partial<PersistedVaultAccessCard> = {}): PersistedVaultAccessCard {
  return {
    family: 'vault_request_access',
    stageId: 'stage-1',
    agent: 'test-agent',
    chatId: '12345',
    cardMessageId: 777,
    stagedAt: NOW - 60_000, // staged a minute ago — still valid
    key: 'example/api-key',
    scope: 'read',
    ttlSeconds: 30 * 86_400,
    ...overrides,
  }
}

describe('approval/restart continuation — spec outcomes across a gateway bounce', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'approval-card-restart-outcome-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('a still-valid card record survives the bounce intact, and removing it clears the durable store', () => {
    // Gateway process #1 stages the card.
    const before = createPendingCardStore(stateDir)
    const card = accessCard()
    before.add(card)

    // ── gateway restarts: all in-memory maps are gone ──
    const after = createPendingCardStore(stateDir)
    const restored = after.loadAll()
    expect(restored).toHaveLength(1)
    // Metadata roundtrips byte-identical — stagedAt included, so the expiry
    // deadline the sweep computes from it is unchanged by the bounce.
    expect(restored[0]).toEqual(card)

    // Post-restart resolution path (what a tap handler does with the store):
    // remove() drops the durable record so a later boot can't resurrect it.
    // The tap handler's Telegram/grant side is NOT exercised here — that's
    // the UAT twin's job.
    after.remove(card.stageId)
    expect(after.loadAll()).toHaveLength(0)
  })

  it('a card that expired during the outage wakes the agent ONCE as timeout-not-denial and records the re-offer', () => {
    // Staged well past the TTL before the bounce.
    const expired = accessCard({ stageId: 'stage-expired', stagedAt: NOW - TTL_MS - 60_000 })
    createPendingCardStore(stateDir).add(expired)

    // ── restart: restore into the in-memory map, then the reaper sweeps ──
    const store = createPendingCardStore(stateDir)
    const missed = createMissedApprovalsStore(stateDir)
    const map = new Map<string, PersistedVaultAccessCard>(
      store.loadAll().map(e => [e.stageId, e as PersistedVaultAccessCard]),
    )
    expect(map.size).toBe(1)

    const delivered: InboundMessage[] = []
    const sweep = () =>
      sweepExpiredEntries(
        map,
        (v, now) => v.stagedAt < now - TTL_MS,
        (stageId, v) => {
          expirePendingCard({
            remove: () => {
              map.delete(stageId)
              store.remove(stageId)
            },
            editCard: () => {},
            buildInbound: () =>
              buildVaultAccessTimeoutInbound({
                agent: v.agent,
                chatId: v.chatId,
                stageId,
                timeoutMinutes: Math.round(TTL_MS / 60_000),
                nowMs: NOW,
                key: v.key,
                scope: v.scope,
              }),
            deliver: m => {
              delivered.push(m)
              return true
            },
            recordMiss: () =>
              missed.add({
                requestId: `approval-card:${stageId}`,
                toolName: 'vault_request_access',
                action: `vault access to ${v.key}`,
                chatId: v.chatId,
                timedOutAt: NOW,
              }),
            log: () => {},
          })
        },
        NOW,
        () => {},
      )

    sweep()

    // Exactly one wake, and it is a TIMEOUT, never a denial.
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toMatch(/TIMEOUT, not a denial/)
    expect(delivered[0].text).toContain('example/api-key')
    expect(delivered[0].meta?.source).toBe('vault_grant_timeout')

    // The re-offer is durably recorded for the operator's return.
    const pending = missed.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].requestId).toBe('approval-card:stage-expired')

    // Durable record is gone — a later boot can't resurrect the card.
    expect(store.loadAll()).toHaveLength(0)

    // A second boot's sweep restores from the (now empty) durable store and
    // therefore fires nothing — the remove() step cleared BOTH the in-memory
    // map and the store, so no later process can re-deliver the wake. (The
    // intra-process single-shot ordering guarantee — remove() before any
    // fallible side effect — is pinned behaviorally in
    // pending-card-expiry.test.ts, not here.)
    const rebootMap = new Map<string, PersistedVaultAccessCard>(
      createPendingCardStore(stateDir)
        .loadAll()
        .map(e => [e.stageId, e as PersistedVaultAccessCard]),
    )
    expect(rebootMap.size).toBe(0)
    let secondBootExpiries = 0
    sweepExpiredEntries(
      rebootMap,
      (v, now) => v.stagedAt < now - TTL_MS,
      () => {
        secondBootExpiries += 1
      },
      NOW,
      () => {},
    )
    expect(secondBootExpiries).toBe(0)
    expect(delivered).toHaveLength(1)
  })

  it('the post-restart sweep never expires a still-valid card (no false timeout on bounce)', () => {
    const valid = accessCard({ stageId: 'stage-valid', stagedAt: NOW - 60_000 })
    createPendingCardStore(stateDir).add(valid)

    const store = createPendingCardStore(stateDir)
    const map = new Map<string, PersistedApprovalCard>(store.loadAll().map(e => [e.stageId, e]))

    let expiredCount = 0
    sweepExpiredEntries(
      map,
      (v, now) => v.stagedAt < now - TTL_MS,
      () => {
        expiredCount += 1
      },
      NOW,
      () => {},
    )

    expect(expiredCount).toBe(0)
    expect(map.size).toBe(1) // the card stays live and tappable
    expect(store.loadAll()).toHaveLength(1)
  })
})
