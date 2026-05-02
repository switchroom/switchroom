/**
 * Voice-message transcription via OpenAI Whisper (#578 spike).
 *
 * Closes the inbound side of `talk-to-agents-from-anywhere`'s
 * voice path. The user sends a voice message from their phone; the
 * gateway:
 *   1. Downloads the audio bytes from Telegram.
 *   2. POSTs them to OpenAI's Whisper API.
 *   3. Surfaces the transcript as the user's inbound text — same
 *      pipeline a typed message goes through.
 *
 * Spike scope (#578): OpenAI provider only. The
 * Groq/Deepgram/local-whisper-cli fallback chain is a follow-up;
 * we want to validate the UX before committing to a multi-provider
 * abstraction.
 *
 * Pure helper module — runs the API call but takes API key + audio
 * bytes as args. No env reads, no file I/O. Unit-testable against a
 * mocked fetch; the gateway-side wiring is the impure part.
 */

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'

export interface TranscribeResult {
  ok: true
  text: string
  /** Provider-reported language (e.g. 'en'). Useful for telemetry +
   *  for the agent to know whether to reply in the same language. */
  language?: string
  /** Wall-clock duration of the API call. Operator-facing telemetry. */
  durationMs: number
  /** Approximate audio length the provider transcribed, in seconds.
   *  null when the provider doesn't include it in the response shape. */
  audioSeconds: number | null
}

export interface TranscribeError {
  ok: false
  /** One of:
   *   - 'no-api-key'           — config / vault missing
   *   - 'audio-too-large'      — exceeds OpenAI's 25MB limit
   *   - 'audio-too-short'      — shorter than 0.1s, Whisper rejects
   *   - 'http-<n>'             — non-2xx HTTP status code
   *   - 'fetch-failed'         — network error before getting any response
   *   - 'malformed-response'   — 200 but body wasn't the expected JSON
   *   - 'timeout'              — exceeded the operator-set timeout */
  reason: string
  /** Body (truncated) for operator stderr logs only. NEVER returned to
   *  the user — error messages may leak token-shaped strings. */
  detail?: string
}

export type TranscribeOutcome = TranscribeResult | TranscribeError

export interface TranscribeArgs {
  apiKey: string
  audio: Uint8Array
  /** Filename hint for the multipart body. Whisper uses the extension
   *  to pick a decoder ('voice.ogg', 'audio.mp3', etc). Pass an
   *  extension matching the actual content. */
  filename: string
  /** Optional: ISO-639-1 language hint to skip detection. */
  language?: string
  /** Per-call timeout in ms. Default 30s — Whisper is fast, but a
   *  60s voice memo on a slow link can run long. */
  timeoutMs?: number
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

/** OpenAI Whisper accepts up to 25 MB. Reject before the round-trip. */
export const OPENAI_WHISPER_MAX_BYTES = 25 * 1024 * 1024

/**
 * Run a single transcription. Resolves to a TranscribeOutcome — the
 * caller branches on `.ok`. Never throws (every error becomes a
 * structured `{ ok: false, reason, detail }`).
 */
export async function transcribeViaWhisper(
  args: TranscribeArgs,
): Promise<TranscribeOutcome> {
  if (!args.apiKey || args.apiKey.length === 0) {
    return { ok: false, reason: 'no-api-key' }
  }
  if (args.audio.length === 0) {
    return { ok: false, reason: 'audio-too-short' }
  }
  if (args.audio.length > OPENAI_WHISPER_MAX_BYTES) {
    return {
      ok: false,
      reason: 'audio-too-large',
      detail: `${args.audio.length} bytes (limit ${OPENAI_WHISPER_MAX_BYTES})`,
    }
  }

  const fetchFn = args.fetchImpl ?? fetch
  const timeoutMs = args.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Multipart body. OpenAI's API requires `model` and `file`; we
  // include `response_format=verbose_json` to get language back.
  const form = new FormData()
  // Bun's FormData accepts Blob via globalThis.Blob; Node 22+ same.
  // Construct the Blob from the Uint8Array.
  const blob = new Blob([args.audio as unknown as BlobPart])
  form.append('file', blob, args.filename)
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  if (args.language) form.append('language', args.language)

  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetchFn(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
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
    return {
      ok: false,
      reason: `http-${res.status}`,
      detail: body.slice(0, 200),
    }
  }

  let parsed: { text?: unknown; language?: unknown; duration?: unknown }
  try {
    parsed = await res.json() as typeof parsed
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed-response',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  if (typeof parsed.text !== 'string') {
    return {
      ok: false,
      reason: 'malformed-response',
      detail: 'response missing `text` field',
    }
  }

  return {
    ok: true,
    text: parsed.text,
    language: typeof parsed.language === 'string' ? parsed.language : undefined,
    durationMs: Date.now() - startedAt,
    audioSeconds: typeof parsed.duration === 'number' ? parsed.duration : null,
  }
}
