/**
 * Unit tests for the pure sticker/gif helpers (#576).
 *
 * Covers:
 *   - resolveStickerSendArgs: alias lookup + file_id passthrough +
 *     error messaging that's actionable for both agent and operator.
 *   - resolveGifSendArgs: file_id vs URL detection, https-only,
 *     extension allow-list, length limits.
 *   - looksLikeFileId / isValidAliasName / isAcceptableGifUrl
 *     boundary cases.
 */

import { describe, it, expect } from 'bun:test'
import {
  resolveStickerSendArgs,
  resolveGifSendArgs,
  looksLikeFileId,
  isValidAliasName,
  isAcceptableGifUrl,
} from '../sticker-aliases.js'

const SAMPLE_FILE_ID = 'CAACAgIAAxkBAAEBQQABZ-9TyZ-something-real-looking_id'
const SAMPLE_FILE_ID_2 = 'CAADAgADBwAD9wLICydOBzNqQNWlAg-another'

describe('looksLikeFileId', () => {
  it('accepts plausible Telegram file_ids', () => {
    expect(looksLikeFileId(SAMPLE_FILE_ID)).toBe(true)
    expect(looksLikeFileId('AgACAgIAA10ABg')).toBe(true)
    expect(looksLikeFileId('a'.repeat(50))).toBe(true)
  })

  it('rejects too-short strings', () => {
    expect(looksLikeFileId('short')).toBe(false)
    expect(looksLikeFileId('')).toBe(false)
  })

  it('rejects too-long strings', () => {
    expect(looksLikeFileId('a'.repeat(201))).toBe(false)
  })

  it('rejects strings with disallowed chars', () => {
    expect(looksLikeFileId('has spaces in it' + 'x'.repeat(30))).toBe(false)
    expect(looksLikeFileId('has/slash' + 'x'.repeat(30))).toBe(false)
    expect(looksLikeFileId('has.dot' + 'x'.repeat(30))).toBe(false)
  })
})

describe('isValidAliasName', () => {
  it('accepts simple lowercase identifiers', () => {
    expect(isValidAliasName('happy')).toBe(true)
    expect(isValidAliasName('mood_happy')).toBe(true)
    expect(isValidAliasName('mood-sad')).toBe(true)
    expect(isValidAliasName('a1b2c3')).toBe(true)
  })

  it('rejects names starting with non-alphanumeric', () => {
    expect(isValidAliasName('_underscore')).toBe(false)
    expect(isValidAliasName('-dash')).toBe(false)
  })

  it('rejects empty + over-long', () => {
    expect(isValidAliasName('')).toBe(false)
    expect(isValidAliasName('a'.repeat(65))).toBe(false)
  })

  it('rejects names with spaces / special chars', () => {
    expect(isValidAliasName('two words')).toBe(false)
    expect(isValidAliasName('with.dot')).toBe(false)
    expect(isValidAliasName('with/slash')).toBe(false)
  })
})

describe('resolveStickerSendArgs — alias lookup', () => {
  const aliasMap = {
    happy: SAMPLE_FILE_ID,
    sad: SAMPLE_FILE_ID_2,
  }

  it('resolves a configured alias to its file_id', () => {
    const r = resolveStickerSendArgs({ chat_id: '1', sticker: 'happy' }, aliasMap)
    expect(r.fileId).toBe(SAMPLE_FILE_ID)
    expect(r.resolution).toBe('alias')
    expect(r.aliasName).toBe('happy')
  })

  it('passes through a raw file_id when no matching alias', () => {
    const r = resolveStickerSendArgs({ chat_id: '1', sticker: SAMPLE_FILE_ID }, aliasMap)
    expect(r.fileId).toBe(SAMPLE_FILE_ID)
    expect(r.resolution).toBe('raw')
    expect(r.aliasName).toBeUndefined()
  })

  it('errors with a list of available aliases when alias unknown', () => {
    expect(() => resolveStickerSendArgs({ chat_id: '1', sticker: 'angry' }, aliasMap))
      .toThrow(/unknown alias 'angry'.*happy.*sad/)
  })

  it('errors usefully when no aliases are configured at all', () => {
    expect(() => resolveStickerSendArgs({ chat_id: '1', sticker: 'angry' }, {}))
      .toThrow(/No sticker aliases are configured/)
  })

  it('errors when raw input is neither a valid file_id nor alias name', () => {
    expect(() => resolveStickerSendArgs({ chat_id: '1', sticker: 'has spaces' }, aliasMap))
      .toThrow(/neither a valid Telegram file_id nor a configured alias/)
  })

  it('errors clearly when alias resolves to malformed file_id (operator config bug)', () => {
    expect(() => resolveStickerSendArgs({ chat_id: '1', sticker: 'broken' }, { broken: 'too short' }))
      .toThrow(/alias 'broken' resolves to malformed file_id.*fix telegram.stickers.broken/)
  })
})

