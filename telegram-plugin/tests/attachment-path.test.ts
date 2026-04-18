/**
 * Exhaustive tests for the attachment-path sanitizer.
 *
 * Covers the specific path-traversal and adversarial-input shapes that
 * the prior inline implementations either handled inconsistently or
 * missed. Complements the integration tests (which use the bot handler
 * end-to-end) — this file verifies the building block in isolation.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import {
  buildAttachmentPath,
  sanitizeExtension,
  sanitizeUniqueId,
  extractExtension,
  assertInsideInbox,
} from '../attachment-path.js'

describe('sanitizeExtension', () => {
  it.each([
    ['jpg', 'jpg'],
    ['png', 'png'],
    ['mp4', 'mp4'],
    ['tar.gz', 'targz'],      // dots stripped
    ['../../etc', 'etc'],      // traversal attempt stripped
    ['sh; rm -rf', 'shrmrf'],  // shell metacharacters stripped
    ['jpg/../etc', 'jpgetc'],  // mixed stripped
    ['', 'bin'],                // empty → fallback
    ['   ', 'bin'],             // whitespace-only → fallback
    ['...', 'bin'],             // punctuation-only → fallback
    ['JPG', 'JPG'],             // case preserved
    ['a1b2c3', 'a1b2c3'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeExtension(input)).toBe(expected)
  })

  it('undefined → fallback', () => {
    expect(sanitizeExtension(undefined)).toBe('bin')
  })
})

describe('sanitizeUniqueId', () => {
  it.each([
    ['AgACAgI123', 'AgACAgI123'],
    ['abc_DEF-123', 'abc_DEF-123'],  // underscore + dash allowed
    ['../../etc', 'etc'],              // dots and slashes stripped
    ['id/with/slash', 'idwithslash'],
    ['id\\back\\slash', 'idbackslash'],
    ['id with space', 'idwithspace'],
    ['id;rm -rf /', 'idrm-rf'],       // dash preserved, shell stripped
    ['', 'dl'],
    ['...', 'dl'],
    ['%00null', '00null'],
    ['a.b.c', 'abc'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeUniqueId(input)).toBe(expected)
  })

  it('undefined → fallback', () => {
    expect(sanitizeUniqueId(undefined)).toBe('dl')
  })
})

describe('extractExtension', () => {
  it.each([
    ['photos/123.jpg', 'jpg'],
    ['documents/file.png', 'png'],
    ['a/b.c/d.tar.gz', 'gz'],        // last dot wins, sanitized
    ['no-dot-here', 'bin'],           // no dot → fallback
    ['', 'bin'],
    ['.hiddenfile', 'hiddenfile'],    // leading dot → that's the extension
    ['file.', 'bin'],                 // trailing dot, empty ext → fallback
    ['photos/123.JPG', 'JPG'],        // case preserved
  ])('%j → %j', (input, expected) => {
    expect(extractExtension(input)).toBe(expected)
  })

  it('undefined → fallback', () => {
    expect(extractExtension(undefined)).toBe('bin')
  })
})

describe('buildAttachmentPath', () => {
  it('composes a stable filename under inboxDir', () => {
    const path = buildAttachmentPath({
      inboxDir: '/inbox',
      telegramFilePath: 'photos/123.jpg',
      fileUniqueId: 'AgACAgI456',
      now: 1700000000000,
    })
    expect(path).toBe(join('/inbox', '1700000000000-AgACAgI456.jpg'))
  })

  it('sanitizes adversarial file_unique_id', () => {
    const path = buildAttachmentPath({
      inboxDir: '/inbox',
      telegramFilePath: 'photos/123.jpg',
      fileUniqueId: '../../etc/passwd',
      now: 1700000000000,
    })
    // The traversal chars are stripped; filename is plain text.
    expect(path).toBe(join('/inbox', '1700000000000-etcpasswd.jpg'))
    expect(path).not.toContain('..')
  })

  it('sanitizes adversarial extension', () => {
    const path = buildAttachmentPath({
      inboxDir: '/inbox',
      telegramFilePath: 'file.sh; rm -rf /',
      fileUniqueId: 'x',
      now: 1700000000000,
    })
    expect(path).toBe(join('/inbox', '1700000000000-x.shrmrf'))
  })

  it('handles missing file_path gracefully', () => {
    const path = buildAttachmentPath({
      inboxDir: '/inbox',
      telegramFilePath: undefined,
      fileUniqueId: 'x',
      now: 1700000000000,
    })
    expect(path).toBe(join('/inbox', '1700000000000-x.bin'))
  })

  it('handles missing file_unique_id gracefully', () => {
    const path = buildAttachmentPath({
      inboxDir: '/inbox',
      telegramFilePath: 'photos/123.jpg',
      fileUniqueId: undefined,
      now: 1700000000000,
    })
    expect(path).toBe(join('/inbox', '1700000000000-dl.jpg'))
  })

  it('null-byte in file_unique_id is stripped', () => {
    const path = buildAttachmentPath({
      inboxDir: '/inbox',
      telegramFilePath: 'a.jpg',
      fileUniqueId: 'id\u0000poison',
      now: 1,
    })
    expect(path).toBe(join('/inbox', '1-idpoison.jpg'))
    expect(path.includes('\u0000')).toBe(false)
  })
})

describe('assertInsideInbox', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'inbox-test-'))

  it('allows a path directly inside inbox', () => {
    expect(() => assertInsideInbox(inbox, join(inbox, 'safe.jpg'))).not.toThrow()
  })

  it('allows the inbox itself', () => {
    expect(() => assertInsideInbox(inbox, inbox)).not.toThrow()
  })

  it('rejects a parent-dir path', () => {
    expect(() => assertInsideInbox(inbox, join(inbox, '..', 'evil.jpg'))).toThrow(
      /escape/,
    )
  })

  it('rejects a sibling path', () => {
    const sibling = join(inbox, '..', 'sibling.jpg')
    expect(() => assertInsideInbox(inbox, sibling)).toThrow()
  })

  it('rejects an absolute path unrelated to inbox', () => {
    expect(() => assertInsideInbox(inbox, '/etc/passwd')).toThrow()
  })

  it('rejects a path whose prefix matches but is a different directory (ambiguity guard)', () => {
    // `/tmp/inbox-test-ABC` vs `/tmp/inbox-test-ABC-other` — the former
    // should NOT accept paths in the latter. This catches a naive
    // `startsWith` check without the path separator.
    const similar = inbox + '-other'
    mkdirSync(similar, { recursive: true })
    expect(() => assertInsideInbox(inbox, join(similar, 'x.jpg'))).toThrow()
  })
})

describe('end-to-end: build + assert', () => {
  it('adversarial inputs still produce inbox-safe paths', () => {
    const tempInbox = mkdtempSync(join(tmpdir(), 'inbox-e2e-'))
    const path = buildAttachmentPath({
      inboxDir: tempInbox,
      telegramFilePath: '../../../etc/passwd',
      fileUniqueId: '../../root/.ssh/id_rsa',
      now: 1700000000000,
    })
    expect(() => assertInsideInbox(tempInbox, path)).not.toThrow()
    expect(path.startsWith(tempInbox + sep)).toBe(true)
  })
})
