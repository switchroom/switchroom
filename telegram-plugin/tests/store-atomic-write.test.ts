/**
 * Atomic-write + corruption contract for the gateway's four small JSON state
 * stores: `pending-card-store`, `scoped-grant-store`, `missed-approvals-store`,
 * `always-allow-persist-queue`.
 *
 * The bug these pin: each store did a non-atomic read-modify-write straight
 * over the destination (`writeFileSync(dest, …)` = open + O_TRUNC + write),
 * and wrapped the read in `catch { return [] }`. A crash between the truncate
 * and the write left a TORN file; on the next boot the parse threw, the catch
 * swallowed it, and every pending approval card / live scoped grant was
 * silently forgotten. Nothing was logged. The operator just saw dead buttons.
 *
 * SCOPE OF THE CLAIM — deliberately narrow. What is asserted here is ATOMIC
 * REPLACEMENT: a reader (or a crash) sees the whole old file or the whole new
 * file, never a half-written one. That is NOT the same as crash-durability
 * against power loss: `atomicWriteFileSync` fsyncs the tempfile but not the
 * PARENT DIRECTORY, so an unjournalled dirent can still revert the rename
 * after a power cut (tracked as a separate follow-up against
 * `src/util/atomic.ts`, which is shared with vault entries and OAuth tokens
 * and needs its own review). Whole-old-or-whole-new holds either way, and
 * that is what the torn-file bug was about.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createPendingCardStore, type PersistedApprovalCard } from '../gateway/pending-card-store.js'
import { createScopedGrantStore } from '../gateway/scoped-grant-store.js'
import { createMissedApprovalsStore, type MissedApproval } from '../gateway/missed-approvals-store.js'
import {
  atomicWriteSeam,
  createAlwaysAllowPersistQueue,
} from '../gateway/always-allow-persist-queue.js'
import { MAX_QUARANTINED_COPIES, quarantineCorruptStoreFile } from '../gateway/store-file.js'

let dir: string
let logged: string[]
const log = (line: string) => {
  logged.push(line)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-atomic-write-'))
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
    writeFileSync(join(dir, 'pending-approval-cards.json'), TORN)

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
    writeFileSync(join(dir, 'scoped-grants.json'), TORN)

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

describe('valid JSON whose LIST FIELD is not a list is corruption, not "empty"', () => {
  // The original silent-loss bug in a second costume: `{"pending": null}` and
  // `{"entries": {}}` parse fine and reach an object at top level, so a naive
  // `Array.isArray(x) ? x : []` coercion swallows them exactly the way the
  // old `catch { return [] }` did — dead buttons, nothing logged.

  it('missed-approvals-store: `pending` present but null quarantines', () => {
    writeFileSync(join(dir, 'missed-approvals.json'), '{"pending":null,"delivered":[]}')

    expect(createMissedApprovalsStore(dir, log).listPending()).toEqual([])
    expect(quarantinedFiles('missed-approvals.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/`pending` is present but not an array/)
  })

  it('missed-approvals-store: `delivered` present but an object quarantines', () => {
    writeFileSync(join(dir, 'missed-approvals.json'), '{"pending":[],"delivered":{}}')

    expect(createMissedApprovalsStore(dir, log).getDigest('d1')).toBeUndefined()
    expect(quarantinedFiles('missed-approvals.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/`delivered` is present but not an array/)
  })

  it('always-allow-persist-queue: `entries` present but an object quarantines', () => {
    writeFileSync(join(dir, 'always-allow-persist-queue.json'), '{"entries":{}}')

    expect(createAlwaysAllowPersistQueue(dir, undefined, log).listAll()).toEqual([])
    expect(quarantinedFiles('always-allow-persist-queue.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/`entries` is present but not an array/)
  })

  it('an ABSENT list is the legitimate partial shape — silent, no quarantine', () => {
    writeFileSync(join(dir, 'missed-approvals.json'), '{}')
    writeFileSync(join(dir, 'always-allow-persist-queue.json'), '{}')

    expect(createMissedApprovalsStore(dir, log).listPending()).toEqual([])
    expect(createAlwaysAllowPersistQueue(dir, undefined, log).listAll()).toEqual([])

    expect(quarantinedFiles('missed-approvals.json')).toEqual([])
    expect(quarantinedFiles('always-allow-persist-queue.json')).toEqual([])
    expect(logged).toEqual([])
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

  it('scoped-grant-store', () => {
    const store = createScopedGrantStore(dir, {}, log)
    store.save(new Map())
    const file = join(dir, 'scoped-grants.json')
    const first = statSync(file).ino

    store.save(new Map())
    expect(statSync(file).ino).not.toBe(first)
    expect(readdirSync(dir)).toEqual(['scoped-grants.json'])
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
    expect(statSync(file).mode & 0o777).toBe(0o600)
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
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('a write failure is surfaced and leaves the previous good content intact', () => {
  // NOTE ON WHAT THIS PROVES: the good write below goes through the REAL
  // atomic writer (`atomicWriteSeam`); only the second call is diverted to a
  // thrower. So this asserts failure PROPAGATION plus "the destination still
  // holds the last good snapshot" — it does NOT by itself prove atomicity
  // (the inode suite above does that).
  it('always-allow-persist-queue: the entry queued before the failure is still readable', async () => {
    let fail = false
    const seam = ((...args: Parameters<typeof atomicWriteSeam>) => {
      if (fail) throw new Error('ENOSPC: no space left on device')
      return atomicWriteSeam(...args)
    }) as typeof atomicWriteSeam

    const q = createAlwaysAllowPersistQueue(dir, seam, log)
    await q.enqueue({ agentName: 'clerk', rule: 'Skill(calendar)', grantPhrase: 'use the calendar skill' })
    const file = join(dir, 'always-allow-persist-queue.json')
    const before = readFileSync(file, 'utf-8')
    const beforeIno = statSync(file).ino

    fail = true
    await expect(
      q.enqueue({ agentName: 'clerk', rule: 'Skill(drive)', grantPhrase: 'use drive' }),
    ).rejects.toThrow(/ENOSPC/)

    // Byte-identical AND the same inode — the failed write never even touched
    // the destination, let alone truncated it.
    expect(readFileSync(file, 'utf-8')).toBe(before)
    expect(statSync(file).ino).toBe(beforeIno)
    fail = false
    expect(q.listAll().map(e => e.rule)).toEqual(['Skill(calendar)'])
  })
})

describe('an UNREADABLE file (not ENOENT) is loud, is never quarantined on read, and fails closed on write', () => {
  // A directory at the store path makes `readFileSync` fail EISDIR — a
  // deterministic stand-in for the flaky-mount EIO / transient EACCES class
  // (chmod tricks don't work: CI and the containers run as root).
  it('pending-card-store: logs loudly and does NOT quarantine on the read', () => {
    mkdirSync(join(dir, 'pending-approval-cards.json'))

    expect(createPendingCardStore(dir, log).loadAll()).toEqual([])

    expect(logged.join('')).toMatch(/pending-card-store read FAILED/)
    expect(logged.join('')).toMatch(/EISDIR/)
    // Crucially NOT quarantined — a file we merely failed to read may still
    // hold perfectly good state, and a transient fault must not destroy it.
    expect(quarantinedFiles('pending-approval-cards.json')).toEqual([])
  })

  it('pending-card-store: the next write PRESERVES the unreadable file instead of clobbering it', () => {
    mkdirSync(join(dir, 'pending-approval-cards.json'))
    const store = createPendingCardStore(dir, log)

    store.add(sampleCard('s1'))

    // The bytes we could not read were moved aside, not overwritten...
    expect(quarantinedFiles('pending-approval-cards.json')).toHaveLength(1)
    expect(logged.join('')).toMatch(/Preserved the previous \(unreadable\) bytes/)
    // ...and the store carried on with a fresh, valid file.
    expect(store.loadAll().map(c => c.stageId)).toEqual(['s1'])
  })

  it('always-allow-persist-queue: the preserve step runs before the write', async () => {
    mkdirSync(join(dir, 'always-allow-persist-queue.json'))
    const q = createAlwaysAllowPersistQueue(dir, undefined, log)

    await q.enqueue({ agentName: 'clerk', rule: 'Skill(calendar)', grantPhrase: 'use the calendar skill' })

    expect(quarantinedFiles('always-allow-persist-queue.json')).toHaveLength(1)
    expect(q.listAll().map(e => e.rule)).toEqual(['Skill(calendar)'])
  })
})

describe('kill switch: a disabled scoped-grant store never touches the file', () => {
  it('does not read, quarantine, or write when SWITCHROOM_SCOPED_GRANT_PERSIST=0', () => {
    writeFileSync(join(dir, 'scoped-grants.json'), TORN)
    const store = createScopedGrantStore(dir, { SWITCHROOM_SCOPED_GRANT_PERSIST: '0' }, log)

    expect(store.enabled).toBe(false)
    expect(store.load(Date.now()).size).toBe(0)
    store.save(new Map())

    // The pre-existing (corrupt) file is left exactly as found — a disabled
    // store must not be the thing that moves the operator's data around.
    expect(readFileSync(join(dir, 'scoped-grants.json'), 'utf-8')).toBe(TORN)
    expect(quarantinedFiles('scoped-grants.json')).toEqual([])
    expect(logged).toEqual([])
  })
})

describe('quarantine copies do not collide and do not accumulate without bound', () => {
  it('two quarantines in the same millisecond both survive (random suffix)', () => {
    const file = join(dir, 'x.json')
    for (const bytes of ['first', 'second']) {
      writeFileSync(file, bytes)
      quarantineCorruptStoreFile(file, 'test-store', 'forced', log)
    }
    const copies = quarantinedFiles('x.json')
    expect(copies).toHaveLength(2)
    expect(copies.map(f => readFileSync(join(dir, f), 'utf-8')).sort()).toEqual(['first', 'second'])
  })

  it(`keeps at most ${MAX_QUARANTINED_COPIES} forensic copies, newest wins`, () => {
    const file = join(dir, 'x.json')
    const total = MAX_QUARANTINED_COPIES + 4
    for (let i = 0; i < total; i++) {
      writeFileSync(file, `copy-${i}`)
      quarantineCorruptStoreFile(file, 'test-store', 'forced', log)
    }
    const copies = quarantinedFiles('x.json')
    expect(copies).toHaveLength(MAX_QUARANTINED_COPIES)
    // The reap drops the OLDEST — exactly the newest MAX are kept, even
    // though these all land in the same millisecond (so the ordering cannot
    // be coming from the embedded timestamp alone).
    expect(copies.map(f => readFileSync(join(dir, f), 'utf-8')).sort()).toEqual(
      Array.from({ length: MAX_QUARANTINED_COPIES }, (_, i) => `copy-${total - MAX_QUARANTINED_COPIES + i}`),
    )
  })

  it('a RESTARTED process does not get its fresh copy reaped as "oldest"', () => {
    // Regression: ordering used to come from the `<epoch-ms>-<seq>` embedded
    // in the filename, but `seq` restarts at 0 on every process boot. A prior
    // process that burned seq 000001..000005 within millisecond T, followed
    // by a restart quarantining in that same T, produced a NEW copy named
    // `T-000000-…` — lexicographically the OLDEST of the set, so the reaper
    // deleted precisely the forensic bytes the operator needed. Ordering is
    // by mtime now, which no process restart can rewind.
    const file = join(dir, 'x.json')
    const stamp = Date.now()
    for (let i = 1; i <= MAX_QUARANTINED_COPIES; i++) {
      // The prior process's sequence numbers — deliberately HIGHER than the
      // restarted process's (whose counter is back near 0), which is the
      // whole point: a name-ordered reaper would rank the fresh copy oldest.
      const seeded = `${file}.corrupt-${stamp}-${String(900_000 + i).padStart(6, '0')}-aaaaaaaa`
      writeFileSync(seeded, `old-${i}`)
      // Genuinely older on disk (the prior process wrote them seconds ago),
      // while still carrying the same embedded millisecond in the NAME — so
      // a name-ordered reaper and an mtime-ordered one disagree, which is
      // exactly the discriminating case.
      const past = new Date(Date.now() - (MAX_QUARANTINED_COPIES + 1 - i) * 1000)
      utimesSync(seeded, past, past)
    }

    // The restarted process quarantines fresh bytes; its seq is back at 0.
    writeFileSync(file, 'NEWEST-FORENSIC-BYTES')
    quarantineCorruptStoreFile(file, 'test-store', 'forced', log)

    const kept = quarantinedFiles('x.json').map(f => readFileSync(join(dir, f), 'utf-8'))
    expect(kept).toHaveLength(MAX_QUARANTINED_COPIES)
    expect(kept).toContain('NEWEST-FORENSIC-BYTES')
    expect(kept).not.toContain('old-1') // the genuinely oldest went instead
  })
})
