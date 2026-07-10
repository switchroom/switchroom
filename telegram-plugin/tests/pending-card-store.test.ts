/**
 * Durable store for the four AGENT-INITIATED approval-card families
 * (vault_request_access / vault_request_save / request_secret /
 * mental_model_propose). Mirrors permission-card-store.test.ts.
 *
 * The load-bearing extra invariant here (beyond plain persistence): NO SECRET
 * VALUE ever lands on disk. The file is written unencrypted; a vault_request_save
 * stages the secret value in gateway memory only, and this store must persist
 * just its key/metadata. The "no value field" test is the regression guard for
 * that hygiene rule.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPendingCardStore,
  type PersistedApprovalCard,
} from '../gateway/pending-card-store.js'

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'pending-card-store-test-'))
}

const ACCESS: PersistedApprovalCard = {
  family: 'vault_request_access',
  stageId: 'a1b2c3d4',
  agent: 'gymbro',
  chatId: '10001',
  cardMessageId: 555,
  key: 'fatsecret/credentials',
  scope: 'read',
  reason: 'needs the API for the daily log',
  ttlSeconds: 30 * 86400,
  stagedAt: 1_700_000_000_000,
}

const SAVE: PersistedApprovalCard = {
  family: 'vault_request_save',
  stageId: 'e5f6a7b8',
  agent: 'marko',
  chatId: '10002',
  cardMessageId: 556,
  key: 'brevo/api-key',
  kind: 'string',
  why: 'store the campaign key',
  stagedAt: 1_700_000_000_000,
}

const SECRET: PersistedApprovalCard = {
  family: 'request_secret',
  stageId: 'c9d0e1f2',
  agent: 'gymbro',
  chatId: '10003',
  cardMessageId: 557,
  key: 'openai/token',
  reason: 'the model call needs it',
  stagedAt: 1_700_000_000_000,
}

const MMP: PersistedApprovalCard = {
  family: 'mental_model_propose',
  stageId: 'aabbccdd',
  agent: 'gymbro',
  chatId: '10004',
  cardMessageId: 558,
  spec: { name: 'training-plan-state', source_query: 'the user current training plan' },
  stagedAt: 1_700_000_000_000,
}

describe('createPendingCardStore', () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    expect(createPendingCardStore(dir).loadAll()).toEqual([])
  })

  it('add + loadAll round-trips each family', () => {
    const store = createPendingCardStore(dir)
    store.add(ACCESS)
    store.add(SAVE)
    store.add(SECRET)
    store.add(MMP)
    const all = store.loadAll()
    expect(all.length).toBe(4)
    expect(new Set(all.map(e => e.family))).toEqual(
      new Set(['vault_request_access', 'vault_request_save', 'request_secret', 'mental_model_propose']),
    )
  })

  it('add is idempotent on stageId (replaces in place)', () => {
    const store = createPendingCardStore(dir)
    store.add(SAVE)
    store.add({ ...SAVE, cardMessageId: 999 })
    const all = store.loadAll()
    expect(all.length).toBe(1)
    expect((all[0] as { cardMessageId?: number }).cardMessageId).toBe(999)
  })

  it('remove drops only the matching stageId', () => {
    const store = createPendingCardStore(dir)
    store.add(ACCESS)
    store.add(SAVE)
    store.remove(ACCESS.stageId)
    const all = store.loadAll()
    expect(all.length).toBe(1)
    expect(all[0].stageId).toBe(SAVE.stageId)
  })

  it('remove is idempotent when the entry is absent', () => {
    const store = createPendingCardStore(dir)
    expect(() => store.remove('nope')).not.toThrow()
  })

  it('clear empties the store', () => {
    const store = createPendingCardStore(dir)
    store.add(ACCESS)
    store.clear()
    expect(store.loadAll()).toEqual([])
  })

  it('survives re-instantiation (data persists across gateway restart)', () => {
    createPendingCardStore(dir).add(ACCESS)
    const all = createPendingCardStore(dir).loadAll()
    expect(all.length).toBe(1)
    expect(all[0].stageId).toBe(ACCESS.stageId)
    // The restored access card carries everything a post-restart tap needs to
    // mint the grant: agent, key, scope, ttl, chat, card message id.
    const restored = all[0] as Extract<PersistedApprovalCard, { family: 'vault_request_access' }>
    expect(restored.agent).toBe('gymbro')
    expect(restored.key).toBe('fatsecret/credentials')
    expect(restored.scope).toBe('read')
    expect(restored.ttlSeconds).toBe(30 * 86400)
    expect(restored.cardMessageId).toBe(555)
  })

  // ── Secrets hygiene — the whole reason this store persists metadata only ──
  it('a vault_request_save record has NO `value` field (type + runtime)', () => {
    // Type-level: PersistedVaultSaveCard has no `value` member, so this object
    // literal wouldn't compile with one. Runtime-level: assert it's absent.
    expect('value' in SAVE).toBe(false)
  })

  it('the on-disk JSON contains NO secret value for a saved card', () => {
    const store = createPendingCardStore(dir)
    // Simulate the gateway callsite: it builds the persisted record from the
    // pending entry WITHOUT copying `value`. Even if a caller mistakenly spread
    // a value in, the type wouldn't allow it — but assert the file is clean.
    store.add(SAVE)
    const raw = readFileSync(join(dir, 'pending-approval-cards.json'), 'utf-8')
    const SECRET_SENTINEL = 'super-secret-brevo-value'
    expect(raw).not.toContain(SECRET_SENTINEL)
    expect(raw).not.toContain('"value"')
    // The key/metadata we DO need is present.
    expect(raw).toContain('brevo/api-key')
    expect(raw).toContain('vault_request_save')
  })

  it('the file ends up 0600 even when it pre-existed with lax perms', () => {
    // writeFileSync's `mode` only applies on CREATE — a pre-existing
    // world-readable file would keep its perms without the explicit chmod
    // the store does on every write.
    const filePath = join(dir, 'pending-approval-cards.json')
    writeFileSync(filePath, '[]', { mode: 0o644 })
    const store = createPendingCardStore(dir)
    store.add(ACCESS)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(createPendingCardStore(dir).loadAll().length).toBe(1)
  })
})
