/**
 * Outcome pins for the voice inbound handler extracted from gateway.ts
 * (switchroom#2996 P6 cluster E). Drives the engine-selection + transcription
 * fallback branch against injected access / host-capability / transcribe
 * surfaces + a mock coalescing dispatch. Asserts the EXACT envelope forwarded
 * to handleInboundCoalesced for each path (local/cloud transcript, caption
 * prefix, disabled, and every fallback to the legacy "(voice message)").
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleVoiceMessage, type VoiceHandlerDeps } from '../gateway/voice-message-handler.js'

const VOICE_META = { kind: 'voice', file_id: 'v1', size: 100, mime: 'audio/ogg' }

function makeDeps(over: Partial<VoiceHandlerDeps> = {}) {
  const handleInboundCoalesced = vi.fn(async () => {})
  const deps: VoiceHandlerDeps = {
    loadAccess: () => ({ voice_in: { enabled: true, provider: 'openai', api_key: 'k', language: 'en' } }),
    loadHostCapabilities: () => null,
    maybeTranscribeVoiceLocal: vi.fn(async () => 'LOCAL TEXT'),
    maybeTranscribeVoice: vi.fn(async () => 'CLOUD TEXT'),
    handleInboundCoalesced,
    ...over,
  }
  return { deps, handleInboundCoalesced }
}

function ctxWith(caption?: string): any {
  return { message: { voice: { file_id: 'v1', file_size: 100, mime_type: 'audio/ogg' }, caption }, chat: { id: 42 } }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.SWITCHROOM_VOICE_ENGINE
})

describe('handleVoiceMessage — cloud path', () => {
  it('transcribes via cloud and forwards a [voice transcript] envelope', async () => {
    delete process.env.SWITCHROOM_VOICE_ENGINE
    const { deps, handleInboundCoalesced } = makeDeps()
    await handleVoiceMessage(ctxWith(), deps)
    expect(deps.maybeTranscribeVoice).toHaveBeenCalledWith('v1', 'audio/ogg', 'en', 'k')
    expect(deps.maybeTranscribeVoiceLocal).not.toHaveBeenCalled()
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      expect.anything(), '[voice transcript] CLOUD TEXT', undefined, VOICE_META,
    )
  })

  it('prefixes the caption to the transcript when present', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    await handleVoiceMessage(ctxWith('note:'), deps)
    expect(handleInboundCoalesced.mock.calls[0][1]).toBe('note:\n\n[voice transcript] CLOUD TEXT')
  })
})

describe('handleVoiceMessage — local path', () => {
  it('routes to the local sidecar when the engine env is local', async () => {
    process.env.SWITCHROOM_VOICE_ENGINE = 'local'
    // voice_in.provider need not be openai for the local path.
    const { deps, handleInboundCoalesced } = makeDeps({
      loadAccess: () => ({ voice_in: { enabled: true, language: 'de' } }),
    })
    await handleVoiceMessage(ctxWith(), deps)
    expect(deps.maybeTranscribeVoiceLocal).toHaveBeenCalledWith('v1', 'audio/ogg', 'de')
    expect(deps.maybeTranscribeVoice).not.toHaveBeenCalled()
    expect(handleInboundCoalesced.mock.calls[0][1]).toBe('[voice transcript] LOCAL TEXT')
  })

  it('reads the engine from host-capabilities when env is unset', async () => {
    delete process.env.SWITCHROOM_VOICE_ENGINE
    const { deps } = makeDeps({
      loadAccess: () => ({ voice_in: { enabled: true } }),
      loadHostCapabilities: () => ({ voice: { engine: 'local' } }),
    })
    await handleVoiceMessage(ctxWith(), deps)
    expect(deps.maybeTranscribeVoiceLocal).toHaveBeenCalled()
  })
})

describe('handleVoiceMessage — fallbacks to the legacy envelope', () => {
  it('falls back when voice_in is disabled', async () => {
    const { deps, handleInboundCoalesced } = makeDeps({ loadAccess: () => ({}) })
    await handleVoiceMessage(ctxWith(), deps)
    expect(deps.maybeTranscribeVoice).not.toHaveBeenCalled()
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      expect.anything(), '(voice message)', undefined, VOICE_META,
    )
  })

  it('falls back to the legacy envelope on transcription failure', async () => {
    const { deps, handleInboundCoalesced } = makeDeps({ maybeTranscribeVoice: vi.fn(async () => null) })
    await handleVoiceMessage(ctxWith(), deps)
    expect(handleInboundCoalesced).toHaveBeenCalledWith(
      expect.anything(), '(voice message)', undefined, VOICE_META,
    )
  })

  it('uses the caption as the legacy envelope when present', async () => {
    const { deps, handleInboundCoalesced } = makeDeps({ loadAccess: () => ({}) })
    await handleVoiceMessage(ctxWith('hi there'), deps)
    expect(handleInboundCoalesced.mock.calls[0][1]).toBe('hi there')
  })

  it('does not use the cloud path when provider is not openai', async () => {
    delete process.env.SWITCHROOM_VOICE_ENGINE
    const { deps } = makeDeps({ loadAccess: () => ({ voice_in: { enabled: true } }) })
    await handleVoiceMessage(ctxWith(), deps)
    expect(deps.maybeTranscribeVoice).not.toHaveBeenCalled()
    expect(deps.maybeTranscribeVoiceLocal).not.toHaveBeenCalled()
  })
})
