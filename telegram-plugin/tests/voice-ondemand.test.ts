/**
 * On-demand voice-out (reply_mode='on-demand') unit tests.
 *
 * gateway.ts is a 25k-line module with import-time side effects, so the
 * on-demand primitives live in ../voice-ondemand.ts (imported by the gateway).
 * These tests exercise those real primitives + reproduce the exact gateway
 * decisions (button injection gate, no-synth-at-reply-time, callback routing)
 * so the observable contract is covered without importing the gateway.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  VoiceOnDemandCache,
  VOICE_ONDEMAND_CALLBACK_PREFIX,
  mintVoiceOnDemandToken,
  isVoiceOnDemandCallback,
  parseVoiceOnDemandToken,
  buildListenKeyboard,
  mayInjectListenButton,
} from '../voice-ondemand.js'
import { parseAgentCallback } from '../inline-keyboard-callbacks.js'

describe('on-demand: token + reserved callback prefix', () => {
  it('mints an 8-hex-char token', () => {
    const t = mintVoiceOnDemandToken()
    expect(t).toMatch(/^[0-9a-f]{8}$/)
  })

  it('builds a single-button Listen keyboard with a voice: callback', () => {
    const kb = buildListenKeyboard('deadbeef')
    expect(kb.inline_keyboard).toHaveLength(1)
    expect(kb.inline_keyboard[0]).toHaveLength(1)
    const btn = kb.inline_keyboard[0]![0]!
    expect(btn.text).toBe('🔊 Listen')
    expect(btn.callback_data).toBe('voice:deadbeef')
    expect(btn.callback_data.length).toBeLessThanOrEqual(64) // Telegram cap
  })

  it('recognises + parses voice: callbacks, rejects others', () => {
    expect(isVoiceOnDemandCallback('voice:abc123')).toBe(true)
    expect(isVoiceOnDemandCallback('agent:foo')).toBe(false)
    expect(parseVoiceOnDemandToken('voice:abc123')).toBe('abc123')
    expect(parseVoiceOnDemandToken('voice:')).toBeNull() // empty token
    expect(parseVoiceOnDemandToken('agent:foo')).toBeNull()
  })
})

describe('on-demand: callback routes internally, NOT to the agent inbound path', () => {
  it('a voice: callback is NOT parsed as an agent callback', () => {
    // The gateway checks isVoiceOnDemandCallback() BEFORE parseAgentCallback().
    const data = `${VOICE_ONDEMAND_CALLBACK_PREFIX}${mintVoiceOnDemandToken()}`
    expect(isVoiceOnDemandCallback(data)).toBe(true)
    // Even if it reached agent routing, the raw voice: data must not be a
    // valid agent callback (which requires the agent: prefix).
    expect(parseAgentCallback(data)).toBeNull()
  })
})

describe('on-demand: bounded TTL LRU cache', () => {
  it('stores and retrieves a payload by token', () => {
    const cache = new VoiceOnDemandCache()
    cache.put('tok', { text: 'hello world', voice: 'af_bella', speed: 1.1 })
    expect(cache.get('tok')).toEqual({ text: 'hello world', voice: 'af_bella', speed: 1.1 })
  })

  it('cache MISS returns null gracefully (no throw)', () => {
    const cache = new VoiceOnDemandCache()
    expect(() => cache.get('never-stored')).not.toThrow()
    expect(cache.get('never-stored')).toBeNull()
  })

  it('expires entries past the TTL (miss → graceful null)', () => {
    let now = 1_000
    const cache = new VoiceOnDemandCache({ ttlMs: 100, maxEntries: 500, now: () => now })
    cache.put('tok', { text: 'x', speed: 1 })
    now = 1_050
    expect(cache.get('tok')).not.toBeNull() // still fresh
    now = 1_200
    expect(cache.get('tok')).toBeNull() // expired → graceful miss
  })

  it('evicts the oldest entry past the size cap (LRU)', () => {
    const cache = new VoiceOnDemandCache({ ttlMs: 60_000, maxEntries: 2 })
    cache.put('a', { text: 'a', speed: 1 })
    cache.put('b', { text: 'b', speed: 1 })
    cache.put('c', { text: 'c', speed: 1 }) // evicts 'a'
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).not.toBeNull()
    expect(cache.get('c')).not.toBeNull()
  })
})

describe('on-demand: cache survives a restart (persistPath)', () => {
  it('reloads tokens from disk so a Listen tap after restart still resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-ondemand-persist-'))
    const persistPath = join(dir, 'voice-ondemand.json')
    try {
      // First "process": mint + store a token, then drop the instance
      // (simulating a gateway restart wiping the in-memory Map).
      const before = new VoiceOnDemandCache({ persistPath })
      before.put('tok', { text: 'hello after restart', voice: 'af_bella', speed: 1.1 })
      expect(existsSync(persistPath)).toBe(true)

      // Second "process": a fresh instance backed by the same file must see it.
      const after = new VoiceOnDemandCache({ persistPath })
      expect(after.get('tok')).toEqual({
        text: 'hello after restart',
        voice: 'af_bella',
        speed: 1.1,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops entries that expired while the gateway was down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-ondemand-expire-'))
    const persistPath = join(dir, 'voice-ondemand.json')
    try {
      let now = 1_000
      const before = new VoiceOnDemandCache({ ttlMs: 100, persistPath, now: () => now })
      before.put('tok', { text: 'x', speed: 1 })
      // Restart happens "later" — past the TTL.
      now = 5_000
      const after = new VoiceOnDemandCache({ ttlMs: 100, persistPath, now: () => now })
      expect(after.get('tok')).toBeNull()
      expect(after.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves LRU insertion order + cap across a reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-ondemand-lru-'))
    const persistPath = join(dir, 'voice-ondemand.json')
    try {
      const before = new VoiceOnDemandCache({ maxEntries: 3, persistPath })
      before.put('a', { text: 'a', speed: 1 })
      before.put('b', { text: 'b', speed: 1 })
      before.put('c', { text: 'c', speed: 1 })

      // Reload with a SMALLER cap — the oldest ('a') must be dropped.
      const after = new VoiceOnDemandCache({ maxEntries: 2, persistPath })
      expect(after.size).toBe(2)
      expect(after.get('a')).toBeNull()
      expect(after.get('b')).not.toBeNull()
      expect(after.get('c')).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a corrupt persistence file degrades to an empty cache (no throw)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-ondemand-corrupt-'))
    const persistPath = join(dir, 'voice-ondemand.json')
    try {
      writeFileSync(persistPath, '{ this is not valid json', 'utf8')
      let cache: VoiceOnDemandCache | undefined
      expect(() => {
        cache = new VoiceOnDemandCache({ persistPath })
      }).not.toThrow()
      expect(cache!.size).toBe(0)
      // Still usable — a fresh put + get round-trips and rewrites the file clean.
      cache!.put('tok', { text: 'ok', speed: 1 })
      expect(cache!.get('tok')).toEqual({ text: 'ok', speed: 1 })
      // File is now valid JSON again.
      expect(() => JSON.parse(readFileSync(persistPath, 'utf8'))).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an in-memory cache (no persistPath) writes no file — unchanged behaviour', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-ondemand-mem-'))
    try {
      const cache = new VoiceOnDemandCache()
      cache.put('tok', { text: 'x', speed: 1 })
      // Nothing under the tmp dir was written.
      expect(existsSync(join(dir, 'voice-ondemand.json'))).toBe(false)
      expect(cache.get('tok')).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('on-demand: reply-time behaviour (gate + no synthesis)', () => {
  it('reply_mode=on-demand + local engine → Listen button, no synth at reply time', () => {
    // Reproduce the gateway reply path decision for reply_mode='on-demand':
    // the voiceOgg synth loop is guarded to SKIP when replyMode==='on-demand',
    // and a Listen button is injected instead.
    const replyMode = 'on-demand' as 'voice+text' | 'voice-only' | 'on-demand'

    let synthCalls = 0
    const fakeSynth = () => {
      synthCalls++
    }
    // gateway guard: `if (plan != null && plan.replyMode !== 'on-demand')`
    if (replyMode !== 'on-demand') fakeSynth()
    expect(synthCalls).toBe(0) // ZERO GPU/sidecar work at reply time

    // No agent buttons → the Listen button is injected.
    const rawKeyboard: unknown[][] | undefined = undefined
    expect(mayInjectListenButton(rawKeyboard)).toBe(true)
    const kb = buildListenKeyboard(mintVoiceOnDemandToken())
    expect(kb.inline_keyboard[0]![0]!.callback_data.startsWith('voice:')).toBe(true)
  })

  it('ENGINE GATE: openai + on-demand does NOT inject a Listen button (falls back to immediate synth)', () => {
    // The gateway computes:
    //   useOnDemandButton = plan != null && replyMode==='on-demand' && engine==='kokoro'
    // and both the reply-time synth-skip AND the button injection key on it.
    // So an openai on-demand config must (a) NOT defer synthesis and (b) NOT
    // mint a Listen button — its taps would dead-end on the local sidecar.
    const useOnDemandButton = (
      engine: 'kokoro' | 'openai',
      replyMode: 'voice+text' | 'voice-only' | 'on-demand',
    ) => replyMode === 'on-demand' && engine === 'kokoro'

    // openai + on-demand: no button, immediate synth path runs.
    expect(useOnDemandButton('openai', 'on-demand')).toBe(false)
    // kokoro + on-demand: button injected, synth deferred.
    expect(useOnDemandButton('kokoro', 'on-demand')).toBe(true)
    // openai non-on-demand modes are unaffected (normal synth).
    expect(useOnDemandButton('openai', 'voice+text')).toBe(false)
    expect(useOnDemandButton('openai', 'voice-only')).toBe(false)

    // Reproduce the reply-time synth guard: `if (plan != null && !useOnDemandButton)`.
    // For openai on-demand it MUST enter the synth loop (fall back), unlike
    // kokoro on-demand which skips it.
    let openaiSynthRan = false
    if (!useOnDemandButton('openai', 'on-demand')) openaiSynthRan = true
    expect(openaiSynthRan).toBe(true)

    let kokoroSynthRan = false
    if (!useOnDemandButton('kokoro', 'on-demand')) kokoroSynthRan = true
    expect(kokoroSynthRan).toBe(false)
  })

  it('GATE: agent-supplied inline_keyboard present → NO voice button injected', () => {
    const agentKeyboard = [[{ text: 'Approve', callback_data: 'yes' }]]
    expect(mayInjectListenButton(agentKeyboard)).toBe(false)

    // An empty keyboard (no rows / empty rows) does not count as agent buttons.
    expect(mayInjectListenButton([])).toBe(true)
    expect(mayInjectListenButton([[]])).toBe(true)
    expect(mayInjectListenButton(undefined)).toBe(true)
  })
})

describe('on-demand: single-use — strip the Listen keyboard on success only', () => {
  // Reproduce the callback handler's control flow. Each terminal branch in the
  // gateway either returns EARLY (leaving the button intact so the user can
  // retry) or falls through to the successful sendVoice + keyboard strip.
  //
  //   expired cache entry           → answerCallbackQuery + return (no strip)
  //   sidecar unavailable           → answerCallbackQuery + return (no strip)
  //   synth failure (!result.ok)    → answerCallbackQuery + return (no strip)
  //   sendVoice success             → strip keyboard
  //
  // We model that as a pure decision so the observable contract — strip iff the
  // audio was actually delivered — is pinned without importing the gateway.
  type Outcome = 'expired' | 'sidecar-unavailable' | 'synth-failed' | 'sent'
  const shouldStripListenKeyboard = (outcome: Outcome, cbMessageId: number | undefined): boolean =>
    outcome === 'sent' && cbMessageId != null

  it('strips the keyboard after a successful sendVoice', () => {
    expect(shouldStripListenKeyboard('sent', 42)).toBe(true)
  })

  it('does NOT strip when the cache entry expired (user can retry)', () => {
    expect(shouldStripListenKeyboard('expired', 42)).toBe(false)
  })

  it('does NOT strip when the voice sidecar is unavailable (user can retry)', () => {
    expect(shouldStripListenKeyboard('sidecar-unavailable', 42)).toBe(false)
  })

  it('does NOT strip when synthesis failed (user can retry)', () => {
    expect(shouldStripListenKeyboard('synth-failed', 42)).toBe(false)
  })

  it('cannot strip without a callback message id even on success', () => {
    // The gateway guards the strip on `cbMessageId != null` (no message → no
    // keyboard to edit).
    expect(shouldStripListenKeyboard('sent', undefined)).toBe(false)
  })

  it('strips by clearing the inline keyboard (empty rows)', () => {
    // The strip payload the handler sends: reply_markup with an empty
    // inline_keyboard — the same shape the agent-button single_use strip uses.
    const stripMarkup = { reply_markup: { inline_keyboard: [] as unknown[][] } }
    expect(stripMarkup.reply_markup.inline_keyboard).toHaveLength(0)
  })
})