describe('resolveStickerSendArgs — required fields', () => {
  it('errors on missing chat_id', () => {
    expect(() => resolveStickerSendArgs({ chat_id: '', sticker: 'happy' }, { happy: SAMPLE_FILE_ID }))
      .toThrow(/chat_id is required/)
  })

  it('errors on missing sticker', () => {
    expect(() => resolveStickerSendArgs({ chat_id: '1', sticker: '' }, {}))
      .toThrow(/sticker .* is required/)
  })
})

describe('resolveStickerSendArgs — optional fields', () => {
  it('parses message_thread_id', () => {
    const r = resolveStickerSendArgs(
      { chat_id: '1', sticker: SAMPLE_FILE_ID, message_thread_id: '42' },
      {},
    )
    expect(r.threadId).toBe(42)
  })

  it('rejects non-positive thread id', () => {
    expect(() => resolveStickerSendArgs(
      { chat_id: '1', sticker: SAMPLE_FILE_ID, message_thread_id: '0' },
      {},
    )).toThrow(/positive integer/)
  })

  it('parses reply_to', () => {
    const r = resolveStickerSendArgs(
      { chat_id: '1', sticker: SAMPLE_FILE_ID, reply_to: '99' },
      {},
    )
    expect(r.replyTo).toBe(99)
  })
})

describe('isAcceptableGifUrl', () => {
  it('accepts https URLs ending in mp4 / gif / webm', () => {
    expect(isAcceptableGifUrl('https://example.com/file.mp4')).toBe(true)
    expect(isAcceptableGifUrl('https://example.com/dance.gif')).toBe(true)
    expect(isAcceptableGifUrl('https://example.com/loop.webm')).toBe(true)
  })

  it('accepts case-insensitive extensions', () => {
    expect(isAcceptableGifUrl('https://example.com/FILE.MP4')).toBe(true)
  })

  it('strips query strings before extension check', () => {
    expect(isAcceptableGifUrl('https://example.com/x.mp4?cache=123&x=y')).toBe(true)
    expect(isAcceptableGifUrl('https://example.com/x.gif#anchor')).toBe(true)
  })

  it('rejects non-https URLs', () => {
    expect(isAcceptableGifUrl('http://example.com/file.mp4')).toBe(false)
    expect(isAcceptableGifUrl('ftp://example.com/file.mp4')).toBe(false)
  })

  it('rejects URLs without an accepted extension', () => {
    expect(isAcceptableGifUrl('https://example.com/page.html')).toBe(false)
    expect(isAcceptableGifUrl('https://example.com/file.png')).toBe(false)
    expect(isAcceptableGifUrl('https://example.com/file')).toBe(false)
  })

  it('rejects over-long URLs', () => {
    const long = 'https://x.com/' + 'a'.repeat(2000) + '.mp4'
    expect(isAcceptableGifUrl(long)).toBe(false)
  })
})

describe('resolveGifSendArgs', () => {
  it('accepts a file_id', () => {
    const r = resolveGifSendArgs({ chat_id: '1', gif: SAMPLE_FILE_ID })
    expect(r.refKind).toBe('file_id')
    expect(r.animationRef).toBe(SAMPLE_FILE_ID)
  })

  it('accepts a valid https URL', () => {
    const r = resolveGifSendArgs({ chat_id: '1', gif: 'https://media.giphy.com/dance.mp4' })
    expect(r.refKind).toBe('url')
    expect(r.animationRef).toBe('https://media.giphy.com/dance.mp4')
  })

  it('errors on bad URL extension', () => {
    expect(() => resolveGifSendArgs({ chat_id: '1', gif: 'https://example.com/page.html' }))
      .toThrow(/url must be https with .mp4/)
  })

  it('errors on http (non-https) URL', () => {
    expect(() => resolveGifSendArgs({ chat_id: '1', gif: 'http://example.com/file.mp4' }))
      .toThrow(/url must be https/)
  })

  it('errors on garbage that is neither a URL nor a file_id', () => {
    expect(() => resolveGifSendArgs({ chat_id: '1', gif: 'just some text' }))
      .toThrow(/neither a valid Telegram file_id nor an acceptable https URL/)
  })

  it('accepts an optional caption', () => {
    const r = resolveGifSendArgs({ chat_id: '1', gif: SAMPLE_FILE_ID, caption: 'lol' })
    expect(r.caption).toBe('lol')
  })

  it('rejects caption over 1024 chars', () => {
    expect(() => resolveGifSendArgs({ chat_id: '1', gif: SAMPLE_FILE_ID, caption: 'x'.repeat(1025) }))
      .toThrow(/caption too long/)
  })

  it('parses thread + reply_to identically to send_sticker', () => {
    const r = resolveGifSendArgs({
      chat_id: '1',
      gif: SAMPLE_FILE_ID,
      message_thread_id: '7',
      reply_to: '88',
    })
    expect(r.threadId).toBe(7)
    expect(r.replyTo).toBe(88)
  })
})
