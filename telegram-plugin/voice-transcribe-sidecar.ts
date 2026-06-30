/**
 * Voice-message transcription via the LOCAL GPU STT sidecar (voice PR-B2).
 *
 * The cloud twin of this module is `voice-transcribe.ts` (OpenAI Whisper).
 * This one POSTs the downloaded audio bytes to the in-fleet
 * `voice-sidecar` service (docker/voice-sidecar/server.py, faster-whisper
 * on a local GPU) when the host's voice-engine verdict is `local` — no
 * third-party STT key (vision #3, subscription-honest) and no cloud
 * dependency (vision #4, always-available).
 *
 * Reachability: the gateway runs inside the agent container, which is
 * `network_mode: host`, so the sidecar's published `0.0.0.0:18900` is
 * reachable at loopback `127.0.0.1:18900` (compose maps host 18900 → the
 * sidecar's in-container 8126). See src/agents/compose.ts
 * (VOICE_SIDECAR_HOST_PORT) for the published-port contract.
 *
 * Contract MIRRORS `transcribeViaWhisper`:
 *   - takes audio bytes + a shared-secret token as args (no env reads,
 *     no file IO) so it's unit-testable against a mocked fetch;
 *   - never throws — every failure becomes a structured
 *     `{ ok: false, reason, detail }`, and the gateway caller falls back
 *     to the legacy "(voice message)" envelope on any non-ok outcome.
 *
 * The sidecar's /stt response shape (server.py):
 *   200 { ok: true,  text, language?, durationMs, audioSeconds }
 *   4xx/5xx { ok: false, reason, detail }
 */

import type {
  TranscribeOutcome,
  TranscribeResult,
} from './voice-transcribe.js'

/** Default loopback base URL for the sidecar (host-network agent). */
export const DEFAULT_SIDECAR_BASE_URL = 'http://127.0.0.1:18900'

/** The sidecar caps inputs at 25MB before transcode (server.py MAX_BYTES);
 *  reject before the round-trip to match the cloud path's pre-flight. */
export const SIDECAR_MAX_BYTES = 25 * 1024 * 1024

export interface SidecarTranscribeArgs {
  /** Shared secret sent in the X-Voice-Token header (vault:voice/sidecar-token). */
  token: string
  audio: Uint8Array
  /** Filename hint for the multipart body (matches the actual content). */
  filename: string
  /** Optional ISO-639-1 language hint to skip detection. */
  language?: string
  /** Base URL for the sidecar. Defaults to DEFAULT_SIDECAR_BASE_URL. */
  baseUrl?: string
  /** Per-call timeout in ms. Default 90s — local whisper can run longer
   *  than the cloud API on a cold model / long memo (the sidecar's own
   *  per-request timeout is 60s by default; we give the HTTP leg slack). */
  timeoutMs?: number
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

/**
 * Run a single transcription against the local sidecar. Resolves to a
 * TranscribeOutcome — the caller branches on `.ok`. Never throws.
 *
 * Reason codes mirror the cloud path where they overlap:
 *   - 'no-token'           — empty shared secret (mirrors 'no-api-key')
 *   - 'audio-too-short'    — empty audio
 *   - 'audio-too-large'    — exceeds SIDECAR_MAX_BYTES
 *   - 'http-<n>'           — non-2xx HTTP status code
 *   - 'sidecar-error'      — 200/2xx but body said { ok: false }
 *   - 'fetch-failed'       — network error before any response
 *   - 'malformed-response' — 2xx but body wasn't the expected JSON
 *   - 'timeout'            — exceeded the per-call timeout
 */
export async function transcribeViaSidecar(
  args: SidecarTranscribeArgs,
): Promise<TranscribeOutcome> {
  if (!args.token || args.token.length === 0) {
    return { ok: false, reason: 'no-token' }
  }
  if (args.audio.length === 0) {
    return { ok: false, reason: 'audio-too-short' }
  }
  if (args.audio.length > SIDECAR_MAX_BYTES) {
    return {
      ok: false,
      reason: 'audio-too-large',
      detail: `${args.audio.length} bytes (limit ${SIDECAR_MAX_BYTES})`,
    }
  }

  const fetchFn = args.fetchImpl ?? fetch
  const baseUrl = (args.baseUrl ?? DEFAULT_SIDECAR_BASE_URL).replace(/\/$/, '')
  const timeoutMs = args.timeoutMs ?? 90_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Multipart: server.py reads `audio` (bytes) + optional `language`.
  const form = new FormData()
  const blob = new Blob([args.audio as unknown as BlobPart])
  form.append('audio', blob, args.filename)
  if (args.language) form.append('language', args.language)

  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/stt`, {
      method: 'POST',
      headers: { 'X-Voice-Token': args.token },
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
    return { ok: false, reason: `http-${res.status}`, detail: body.slice(0, 200) }
  }

  let parsed: {
    ok?: unknown
    text?: unknown
    language?: unknown
    durationMs?: unknown
    audioSeconds?: unknown
    reason?: unknown
    detail?: unknown
  }
  try {
    parsed = (await res.json()) as typeof parsed
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed-response',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  // A 2xx with { ok: false } (defence in depth — the sidecar returns
  // non-2xx on errors, but a proxy could rewrite the status).
  if (parsed.ok === false) {
    return {
      ok: false,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'sidecar-error',
      detail: typeof parsed.detail === 'string' ? parsed.detail.slice(0, 200) : undefined,
    }
  }

  if (typeof parsed.text !== 'string') {
    return {
      ok: false,
      reason: 'malformed-response',
      detail: 'response missing `text` field',
    }
  }

  const out: TranscribeResult = {
    ok: true,
    text: parsed.text,
    language: typeof parsed.language === 'string' ? parsed.language : undefined,
    // Prefer the sidecar's own durationMs; fall back to our wall-clock.
    durationMs:
      typeof parsed.durationMs === 'number'
        ? parsed.durationMs
        : Date.now() - startedAt,
    audioSeconds:
      typeof parsed.audioSeconds === 'number' ? parsed.audioSeconds : null,
  }
  return out
}
