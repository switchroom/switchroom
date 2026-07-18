/**
 * Outcome pins for the on-demand voice ('🔊 Listen') callback family
 * (`voice:<token>`) extracted from the gateway's callback_query dispatcher
 * (switchroom#2996 P6). Uses the REAL voice-ondemand token helpers and the
 * REAL sendVoiceReusingFileId contract via injected send fns: asserts the
 * fall-through for non-voice data, the auth gate, expiry toast, the
 * file_id fast path (no upload), the upload path capturing the returned
 * file_id, and the single-use keyboard strip on success only.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleVoiceOnDemandCallback,
  type VoiceOnDemandCallbackDeps,
} from '../gateway/voice-ondemand-callback-handler.js'

const TOKEN = 'tok123'
const DATA = `voice:${TOKEN}`

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    from: { id: 42 },
    chat: { id: 42 },
    callbackQuery: { message: { message_id: 77 } },
    answerCallbackQuery: vi.fn(async () => {}),
    ...over,
  } as any
}

function makeDeps(over: Partial<VoiceOnDemandCallbackDeps> = {}) {
  const setTelegramFileId = vi.fn()
  const sendVoiceByFileId = vi.fn(async () => ({ voice: { file_id: 'same' } }))
  const sendVoiceByUpload = vi.fn(async () => ({ voice: { file_id: 'fresh-id' } }))
  const stripListenKeyboard = vi.fn(async () => {})
  const log = vi.fn()
  const deps: VoiceOnDemandCallbackDeps = {
    loadAccess: () => ({ allowFrom: ['42'] }),
    voiceOnDemandCache: {
      get: () => null,
      setTelegramFileId,
    },
    sendVoiceByFileId,
    sendVoiceByUpload,
    stripListenKeyboard,
    log,
    ...over,
  }
  return { deps, setTelegramFileId, sendVoiceByFileId, sendVoiceByUpload, stripListenKeyboard, log }
}

describe('handleVoiceOnDemandCallback — routing + gates', () => {
  it('returns false for non-voice callback data', async () => {
    const { deps } = makeDeps()
    const ctx = makeCtx()
    expect(await handleVoiceOnDemandCallback(ctx, 'agent:whatever', deps)).toBe(false)
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled()
  })

  it('gates non-allowlisted senders', async () => {
    const { deps, sendVoiceByFileId } = makeDeps()
    const ctx = makeCtx({ from: { id: 666 } })
    expect(await handleVoiceOnDemandCallback(ctx, DATA, deps)).toBe(true)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    expect(sendVoiceByFileId).not.toHaveBeenCalled()
  })

  it('acks an expired token politely', async () => {
    const { deps } = makeDeps() // cache.get → null
    const ctx = makeCtx()
    expect(await handleVoiceOnDemandCallback(ctx, DATA, deps)).toBe(true)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Voice expired — send again to hear it.',
    })
  })
})

describe('handleVoiceOnDemandCallback — send paths', () => {
  it('file_id fast path: sends BY id, strips the keyboard, no upload', async () => {
    const { deps, sendVoiceByFileId, sendVoiceByUpload, stripListenKeyboard } = makeDeps({
      voiceOnDemandCache: {
        get: () => ({ text: 'hello', speed: 1, telegramFileId: 'cached-id' }),
        setTelegramFileId: vi.fn(),
      },
    })
    const ctx = makeCtx()
    expect(await handleVoiceOnDemandCallback(ctx, DATA, deps)).toBe(true)
    expect(sendVoiceByFileId).toHaveBeenCalledWith(
      '42',
      'cached-id',
      expect.objectContaining({ reply_parameters: { message_id: 77 } }),
      undefined,
    )
    expect(sendVoiceByUpload).not.toHaveBeenCalled()
    expect(stripListenKeyboard).toHaveBeenCalledWith('42', 77, undefined)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '🔊' })
  })

  it('pre-synth file path: uploads the on-disk audio and captures the returned file_id', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'voice-od-'))
    const fp = join(dir, 'a.ogg')
    writeFileSync(fp, Buffer.from([1, 2, 3]))
    const setTelegramFileId = vi.fn()
    const { deps, sendVoiceByUpload, stripListenKeyboard } = makeDeps({
      voiceOnDemandCache: {
        get: () => ({ text: 'hello', speed: 1, filePath: fp }),
        setTelegramFileId,
      },
    })
    const ctx = makeCtx()
    await handleVoiceOnDemandCallback(ctx, DATA, deps)
    expect(sendVoiceByUpload).toHaveBeenCalled()
    // Returned message's file_id captured back into the cache for reuse.
    expect(setTelegramFileId).toHaveBeenCalledWith(TOKEN, 'fresh-id')
    expect(stripListenKeyboard).toHaveBeenCalled()
  })

  it('send failure: logs non-fatally and leaves the keyboard intact (retryable)', async () => {
    const { deps, stripListenKeyboard, log } = makeDeps({
      voiceOnDemandCache: {
        get: () => ({ text: 'hello', speed: 1, telegramFileId: 'cached-id' }),
        setTelegramFileId: vi.fn(),
      },
      sendVoiceByFileId: vi.fn(async () => {
        throw new Error('boom')
      }),
      // Stale-id fallback then tries upload; make it fail too so the send
      // resolves as send-failed overall. filePath absent → lazy synth path
      // would need the sidecar; keep it simple: upload throws.
      sendVoiceByUpload: vi.fn(async () => {
        throw new Error('boom2')
      }),
    })
    const ctx = makeCtx()
    expect(await handleVoiceOnDemandCallback(ctx, DATA, deps)).toBe(true)
    expect(stripListenKeyboard).not.toHaveBeenCalled()
  })
})
