/**
 * Unit tests for the LOCAL TTS sidecar synthesis path (voice PR-C2):
 *   - synthesizeViaSidecar (HTTP POST to /tts, mocked fetch)
 *
 * The OUTBOUND mirror of voice-transcribe-sidecar.test.ts: every error
 * reason is pinned so a refactor can't silently change the contract the
 * gateway depends on (any non-ok → null → text-only fallback). The /tts
 * endpoint returns RAW OGG bytes on success (not JSON), so the happy-path
 * asserts on arrayBuffer + the audio/ogg-style meta headers.
 */

import { describe, it, expect } from 'bun:test'
import {
  synthesizeViaSidecar,
  chunkTtsText,
  clampTtsSpeed,
  SIDECAR_TTS_MAX_CHARS,
  DEFAULT_SIDECAR_BASE_URL,
} from '../voice-synthesize-sidecar.js'

const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53]) // OggS magic

/** Mock a 200 audio/ogg response carrying `bytes`. */
function makeOggFetch(
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
    headers: new Headers(headers),
  })) as unknown as typeof fetch
}

/** Mock a non-2xx JSON error response. */
function makeErrFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
  })) as unknown as typeof fetch
}

describe('synthesizeViaSidecar — pre-flight checks', () => {
  it('returns no-token when token is empty', async () => {
    const r = await synthesizeViaSidecar({
      token: '',
      text: 'hello',
      fetchImpl: makeOggFetch(OGG_BYTES),
    })
    expect(r).toMatchObject({ ok: false, reason: 'no-token' })
  })

  it('returns empty-text on whitespace-only text', async () => {
    const r = await synthesizeViaSidecar({ token: 't', text: '   ' })
    expect(r).toMatchObject({ ok: false, reason: 'empty-text' })
  })

  it('returns text-too-long above the cap', async () => {
    const r = await synthesizeViaSidecar({
      token: 't',
      text: 'x'.repeat(SIDECAR_TTS_MAX_CHARS + 1),
    })
    expect(r).toMatchObject({ ok: false, reason: 'text-too-long' })
  })
})

describe('synthesizeViaSidecar — happy path', () => {
  it('returns OGG bytes + meta on 200 audio/ogg', async () => {
    const r = await synthesizeViaSidecar({
      token: 't',
      text: 'Hello world',
      fetchImpl: makeOggFetch(OGG_BYTES, {
        'X-Voice-Duration-Ms': '1234',
        'X-Voice-Audio-Seconds': '2.5',
        'X-Voice-Voice': 'af_heart',
      }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Array.from(r.audio)).toEqual(Array.from(OGG_BYTES))
      expect(r.durationMs).toBe(1234)
      expect(r.audioSeconds).toBe(2.5)
      expect(r.voice).toBe('af_heart')
    }
  })

  it('POSTs JSON {text,voice,format:ogg} + X-Voice-Token to <base>/tts', async () => {
    let receivedUrl = ''
    let receivedToken: string | null = null
    let receivedBody: string | null = null
    const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      receivedUrl = url
      receivedToken = (init?.headers as Record<string, string>)['X-Voice-Token']
      receivedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch

    const r = await synthesizeViaSidecar({
      token: 'secret-token',
      text: 'bonjour',
      voice: 'af_sky',
      fetchImpl: fakeFetch,
    })
    expect(r.ok).toBe(true)
    expect(receivedUrl).toBe(`${DEFAULT_SIDECAR_BASE_URL}/tts`)
    expect(receivedToken).toBe('secret-token')
    const parsed = JSON.parse(receivedBody!)
    expect(parsed.text).toBe('bonjour')
    expect(parsed.voice).toBe('af_sky')
    expect(parsed.format).toBe('ogg')
  })

  it('omits the voice field when none is supplied', async () => {
    let receivedBody: string | null = null
    const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      receivedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch
    await synthesizeViaSidecar({ token: 't', text: 'hi', fetchImpl: fakeFetch })
    const parsed = JSON.parse(receivedBody!)
    expect('voice' in parsed).toBe(false)
  })

  it('omits the speed field when none is supplied (sidecar defaults to 1.0)', async () => {
    let receivedBody: string | null = null
    const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      receivedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch
    await synthesizeViaSidecar({ token: 't', text: 'hi', fetchImpl: fakeFetch })
    const parsed = JSON.parse(receivedBody!)
    expect('speed' in parsed).toBe(false)
  })

  it('includes speed in the /tts body when supplied', async () => {
    let receivedBody: string | null = null
    const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      receivedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch
    await synthesizeViaSidecar({ token: 't', text: 'hi', speed: 1.1, fetchImpl: fakeFetch })
    const parsed = JSON.parse(receivedBody!)
    expect(parsed.speed).toBe(1.1)
  })

  it('clamps an out-of-range speed before putting it on the wire', async () => {
    const cap = async (speed: number): Promise<number> => {
      let receivedBody: string | null = null
      const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
        receivedBody = init?.body as string
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
          text: async () => '',
          headers: new Headers(),
        }
      }) as unknown as typeof fetch
      await synthesizeViaSidecar({ token: 't', text: 'hi', speed, fetchImpl: fakeFetch })
      return JSON.parse(receivedBody!).speed
    }
    expect(await cap(5.0)).toBe(2.0) // above max → 2.0
    expect(await cap(0.1)).toBe(0.5) // below min → 0.5
  })
})

