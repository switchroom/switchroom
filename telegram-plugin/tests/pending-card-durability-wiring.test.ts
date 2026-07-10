/**
 * Source-text wiring pins for the agent-initiated approval-card durability fix.
 *
 * gateway.ts has top-level side effects and isn't unit-importable; the pure
 * primitives are unit-tested in pending-card-store.test.ts and
 * approval-timeout-inbound-builders.test.ts. These pins lock the wiring that
 * connects them so the two failure modes can't silently regress:
 *
 *   Defect A — pending card state was in-memory only; a gateway restart lost it
 *     and a later tap hit the "Card expired" tombstone (agent parked forever).
 *   Defect B — no wake on TTL expiry; an unanswered card left the agent parked
 *     forever (the sweeps were lazy and never woke the agent).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
const GATEWAY = read('gateway/gateway.ts')
// #2996 Phase 3: the in-memory approval-card Maps + their TTL sweeps moved
// behind approval-card-stores.ts. The gateway now delegates each family sweep
// to `<store>.sweep(now)`; the per-entry sweepExpiredEntries guard lives in the
// store module.
const CARD_STORES = read('gateway/approval-card-stores.ts')
// #2996 Phase 5: the callback-query handler families (vault access/save,
// mental-model, deferred-secret, grant wizard, operator-event, auth dashboard)
// moved verbatim behind callback-query-handlers.ts; handler-body pins read
// that module while staging/boot/sweep wiring stays pinned on gateway.ts.
const CB_HANDLERS = read('gateway/callback-query-handlers.ts')

function slice(src: string, header: string, span = 3000): string {
  const start = src.indexOf(header)
  expect(start, `expected to find ${header}`).toBeGreaterThan(-1)
  return src.slice(start, start + span)
}

// ─── Store instantiation ──────────────────────────────────────────────────

describe('pending-card-store wiring', () => {
  it('imports and instantiates the durable pending-card store', () => {
    expect(GATEWAY).toMatch(/from '\.\/pending-card-store\.js'/)
    expect(GATEWAY).toMatch(/const pendingCardStore = createPendingCardStore\(STATE_DIR\)/)
  })

  it('imports the four timeout inbound builders', () => {
    expect(GATEWAY).toMatch(/from '\.\/approval-timeout-inbound-builders\.js'/)
    for (const b of [
      'buildVaultAccessTimeoutInbound',
      'buildVaultSaveTimeoutInbound',
      'buildSecretRequestTimeoutInbound',
      'buildMentalModelProposeTimeoutInbound',
    ]) {
      expect(GATEWAY).toContain(b)
    }
  })
})

// ─── Defect A part 1: persistence at staging ──────────────────────────────

describe('staging persists card metadata (Defect A)', () => {
  it('vault_request_access stages into the durable store', () => {
    const fn = slice(GATEWAY, 'async function executeVaultRequestAccess', 6000)
    expect(fn).toMatch(/pendingCardStore\.add\(\{[\s\S]*family: 'vault_request_access'/)
  })

  it('request_secret stages into the durable store', () => {
    const fn = slice(GATEWAY, 'async function executeRequestSecret', 3000)
    expect(fn).toMatch(/pendingCardStore\.add\(\{[\s\S]*family: 'request_secret'/)
  })

  it('mental_model_propose stages into the durable store', () => {
    const fn = slice(GATEWAY, 'async function executeMentalModelPropose', 6000)
    expect(fn).toMatch(/pendingCardStore\.add\(\{[\s\S]*family: 'mental_model_propose'/)
  })

  it('vault_request_save stages metadata but NEVER the secret value (hygiene)', () => {
    const fn = slice(GATEWAY, 'async function executeVaultRequestSave', 6000)
    const addBlock = slice(fn, "pendingCardStore.add({", 700)
    expect(addBlock).toMatch(/family: 'vault_request_save'/)
    // The staged secret `value` must NOT be copied into the persisted record.
    expect(addBlock).not.toMatch(/value:/)
  })
})

// ─── Defect A part 2: boot restore ────────────────────────────────────────

describe('boot restore (Defect A)', () => {
  it('defines restorePendingApprovalCards and calls it at boot', () => {
    expect(GATEWAY).toMatch(/function restorePendingApprovalCards\(\)/)
    expect(GATEWAY).toMatch(/restorePendingApprovalCards\(\)/g)
  })

  it('restored vault_request_save has no value + is flagged restoredWithoutValue', () => {
    const fn = slice(GATEWAY, 'function restorePendingApprovalCards', 4000)
    expect(fn).toMatch(/value: '',/)
    expect(fn).toMatch(/restoredWithoutValue: true/)
  })

  it('a Save tap on a restored (valueless) card degrades gracefully instead of writing empty', () => {
    const fn = slice(CB_HANDLERS, 'async function handleVaultRequestSaveCallback', 9000)
    expect(fn).toMatch(/pending\.restoredWithoutValue \|\| pending\.value\.length === 0/)
    expect(fn).toMatch(/lost to a gateway restart/)
    expect(fn).toMatch(/buildVaultSaveFailedInbound/)
  })
})

// ─── Defect A part 3: removal on resolution ───────────────────────────────

describe('resolution clears the durable store (Defect A)', () => {
  it('vault access approve/deny remove from the store', () => {
    // deny path
    const deny = slice(CB_HANDLERS, 'async function handleVaultRequestAccessCallback', 4000)
    expect(deny).toMatch(/pendingCardStore\.remove\(stageId\)/)
    // approve path (performVaultAccessApproval) removes on every terminal branch
    const approve = slice(CB_HANDLERS, 'async function performVaultAccessApproval', 9000)
    expect(approve).toMatch(/pendingCardStore\.remove\(stageId\)/)
  })

  it('vault save resolution paths remove from the store', () => {
    const fn = slice(CB_HANDLERS, 'async function handleVaultRequestSaveCallback', 12000)
    // discard / write-fail / success / passphrase-missing all clear the store.
    const count = (fn.match(/pendingCardStore\.remove\(stageId\)/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(3)
  })

  it('secret request provide/decline remove from the store', () => {
    // capture (provide → value arrives) removes via armed.stageId
    expect(GATEWAY).toMatch(/pendingCardStore\.remove\(armed\.stageId\)/)
    const decline = slice(GATEWAY, 'async function handleSecretRequestCallback', 3000)
    expect(decline).toMatch(/pendingCardStore\.remove\(stageId\)/)
  })

  it('mental model resolve removes from the store', () => {
    const fn = slice(CB_HANDLERS, 'async function handleMentalModelProposeCallback', 4000)
    expect(fn).toMatch(/pendingCardStore\.remove\(stageId\)/)
  })
})

// ─── Defect B: TTL expiry wakes the parked agent ──────────────────────────

describe('TTL expiry wakes the parked agent (Defect B)', () => {
  it('the periodic reaper runs the approval-card expiry sweep inside try/catch', () => {
    const reaper = slice(GATEWAY, 'const pendingStateReaper = setInterval', 12000)
    // The sweep call must be guarded like the sibling sweepStaleTurnActiveMarker:
    // an escaped throw inside this setInterval callback reaches uncaughtException
    // and takes the whole gateway down.
    expect(reaper).toMatch(/try\s*\{\s*sweepExpiredApprovalCards\(now\)\s*\}\s*catch/)
  })

  it('sweepExpiredApprovalCards runs all four family sweeps', () => {
    // #2996 Phase 3: three families now delegate to their store's `.sweep(now)`;
    // request_secret still routes via sweepSecretRequests (which also sweeps the
    // transient armedSecretCaptures) and that in turn calls the store sweep.
    const fn = slice(GATEWAY, 'function sweepExpiredApprovalCards', 600)
    expect(fn).toMatch(/pendingVaultRequestAccesses\.sweep\(now\)/)
    expect(fn).toMatch(/pendingVaultRequestSaves\.sweep\(now\)/)
    expect(fn).toMatch(/pendingMentalModelProposes\.sweep\(now\)/)
    expect(fn).toMatch(/sweepSecretRequests\(now\)/)
  })

  it('each expire* helper routes through the guarded expirePendingCard core', () => {
    for (const [fnName, builder] of [
      ['function expireVaultAccessCard', 'buildVaultAccessTimeoutInbound'],
      ['function expireVaultSaveCard', 'buildVaultSaveTimeoutInbound'],
      ['function expireSecretRequestCard', 'buildSecretRequestTimeoutInbound'],
      ['function expireMentalModelProposeCard', 'buildMentalModelProposeTimeoutInbound'],
    ] as const) {
      const fn = slice(GATEWAY, fnName, 2400)
      // The pure core owns ordering + fault isolation (delete-before-deliver,
      // recordMiss-before-deliver, guarded deliver) — pinned BEHAVIORALLY in
      // pending-card-expiry.test.ts. Here we pin that the gateway routes each
      // family through it with the right dependencies.
      expect(fn, fnName).toMatch(/expirePendingCard\(\{/)
      expect(fn, fnName).toMatch(new RegExp(builder))
      // turn-safe injection gate
      expect(fn, fnName).toMatch(/deliverResumeSyntheticOrBuffer\(/)
      // re-offered when the operator returns
      expect(fn, fnName).toMatch(/recordMissedApproval\(/)
      // card edited to expired + store cleared
      expect(fn, fnName).toMatch(/editCardExpired\(/)
      expect(fn, fnName).toMatch(/pendingCardStore\.remove\(stageId\)/)
    }
  })

  it('each family sweep is per-entry guarded via sweepExpiredEntries', () => {
    // #2996 Phase 3: the per-entry guard moved into the store module's `.sweep`,
    // which is a thin pass-through to the same pure sweepExpiredEntries core.
    // The three vault/mental families delegate to that store method; the
    // request_secret family's sweepSecretRequests delegates to it too.
    expect(CARD_STORES).toMatch(/sweep:\s*\(now\)\s*=>\s*\n?\s*sweepExpiredEntries\(/)
    const secretSweep = slice(GATEWAY, 'function sweepSecretRequests', 500)
    expect(secretSweep).toMatch(/pendingSecretRequests\.sweep\(now\)/)
    for (const store of [
      'const pendingVaultRequestAccesses = createSweepableCardStore',
      'const pendingVaultRequestSaves = createSweepableCardStore',
      'const pendingMentalModelProposes = createSweepableCardStore',
      'const pendingSecretRequests = createSweepableCardStore',
    ]) {
      expect(GATEWAY, store).toContain(store)
    }
  })

  it('recordMissedApproval writes to the missed-approvals store (re-offer path)', () => {
    const fn = slice(GATEWAY, 'function recordMissedApproval', 700)
    expect(fn).toMatch(/missedApprovalsStore\.add\(/)
    expect(fn).toMatch(/MISSED_APPROVAL_REOFFER_ENABLED/)
  })
})

// ─── Copy-bug fix: derive the timeout window from the real TTL ─────────────

describe('vault_request_access copy derives the window from the real TTL', () => {
  it('no hard-coded "10 min" claim; uses VAULT_REQUEST_ACCESS_TTL_MS', () => {
    const fn = slice(GATEWAY, 'async function executeVaultRequestAccess', 12000)
    expect(fn).not.toMatch(/times out \(10 min\)/)
    expect(fn).toMatch(/Math\.round\(VAULT_REQUEST_ACCESS_TTL_MS \/ 60000\)/)
  })
})
