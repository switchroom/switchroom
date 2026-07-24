/**
 * outbox-listen-markup.ts — wires the shared `planListenButton` decision into
 * the durable-outbox safety-net delivery (outbox-sweep.ts), so a net-delivered
 * final answer carries the SAME 🔊 Listen button / voice-out keyboard the normal
 * `sendReply` path injects (switchroom #3502 regression: the sweep sent captured
 * prose via a RAW `bot.api.sendMessage` with no voice-out resolution, dropping
 * the button).
 *
 * Extracted from gateway.ts so the wiring lives in a module (the #2996 gateway
 * anti-inflation ratchet) and is independently testable.
 */

import {
  planListenButton,
  type ListenButtonVoiceOutPlan,
  type VoiceOnDemandPayload,
} from '../voice-ondemand.js'
import type { OutboxDeliveryMarkup } from './outbox-sweep.js'

/** The minimal side-effecting deps the resolver needs — mirrors what `sendReply`
 *  does on the normal path (cache put + eager pre-synth), kept as an injected
 *  surface so gateway.ts passes its own singletons and this stays unit-testable. */
export interface OutboxListenMarkupDeps {
  /** Resolve the agent's voice-out plan for a reply body (loadAccess().voice_out
   *  → resolveVoiceOutPlan). Returns null when voice-out is off / not applicable. */
  resolveVoiceOutPlan: (replyText: string) => ListenButtonVoiceOutPlan | null
  /** Persist a minted token so a Listen tap can resynthesize. A thin closure
   *  (not the cache instance) so the gateway can pass it before its module-scope
   *  `voiceOnDemandCache` const is initialized (this factory runs at wiring time,
   *  earlier in gateway.ts than the cache declaration). */
  cachePut: (token: string, payload: VoiceOnDemandPayload) => void
  /** True when eager pre-synth is enabled (kill switch off). */
  eagerVoiceEnabled: () => boolean
  /** Enqueue an eager pre-synth job (best-effort, off the critical path). */
  enqueuePreSynth: (job: { token: string; text: string; voice?: string; speed: number }) => void
}

/**
 * Build the `resolveReplyMarkup` callback for `startOutboxSweep`. Returns the
 * Listen keyboard (and persists the token + eager-synth job) when kokoro
 * on-demand voice-out is enabled and the empty-TTS / collision gates pass;
 * otherwise undefined → the sweep delivers plain.
 *
 * A net-delivered captured-prose answer never carries an agent keyboard, so
 * `rawKeyboard` is always undefined here; `planListenButton` still enforces the
 * empty-TTS guard and the kokoro-on-demand gate.
 */
export function makeOutboxListenMarkupResolver(
  deps: OutboxListenMarkupDeps,
): (chatId: string, threadId: number | null, text: string) => OutboxDeliveryMarkup | undefined {
  return (_chatId, _threadId, text) => {
    const voiceOutPlan = deps.resolveVoiceOutPlan(text)
    const listenPlan = planListenButton({ voiceOutPlan, rawKeyboard: undefined })
    if (listenPlan == null) return undefined
    const payload: VoiceOnDemandPayload = listenPlan.payload
    deps.cachePut(listenPlan.token, payload)
    if (deps.eagerVoiceEnabled()) {
      deps.enqueuePreSynth({
        token: listenPlan.token,
        text: payload.text,
        ...(payload.voice != null ? { voice: payload.voice } : {}),
        speed: payload.speed,
      })
    }
    return listenPlan.replyMarkup
  }
}
