import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPermissionCardStore } from '../gateway/permission-card-store.js'

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
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't', cardText: 'c' })
    store.add({ requestId: 'aabcd', chatId: '222', messageId: 2, startedAt: 1000, toolName: 't', cardText: 'c' })
    const all = store.loadAll()
    expect(all.length).toBe(2)
  })

  it('does not duplicate same requestId+messageId', () => {
    const store = createPermissionCardStore(dir)
    const entry = { requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't', cardText: 'c' }
    store.add(entry)
    store.add(entry)
    expect(store.loadAll().length).toBe(1)
  })

  it('remove clears all entries for a requestId', () => {
    const store = createPermissionCardStore(dir)
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't', cardText: 'c' })
    store.add({ requestId: 'aabcd', chatId: '222', messageId: 2, startedAt: 1000, toolName: 't', cardText: 'c' })
    store.add({ requestId: 'xyzab', chatId: '333', messageId: 3, startedAt: 1000, toolName: 't', cardText: 'c' })
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
    store.add({ requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't', cardText: 'c' })
    store.clear()
    expect(store.loadAll()).toEqual([])
  })

  it('survives re-instantiation (data persists across instances)', () => {
    createPermissionCardStore(dir).add({
      requestId: 'aabcd', chatId: '111', messageId: 1, startedAt: 1000, toolName: 't', cardText: 'c',
    })
    const all = createPermissionCardStore(dir).loadAll()
    expect(all.length).toBe(1)
    expect(all[0].requestId).toBe('aabcd')
  })
})
