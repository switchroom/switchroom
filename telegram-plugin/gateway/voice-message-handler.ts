/**
 * Voice inbound handler (switchroom#2996 P6 cluster E).
 *
 * `message:voice` is the attachment type with the richest branch: when
 * `voice_in` is enabled in access.json it downloads the audio and transcribes
 * it (local GPU sidecar or OpenAI cloud, per the host voice-engine verdict)
 * before surfacing the transcript to the agent as inbound text. Every failure
 * path falls back to the legacy `(voice message)` envelope so the agent still
 * gets something — better than a silent drop. Split out of gateway.ts so the
 * engine-selection + fallback logic is unit-testable against injected
 * transcribe/access/capability surfaces.
 *
 * The registration line stays in gateway.ts (order is a load-bearing invariant
 * pinned by gateway-handler-registration-wiring.test.ts) and delegates here.
 * The engine env (`SWITCHROOM_VOICE_ENGINE`) is read directly — it is process
 * ambient, not a gateway module global. All gateway surfaces (access load,
 * host-capabilities load, both transcribe entry points, the coalescing
 * dispatch) are injected (switchroom#2996 Amendment 9).
 */

import type { Context, Filter } from 'grammy'
import type { VoiceEngine } from '../../src/setup/gpu-detect.js'
import type { AttachmentMeta } from './attachment-message-handlers.js'

interface VoiceInConfig {
  enabled?: boolean
  provider?: 'openai'
  language?: string
  api_key?: string
}

export interface VoiceHandlerDeps {
  /** Load the agent's access config (for the `voice_in` block). */
  loadAccess: () => { voice_in?: VoiceInConfig }
  /** Load the persisted host voice-engine verdict (null when absent). */
  loadHostCapabilities: () => { voice: { engine: VoiceEngine } } | null
  /** Transcribe via the in-fleet local GPU sidecar (no third-party key). */
  maybeTranscribeVoiceLocal: (
    fileId: string,
    mimeType: string | undefined,
    language: string | undefined,
  ) => Promise<string | null>
  /** Transcribe via the OpenAI cloud provider. */
  maybeTranscribeVoice: (
    fileId: string,
    mimeType: string | undefined,
    language: string | undefined,
    apiKeyRef: string | undefined,
  ) => Promise<string | null>
  /** Normal coalescing inbound pipeline. */
  handleInboundCoalesced: (
    ctx: Context,
    text: string,
    downloadImage: undefined,
    attachment?: AttachmentMeta,
  ) => Promise<void>
}

export async function handleVoiceMessage(
  ctx: Filter<Context, 'message:voice'>,
  deps: VoiceHandlerDeps,
): Promise<void> {
  const voice = ctx.message.voice
  // #578 spike: when voice_in is enabled in access.json, download
  // the audio and transcribe via Whisper before surfacing to the
  // agent. The transcript becomes the inbound text; the agent reads
  // it like a typed message. Failure paths gracefully fall back to
  // the legacy "(voice message)" envelope so the agent still gets
  // SOMETHING — better than silent drops.
  const access = deps.loadAccess()
  const voiceIn = access.voice_in
  // Engine selection (PR-B2): the persisted host verdict decides HOW we
  // transcribe. `local` → the in-fleet GPU sidecar (no third-party key,
  // vision #3 + #4); anything else → the OpenAI cloud provider. The local
  // path needs no `provider === 'openai'` gate — it has no API key — so we
  // route to the sidecar whenever voice_in is enabled AND the host verdict
  // is `local`. The cloud path keeps its existing openai gate.
  // Source precedence: the compose-injected SWITCHROOM_VOICE_ENGINE env
  // (set per-agent by compose-gen from the host verdict — PR-B3) wins,
  // then the persisted host-capabilities file, then a fail-safe `cloud`.
  // The env is load-bearing in-fleet: the in-container `~/.switchroom`
  // is a read-only constructed view that does NOT carry the host's
  // host-capabilities.json, so without the env the file lookup always
  // misses and every agent silently falls back to `cloud`. Narrow the
  // env value to the VoiceEngine union so a bogus value can't leak
  // through — anything but 'local'/'cloud' is ignored and we fall back.
  const envVoiceEngine = process.env.SWITCHROOM_VOICE_ENGINE
  const voiceEngine: VoiceEngine =
    envVoiceEngine === 'local' || envVoiceEngine === 'cloud'
      ? envVoiceEngine
      : deps.loadHostCapabilities()?.voice.engine ?? 'cloud'
  const localEnabled = voiceIn?.enabled === true && voiceEngine === 'local'
  const cloudEnabled =
    voiceIn?.enabled === true && voiceEngine !== 'local' && voiceIn?.provider === 'openai'
  if (localEnabled || cloudEnabled) {
    const transcript = localEnabled
      ? await deps.maybeTranscribeVoiceLocal(
          voice.file_id,
          voice.mime_type,
          voiceIn?.language,
        )
      : await deps.maybeTranscribeVoice(
          voice.file_id,
          voice.mime_type,
          voiceIn?.language,
          voiceIn?.api_key,
        )
    if (transcript != null) {
      const text = ctx.message.caption
        ? `${ctx.message.caption}\n\n[voice transcript] ${transcript}`
        : `[voice transcript] ${transcript}`
      await deps.handleInboundCoalesced(ctx, text, undefined, {
        kind: 'voice',
        file_id: voice.file_id,
        size: voice.file_size,
        mime: voice.mime_type,
      })
      return
    }
    // Fall through to the legacy path on transcription failure.
  }
  await deps.handleInboundCoalesced(ctx, ctx.message.caption ?? '(voice message)', undefined, { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type })
}
