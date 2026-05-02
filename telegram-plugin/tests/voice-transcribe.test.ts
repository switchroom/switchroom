/**
 * Unit tests for `transcribeViaWhisper` (#578).
 *
 * Every error path goes through the same `{ ok: false, reason }`
 * shape, and every reason is asserted here so a future refactor
 * can't silently change the contract the gateway depends on.
 *
 * Production runs of this fn fire a real HTTPS POST to OpenAI; tests
 * inject a mock fetch via the `fetchImpl` arg.
 */

import { describe, it, expect } from 'bun:test'
import {
  transcribeViaWhisper,
  OPENAI_WHISPER_MAX_BYTES,
} from '../voice-transcribe.js'

const SMALL_AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53]) // OggS magic; not real audio

function makeFetch(
  status: number,
  body: unknown,
  contentType = 'application/json',
): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () =>
      typeof body === 'string' ? body : JSON.stringify(body),
    headers: new Headers({ 'content-type': contentType }),
  })) as unknown as typeof fetch
}

describe('transcribeViaWhisper — pre-flight checks', () => {
  it('returns no-api-key when key is empty', async () => {
    const r = await transcribeViaWhisper({
      apiKey: '',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { text: 'x' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'no-api-key' })
  })

  it('returns audio-too-short on empty audio', async () => {
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: new Uint8Array(0),
      filename: 'voice.ogg',
    })
    expect(r).toMatchObject({ ok: false, reason: 'audio-too-short' })
  })

  it('returns audio-too-large above 25MB', async () => {
    // We don't actually allocate 25MB; we lie about length using a
    // huge typed-array view trick — but Uint8Array cannot exceed
    // platform limits. Instead, allocate exactly limit + 1 bytes.
    const tooBig = new Uint8Array(OPENAI_WHISPER_MAX_BYTES + 1)
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: tooBig,
      filename: 'voice.ogg',
    })
    expect(r).toMatchObject({ ok: false, reason: 'audio-too-large' })
    expect(r.detail).toContain(`${tooBig.length} bytes`)
  })
})

describe('transcribeViaWhisper — happy path', () => {
  it('returns transcript on 200 + valid JSON', async () => {
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, {
        text: 'Hello world',
        language: 'en',
        duration: 3.2,
      }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe('Hello world')
      expect(r.language).toBe('en')
      expect(r.audioSeconds).toBe(3.2)
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('handles missing language + duration fields gracefully', async () => {
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { text: 'just text' }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe('just text')
      expect(r.language).toBeUndefined()
      expect(r.audioSeconds).toBeNull()
    }
  })

  it('passes optional language hint through to the request', async () => {
    let receivedForm: FormData | null = null
    const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      receivedForm = init?.body as FormData
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'bonjour' }),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch

    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      language: 'fr',
      fetchImpl: fakeFetch,
    })
    expect(r.ok).toBe(true)
    expect(receivedForm).not.toBeNull()
    expect(receivedForm!.get('language')).toBe('fr')
    expect(receivedForm!.get('model')).toBe('whisper-1')
    expect(receivedForm!.get('response_format')).toBe('verbose_json')
  })
})

describe('transcribeViaWhisper — error paths', () => {
  it('returns http-N with detail on non-2xx response', async () => {
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(401, '{"error":"bad-key"}'),
    })
    expect(r).toMatchObject({ ok: false, reason: 'http-401' })
    expect(r.detail).toContain('bad-key')
  })

  it('returns http-429 on rate limit (caller can decide to retry later)', async () => {
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(429, 'Too Many Requests'),
    })
    expect(r).toMatchObject({ ok: false, reason: 'http-429' })
  })

  it('returns malformed-response when 200 body has no text field', async () => {
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { unexpected: 'shape' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'malformed-response' })
  })

  it('returns fetch-failed on a thrown network error', async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: fakeFetch,
    })
    expect(r).toMatchObject({ ok: false, reason: 'fetch-failed' })
    expect(r.detail).toContain('ECONNRESET')
  })

  it('returns timeout when fetch is aborted', async () => {
    const fakeFetch: typeof fetch = (async () => {
      const e = new Error('The operation was aborted')
      // grammY/whatever sets .name = 'AbortError'; our matcher is
      // permissive (substring match on 'aborted' OR 'timeout').
      throw e
    }) as unknown as typeof fetch
    const r = await transcribeViaWhisper({
      apiKey: 'sk-test',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      timeoutMs: 5,
      fetchImpl: fakeFetch,
    })
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
  })
})
