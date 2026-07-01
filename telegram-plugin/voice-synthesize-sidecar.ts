/**
 * Spoken-reply synthesis (TTS) via the LOCAL voice sidecar (voice PR-C2).
 *
 * The mirror of `voice-transcribe-sidecar.ts` for the OUTBOUND direction.
 * Where that module POSTs audio bytes to `/stt` and gets text back, this
 * one POSTs the agent's reply text to `/tts` (docker/voice-sidecar/server.py,
 * Kokoro on a local GPU/CPU) and gets OGG/Opus bytes back — ready to hand
 * straight to Telegram `sendVoice`. Used when the host's voice-engine
 * verdict is `local` (no third-party TTS key, vision #3 + #4).
 *
 * Reachability: the gateway runs inside the agent container
 * (`network_mode: host`), so the sidecar's published `0.0.0.0:18900` is
 * reachable at loopback `127.0.0.1:18900` (compose maps host 18900 → the
 * sidecar's in-container 8126). See src/agents/compose.ts
 * (VOICE_SIDECAR_HOST_PORT) for the published-port contract.
 *
 * Contract MIRRORS `transcribeViaSidecar`:
 *   - takes the text + a shared-secret token as args (no env reads, no
 *     file IO) so it's unit-testable against a mocked fetch;
 *   - never throws — every failure becomes a structured
 *     `{ ok: false, reason, detail }`, and the gateway caller falls back
 *     to a text-only reply on any non-ok outcome (voice is best-effort).
 *
 * The sidecar's /tts response shape (server.py):
 *   200 audio/ogg  (OGG/Opus, mono — raw bytes, NOT JSON)
 *   4xx/5xx { ok: false, reason, detail }
 */

/** Default loopback base URL for the sidecar (host-network agent). */
export const DEFAULT_SIDECAR_BASE_URL = 'http://127.0.0.1:18900'

/** Defence-in-depth ceiling on a SINGLE /tts request.
 *
 *  The sidecar now accepts arbitrarily long text and chunks + concatenates
 *  internally on the GPU, returning a single ogg/opus file (one voice note
 *  per response). This client cap is therefore only a sanity ceiling against
 *  a pathological reply, not a per-note splitter — the gateway sends the
 *  whole normalized reply in one call. Kept comfortably above any realistic
 *  chat reply. (Contract with docker/voice-sidecar/server.py: endpoint path,
 *  X-Voice-Token header, and {text, voice?, format?} JSON shape UNCHANGED.) */
export const SIDECAR_TTS_MAX_CHARS = 100_000

/** TTS playback-speed bounds (mirrors the sidecar clamp in server.py). */
export const SIDECAR_TTS_SPEED_MIN = 0.5
export const SIDECAR_TTS_SPEED_MAX = 2.0

/**
 * Coerce an incoming speed to a float in [SIDECAR_TTS_SPEED_MIN,
 * SIDECAR_TTS_SPEED_MAX]. Non-finite / non-numeric input falls back to
 * `fallback` (default 1.0). Out-of-range numbers are clamped to the nearest
 * bound. Mirrors the sidecar's `_clamp_speed` so the wire value is already
 * valid before it leaves the gateway.
 */
export function clampTtsSpeed(value: unknown, fallback = 1.0): number {
  // Only a real, finite number is a speed. null/undefined/boolean/string all
  // fall back (Number(null) is 0 and Number('') is 0 — both would otherwise
  // masquerade as a valid slow speed).
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(SIDECAR_TTS_SPEED_MIN, Math.min(SIDECAR_TTS_SPEED_MAX, value))
}

/**
 * Split already-stripped plain text into sequential TTS chunks, each ≤
 * `chunkChars`, preferring sentence then word boundaries so a voice note
 * never cuts mid-sentence. A run with no boundary that fits (e.g. one
 * enormous URL) is hard-sliced at the cap so a chunk can't exceed the
 * engine limit. PR-C2 (long-reply voice chunking — the full answer is
 * spoken across several notes instead of truncated to text-only).
 */
export function chunkTtsText(text: string, chunkChars: number): string[] {
  const cap = Math.max(1, chunkChars)
  if (text.length <= cap) {
    const t = text.trim()
    return t.length > 0 ? [t] : []
  }

  // Sentence-ish units: keep the terminator with the sentence. Falls back
  // to the whole string when there's no punctuation to split on.
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text]
  const chunks: string[] = []
  let buf = ''

  const flush = (): void => {
    const t = buf.trim()
    if (t.length > 0) chunks.push(t)
    buf = ''
  }
  const hardSlice = (s: string): void => {
    // No boundary fits the cap — split on word boundaries, then hard-cut
    // any single token still over the cap.
    let rest = s
    while (rest.length > cap) {
      let cut = rest.lastIndexOf(' ', cap)
      if (cut <= 0) cut = cap
      chunks.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trimStart()
    }
    buf = rest
  }

  for (const sentence of sentences) {
    if (sentence.length > cap) {
      // The sentence itself overflows — flush what we have, then slice it.
      flush()
      hardSlice(sentence)
      continue
    }
    if (buf.length + sentence.length > cap) flush()
    buf += sentence
  }
  flush()
  return chunks
}

