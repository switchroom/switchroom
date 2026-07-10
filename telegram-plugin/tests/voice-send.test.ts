/**
 * Telegram file_id reuse for the on-demand '🔊 Listen' send path.
 *
 * gateway.ts is a 25k-line module with import-time side effects, so the send
 * decision core lives in ../voice-send.ts (imported by the gateway). These
 * tests drive the real orchestrator + cache primitive with a mocked bot api,
 * proving the observable contract the gateway wires up:
 *
 *   (a) FIRST tap (no stored id) uploads via InputFile and captures the
 *       returned file_id onto the cache entry;
 *   (b) SECOND tap sends BY the file_id string — no disk read, no InputFile;
 *   (c) a file_id send REJECTED as stale (400) falls back to a re-upload and
 *       refreshes the stored id, so a dead id never permanently breaks Listen.
 */

import { describe, it, expect } from 'bun:test'
import {
  sendVoiceReusingFileId,
  extractVoiceFileId,
  isInvalidTelegramFileIdError,
  isHttp400Error,
  type SentVoiceMessage,
} from '../voice-send.js'
import { VoiceOnDemandCache } from '../voice-ondemand.js'

/** A minimal grammy-shaped 400 error (duck-typed the way the gateway sees it). */
function grammy400(description: string): Error {
  return Object.assign(new Error(description), { error_code: 400, description })
}

/** Sent-message stub echoing a file_id, as Telegram returns from sendVoice. */
function sentWithFileId(fileId: string): SentVoiceMessage {
  return { voice: { file_id: fileId } }
}

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53]) // OggS magic

