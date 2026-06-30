import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPermissionCardStore, sweepStalePermCards } from '../gateway/permission-card-store.js'

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'perm-card-store-test-'))
}

describe('createPermissionCardStore', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    const store = createPermissionCardStore(dir)
    expect(store.loadAll()).toEqual([])
  })

  it('add and loadAll returns the entry', () => {
    const store = createPermissionCardStore(dir)
    const entry = {
      requestId: 'aabcd',
      chatId: '12345',
      messageId: 999,
      startedAt: Date.now(),
      toolName: 'mcp__shell__run',
      cardText: 'Run shell command',
    }
    store.add(entry)
    expect(store.loadAll()).toEqual([entry])
  })

  it('add multiple entries for same requestId (different messageIds)', () => {
    const store = createPermissionCardStore(dir)
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't' })
    store.add({ requestId: 'aabcd', chatId: '222', messageId: 2, startedAt: 1000, toolName: 't' })
    const all = store.loadAll()
    expect(all.length).toBe(2)
  })

  it('does not duplicate same requestId+messageId', () => {
    const store = createPermissionCardStore(dir)
    const entry = { requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't' }
    store.add(entry)
    store.add(entry)
    expect(store.loadAll().length).toBe(1)
  })

  it('remove clears all entries for a requestId', () => {
    const store = createPermissionCardStore(dir)
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't' })
    store.add({ requestId: 'aabcd', chatId: '222', messageId: 2, startedAt: 1000, toolName: 't' })
    store.add({ requestId: 'xyzab', chatId: '333', messageId: 3, startedAt: 1000, toolName: 't' })
    store.remove('aabcd')
    const all = store.loadAll()
    expect(all.length).toBe(1)
    expect(all[0].requestId).toBe('xyzab')
  })

  it('remove is idempotent when entry not present', () => {
    const store = createPermissionCardStore(dir)
    expect(() => store.remove('nonexistent')).not.toThrow()
  })

  it('clear empties the store', () => {
    const store = createPermissionCardStore(dir)
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't' })
    store.clear()
    expect(store.loadAll()).toEqual([])
  })

  it('survives re-instantiation (data persists across instances)', () => {
    createPermissionCardStore(dir).add({
      requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't',
    })
    const all = createPermissionCardStore(dir).loadAll()
    expect(all.length).toBe(1)
    expect(all[0].requestId).toBe('aabcd')
  })

  it('corrupt JSON file → loadAll returns []', () => {
    writeFileSync(join(dir, 'pending-perm-cards.json'), 'not-json{broken')
    expect(createPermissionCardStore(dir).loadAll()).toEqual([])
  })

  it('add after corrupt file recovers cleanly', () => {
    writeFileSync(join(dir, 'pending-perm-cards.json'), 'not-json{broken')
    const store = createPermissionCardStore(dir)
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't' })
    expect(store.loadAll().length).toBe(1)
  })
})

describe('sweepStalePermCards', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'perm-sweep-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function makeCard(requestId: string, messageId: number) {
    return { requestId, chatId: '99', messageId, startedAt: 1000, toolName: 'mcp__shell__run' }
  }

  it('no-op on empty list', async () => {
    const store = createPermissionCardStore(dir)
    const editFn = vi.fn()
    await sweepStalePermCards([], editFn, store)
    expect(editFn).not.toHaveBeenCalled()
  })

  it('calls editFn for each card with correct args', async () => {
    const store = createPermissionCardStore(dir)
    const cards = [makeCard('aabcd', 1), makeCard('bbcde', 2)]
    const editFn = vi.fn().mockResolvedValue(undefined)
    await sweepStalePermCards(cards, editFn, store)
    expect(editFn).toHaveBeenCalledTimes(2)
    expect(editFn).toHaveBeenCalledWith('99', 1, 'mcp__shell__run')
    expect(editFn).toHaveBeenCalledWith('99', 2, 'mcp__shell__run')
  })

  it('removes each stale card from the store after editing', async () => {
    const store = createPermissionCardStore(dir)
    store.add(makeCard('aabcd', 1))
    store.add(makeCard('bbcde', 2))
    await sweepStalePermCards(store.loadAll(), vi.fn().mockResolvedValue(undefined), store)
    expect(store.loadAll()).toEqual([])
  })

  it('fresh entries added during sweep are NOT removed', async () => {
    const store = createPermissionCardStore(dir)
    const stale = [makeCard('aabcd', 1)]
    const fresh = makeCard('zzzzz', 99)
    // Simulate a new card arriving mid-sweep (between editFn and remove)
    const editFn = vi.fn().mockImplementation(async () => {
      store.add(fresh)
    })
    await sweepStalePermCards(stale, editFn, store)
    // Stale entry removed; fresh entry untouched
    const remaining = store.loadAll()
    expect(remaining.length).toBe(1)
    expect(remaining[0].requestId).toBe('zzzzz')
  })

  it('editFn failure on one card does not stop sweep of remaining cards', async () => {
    const store = createPermissionCardStore(dir)
    const cards = [makeCard('aabcd', 1), makeCard('bbcde', 2)]
    cards.forEach(c => store.add(c))
    let callCount = 0
    const editFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) throw new Error('Telegram: message not found')
    })
    const logs: string[] = []
    await sweepStalePermCards(store.loadAll(), editFn, store, msg => logs.push(msg))
    expect(editFn).toHaveBeenCalledTimes(2)
    // Both cards removed regardless of edit failure
    expect(store.loadAll()).toEqual([])
    expect(logs.some(l => l.includes('stale-card strip failed'))).toBe(true)
  })
})