/** A successful synthesis: the OGG/Opus voice-note bytes plus sidecar meta. */
export interface SynthesizeResult {
  ok: true
  /** OGG/Opus (mono) bytes — hand directly to Telegram sendVoice. */
  audio: Uint8Array
  /** Wall-clock (or sidecar-reported) synthesis time in ms. */
  durationMs: number
  /** Audio length in seconds, if the sidecar reported it. */
  audioSeconds: number | null
  /** The voice actually used (echoed by the sidecar). */
  voice: string | null
}

export interface SynthesizeFailure {
  ok: false
  reason: string
  detail?: string
}

export type SynthesizeOutcome = SynthesizeResult | SynthesizeFailure

export interface SidecarSynthesizeArgs {
  /** Shared secret sent in the X-Voice-Token header (vault:voice/sidecar-token). */
  token: string
  /** Plain text to speak. Strip markdown before calling — Kokoro reads it literally. */
  text: string
  /** Optional engine-specific voice id; the sidecar has its own default. */
  voice?: string
  /** Optional playback speed. Clamped to [0.5, 2.0] before send; when unset
   *  the sidecar applies its own 1.0 default. */
  speed?: number
  /** Base URL for the sidecar. Defaults to DEFAULT_SIDECAR_BASE_URL. */
  baseUrl?: string
  /** Per-call timeout in ms. Default 60s — Kokoro on CPU can run a few
   *  seconds for a long memo; the sidecar's own per-request timeout is 60s. */
  timeoutMs?: number
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

/**
 * Synthesize a single reply against the local sidecar. Resolves to a
 * SynthesizeOutcome — the caller branches on `.ok`. Never throws.
 *
 * Reason codes mirror the STT path where they overlap:
 *   - 'no-token'           — empty shared secret
 *   - 'empty-text'         — empty/whitespace text
 *   - 'text-too-long'      — exceeds SIDECAR_TTS_MAX_CHARS
 *   - 'http-<n>'           — non-2xx HTTP status code
 *   - 'fetch-failed'       — network error before any response
 *   - 'empty-audio'        — 2xx but no body bytes
 *   - 'timeout'            — exceeded the per-call timeout
 */
export async function synthesizeViaSidecar(
  args: SidecarSynthesizeArgs,
): Promise<SynthesizeOutcome> {
  if (!args.token || args.token.length === 0) {
    return { ok: false, reason: 'no-token' }
  }
  const text = args.text?.trim() ?? ''
  if (text.length === 0) {
    return { ok: false, reason: 'empty-text' }
  }
  if (text.length > SIDECAR_TTS_MAX_CHARS) {
    return {
      ok: false,
      reason: 'text-too-long',
      detail: `${text.length} chars (limit ${SIDECAR_TTS_MAX_CHARS})`,
    }
  }

  const fetchFn = args.fetchImpl ?? fetch
  const baseUrl = (args.baseUrl ?? DEFAULT_SIDECAR_BASE_URL).replace(/\/$/, '')
  const timeoutMs = args.timeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // JSON body: server.py reads `text` (str) + optional `voice` + `speed` +
  // `format`.
  const body: { text: string; voice?: string; speed?: number; format: 'ogg' } = {
    text,
    format: 'ogg',
  }
  if (args.voice) body.voice = args.voice
  if (args.speed !== undefined) body.speed = clampTtsSpeed(args.speed)

  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/tts`, {
      method: 'POST',
      headers: {
        'X-Voice-Token': args.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    // Error bodies are JSON ({ ok:false, reason, detail }); echo the reason.
    const errText = await res.text().catch(() => '')
    let reason = `http-${res.status}`
    let detail: string | undefined = errText.slice(0, 200)
    try {
      const parsed = JSON.parse(errText) as { reason?: unknown; detail?: unknown }
      if (typeof parsed.reason === 'string') reason = parsed.reason
      if (typeof parsed.detail === 'string') detail = parsed.detail.slice(0, 200)
    } catch {
      // not JSON — keep the http-<n> reason + raw text detail
    }
    return { ok: false, reason, detail }
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length === 0) {
    return { ok: false, reason: 'empty-audio' }
  }

  // Sidecar echoes synthesis meta as response headers (server.py). A
  // MISSING header reads as null — guard before Number() (Number(null) is 0,
  // which would masquerade as a real 0-second clip).
  const rawDuration = res.headers.get('X-Voice-Duration-Ms')
  const rawAudioSec = res.headers.get('X-Voice-Audio-Seconds')
  const hdrDuration = rawDuration != null ? Number(rawDuration) : NaN
  const hdrAudioSec = rawAudioSec != null ? Number(rawAudioSec) : NaN
  return {
    ok: true,
    audio: buf,
    durationMs: Number.isFinite(hdrDuration) && hdrDuration > 0
      ? hdrDuration
      : Date.now() - startedAt,
    audioSeconds: Number.isFinite(hdrAudioSec) ? hdrAudioSec : null,
    voice: res.headers.get('X-Voice-Voice'),
  }
}
