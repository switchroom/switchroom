/**
 * Unit tests for telegram-plugin/gateway/missed-approvals-store.ts (#2862).
 *
 * Persisted list of approvals that TTL-expired while the operator was away.
 * Contract under test:
 *   - append at auto-deny; dedup on requestId; survive reload (new instance);
 *   - cap pending (drop oldest) so the file stays bounded;
 *   - promoteToDigest moves pending → delivered (so a second read sees empty
 *     pending → "posts once");
 *   - getDigest / removeDigest for the retry/dismiss taps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createMissedApprovalsStore,
  MAX_PENDING,
  type MissedApproval,
} from '../gateway/missed-approvals-store.js'

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'missed-approvals-store-test-'))
}

function entry(over: Partial<MissedApproval> = {}): MissedApproval {
  return {
    requestId: 'fztws',
    toolName: 'mcp__brevo__post',
    action: 'post to Brevo',
    chatId: '-100123',
    threadId: 7,
    timedOutAt: 1_700_000_000_000,
    ...over,
  }
}

describe('createMissedApprovalsStore', () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    const store = createMissedApprovalsStore(dir)
    expect(store.listPending()).toEqual([])
    expect(store.pendingCount()).toBe(0)
  })

  it('append + listPending returns the entry', () => {
    const store = createMissedApprovalsStore(dir)
    store.add(entry())
    expect(store.listPending()).toHaveLength(1)
    expect(store.listPending()[0].action).toBe('post to Brevo')
  })

  it('dedups on requestId (replace, not duplicate)', () => {
    const store = createMissedApprovalsStore(dir)
    store.add(entry({ requestId: 'aaa', action: 'first' }))
    store.add(entry({ requestId: 'aaa', action: 'second' }))
    expect(store.listPending()).toHaveLength(1)
    expect(store.listPending()[0].action).toBe('second')
  })

  it('survives reload (a fresh instance sees persisted entries)', () => {
    const s1 = createMissedApprovalsStore(dir)
    s1.add(entry({ requestId: 'a' }))
    s1.add(entry({ requestId: 'b' }))
    const s2 = createMissedApprovalsStore(dir)
    expect(s2.pendingCount()).toBe(2)
  })

  it('caps pending at MAX_PENDING, dropping the oldest', () => {
    const store = createMissedApprovalsStore(dir)
    for (let i = 0; i < MAX_PENDING + 5; i++) {
      store.add(entry({ requestId: `r${i}`, timedOutAt: 1_700_000_000_000 + i }))
    }
    const pending = store.listPending()
    expect(pending).toHaveLength(MAX_PENDING)
    // Oldest (r0..r4) dropped; newest (r<MAX+4>) retained.
    expect(pending.some(e => e.requestId === 'r0')).toBe(false)
    expect(pending.some(e => e.requestId === `r${MAX_PENDING + 4}`)).toBe(true)
  })

  it('promoteToDigest moves entries out of pending into a delivered record', () => {
    const store = createMissedApprovalsStore(dir)
    store.add(entry({ requestId: 'a', action: 'post to Brevo' }))
    store.add(entry({ requestId: 'b', action: 'send email' }))
    const entries = store.listPending()
    store.promoteToDigest({
      digestId: 'deadbeef',
      chatId: '-100123',
      threadId: 7,
      entries,
      deliveredAt: Date.now(),
    })
    // Pending is now empty — a second operator-activity event posts nothing.
    expect(store.listPending()).toEqual([])
    const digest = store.getDigest('deadbeef')
    expect(digest?.entries).toHaveLength(2)
    expect(digest?.entries.map(e => e.action)).toEqual(['post to Brevo', 'send email'])
  })

  it('removeDigest drops the delivered record (dismiss / retry consumed it)', () => {
    const store = createMissedApprovalsStore(dir)
    store.add(entry({ requestId: 'a' }))
    store.promoteToDigest({
      digestId: 'cafef00d',
      chatId: '-100123',
      threadId: 7,
      entries: store.listPending(),
      deliveredAt: Date.now(),
    })
    expect(store.getDigest('cafef00d')).toBeDefined()
    store.removeDigest('cafef00d')
    expect(store.getDigest('cafef00d')).toBeUndefined()
  })

  it('promote + remove survive reload', () => {
    const s1 = createMissedApprovalsStore(dir)
    s1.add(entry({ requestId: 'a' }))
    s1.promoteToDigest({
      digestId: 'd1',
      chatId: '-100123',
      threadId: null,
      entries: s1.listPending(),
      deliveredAt: Date.now(),
    })
    const s2 = createMissedApprovalsStore(dir)
    expect(s2.getDigest('d1')?.entries).toHaveLength(1)
    expect(s2.listPending()).toEqual([])
  })

  it('clear() wipes the backing file', () => {
    const store = createMissedApprovalsStore(dir)
    store.add(entry())
    store.clear()
    expect(store.listPending()).toEqual([])
  })

  it('tolerates a corrupt backing file (returns empty)', () => {
    const store = createMissedApprovalsStore(dir)
    // Write garbage directly, then ensure reads don't throw.
    writeFileSync(join(dir, 'missed-approvals.json'), 'not json')
    expect(store.listPending()).toEqual([])
  })
})
