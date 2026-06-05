/**
 * Silence-poke production-liveness — heartbeat-safety guard (2026-06-05).
 *
 * The production-liveness fix resets the silence clock on observable production
 * so a long WORKING turn doesn't dark out. The load-bearing constraint: the
 * reset must fire ONLY on MODEL-driven production, NEVER from the framework
 * `feedHeartbeatTick` — a model-INDEPENDENT setInterval that re-renders a
 * climbing " · Ns" elapsed every 6s (defeating the feed's content-dedup). If the
 * reset lived in `drainActivitySummary` (which the heartbeat drains), a
 * hung-but-bridge-connected agent would have its 300s silence clock reset every
 * 6s forever, the load-bearing silence-poke unwedge would NEVER fire, and the
 * conversation would be pinned — the #1556 permanent dangling-turn wedge.
 *
 * An adversarial review panel caught exactly this in an earlier revision. These
 * are STRUCTURAL assertions (the gateway IIFE can't be instantiated in-process —
 * same pattern as multitopic-routing-wiring.test) that pin the reset to the
 * model-driven sites so a refactor can't silently reintroduce the regression.
 * The behavioural counterpart (noteProduction resets; STOP producing → fires)
 * lives in silence-poke.test.ts; this guards the WIRING the heartbeat must not
 * cross.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')

function between(src: string, startMarker: string, endMarker: string): string {
  const after = src.split(startMarker)[1] ?? ''
  return after.split(endMarker)[0] ?? ''
}

describe('silence-poke production-liveness — heartbeat safety', () => {
  it('drainActivitySummary must NOT reset the silence clock (the framework heartbeat drains here)', () => {
    const body = between(gatewaySrc, 'async function drainActivitySummary', '\nfunction feedHeartbeatTick')
    expect(body.length).toBeGreaterThan(100) // sanity: the slice found the function body
    expect(body).not.toMatch(/noteProduction/)
  })

  it('feedHeartbeatTick itself must NOT reset the silence clock (model-independent re-render)', () => {
    const body = between(gatewaySrc, 'function feedHeartbeatTick(): void {', '\n}')
    expect(body.length).toBeGreaterThan(50)
    expect(body).not.toMatch(/noteProduction/)
  })

  it('the MODEL-driven tool-label append IS the reset site, gated on the live turn', () => {
    // appendActivityLabel returns a fresh render only when the model emits a NEW
    // labelled step — the genuine liveness signal the heartbeat can never forge.
    const block = between(
      gatewaySrc,
      'const rendered = appendActivityLabel(turn.mirrorLines, ev.label)',
      '\n      return',
    )
    expect(block).toMatch(/silencePoke\.noteProduction/)
    expect(block).toMatch(/currentTurn === turn/)
  })

  it('the answer-stream draft onMetric reset is model-driven and gated on the live turn', () => {
    const block = between(gatewaySrc, 'onMetric: (metricEv) => {', '\n            },')
    expect(block).toMatch(/silencePoke\.noteProduction/)
    expect(block).toMatch(/currentTurn === turn/)
  })

  it('production-liveness is behind the default-ON SWITCHROOM_SILENCE_LIVENESS_PRODUCTION kill switch', () => {
    expect(gatewaySrc).toMatch(/SWITCHROOM_SILENCE_LIVENESS_PRODUCTION !== '0'/)
  })
})
