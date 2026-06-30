/**
 * Unit tests for the LOCAL STT sidecar transcription path (voice PR-B2):
 *   - transcribeViaSidecar (HTTP POST to /stt, mocked fetch)
 *   - materializeSidecarToken (vault resolution, mocked broker)
 *
 * Mirrors the cloud twin's test (voice-transcribe.test.ts): every error
 * reason is pinned so a refactor can't silently change the contract the
 * gateway depends on (any non-ok → null → "(voice message)" fallback).
 */

import { describe, it, expect } from 'bun:test'
import {
  transcribeViaSidecar,
  SIDECAR_MAX_BYTES,
  DEFAULT_SIDECAR_BASE_URL,
} from '../voice-transcribe-sidecar.js'
import {
  materializeSidecarToken,
  DEFAULT_VOICE_SIDECAR_TOKEN_REF,
  VOICE_SIDECAR_TOKEN_KEY,
} from '../../src/telegram/materialize-sidecar-token.js'
import type { resolveVaultReferencesViaBroker } from '../../src/vault/resolver.js'
import type { SwitchroomConfig } from '../../src/config/schema.js'

const SMALL_AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53]) // OggS magic

function makeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
  })) as unknown as typeof fetch
}

describe('transcribeViaSidecar — pre-flight checks', () => {
  it('returns no-token when token is empty', async () => {
    const r = await transcribeViaSidecar({
      token: '',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { ok: true, text: 'x' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'no-token' })
  })

  it('returns audio-too-short on empty audio', async () => {
    const r = await transcribeViaSidecar({
      token: 't',
      audio: new Uint8Array(0),
      filename: 'voice.ogg',
    })
    expect(r).toMatchObject({ ok: false, reason: 'audio-too-short' })
  })

  it('returns audio-too-large above the cap', async () => {
    const tooBig = new Uint8Array(SIDECAR_MAX_BYTES + 1)
    const r = await transcribeViaSidecar({
      token: 't',
      audio: tooBig,
      filename: 'voice.ogg',
    })
    expect(r).toMatchObject({ ok: false, reason: 'audio-too-large' })
  })
})

describe('transcribeViaSidecar — happy path', () => {
  it('returns transcript on 200 + valid JSON', async () => {
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, {
        ok: true,
        text: 'Hello world',
        language: 'en',
        durationMs: 1234,
        audioSeconds: 3.2,
      }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe('Hello world')
      expect(r.language).toBe('en')
      expect(r.durationMs).toBe(1234)
      expect(r.audioSeconds).toBe(3.2)
    }
  })

  it('sends the X-Voice-Token header, audio + language fields, to <base>/stt', async () => {
    let receivedUrl = ''
    let receivedToken: string | null = null
    let receivedForm: FormData | null = null
    const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      receivedUrl = url
      receivedToken = (init?.headers as Record<string, string>)['X-Voice-Token']
      receivedForm = init?.body as FormData
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, text: 'bonjour' }),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch

    const r = await transcribeViaSidecar({
      token: 'secret-token',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      language: 'fr',
      fetchImpl: fakeFetch,
    })
    expect(r.ok).toBe(true)
    expect(receivedUrl).toBe(`${DEFAULT_SIDECAR_BASE_URL}/stt`)
    expect(receivedToken).toBe('secret-token')
    expect(receivedForm).not.toBeNull()
    expect(receivedForm!.get('language')).toBe('fr')
    expect(receivedForm!.get('audio')).not.toBeNull()
  })

  it('falls back to wall-clock durationMs when the sidecar omits it', async () => {
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { ok: true, text: 'hi' }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
      expect(r.audioSeconds).toBeNull()
    }
  })
})

describe('transcribeViaSidecar — error paths', () => {
  it('returns http-401 on a wrong/missing token (sidecar rejects)', async () => {
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(401, { ok: false, reason: 'unauthorized' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'http-401' })
  })

  it('surfaces the sidecar reason on a 2xx { ok: false } body', async () => {
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { ok: false, reason: 'gpu-timeout', detail: 'busy' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'gpu-timeout' })
  })

  it('returns malformed-response when 200 body has no text field', async () => {
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: makeFetch(200, { ok: true, unexpected: 'shape' }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'malformed-response' })
  })

  it('returns fetch-failed on a thrown network error', async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      fetchImpl: fakeFetch,
    })
    expect(r).toMatchObject({ ok: false, reason: 'fetch-failed' })
    expect(r.detail).toContain('ECONNREFUSED')
  })

  it('returns timeout when fetch is aborted', async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error('The operation was aborted')
    }) as unknown as typeof fetch
    const r = await transcribeViaSidecar({
      token: 't',
      audio: SMALL_AUDIO,
      filename: 'voice.ogg',
      timeoutMs: 5,
      fetchImpl: fakeFetch,
    })
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
  })
})

// ── materializeSidecarToken — vault resolution (mirrors the key helper) ──

const EMPTY_CONFIG = {} as unknown as SwitchroomConfig

function makeBrokerResolver(
  resolvedRefs: Record<string, string>,
): typeof resolveVaultReferencesViaBroker {
  return (async (config: SwitchroomConfig) => {
    const ref = config.telegram?.bot_token
    if (ref && resolvedRefs[ref] !== undefined) {
      return {
        ok: true,
        config: {
          ...config,
          telegram: { ...config.telegram, bot_token: resolvedRefs[ref] },
        },
      }
    }
    return { ok: false, reason: 'not_found' as const }
  }) as unknown as typeof resolveVaultReferencesViaBroker
}

describe('materializeSidecarToken — vault resolution', () => {
  it('defaults to vault:voice/sidecar-token', () => {
    expect(VOICE_SIDECAR_TOKEN_KEY).toBe('voice/sidecar-token')
    expect(DEFAULT_VOICE_SIDECAR_TOKEN_REF).toBe('vault:voice/sidecar-token')
  })

  it('resolves the configured vault ref via the broker', async () => {
    const tok = await materializeSidecarToken({
      config: EMPTY_CONFIG,
      env: {},
      resolveViaBroker: makeBrokerResolver({
        'vault:voice/sidecar-token': 'deadbeef' + 'cafe',
      }),
    })
    expect(tok).toBe('deadbeef' + 'cafe')
  })

  it('returns a literal (non-vault) token directly without the broker', async () => {
    let brokerCalled = false
    const tok = await materializeSidecarToken({
      tokenRef: 'raw' + 'token',
      config: EMPTY_CONFIG,
      env: {},
      resolveViaBroker: (async () => {
        brokerCalled = true
        return { ok: false, reason: 'not_found' as const }
      }) as unknown as typeof resolveVaultReferencesViaBroker,
    })
    expect(tok).toBe('raw' + 'token')
    expect(brokerCalled).toBe(false)
  })

  it('returns null (graceful fallback, no throw) when unresolvable', async () => {
    const tok = await materializeSidecarToken(
      {
        config: EMPTY_CONFIG,
        env: {},
        resolveViaBroker: makeBrokerResolver({}),
      },
      () => {},
    )
    expect(tok).toBeNull()
  })
})
