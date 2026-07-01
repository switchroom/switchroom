/**
 * On-demand voice-out (reply_mode='on-demand').
 *
 * Instead of synthesizing at reply time, the gateway appends a single
 * "🔊 Listen" inline button carrying a reserved `voice:<token>` callback_data;
 * the voice note is synthesized + sent only when the user taps it. Zero
 * GPU/sidecar work happens unless requested — which keeps the voice pipeline
 * subscription-honest and visible: nothing is generated behind the user's back
 * (see reference/vision.md outcome 3, jobs/keep-my-subscription-honest.md and
 * the local-sidecar voice path).
 *
 * This module owns the reserved callback prefix, the token mint, the bounded
 * TTL LRU cache (keyed by TOKEN because the message_id is not known at send
 * time), the Listen-button builder, and the collision gate that decides
 * whether the button may be injected. It is deliberately dependency-free so it
 * can be unit-tested without importing the 25k-line gateway module.
 */

import { randomBytes } from 'crypto'

/** Reserved callback_data prefix for on-demand Listen buttons. Handled
 *  INTERNALLY by the gateway's callback dispatcher (never routed to the agent
 *  as an inbound), so it must NOT overlap the agent: / auth: / op: families. */
export const VOICE_ONDEMAND_CALLBACK_PREFIX = 'voice:'

/** Cache entry TTL. A button tapped after this degrades to an "expired" toast
 *  rather than pinning reply text in memory forever. */
export const VOICE_ONDEMAND_TTL_MS = 60 * 60 * 1000 // 1h

/** Bounded cache size; oldest entries are evicted past this. */
export const VOICE_ONDEMAND_MAX_ENTRIES = 500

export type VoiceOnDemandPayload = {
  /** Speech-normalized text to synthesize (normalizeForSpeech(reply)). */
  text: string
  /** Optional engine-specific voice id. */
  voice?: string
  /** Resolved + clamped playback speed. */
  speed: number
}

type StoredEntry = VoiceOnDemandPayload & { expiresAt: number }

/**
 * Bounded, TTL'd LRU cache from Listen token → synthesis payload. Keyed by
 * token (not message_id) because the message_id isn't known when the button
 * is sent. A Map preserves insertion order, so the first key is the oldest.
 */
export class VoiceOnDemandCache {
  private readonly store = new Map<string, StoredEntry>()

  constructor(
    private readonly ttlMs: number = VOICE_ONDEMAND_TTL_MS,
    private readonly maxEntries: number = VOICE_ONDEMAND_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /** Store a payload under `token`, evicting the oldest entries past the cap. */
  put(token: string, payload: VoiceOnDemandPayload): void {
    // Re-insert to move an existing key to the newest (most-recent) position.
    this.store.delete(token)
    this.store.set(token, { ...payload, expiresAt: this.now() + this.ttlMs })
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }

  /** Look up a payload; returns null on miss or expiry (and evicts expired). */
  get(token: string): VoiceOnDemandPayload | null {
    const entry = this.store.get(token)
    if (entry == null) return null
    if (entry.expiresAt <= this.now()) {
      this.store.delete(token)
      return null
    }
    const { text, voice, speed } = entry
    return voice === undefined ? { text, speed } : { text, voice, speed }
  }

  /** Current entry count (test/introspection aid). */
  get size(): number {
    return this.store.size
  }
}

/** Mint a short, unguessable Listen token (8 hex chars). */
export function mintVoiceOnDemandToken(): string {
  return randomBytes(4).toString('hex')
}

/** True iff `data` is an on-demand Listen callback (must be routed
 *  internally, before agent: routing). */
export function isVoiceOnDemandCallback(data: string): boolean {
  return data.startsWith(VOICE_ONDEMAND_CALLBACK_PREFIX)
}

/** Extract the token from a `voice:<token>` callback_data, or null. */
export function parseVoiceOnDemandToken(data: string): string | null {
  if (!isVoiceOnDemandCallback(data)) return null
  const token = data.slice(VOICE_ONDEMAND_CALLBACK_PREFIX.length)
  return token.length > 0 ? token : null
}

/** Build the single-row Listen keyboard for a token. single_use is N/A —
 *  the gate guarantees this is the only button, so the keyboard is never
 *  stripped and the button stays replayable. */
export function buildListenKeyboard(token: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
} {
  return {
    inline_keyboard: [
      [{ text: '🔊 Listen', callback_data: `${VOICE_ONDEMAND_CALLBACK_PREFIX}${token}` }],
    ],
  }
}

/**
 * Collision gate: the Listen button may be injected ONLY when the reply
 * carries no agent-authored buttons.
 *
 * Why: the callback dispatcher's single_use strip (keyboardIsSingleUse)
 * governs the WHOLE message's keyboard. A Listen button is single_use:false
 * (replayable); adding it alongside agent buttons would turn the message into
 * a mixed keyboard and defeat the agent's double-fire protection. So if the
 * agent supplied any button, we skip the Listen button for this message.
 */
export function mayInjectListenButton(
  rawKeyboard: unknown[][] | undefined | null,
): boolean {
  if (rawKeyboard == null) return true
  return !rawKeyboard.some((row) => Array.isArray(row) && row.length > 0)
}