describe('sendVoiceReusingFileId — file_id reuse contract', () => {
  it('(a) first tap: no stored id → uploads via InputFile, captures the id', async () => {
    const calls: string[] = []
    let byFileId = 0
    let uploaded = 0
    let captured: string | null = null

    const res = await sendVoiceReusingFileId({
      fileId: null,
      sendByFileId: async () => {
        byFileId++
        return null
      },
      loadAudio: async () => {
        calls.push('loadAudio')
        return OGG
      },
      sendByUpload: async (audio) => {
        uploaded++
        expect(audio).toBe(OGG)
        return sentWithFileId('FILE_ID_1')
      },
      onFileId: (id) => {
        captured = id
      },
    })

    expect(res).toEqual({ ok: true, path: 'upload', refreshed: false })
    expect(byFileId).toBe(0) // never tried the id path — none stored
    expect(uploaded).toBe(1) // exactly one upload
    expect(calls).toEqual(['loadAudio']) // audio WAS loaded on the first tap
    expect(captured).toBe('FILE_ID_1') // id captured for reuse
  })

  it('(b) second tap: stored id → sends by file_id string, no disk read, no InputFile', async () => {
    let loadAudioCalls = 0
    let uploadCalls = 0
    let sentId: string | null = null

    const res = await sendVoiceReusingFileId({
      fileId: 'FILE_ID_1',
      sendByFileId: async (fid) => {
        sentId = fid
        return sentWithFileId('FILE_ID_1') // Telegram echoes the same id
      },
      loadAudio: async () => {
        loadAudioCalls++ // MUST NOT happen — proves no disk read
        return OGG
      },
      sendByUpload: async () => {
        uploadCalls++ // MUST NOT happen — proves no re-upload
        return null
      },
      onFileId: () => {},
    })

    expect(res).toEqual({ ok: true, path: 'file_id', refreshed: false })
    expect(sentId).toBe('FILE_ID_1') // sent BY the string id
    expect(loadAudioCalls).toBe(0) // no disk read
    expect(uploadCalls).toBe(0) // no InputFile upload
  })

  it('(c) stale id (400): falls back to re-upload and refreshes the stored id', async () => {
    let byFileId = 0
    let uploaded = 0
    let refreshedTo: string | null = null

    const res = await sendVoiceReusingFileId({
      fileId: 'STALE_ID',
      sendByFileId: async () => {
        byFileId++
        throw grammy400('Bad Request: wrong file identifier/HTTP URL specified')
      },
      loadAudio: async () => OGG,
      sendByUpload: async () => {
        uploaded++
        return sentWithFileId('FRESH_ID')
      },
      onFileId: (id) => {
        refreshedTo = id
      },
    })

    expect(res).toEqual({ ok: true, path: 'upload', refreshed: true })
    expect(byFileId).toBe(1) // tried the stale id once
    expect(uploaded).toBe(1) // then re-uploaded
    expect(refreshedTo).toBe('FRESH_ID') // stored id refreshed, not left stale
  })

  it('a NON-stale send error is a real failure — no silent re-upload', async () => {
    let uploaded = 0
    const res = await sendVoiceReusingFileId({
      fileId: 'FILE_ID_1',
      sendByFileId: async () => {
        throw Object.assign(new Error('forbidden'), { error_code: 403 })
      },
      loadAudio: async () => OGG,
      sendByUpload: async () => {
        uploaded++
        return null
      },
      onFileId: () => {},
    })
    expect(res.ok).toBe(false)
    expect(uploaded).toBe(0) // did NOT paper over a 403 with an upload
  })

  it('(C1) UNKNOWN-wording 400: re-uploads + refreshes id even outside the stale-id substrings', async () => {
    // A 400 whose text is NOT in isInvalidTelegramFileIdError's substring set.
    // Pre-tweak (substring-gated) this classified as send-failed and never
    // refreshed the id; post-tweak ANY 400 recovers via re-upload.
    let byFileId = 0
    let uploaded = 0
    let refreshedTo: string | null = null

    const err400 = grammy400('Bad Request: some brand-new file rejection wording')
    expect(isInvalidTelegramFileIdError(err400)).toBe(false) // guard: outside old substrings
    expect(isHttp400Error(err400)).toBe(true) // but IS a 400 → now re-uploadable

    const res = await sendVoiceReusingFileId({
      fileId: 'STALE_ID',
      sendByFileId: async () => {
        byFileId++
        throw err400
      },
      loadAudio: async () => OGG,
      sendByUpload: async () => {
        uploaded++
        return sentWithFileId('FRESH_ID')
      },
      onFileId: (id) => {
        refreshedTo = id
      },
    })

    expect(res).toEqual({ ok: true, path: 'upload', refreshed: true })
    expect(byFileId).toBe(1) // tried the id once
    expect(uploaded).toBe(1) // then re-uploaded on the unknown 400
    expect(refreshedTo).toBe('FRESH_ID') // stored id refreshed, not left stale
  })

  it('(C1) a network error (no error_code) still does NOT re-upload', async () => {
    let uploaded = 0
    const res = await sendVoiceReusingFileId({
      fileId: 'FILE_ID_1',
      sendByFileId: async () => {
        throw new Error('ECONNRESET') // no error_code → not a 400
      },
      loadAudio: async () => OGG,
      sendByUpload: async () => {
        uploaded++
        return null
      },
      onFileId: () => {},
    })
    expect(res.ok).toBe(false)
    expect(uploaded).toBe(0) // transient network error is a real failure, not a re-upload
  })

  it('(C1) re-upload after a 400 ALSO fails → returns failure, no second re-upload', async () => {
    let byFileId = 0
    let uploaded = 0
    let refreshed: string | null = null

    const res = await sendVoiceReusingFileId({
      fileId: 'STALE_ID',
      sendByFileId: async () => {
        byFileId++
        throw grammy400('Bad Request: totally unfamiliar 400 wording')
      },
      loadAudio: async () => OGG,
      sendByUpload: async () => {
        uploaded++
        throw grammy400('Bad Request: upload also rejected') // recovery send fails too
      },
      onFileId: (id) => {
        refreshed = id
      },
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('send-failed')
    expect(byFileId).toBe(1) // id tried once
    expect(uploaded).toBe(1) // re-uploaded exactly once — NO second attempt / loop
    expect(refreshed).toBeNull() // failed upload never refreshed the id
  })

  it('no-audio on the upload path returns { ok:false, reason:"no-audio" }', async () => {
    const res = await sendVoiceReusingFileId({
      fileId: null,
      sendByFileId: async () => null,
      loadAudio: async () => null, // swept + synth unavailable
      sendByUpload: async () => {
        throw new Error('should not be called')
      },
      onFileId: () => {},
    })
    expect(res).toEqual({ ok: false, reason: 'no-audio' })
  })
})

describe('extractVoiceFileId / isInvalidTelegramFileIdError', () => {
  it('extracts a present file_id, ignores missing/empty', () => {
    expect(extractVoiceFileId({ voice: { file_id: 'abc' } })).toBe('abc')
    expect(extractVoiceFileId({ voice: {} })).toBeUndefined()
    expect(extractVoiceFileId({ voice: { file_id: '' } })).toBeUndefined()
    expect(extractVoiceFileId(null)).toBeUndefined()
    expect(extractVoiceFileId(undefined)).toBeUndefined()
  })

  it('classifies a 400 wrong-file-identifier as stale, others as not', () => {
    expect(
      isInvalidTelegramFileIdError(grammy400('Bad Request: wrong file identifier/HTTP URL specified')),
    ).toBe(true)
    expect(isInvalidTelegramFileIdError(grammy400('Bad Request: wrong remote file identifier'))).toBe(
      true,
    )
    // Not a file_id problem — genuine failures the caller must surface.
    expect(isInvalidTelegramFileIdError(grammy400('Bad Request: chat not found'))).toBe(false)
    expect(
      isInvalidTelegramFileIdError(Object.assign(new Error('forbidden'), { error_code: 403 })),
    ).toBe(false)
    expect(isInvalidTelegramFileIdError(new Error('network'))).toBe(false)
    expect(isInvalidTelegramFileIdError(null)).toBe(false)
  })

  it('isHttp400Error: true only for error_code 400, wording-agnostic', () => {
    expect(isHttp400Error(grammy400('any wording at all'))).toBe(true)
    expect(isHttp400Error(grammy400('Bad Request: chat not found'))).toBe(true) // 400 regardless of text
    expect(isHttp400Error(Object.assign(new Error('x'), { error_code: 403 }))).toBe(false)
    expect(isHttp400Error(Object.assign(new Error('x'), { error_code: 500 }))).toBe(false)
    expect(isHttp400Error(new Error('network'))).toBe(false) // no error_code
    expect(isHttp400Error(null)).toBe(false)
    expect(isHttp400Error(undefined)).toBe(false)
  })
})

describe('VoiceOnDemandCache.setTelegramFileId — capture + sweep drop', () => {
  it('stores an id on a live entry and returns it via get()', () => {
    const cache = new VoiceOnDemandCache()
    cache.put('tok', { text: 'hi', speed: 1.1 })
    cache.setTelegramFileId('tok', 'FILE_ID_1')
    expect(cache.get('tok')?.telegramFileId).toBe('FILE_ID_1')
  })

  it('ignores an empty id and unknown/evicted tokens', () => {
    const cache = new VoiceOnDemandCache()
    cache.put('tok', { text: 'hi', speed: 1.1 })
    cache.setTelegramFileId('tok', '') // ignored
    expect(cache.get('tok')?.telegramFileId).toBeUndefined()
    cache.setTelegramFileId('missing', 'X') // no-op, no throw
    expect(cache.get('missing')).toBeNull()
  })

  it('drops the stored id when the 7-day sweep prunes the entry — no resurrection', () => {
    const cache = new VoiceOnDemandCache()
    cache.put('tok', { text: 'hi', speed: 1.1 })
    cache.setTelegramFileId('tok', 'FILE_ID_1')
    cache.prune(['tok']) // sweep deleted the on-disk file for this token
    expect(cache.get('tok')).toBeNull() // entry AND its file_id are gone
  })

  it('does not store an id on an already-expired entry', () => {
    let t = 1000
    const cache = new VoiceOnDemandCache({ ttlMs: 100, now: () => t })
    cache.put('tok', { text: 'hi', speed: 1.1 })
    t = 2000 // past TTL
    cache.setTelegramFileId('tok', 'FILE_ID_1') // no-op on expired entry
    expect(cache.get('tok')).toBeNull()
  })
})
