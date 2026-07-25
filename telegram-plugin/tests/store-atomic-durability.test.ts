/**
 * Durability contract for the gateway's four small JSON state stores:
 * `pending-card-store`, `scoped-grant-store`, `missed-approvals-store`,
 * `always-allow-persist-queue`.
 *
 * The bug these pin: each store did a non-atomic read-modify-write straight
 * over the destination (`writeFileSync(dest, …)` = open + O_TRUNC + write),
 * and wrapped the read in `catch { return [] }`. A crash between the truncate
 * and the write left a TORN file; on the next boot the parse threw, the catch
 * swallowed it, and every pending approval card / live scoped grant was
 * silently forgotten. Nothing was logged. The operator just saw dead buttons.
 *
 * Two outcomes are asserted here, both of which FAIL against the pre-fix code:
 *
 *   1. A torn/truncated file must not silently yield an empty store. The
 *      store still comes up empty (the gateway must boot), but the corrupt
 *      bytes are preserved as `<file>.corrupt-<ts>` and a loud line lands on
 *      the log sink. Pre-fix: empty store, no quarantine file, no log line.
 *
 *   2. An update must REPLACE the destination via rename(2), never truncate
 *      it in place — that is what makes an interrupted write leave the
 *      previous good content fully intact. Asserted on the destination's
 *      inode: rename swaps in a new inode, whereas the pre-fix in-place
 *      `writeFileSync` keeps the same inode (and therefore has a window in
 *      which the destination is truncated/short on disk).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createPendingCardStore, type PersistedApprovalCard } from '../gateway/pending-card-store.js'
import { createScopedGrantStore } from '../gateway/scoped-grant-store.js'
import { createMissedApprovalsStore, type MissedApproval } from '../gateway/missed-approvals-store.js'
import { createAlwaysAllowPersistQueue } from '../gateway/always-allow-persist-queue.js'

let dir: string
let logged: string[]
const log = (line: string) => {
  logged.push(line)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-atomic-durability-'))
  logged = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The bytes a crash between truncate and write leaves behind. */
const TORN = '[{"family":"vault_request_access","stageId":"abc'

function quarantinedFiles(base: string): string[] {
  return readdirSync(dir).filter(f => f.startsWith(`${base}.corrupt-`))
}

function sampleCard(stageId: string): PersistedApprovalCard {
  return {
    family: 'vault_request_access',
    stageId,
    agent: 'clerk',
    chatId: '123',
    stagedAt: 1_700_000_000_000,
    key: 'coolify/api-token',
    scope: 'read',
    ttlSeconds: 900,
  }
}

function sampleMiss(requestId: string): MissedApproval {
  return {
    requestId,
    toolName: 'mcp__brevo__post',
    action: 'post to Brevo',
    chatId: '123',
    timedOutAt: 1_700_000_000_000,
  }
}

