/**
 * Spoken-reply synthesis (TTS) via the OpenAI cloud API (voice PR-C2).
 *
 * The cloud twin of `voice-synthesize-sidecar.ts` (local Kokoro sidecar),
 * and the OUTBOUND mirror of `voice-transcribe.ts` (OpenAI Whisper STT).
 * Used only when the operator opts an agent into `voice_out.engine: openai`
 * — an honest-exception third-party path gated on an `api_key` vault ref
 * (the local sidecar is the subscription-honest default).
 *
 * Pure: takes the text + resolved API key as args (no env reads, no file
 * IO) so it's unit-testable against a mocked fetch. Never throws — every
 * failure becomes a structured `{ ok: false, reason, detail }` and the
 * gateway caller falls back to a text-only reply (voice is best-effort).
 *
 * Requests OGG/Opus directly (response_format: 'opus') so the bytes hand
 * straight to Telegram sendVoice with no transcode — same shape the local
 * sidecar returns.
 */

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'

/** Default model + voice when the operator doesn't pin one. */
export const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
export const DEFAULT_OPENAI_TTS_VOICE = 'alloy'

export interface OpenAiSynthesizeResult {
  ok: true
  /** OGG/Opus bytes — hand directly to Telegram sendVoice. */
  audio: Uint8Array
  /** Wall-clock synthesis time in ms. */
  durationMs: number
  /** The voice actually requested. */
  voice: string
}

export interface OpenAiSynthesizeError {
  ok: false
  reason: string
  detail?: string
}

export type OpenAiSynthesizeOutcome = OpenAiSynthesizeResult | OpenAiSynthesizeError

export interface OpenAiSynthesizeArgs {
  /** Resolved OpenAI API key (already materialized from the vault). */
  apiKey: string
  /** Plain text to speak. Strip markdown before calling. */
  text: string
  /** Voice id (e.g. 'alloy', 'nova'). Defaults to DEFAULT_OPENAI_TTS_VOICE. */
  voice?: string
  /** Model. Defaults to DEFAULT_OPENAI_TTS_MODEL. */
  model?: string
  /** Per-call timeout in ms. Default 60s. */
  timeoutMs?: number
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

/**
 * Synthesize a single reply via OpenAI TTS. Resolves to an outcome — the
 * caller branches on `.ok`. Never throws.
 *
 * Reason codes:
 *   - 'no-api-key'  — empty key
 *   - 'empty-text'  — empty/whitespace text
 *   - 'http-<n>'    — non-2xx HTTP status code
 *   - 'fetch-failed'— network error before any response
 *   - 'empty-audio' — 2xx but no body bytes
 *   - 'timeout'     — exceeded the per-call timeout
 */
export async function synthesizeViaOpenAi(
  args: OpenAiSynthesizeArgs,
): Promise<OpenAiSynthesizeOutcome> {
  if (!args.apiKey || args.apiKey.length === 0) {
    return { ok: false, reason: 'no-api-key' }
  }
  const text = args.text?.trim() ?? ''
  if (text.length === 0) {
    return { ok: false, reason: 'empty-text' }
  }

  const fetchFn = args.fetchImpl ?? fetch
  const voice = args.voice && args.voice.length > 0 ? args.voice : DEFAULT_OPENAI_TTS_VOICE
  const model = args.model && args.model.length > 0 ? args.model : DEFAULT_OPENAI_TTS_MODEL
  const timeoutMs = args.timeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetchFn(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      // response_format 'opus' → OGG/Opus, ready for Telegram sendVoice.
      body: JSON.stringify({ model, voice, input: text, response_format: 'opus' }),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('aborted') || /timeout/i.test(msg)) {
      return { ok: false, reason: 'timeout', detail: msg }
    }
    return { ok: false, reason: 'fetch-failed', detail: msg }
  }
  clearTimeout(timer)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, reason: `http-${res.status}`, detail: body.slice(0, 200) }
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length === 0) {
    return { ok: false, reason: 'empty-audio' }
  }

  return {
    ok: true,
    audio: buf,
    durationMs: Date.now() - startedAt,
    voice,
  }
}