describe('clampTtsSpeed', () => {
  it('passes in-range values through', () => {
    for (const v of [0.5, 0.75, 1.0, 1.1, 1.5, 2.0]) {
      expect(clampTtsSpeed(v)).toBe(v)
    }
  })

  it('clamps out-of-range numbers to the nearest bound', () => {
    expect(clampTtsSpeed(0.1)).toBe(0.5)
    expect(clampTtsSpeed(-3)).toBe(0.5)
    expect(clampTtsSpeed(2.5)).toBe(2.0)
    expect(clampTtsSpeed(100)).toBe(2.0)
  })

  it('falls back to the default for non-finite / non-numeric input', () => {
    expect(clampTtsSpeed(undefined)).toBe(1.0)
    expect(clampTtsSpeed(null)).toBe(1.0)
    expect(clampTtsSpeed(NaN)).toBe(1.0)
    expect(clampTtsSpeed('fast')).toBe(1.0)
    expect(clampTtsSpeed(undefined, 1.1)).toBe(1.1) // custom fallback
  })

  it('falls back to wall-clock durationMs when headers are absent', async () => {
    const r = await synthesizeViaSidecar({
      token: 't',
      text: 'hi',
      fetchImpl: makeOggFetch(OGG_BYTES),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
      expect(r.audioSeconds).toBeNull()
      expect(r.voice).toBeNull()
    }
  })
})

describe('synthesizeViaSidecar — error paths', () => {
  it('echoes the sidecar reason from a non-2xx JSON body', async () => {
    const r = await synthesizeViaSidecar({
      token: 't',
      text: 'hi',
      fetchImpl: makeErrFetch(413, { ok: false, reason: 'text-too-long', detail: '9999 > 1200' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'text-too-long', detail: '9999 > 1200' })
  })

  it('falls back to http-<n> when the error body is not JSON', async () => {
    const r = await synthesizeViaSidecar({
      token: 't',
      text: 'hi',
      fetchImpl: makeErrFetch(503, 'service unavailable'),
    })
    expect(r).toMatchObject({ ok: false, reason: 'http-503' })
  })

  it('returns empty-audio on a 200 with no bytes', async () => {
    const r = await synthesizeViaSidecar({
      token: 't',
      text: 'hi',
      fetchImpl: makeOggFetch(new Uint8Array(0)),
    })
    expect(r).toMatchObject({ ok: false, reason: 'empty-audio' })
  })

  it('returns fetch-failed on a network error', async () => {
    const boom: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await synthesizeViaSidecar({ token: 't', text: 'hi', fetchImpl: boom })
    expect(r).toMatchObject({ ok: false, reason: 'fetch-failed' })
  })

  it('returns timeout when the fetch aborts', async () => {
    const aborted: typeof fetch = (async () => {
      throw new Error('The operation was aborted')
    }) as unknown as typeof fetch
    const r = await synthesizeViaSidecar({ token: 't', text: 'hi', fetchImpl: aborted })
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
  })
})

describe('chunkTtsText — long-reply voice chunking (PR-C2)', () => {
  it('returns a single chunk when text fits the cap', () => {
    expect(chunkTtsText('Short answer.', 600)).toEqual(['Short answer.'])
  })

  it('returns no chunks for empty text', () => {
    expect(chunkTtsText('', 600)).toEqual([])
    expect(chunkTtsText('   ', 600)).toEqual([])
  })

  it('splits a long reply into multiple chunks, each under the cap', () => {
    const sentence = 'This is a sentence that is reasonably long. '
    const text = sentence.repeat(20).trim() // ~880 chars
    const chunks = chunkTtsText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200)
    // No text is lost: every sentence's words survive across the chunks.
    const rejoined = chunks.join(' ')
    expect(rejoined).toContain('reasonably long')
    expect(rejoined.split('reasonably long').length - 1).toBe(20)
  })

  it('prefers sentence boundaries — does not cut mid-sentence', () => {
    const text =
      'First sentence here. Second sentence here. Third sentence here. Fourth one too.'
    const chunks = chunkTtsText(text, 45)
    // Each chunk should end at a sentence terminator (no dangling fragment).
    for (const c of chunks) expect(/[.!?]$/.test(c)).toBe(true)
  })

  it('hard-slices a single sentence longer than the cap (no boundary fits)', () => {
    const longWord = 'a'.repeat(50)
    const text = `${longWord} ${longWord} ${longWord}` // one boundary-less-ish run
    const chunks = chunkTtsText(text, 60)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60)
  })

  it('never emits a chunk over the cap even with a giant tokenless blob', () => {
    const blob = 'x'.repeat(5000)
    const chunks = chunkTtsText(blob, 1200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200)
  })
})

describe('synthesizeViaSidecar — multi-chunk send path (PR-C2)', () => {
  it('synthesizes each chunk independently (one POST per chunk)', async () => {
    const text = 'Sentence one is here. '.repeat(40).trim() // long → many chunks
    const chunks = chunkTtsText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)

    let calls = 0
    const fakeFetch: typeof fetch = (async () => {
      calls++
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch

    // Mirror the gateway's per-chunk synthesis loop.
    const oggs: Uint8Array[] = []
    for (const c of chunks) {
      const r = await synthesizeViaSidecar({ token: 't', text: c, fetchImpl: fakeFetch })
      expect(r.ok).toBe(true)
      if (r.ok) oggs.push(r.audio)
    }
    expect(calls).toBe(chunks.length)
    expect(oggs.length).toBe(chunks.length)
  })
})
