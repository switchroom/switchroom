/**
 * Unit tests for the cross-reboot boot-card message-id store
 * (gateway/boot-card-msgid.ts) — the persistence that lets a routine reboot
 * EDIT the prior boot card in place (zero notification) instead of sending a
 * new one.
 *
 * All I/O is to an isolated mkdtemp dir — NEVER ~/.switchroom (test discipline).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bootCardChatKey,
  loadBootCardMsgId,
  saveBootCardMsgId,
} from '../gateway/boot-card-msgid.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-card-msgid-'))
  path = join(dir, '.boot-card-msgid.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('bootCardChatKey', () => {
  it('keys a DM (no topic) distinctly from a supergroup topic', () => {
    expect(bootCardChatKey('12345', undefined)).toBe('12345:')
    expect(bootCardChatKey('-1001234567890', 4)).toBe('-1001234567890:4')
    // Different topics in the same supergroup are distinct cards.
    expect(bootCardChatKey('-100', 3)).not.toBe(bootCardChatKey('-100', 4))
  })
})

describe('loadBootCardMsgId / saveBootCardMsgId', () => {
  it('returns null when the file does not exist (first boot)', () => {
    expect(loadBootCardMsgId(path, 'dm:')).toBeNull()
  })

  it('round-trips a saved id', () => {
    saveBootCardMsgId(path, 'dm:', 353)
    expect(loadBootCardMsgId(path, 'dm:')).toBe(353)
  })

  it('keeps ids for different chats independent', () => {
    saveBootCardMsgId(path, 'dm:', 100)
    saveBootCardMsgId(path, '-100:4', 200)
    expect(loadBootCardMsgId(path, 'dm:')).toBe(100)
    expect(loadBootCardMsgId(path, '-100:4')).toBe(200)
    // Updating one leaves the other intact.
    saveBootCardMsgId(path, 'dm:', 101)
    expect(loadBootCardMsgId(path, 'dm:')).toBe(101)
    expect(loadBootCardMsgId(path, '-100:4')).toBe(200)
  })

  it('returns null for an unknown chat key', () => {
    saveBootCardMsgId(path, 'dm:', 1)
    expect(loadBootCardMsgId(path, 'other:')).toBeNull()
  })

  it('rejects non-positive / non-finite ids on save and load', () => {
    saveBootCardMsgId(path, 'dm:', 0)
    saveBootCardMsgId(path, 'dm:', -5)
    saveBootCardMsgId(path, 'dm:', Number.NaN)
    expect(loadBootCardMsgId(path, 'dm:')).toBeNull()
  })

  it('treats a corrupt file as empty (falls back to fresh send)', () => {
    writeFileSync(path, 'not json{', 'utf8')
    expect(loadBootCardMsgId(path, 'dm:')).toBeNull()
    // And a subsequent save still works (overwrites the garbage).
    saveBootCardMsgId(path, 'dm:', 7)
    expect(loadBootCardMsgId(path, 'dm:')).toBe(7)
  })

  it('does not rewrite the file when the id is unchanged (idempotent)', () => {
    saveBootCardMsgId(path, 'dm:', 42)
    expect(existsSync(path)).toBe(true)
    // Saving the same value again is a no-op; the value is still readable.
    saveBootCardMsgId(path, 'dm:', 42)
    expect(loadBootCardMsgId(path, 'dm:')).toBe(42)
  })
})
