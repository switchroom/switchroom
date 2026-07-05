/**
 * Tests for the persistence of the 30-min scoped-approval windows across
 * gateway restarts (#2863). The store (scopedGrants) is in-memory and used
 * to evaporate on any gateway bounce, re-carding an action the operator
 * allowed minutes ago. These pin:
 *
 *   - round-trip: record → persist → reload → lookup still hits in-window;
 *   - entries already past their ABSOLUTE expiry are dropped at reload;
 *   - a restart NEVER extends a window (grant at T, reload at T+29min →
 *     ~1 min left, not a fresh 30);
 *   - fail-closed survives a reload (a destructive Bash command still
 *     re-cards even when a reloaded family grant matches; an expired grant
 *     never matches);
 *   - kill switch (SWITCHROOM_SCOPED_GRANT_PERSIST=0): no writes, boot
 *     ignores any pre-existing file.
 *
 * The persistence I/O (createScopedGrantStore) is thin; the invariants live
 * in the pure serialize/deserialize + lookup, so we drive both together with
 * an isolated tmpdir (never ~/.switchroom or a shared STATE_DIR).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SCOPED_APPROVAL_DEFAULT_TTL_MS,
  recordScopedGrant,
  lookupScopedGrant,
  sweepScopedGrants,
  serializeScopedGrants,
  deserializeScopedGrants,
  countScopedGrants,
  type ScopedGrantStore,
} from '../scoped-approval.js'
import { createScopedGrantStore, scopedGrantPersistEnabled } from '../gateway/scoped-grant-store.js'

const T0 = 1_000_000
const TTL = SCOPED_APPROVAL_DEFAULT_TTL_MS
const AGENT = 'marko'

const editInput = (path: string) => JSON.stringify({ file_path: path })
const bashInput = (command: string) => JSON.stringify({ command })

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'scoped-grant-persist-test-'))
}

function filePath(dir: string) {
  return join(dir, 'scoped-grants.json')
}

describe('scoped-grant persistence', () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips: record → persist → reload → lookup hits within the window', () => {
    const store = createScopedGrantStore(dir, {})
    expect(store.enabled).toBe(true)

    // Operator taps Allow on a narrow file edit at T0.
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL)
    store.save(live)

    expect(existsSync(filePath(dir))).toBe(true)

    // Gateway restarts 5 minutes later; reload the store.
    const reloadAt = T0 + 5 * 60_000
    const reloaded = store.load(reloadAt)

    // The window is still live → an identical action auto-allows (no re-card).
    const hit = lookupScopedGrant(reloaded, AGENT, 'Edit', editInput('/state/x.ts'), reloadAt)
    expect(hit).toBe('Edit(/state/x.ts)')
  })

  it('drops entries already past their absolute expiry at reload', () => {
    const store = createScopedGrantStore(dir, {})
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL)
    store.save(live)

    // Reload well after the 30-min window has elapsed.
    const reloadAt = T0 + TTL + 60_000
    const reloaded = store.load(reloadAt)

    expect(countScopedGrants(reloaded)).toBe(0)
    const hit = lookupScopedGrant(reloaded, AGENT, 'Edit', editInput('/state/x.ts'), reloadAt)
    expect(hit).toBeNull()
  })

  it('a restart does NOT extend the window (absolute expiry preserved)', () => {
    const store = createScopedGrantStore(dir, {})
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL) // expiresAt = T0 + 30min
    store.save(live)

    // Reload at T0 + 29 min: only ~1 min should remain, not a fresh 30.
    const reloadAt = T0 + 29 * 60_000
    const reloaded = store.load(reloadAt)

    // Still live one minute before expiry...
    expect(lookupScopedGrant(reloaded, AGENT, 'Edit', editInput('/state/x.ts'), reloadAt)).toBe(
      'Edit(/state/x.ts)',
    )
    // ...but dead ~90s later — the original absolute expiry is honoured, the
    // reload gave it no new lease.
    const afterOriginalExpiry = T0 + TTL + 1_000
    expect(
      lookupScopedGrant(reloaded, AGENT, 'Edit', editInput('/state/x.ts'), afterOriginalExpiry),
    ).toBeNull()
  })

  it('fail-closed survives reload: destructive Bash never auto-allows', () => {
    const store = createScopedGrantStore(dir, {})
    const live: ScopedGrantStore = new Map()
    // A benign `git status` earned a Bash(git:*) family window.
    recordScopedGrant(live, AGENT, 'Bash(git:*)', T0, TTL)
    store.save(live)

    const reloadAt = T0 + 60_000
    const reloaded = store.load(reloadAt)

    // Benign member still auto-allows.
    expect(lookupScopedGrant(reloaded, AGENT, 'Bash', bashInput('git status'), reloadAt)).toBe(
      'Bash(git:*)',
    )
    // Destructive member of the SAME family fails closed after reload.
    expect(
      lookupScopedGrant(reloaded, AGENT, 'Bash', bashInput('git push --force'), reloadAt),
    ).toBeNull()
    expect(
      lookupScopedGrant(reloaded, AGENT, 'Bash', bashInput('git reset --hard'), reloadAt),
    ).toBeNull()
  })

  it('sweep-expiry removal is written through and a reload cannot resurrect it', () => {
    const store = createScopedGrantStore(dir, {})
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL)
    store.save(live)

    // Periodic sweep runs past expiry and removes the entry; write it through.
    const sweepAt = T0 + TTL + 1_000
    sweepScopedGrants(live, sweepAt)
    store.save(live)

    // A restart immediately after must see an empty store.
    const reloaded = store.load(sweepAt + 1)
    expect(countScopedGrants(reloaded)).toBe(0)
  })

  it('kill switch: no writes, and boot ignores a pre-existing file', () => {
    // Seed a live grant on disk as if a prior (persist-enabled) boot wrote it.
    const seeded = createScopedGrantStore(dir, {})
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL)
    seeded.save(live)
    const onDiskBefore = readFileSync(filePath(dir), 'utf-8')

    // Now boot with the kill switch on.
    const killed = createScopedGrantStore(dir, { SWITCHROOM_SCOPED_GRANT_PERSIST: '0' })
    expect(killed.enabled).toBe(false)
    expect(scopedGrantPersistEnabled({ SWITCHROOM_SCOPED_GRANT_PERSIST: '0' })).toBe(false)

    // Boot ignores the pre-existing file → empty store.
    const reloaded = killed.load(T0 + 60_000)
    expect(countScopedGrants(reloaded)).toBe(0)

    // save() is a no-op — the file is not touched.
    const grantsToPersist: ScopedGrantStore = new Map()
    recordScopedGrant(grantsToPersist, AGENT, 'Edit(/state/y.ts)', T0, TTL)
    killed.save(grantsToPersist)
    expect(readFileSync(filePath(dir), 'utf-8')).toBe(onDiskBefore)
  })

  it('pure serialize/deserialize drops malformed and expired rows (fail-closed)', () => {
    const now = T0
    const raw = [
      { agent: AGENT, rule: 'Edit(/state/live.ts)', expiresAt: now + TTL }, // keep
      { agent: AGENT, rule: 'Edit(/state/gone.ts)', expiresAt: now - 1 }, // expired → drop
      { agent: AGENT, rule: 'Edit(/state/x.ts)' }, // no expiresAt → drop
      { rule: 'Edit(/state/x.ts)', expiresAt: now + TTL }, // no agent → drop
      { agent: AGENT, rule: '', expiresAt: now + TTL }, // empty rule → drop
      'garbage', // not an object → drop
      null, // → drop
    ]
    const store = deserializeScopedGrants(raw, now)
    expect(countScopedGrants(store)).toBe(1)
    expect(lookupScopedGrant(store, AGENT, 'Edit', editInput('/state/live.ts'), now)).toBe(
      'Edit(/state/live.ts)',
    )
  })

  it('serialize captures absolute expiry, not a relative TTL', () => {
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL)
    const flat = serializeScopedGrants(live)
    expect(flat).toEqual([{ agent: AGENT, rule: 'Edit(/state/x.ts)', expiresAt: T0 + TTL }])
  })

  it('corrupt on-disk JSON reloads as an empty store (fail-closed, no throw)', () => {
    writeFileSync(filePath(dir), '{ this is not json', 'utf-8')
    const store = createScopedGrantStore(dir, {})
    const reloaded = store.load(T0)
    expect(countScopedGrants(reloaded)).toBe(0)
  })

  it('persisted file is written with mode 0o600', () => {
    const store = createScopedGrantStore(dir, {})
    const live: ScopedGrantStore = new Map()
    recordScopedGrant(live, AGENT, 'Edit(/state/x.ts)', T0, TTL)
    store.save(live)
    const mode = statSync(filePath(dir)).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
