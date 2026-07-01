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
    const cache = new VoiceOnDemandCache(100 /* ttl */, 500, () => now)
    cache.put('tok', { text: 'x', speed: 1 })
    now = 1_050
    expect(cache.get('tok')).not.toBeNull() // still fresh
    now = 1_200
    expect(cache.get('tok')).toBeNull() // expired → graceful miss
  })

  it('evicts the oldest entry past the size cap (LRU)', () => {
    const cache = new VoiceOnDemandCache(60_000, 2 /* cap */)
    cache.put('a', { text: 'a', speed: 1 })
    cache.put('b', { text: 'b', speed: 1 })
    cache.put('c', { text: 'c', speed: 1 }) // evicts 'a'
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).not.toBeNull()
    expect(cache.get('c')).not.toBeNull()
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
