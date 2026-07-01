/**
 * One-voice-note-per-response contract test for the kokoro (local sidecar)
 * voice-out path.
 *
 * The gateway send path (gateway.ts resolveVoiceOutPlan → synth loop →
 * sendVoice loop) now, for the kokoro engine, sends the WHOLE speech-
 * normalized reply to /tts in a SINGLE call and issues a SINGLE sendVoice —
 * the sidecar chunks + concatenates internally and returns one ogg/opus file.
 *
 * gateway.ts is a large module with import-time side effects, so rather than
 * import resolveVoiceOutPlan (private) we reproduce the exact decision it
 * makes for the kokoro path and assert the observable contract: for a LONG
 * reply, normalization yields the single text sent to /tts, synthesis issues
 * exactly ONE /tts fetch, and exactly ONE sendVoice is issued.
 */

import { describe, it, expect } from 'bun:test'
import { normalizeForSpeech } from '../voice-normalize-text.js'
import { synthesizeViaSidecar, clampTtsSpeed } from '../voice-synthesize-sidecar.js'

/** The fleet default speed the gateway applies when voice_out is enabled but
 *  speed is unset (mirrors VOICE_OUT_DEFAULT_SPEED in gateway.ts). */
const VOICE_OUT_DEFAULT_SPEED = 1.1

/** Reproduce resolveVoiceOutPlan's speed resolution: default to 1.1 when
 *  unset, clamp to 0.5–2.0. */
function resolveSpeed(speed: number | undefined): number {
  return clampTtsSpeed(speed, VOICE_OUT_DEFAULT_SPEED)
}

const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53]) // OggS magic

/** Build the kokoro voice-note chunks exactly as resolveVoiceOutPlan does:
 *  normalize the whole reply, then a SINGLE element (no client-side split). */
function kokoroTtsChunks(replyText: string): string[] {
  const ttsText = normalizeForSpeech(replyText)
  if (ttsText.length === 0) return []
  return [ttsText] // kokoro: one call, one note
}

describe('voice-out kokoro path — ONE synth call, ONE sendVoice', () => {
  it('splits a long markdown reply into exactly one voice-note chunk', () => {
    const longReply = Array.from(
      { length: 40 },
      (_, i) => `## Section ${i}\nSome **bold** prose with \`code\` and a [link](https://x.com/${i}).`,
    ).join('\n\n')
    expect(longReply.length).toBeGreaterThan(1200) // would have been multi-chunk before

    const chunks = kokoroTtsChunks(longReply)
    expect(chunks).toHaveLength(1)
    // Normalization is applied: no markdown/symbols leak into the spoken text.
    expect(chunks[0]).not.toContain('##')
    expect(chunks[0]).not.toContain('`')
    expect(chunks[0]).not.toContain('**')
    expect(chunks[0]).not.toContain('https://')
  })

  it('issues exactly ONE /tts fetch for the whole long reply', async () => {
    const longReply = 'A '.repeat(2000) // ~4000 chars, well over the old 1200 cap
    const chunks = kokoroTtsChunks(longReply)
    expect(chunks).toHaveLength(1)

    let fetchCalls = 0
    const countingFetch = (async (_url: string, init: RequestInit) => {
      fetchCalls++
      // The single call must carry the full normalized text.
      const body = JSON.parse(init.body as string) as { text: string }
      expect(body.text.length).toBeGreaterThan(1200)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          OGG_BYTES.buffer.slice(OGG_BYTES.byteOffset, OGG_BYTES.byteOffset + OGG_BYTES.byteLength),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch

    // Simulate the gateway synth loop over the (single) chunk set.
    const voiceOggs: Uint8Array[] = []
    for (const chunkText of chunks) {
      const r = await synthesizeViaSidecar({ token: 'tok', text: chunkText, fetchImpl: countingFetch })
      if (r.ok) voiceOggs.push(r.audio)
    }

    expect(fetchCalls).toBe(1) // ONE synth call
    expect(voiceOggs).toHaveLength(1) // ONE ogg → ONE sendVoice
  })

  it('issues exactly ONE sendVoice (simulating the gateway send loop)', async () => {
    const chunks = kokoroTtsChunks('Hello **world**, this is a `test` reply.\n\nSecond paragraph.')
    expect(chunks).toHaveLength(1)

    const okFetch = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        OGG_BYTES.buffer.slice(OGG_BYTES.byteOffset, OGG_BYTES.byteOffset + OGG_BYTES.byteLength),
      text: async () => '',
      headers: new Headers(),
    })) as unknown as typeof fetch

    const voiceOggs: Uint8Array[] = []
    for (const chunkText of chunks) {
      const r = await synthesizeViaSidecar({ token: 'tok', text: chunkText, fetchImpl: okFetch })
      if (r.ok) voiceOggs.push(r.audio)
    }

    let sendVoiceCalls = 0
    for (const _ogg of voiceOggs) {
      sendVoiceCalls++ // gateway: one sendVoice per ogg
    }
    expect(sendVoiceCalls).toBe(1)
  })
})

describe('voice-out kokoro path — speed resolution (gateway default 1.1)', () => {
  it('defaults to 1.1 when voice_out.speed is unset', () => {
    expect(resolveSpeed(undefined)).toBe(1.1)
  })

  it('honours an explicit in-range speed', () => {
    expect(resolveSpeed(0.9)).toBe(0.9)
    expect(resolveSpeed(1.5)).toBe(1.5)
  })

  it('clamps an out-of-range configured speed to 0.5–2.0', () => {
    expect(resolveSpeed(3.0)).toBe(2.0)
    expect(resolveSpeed(0.1)).toBe(0.5)
  })

  it('threads the resolved speed into the single /tts body', async () => {
    let sentSpeed: number | undefined
    const capturingFetch = (async (_url: string, init: RequestInit) => {
      sentSpeed = (JSON.parse(init.body as string) as { speed?: number }).speed
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => OGG_BYTES.buffer.slice(0),
        text: async () => '',
        headers: new Headers(),
      }
    }) as unknown as typeof fetch

    await synthesizeViaSidecar({
      token: 't',
      text: 'hello there',
      speed: resolveSpeed(undefined), // gateway default path
      fetchImpl: capturingFetch,
    })
    expect(sentSpeed).toBe(1.1)
  })
})