describe('a torn file must NOT silently yield an empty store', () => {
  it('pending-card-store: quarantines the torn bytes and logs loudly', () => {
    const file = join(dir, 'pending-approval-cards.json')
    writeFileSync(file, TORN)

    const store = createPendingCardStore(dir, log)
    expect(store.loadAll()).toEqual([])

    // The loss is OBSERVABLE: corrupt bytes preserved + a loud log line.
    const quarantined = quarantinedFiles('pending-approval-cards.json')
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]!), 'utf-8')).toBe(TORN)
    expect(logged.join('')).toMatch(/pending-card-store CORRUPT/)
    expect(logged.join('')).toMatch(/LOST/)
  })

  it('scoped-grant-store: quarantines the torn bytes and logs loudly', () => {
    const file = join(dir, 'scoped-grants.json')
    writeFileSync(file, TORN)

    const store = createScopedGrantStore(dir, {}, log)
    expect(store.load(Date.now()).size).toBe(0)

    expect(quarantinedFiles('scoped-grants.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/scoped-grant-store CORRUPT/)
  })

  it('missed-approvals-store: quarantines the torn bytes and logs loudly', () => {
    writeFileSync(join(dir, 'missed-approvals.json'), '{"pending":[{"requestId":"r1"')

    const store = createMissedApprovalsStore(dir, log)
    expect(store.listPending()).toEqual([])

    expect(quarantinedFiles('missed-approvals.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/missed-approvals-store CORRUPT/)
  })

  it('always-allow-persist-queue: quarantines the torn bytes and logs loudly', () => {
    writeFileSync(join(dir, 'always-allow-persist-queue.json'), '{"entries":[{"id":"clerk::Ski')

    const q = createAlwaysAllowPersistQueue(dir, undefined, log)
    expect(q.listAll()).toEqual([])

    expect(quarantinedFiles('always-allow-persist-queue.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/always-allow-persist-queue CORRUPT/)
  })

  it('a MISSING file is the normal cold start — no quarantine, no alarm', () => {
    const store = createPendingCardStore(dir, log)
    expect(store.loadAll()).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    expect(logged).toEqual([])
  })

  it('quarantine happens once — the next boot starts clean instead of re-alarming', () => {
    writeFileSync(join(dir, 'pending-approval-cards.json'), TORN)
    createPendingCardStore(dir, log).loadAll()
    logged = []

    createPendingCardStore(dir, log).loadAll()
    expect(logged).toEqual([])
    expect(quarantinedFiles('pending-approval-cards.json')).toHaveLength(1)
  })
})

describe('an update replaces the destination by rename — it is never truncated in place', () => {
  /**
   * rename(2) swaps a NEW inode into the destination name, so a reader (or a
   * crash) only ever sees the whole old file or the whole new file. An
   * in-place `writeFileSync` keeps the destination inode and truncates it
   * first — that truncate window is the torn-file bug. Inode identity is the
   * observable difference.
   */
  it('pending-card-store', () => {
    const store = createPendingCardStore(dir, log)
    store.add(sampleCard('s1'))
    const file = join(dir, 'pending-approval-cards.json')
    const first = statSync(file).ino

    store.add(sampleCard('s2'))
    expect(statSync(file).ino).not.toBe(first)
    expect(store.loadAll().map(c => c.stageId)).toEqual(['s1', 's2'])
    // No tempfile left behind on a successful write.
    expect(readdirSync(dir)).toEqual(['pending-approval-cards.json'])
    // Perms stay owner-only even across a replace.
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('missed-approvals-store', () => {
    const store = createMissedApprovalsStore(dir, log)
    store.add(sampleMiss('r1'))
    const file = join(dir, 'missed-approvals.json')
    const first = statSync(file).ino

    store.add(sampleMiss('r2'))
    expect(statSync(file).ino).not.toBe(first)
    expect(store.listPending().map(e => e.requestId)).toEqual(['r1', 'r2'])
    expect(readdirSync(dir)).toEqual(['missed-approvals.json'])
  })

  it('always-allow-persist-queue', async () => {
    const q = createAlwaysAllowPersistQueue(dir, undefined, log)
    await q.enqueue({ agentName: 'clerk', rule: 'Skill(calendar)', grantPhrase: 'use the calendar skill' })
    const file = join(dir, 'always-allow-persist-queue.json')
    const first = statSync(file).ino

    await q.enqueue({ agentName: 'clerk', rule: 'Skill(drive)', grantPhrase: 'use drive' })
    expect(statSync(file).ino).not.toBe(first)
    expect(q.listAll()).toHaveLength(2)
    expect(readdirSync(dir)).toEqual(['always-allow-persist-queue.json'])
  })
})

describe('a failed write leaves the previous good content intact', () => {
  it('always-allow-persist-queue: the entry queued before the failure is still readable', async () => {
    // The store's write seam is injectable precisely so a disk-full /
    // read-only-fs failure can be simulated deterministically. What matters
    // for durability is the OUTCOME: the destination still holds the last
    // good snapshot, not a truncated husk.
    let fail = false
    const seam = ((...args: Parameters<typeof writeFileSync>) => {
      if (fail) throw new Error('ENOSPC: no space left on device')
      return writeFileSync(...args)
    }) as typeof writeFileSync

    const q = createAlwaysAllowPersistQueue(dir, seam, log)
    await q.enqueue({ agentName: 'clerk', rule: 'Skill(calendar)', grantPhrase: 'use the calendar skill' })
    const before = readFileSync(join(dir, 'always-allow-persist-queue.json'), 'utf-8')

    fail = true
    await expect(
      q.enqueue({ agentName: 'clerk', rule: 'Skill(drive)', grantPhrase: 'use drive' }),
    ).rejects.toThrow(/ENOSPC/)

    expect(readFileSync(join(dir, 'always-allow-persist-queue.json'), 'utf-8')).toBe(before)
    fail = false
    expect(q.listAll().map(e => e.rule)).toEqual(['Skill(calendar)'])
  })
})
