/**
 * Integration test for the premium-recovery ping GLUE
 * (`runPremiumRecoveryPing`, premium-recovery-wiring.ts) — the never-storm
 * orchestration the pure `decidePremiumRecovery` / `renderPremiumRecoveryPing`
 * tests do NOT cover. This is the P0 at-most-once guarantee (claim-gate → clear-
 * marker-before-send → per-chat fan-out) that was inline in the gateway and so
 * had ZERO coverage; the same untested-glue gap the tier-downgrade extraction
 * closed for the downgrade path.
 *
 * It drives the real runner with injected seams and PINS:
 *   - clear-BEFORE-send ordering (never-storm) + exactly one send per chat;
 *   - claim !granted → marker cleared, NO send;
 *   - decision.fire === false → no clear, no claim, no send;
 *   - no marker / no agent dir → no-op;
 *   - the button `callback_data` is EXACTLY `mdl:alias:<premium>` (a future edit
 *     can't silently break the session-scoped switch-back path).
 * These are outcome assertions that FAIL if the guard logic is reordered/dropped.
 */

import { describe, it, expect } from 'vitest'
import {
  runPremiumRecoveryPing,
  type PremiumRecoveryPingDeps,
  type PremiumRecoveryMarkerView,
  type PremiumRecoveryKeyboard,
} from '../gateway/premium-recovery-wiring.js'
import type { PremiumRecoveryPing } from '../premium-recovery.js'

interface Recorder {
  /** Ordered event log — pins clear-before-send. */
  events: string[]
  clears: number
  claims: string[]
  sends: Array<{ chatId: string; ping: PremiumRecoveryPing; keyboard: PremiumRecoveryKeyboard }>
  decides: number
  logs: string[]
}

function makeDeps(
  over: {
    agentDir?: string | null
    marker?: PremiumRecoveryMarkerView | null
    fire?: boolean
    granted?: boolean
    fallbackChats?: string[]
  } = {},
): { deps: PremiumRecoveryPingDeps; rec: Recorder } {
  const rec: Recorder = { events: [], clears: 0, claims: [], sends: [], decides: 0, logs: [] }
  const deps: PremiumRecoveryPingDeps = {
    getAgentDir: () => (over.agentDir === undefined ? '/tmp/agent' : over.agentDir),
    readMarker: () =>
      over.marker === undefined
        ? { premiumModel: 'fable', chats: ['111', '222'] }
        : over.marker,
    clearMarker: () => {
      rec.clears += 1
      rec.events.push('clear')
    },
    getAgent: () => 'klanker',
    decide: () => {
      rec.decides += 1
      return over.fire === undefined ? true : over.fire
    },
    claimNotification: async (key) => {
      rec.claims.push(key)
      return over.granted === undefined ? true : over.granted
    },
    fallbackChats: () => over.fallbackChats ?? ['999'],
    sendToChat: (chatId, ping, keyboard) => {
      rec.sends.push({ chatId, ping, keyboard })
      rec.events.push(`send:${chatId}`)
    },
    log: (msg) => rec.logs.push(msg),
  }
  return { deps, rec }
}

describe('runPremiumRecoveryPing — never-storm at-most-once ordering', () => {
  it('fire + granted: marker cleared BEFORE any send, exactly one send per chat', async () => {
    const { deps, rec } = makeDeps({ marker: { premiumModel: 'fable', chats: ['111', '222'] } })
    await runPremiumRecoveryPing(deps)
    expect(rec.clears).toBe(1)
    // One send per recorded chat, in order, no duplicates.
    expect(rec.sends.map((s) => s.chatId)).toEqual(['111', '222'])
    // The clear MUST precede the first send (a double-send is unrecoverable).
    const clearIdx = rec.events.indexOf('clear')
    const firstSendIdx = rec.events.findIndex((e) => e.startsWith('send:'))
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(firstSendIdx).toBeGreaterThanOrEqual(0)
    expect(clearIdx).toBeLessThan(firstSendIdx)
    // The fleet claim was keyed on agent + the dropped premium token.
    expect(rec.claims).toEqual(['premium-recovery:klanker:fable'])
    expect(rec.logs).toHaveLength(1)
  })

  it('claim NOT granted: marker cleared (no lingering re-attempt), NO send', async () => {
    const { deps, rec } = makeDeps({ granted: false })
    await runPremiumRecoveryPing(deps)
    expect(rec.claims).toEqual(['premium-recovery:klanker:fable'])
    expect(rec.clears).toBe(1)
    expect(rec.sends).toHaveLength(0)
  })

  it('decision.fire === false: NO clear, NO claim, NO send (marker survives for a later tick)', async () => {
    const { deps, rec } = makeDeps({ fire: false })
    await runPremiumRecoveryPing(deps)
    expect(rec.decides).toBe(1)
    expect(rec.clears).toBe(0)
    expect(rec.claims).toHaveLength(0)
    expect(rec.sends).toHaveLength(0)
  })

  it('no marker present: no-op — no decide, no claim, no clear, no send', async () => {
    const { deps, rec } = makeDeps({ marker: null })
    await runPremiumRecoveryPing(deps)
    expect(rec.decides).toBe(0)
    expect(rec.clears).toBe(0)
    expect(rec.claims).toHaveLength(0)
    expect(rec.sends).toHaveLength(0)
  })

  it('no agent dir: immediate no-op (marker is never even read)', async () => {
    const { deps, rec } = makeDeps({ agentDir: null })
    await runPremiumRecoveryPing(deps)
    expect(rec.decides).toBe(0)
    expect(rec.clears).toBe(0)
    expect(rec.sends).toHaveLength(0)
  })

  it('marker with no chats falls back to the access allowFrom chats', async () => {
    const { deps, rec } = makeDeps({
      marker: { premiumModel: 'fable', chats: [] },
      fallbackChats: ['999'],
    })
    await runPremiumRecoveryPing(deps)
    expect(rec.sends.map((s) => s.chatId)).toEqual(['999'])
  })
})

describe('runPremiumRecoveryPing — session-scoped switch-back button', () => {
  it('the button callback_data is EXACTLY mdl:alias:<premium> (routes the model-menu apply path)', async () => {
    const { deps, rec } = makeDeps({ marker: { premiumModel: 'fable', chats: ['111'] } })
    await runPremiumRecoveryPing(deps)
    const button = rec.sends[0].keyboard.inline_keyboard[0][0]
    // Pin the exact wire format — a change to MODEL_CALLBACK_ALIAS or the button
    // construction that broke the session-scoped `/model` apply path must fail here.
    expect(button.callback_data).toBe('mdl:alias:fable')
    expect(button.text).toBe('Switch to fable')
  })
})
