/**
 * Unit tests for access-store.ts — the access/allowlist file layer extracted
 * from gateway.ts (switchroom#4248).
 *
 * These lock in the behavior that used to be inline in gateway.ts, in
 * particular the init-time-only static-mode snapshot (BOOT_ACCESS): in static
 * mode the allowlist is read ONCE when the store is built and frozen for the
 * life of the store, so a later edit to access.json on disk is NOT observed.
 * That timing is the whole reason the store is a factory rather than a set of
 * lazy free functions — this suite is the outcome guard for it.
 *
 * Run with: npx vitest run telegram-plugin/gateway/access-store.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccessStore, type AccessStoreDeps } from './access-store.js'
import type { Access } from './gateway.js'

function makeDeps(dir: string, isStatic: boolean): AccessStoreDeps {
  return {
    accessFile: join(dir, 'access.json'),
    peopleFile: join(dir, 'people.json'),
    stateDir: dir,
    isStatic,
  }
}

describe('access-store', () => {
  let dir: string
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'access-store-'))
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  // ─── defaultAccess ─────────────────────────────────────────────────────────

  it('defaultAccess returns a pairing-mode empty allowlist', () => {
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.defaultAccess()).toEqual({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    })
  })

  // ─── readAccessFile ────────────────────────────────────────────────────────

  it('readAccessFile returns defaultAccess when the file is missing (ENOENT)', () => {
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.readAccessFile()).toEqual(store.defaultAccess())
  })

  it('readAccessFile parses a valid access.json and projects known fields', () => {
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({
        dmPolicy: 'allowlist',
        allowFrom: ['111'],
        groups: { '-100': { requireMention: true, allowFrom: ['222'] } },
        pending: {},
        parseMode: 'text',
        historyEnabled: false,
      }),
    )
    const store = createAccessStore(makeDeps(dir, false))
    const a = store.readAccessFile()
    expect(a.dmPolicy).toBe('allowlist')
    expect(a.allowFrom).toEqual(['111'])
    expect(a.groups['-100']).toEqual({ requireMention: true, allowFrom: ['222'] })
    expect(a.parseMode).toBe('text')
    expect(a.historyEnabled).toBe(false)
  })

  it('readAccessFile fails closed on number-array fields (the hand-edit bug)', () => {
    // Unquoted IDs parse as numbers; validateStringArray must drop them.
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [12345], groups: {}, pending: {} }),
    )
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.readAccessFile().allowFrom).toEqual([])
    expect(stderrSpy).toHaveBeenCalled()
  })

  it('readAccessFile moves a corrupt file aside and returns defaultAccess', () => {
    writeFileSync(join(dir, 'access.json'), '{ not valid json')
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.readAccessFile()).toEqual(store.defaultAccess())
    // Original replaced by a .corrupt-* sibling.
    expect(existsSync(join(dir, 'access.json'))).toBe(false)
    const corrupt = readdirSync(dir).filter((f) => f.startsWith('access.json.corrupt-'))
    expect(corrupt.length).toBe(1)
  })

  // ─── loadAccess — non-static re-reads live ─────────────────────────────────

  it('loadAccess re-reads the file on every call in non-static mode', () => {
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} }),
    )
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.loadAccess().allowFrom).toEqual(['111'])
    // Edit on disk is observed immediately (no snapshot in non-static mode).
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['222'], groups: {}, pending: {} }),
    )
    expect(store.loadAccess().allowFrom).toEqual(['222'])
  })

  // ─── Static-mode BOOT_ACCESS snapshot (init-time semantics) ────────────────

  it('static mode snapshots at build time: downgrades pairing→allowlist and clears pending', () => {
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({
        dmPolicy: 'pairing',
        allowFrom: ['111'],
        groups: {},
        pending: { code123: { senderId: 's', chatId: 'c', createdAt: 1, expiresAt: 2, replies: 0 } },
      }),
    )
    const store = createAccessStore(makeDeps(dir, true))
    const a = store.loadAccess()
    expect(a.dmPolicy).toBe('allowlist')
    expect(a.pending).toEqual({})
    expect(a.allowFrom).toEqual(['111'])
  })

  it('static mode freezes the allowlist: an on-disk edit after build is NOT observed', () => {
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} }),
    )
    const store = createAccessStore(makeDeps(dir, true))
    expect(store.loadAccess().allowFrom).toEqual(['111'])
    // Change the file after the store was built.
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['999'], groups: {}, pending: {} }),
    )
    // Still the boot snapshot — this is the init-time-only guarantee.
    expect(store.loadAccess().allowFrom).toEqual(['111'])
  })

  // ─── saveAccess ────────────────────────────────────────────────────────────

  it('saveAccess writes access.json atomically in non-static mode', () => {
    const store = createAccessStore(makeDeps(dir, false))
    const a: Access = { dmPolicy: 'allowlist', allowFrom: ['abc'], groups: {}, pending: {} }
    store.saveAccess(a)
    const written = JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'))
    expect(written.allowFrom).toEqual(['abc'])
    // No leftover temp file.
    expect(existsSync(join(dir, 'access.json.tmp'))).toBe(false)
  })

  it('saveAccess is a no-op in static mode', () => {
    const store = createAccessStore(makeDeps(dir, true))
    store.saveAccess({ dmPolicy: 'allowlist', allowFrom: ['abc'], groups: {}, pending: {} })
    expect(existsSync(join(dir, 'access.json'))).toBe(false)
  })

  // ─── pruneExpired ──────────────────────────────────────────────────────────

  it('pruneExpired removes expired pending entries and reports whether it changed', () => {
    const now = Date.now()
    const store = createAccessStore(makeDeps(dir, false))
    const a: Access = {
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {
        old: { senderId: 's', chatId: 'c', createdAt: 1, expiresAt: now - 1000, replies: 0 },
        fresh: { senderId: 's', chatId: 'c', createdAt: 1, expiresAt: now + 100000, replies: 0 },
      },
    }
    expect(store.pruneExpired(a)).toBe(true)
    expect(Object.keys(a.pending)).toEqual(['fresh'])
    // Second pass: nothing expired now → no change.
    expect(store.pruneExpired(a)).toBe(false)
  })

  // ─── assertAllowedChat ─────────────────────────────────────────────────────

  it('assertAllowedChat permits an allowFrom chat, a group chat, and rejects others', () => {
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({
        dmPolicy: 'allowlist',
        allowFrom: ['111'],
        groups: { '-100': { requireMention: false, allowFrom: [] } },
        pending: {},
      }),
    )
    const store = createAccessStore(makeDeps(dir, false))
    expect(() => store.assertAllowedChat('111')).not.toThrow()
    expect(() => store.assertAllowedChat(111)).not.toThrow() // number coerced
    expect(() => store.assertAllowedChat('-100')).not.toThrow()
    expect(() => store.assertAllowedChat('404')).toThrow(/not allowlisted/)
  })

  // ─── readPeopleFile ────────────────────────────────────────────────────────

  it('readPeopleFile returns entries for a valid people.json', () => {
    writeFileSync(
      join(dir, 'people.json'),
      JSON.stringify({ entries: [{ telegramUserId: '5', personId: 'p1' }] }),
    )
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.readPeopleFile()).toEqual([{ telegramUserId: '5', personId: 'p1' }])
  })

  it('readPeopleFile fails open to [] on missing or corrupt file', () => {
    const store = createAccessStore(makeDeps(dir, false))
    expect(store.readPeopleFile()).toEqual([]) // ENOENT
    writeFileSync(join(dir, 'people.json'), 'not json')
    expect(store.readPeopleFile()).toEqual([]) // corrupt
    writeFileSync(join(dir, 'people.json'), JSON.stringify({ entries: 'nope' }))
    expect(store.readPeopleFile()).toEqual([]) // entries not an array
  })
})
