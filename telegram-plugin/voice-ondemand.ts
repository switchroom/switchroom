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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** Reserved callback_data prefix for on-demand Listen buttons. Handled
 *  INTERNALLY by the gateway's callback dispatcher (never routed to the agent
 *  as an inbound), so it must NOT overlap the agent: / auth: / op: families. */
export const VOICE_ONDEMAND_CALLBACK_PREFIX = 'voice:'

/** Cache entry TTL. A button tapped after this degrades to an "expired" toast
 *  rather than pinning reply text in memory forever.
 *
 *  7 days since #2763 (was 1h): eager pre-synthesis keeps the spoken file on
 *  disk for 7 days, and the acceptance bar is "tapping Listen on any message
 *  <7 days old plays instantly" — which needs the ENTRY alive that long too
 *  (the lazy fallback also reads it). Memory stays bounded by
 *  VOICE_ONDEMAND_MAX_ENTRIES; the entry is a few hundred bytes of text. */
export const VOICE_ONDEMAND_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Bounded cache size; oldest entries are evicted past this. */
export const VOICE_ONDEMAND_MAX_ENTRIES = 500

export type VoiceOnDemandPayload = {
  /** Speech-normalized text to synthesize (normalizeForSpeech(reply)). */
  text: string
  /** Optional engine-specific voice id. */
  voice?: string
  /** Resolved + clamped playback speed. */
  speed: number
  /** Absolute path of the eagerly pre-synthesized audio file (#2763), set by
   *  the pre-synth queue after a successful background synth. Absent on
   *  pre-feature entries, on kill-switched gateways, and until the job runs. */
  filePath?: string
  /** Telegram's reusable file_id for the audio, captured from the FIRST
   *  successful `sendVoice` for this entry. On subsequent taps the gateway
   *  sends BY this id (a plain string, not an InputFile) so Telegram serves
   *  the already-uploaded bytes — no disk read, no re-upload round-trip, so
   *  the voice note arrives near-instantly. Absent until the first send;
   *  refreshed if a stale id is rejected and the audio is re-uploaded. It
   *  lives on the entry, so the 7-day sweep's `prune()` drops it together
   *  with the entry — a dead id is never resurrected. */
  telegramFileId?: string
  /** Epoch ms the entry was stored (put time) — recorded alongside filePath
   *  per #2763 so the sweep/introspection can reason about entry age. */
  createdAt?: number
}

type StoredEntry = VoiceOnDemandPayload & { expiresAt: number }

/** On-disk shape of the persisted cache: a versioned envelope around the
 *  token→entry map. Versioned so a future schema change can be detected and
 *  discarded rather than mis-parsed. */
type PersistedCache = {
  version: 1
  entries: Record<string, StoredEntry>
}

/**
 * Options for {@link VoiceOnDemandCache}. `persistPath`, when set, backs the
 * cache with a JSON file so Listen tokens survive a gateway restart — a button
 * tapped after a restart still synthesizes instead of degrading to "Voice
 * expired". Omit it (the default) for a pure in-memory cache.
 */
export type VoiceOnDemandCacheOptions = {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
  /** Absolute path to the JSON persistence file (e.g. under TELEGRAM_STATE_DIR,
   *  which lives on a volume that survives container recreation). When set, the
   *  cache loads existing (non-expired) entries on construction and rewrites the
   *  file on every mutation. */
  persistPath?: string
}

/**
 * Bounded, TTL'd LRU cache from Listen token → synthesis payload. Keyed by
 * token (not message_id) because the message_id isn't known when the button
 * is sent. A Map preserves insertion order, so the first key is the oldest.
 *
 * Optionally durable: pass `persistPath` to back the store with a JSON file so
 * tokens survive a gateway restart. Persistence uses a synchronous
 * write-to-temp + atomic rename on each mutation — the store is small (≤
 * maxEntries) and writes are infrequent (one per reply that offers a Listen
 * button), so the cost is negligible and the module stays dependency-free.
 * Any load/write error is swallowed (logged to stderr): a broken persistence
 * file must never take the gateway down — the cache simply degrades to the old
 * in-memory behaviour.
 */
export class VoiceOnDemandCache {
  private readonly store = new Map<string, StoredEntry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly persistPath: string | undefined

  constructor(options: VoiceOnDemandCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? VOICE_ONDEMAND_TTL_MS
    this.maxEntries = options.maxEntries ?? VOICE_ONDEMAND_MAX_ENTRIES
    this.now = options.now ?? Date.now
    this.persistPath = options.persistPath
    if (this.persistPath !== undefined) this.load()
  }

  /** Store a payload under `token`, evicting the oldest entries past the cap. */
  put(token: string, payload: VoiceOnDemandPayload): void {
    // Re-insert to move an existing key to the newest (most-recent) position.
    this.store.delete(token)
    this.store.set(token, {
      createdAt: this.now(),
      ...payload,
      expiresAt: this.now() + this.ttlMs,
    })
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
    this.flush()
  }

  /** Look up a payload; returns null on miss or expiry (and evicts expired). */
  get(token: string): VoiceOnDemandPayload | null {
    const entry = this.store.get(token)
    if (entry == null) return null
    if (entry.expiresAt <= this.now()) {
      this.store.delete(token)
      this.flush()
      return null
    }
    const { text, voice, speed, filePath, telegramFileId } = entry
    // createdAt stays internal (persisted for sweep/introspection) so the
    // returned shape only grows when a pre-synth file actually exists —
    // pre-#2763 callers and tests see the exact old payload.
    return {
      text,
      speed,
      ...(voice !== undefined ? { voice } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(telegramFileId !== undefined ? { telegramFileId } : {}),
    }
  }

  /** Record the pre-synthesized audio file path on an existing entry (#2763).
   *  No-op if the entry has expired or been evicted meanwhile (the file will
   *  simply age out via the sweep). Does NOT bump LRU position or TTL — the
   *  entry's lifetime is anchored at put time. */
  setFilePath(token: string, filePath: string): void {
    const entry = this.store.get(token)
    if (entry == null || entry.expiresAt <= this.now()) return
    entry.filePath = filePath
    this.flush()
  }

  /** Record (or refresh) Telegram's reusable file_id on an existing entry,
   *  captured from a successful `sendVoice`. Mirrors {@link setFilePath}: no-op
   *  if the entry has expired or been evicted meanwhile, and does NOT bump LRU
   *  position or TTL — the entry's lifetime stays anchored at put time so a
   *  captured id can never resurrect a dying entry. Passing an empty string is
   *  ignored (nothing to store). */
  setTelegramFileId(token: string, fileId: string): void {
    if (fileId.length === 0) return
    const entry = this.store.get(token)
    if (entry == null || entry.expiresAt <= this.now()) return
    entry.telegramFileId = fileId
    this.flush()
  }

  /** Drop entries whose pre-synth files the sweep deleted (#2763). Unknown
   *  tokens are ignored (file may belong to an already-evicted entry). */
  prune(tokens: Iterable<string>): void {
    let changed = false
    for (const token of tokens) {
      if (this.store.delete(token)) changed = true
    }
    if (changed) this.flush()
  }

  /** Current entry count (test/introspection aid). */
  get size(): number {
    return this.store.size
  }

  /** Load persisted entries, dropping any already expired. Best-effort: a
   *  missing or corrupt file leaves the cache empty (fresh-start). */
  private load(): void {
    if (this.persistPath === undefined) return
    let raw: string
    try {
      raw = readFileSync(this.persistPath, 'utf8')
    } catch {
      // No file yet (first boot) — nothing to load.
      return
    }
    try {
      const parsed = JSON.parse(raw) as PersistedCache
      if (parsed == null || parsed.version !== 1 || typeof parsed.entries !== 'object') return
      const nowMs = this.now()
      // Object.entries preserves insertion order for string keys, which is the
      // insertion order we wrote — so LRU ordering survives the round-trip.
      for (const [token, entry] of Object.entries(parsed.entries)) {
        if (
          entry == null ||
          typeof entry.expiresAt !== 'number' ||
          typeof entry.text !== 'string' ||
          typeof entry.speed !== 'number'
        ) {
          continue
        }
        if (entry.expiresAt <= nowMs) continue // already expired — drop
        this.store.set(token, entry)
      }
      // Honour the cap in case the file predates a smaller maxEntries.
      while (this.store.size > this.maxEntries) {
        const oldest = this.store.keys().next().value
        if (oldest === undefined) break
        this.store.delete(oldest)
      }
    } catch (err) {
      process.stderr.write(
        `voice-ondemand: failed to parse persisted cache ${this.persistPath}: ${String(err)}\n`,
      )
    }
  }

  /** Write the current store to disk atomically. No-op when not persisting. */
  private flush(): void {
    if (this.persistPath === undefined) return
    const doc: PersistedCache = {
      version: 1,
      entries: Object.fromEntries(this.store),
    }
    const tmp = `${this.persistPath}.tmp`
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(tmp, JSON.stringify(doc), 'utf8')
      renameSync(tmp, this.persistPath)
    } catch (err) {
      process.stderr.write(
        `voice-ondemand: failed to persist cache ${this.persistPath}: ${String(err)}\n`,
      )
    }
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

/** Build the single-row Listen keyboard for a token. Effectively single-use:
 *  the callback handler strips this keyboard after a SUCCESSFUL synth+send, so
 *  a delivered voice note can't be re-tapped. On expiry / synth-failure /
 *  sidecar-unavailable the button is left intact so the user can retry. */
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
 * governs the WHOLE message's keyboard, keyed off the agent-button metadata.
 * The Listen button strips its own keyboard independently (on successful
 * send, in the voice-on-demand callback handler) and carries no agent-button
 * meta; mixing it alongside agent buttons would put two independent strip
 * regimes on one message and could defeat the agent's double-fire protection.
 * So if the agent supplied any button, we skip the Listen button for this
 * message.
 */
export function mayInjectListenButton(
  rawKeyboard: unknown[][] | undefined | null,
): boolean {
  if (rawKeyboard == null) return true
  return !rawKeyboard.some((row) => Array.isArray(row) && row.length > 0)
}
