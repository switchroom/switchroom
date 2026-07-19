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
// #2996 P4-A: the model-driven reset sites (tool_label append, answer-stream
// onMetric) live inside handleSessionEvent, which moved VERBATIM to
// stream-render.ts. There the live-turn guard reads the injected accessor
// (`getCurrentTurn() === turn`) rather than the `currentTurn` module global.
const streamSrc = readFileSync(resolve(__dirname, '..', 'gateway', 'stream-render.ts'), 'utf-8')
// #2996 P4-B: drainActivitySummary / feedHeartbeatTick moved VERBATIM into
// narrative-lane.ts (factory scope, bodies indented +2; gateway keeps thin
// same-name wrappers) — the heartbeat-safety windows read the module source.
const laneSrc = readFileSync(resolve(__dirname, '..', 'gateway', 'narrative-lane.ts'), 'utf-8')

function between(src: string, startMarker: string, endMarker: string): string {
  const after = src.split(startMarker)[1] ?? ''
  return after.split(endMarker)[0] ?? ''
}

describe('silence-poke production-liveness — heartbeat safety', () => {
  it('drainActivitySummary must NOT reset the silence clock (the framework heartbeat drains here)', () => {
    const body = between(laneSrc, 'async function drainActivitySummary', '\n  function feedHeartbeatTick')
    expect(body.length).toBeGreaterThan(100) // sanity: the slice found the function body
    expect(body).not.toMatch(/noteProduction/)
  })

  it('feedHeartbeatTick itself must NOT reset the silence clock (model-independent re-render)', () => {
    const body = between(laneSrc, 'function feedHeartbeatTick(): void {', '\n  }')
    expect(body.length).toBeGreaterThan(50)
    expect(body).not.toMatch(/noteProduction/)
  })

  it('the MODEL-driven tool-label append IS the reset site, gated on the live turn', () => {
    // appendActivityLabel returns a fresh render only when the model emits a NEW
    // labelled step — the genuine liveness signal the heartbeat can never forge.
    const block = between(
      streamSrc,
      'const rendered = appendActivityLabel(turn.mirrorLines, ev.label)',
      '\n      return',
    )
    expect(block).toMatch(/silencePoke\.noteProduction/)
    expect(block).toMatch(/getCurrentTurn\(\) === turn/)
  })

  it('the answer-stream draft onMetric reset is model-driven and gated on the live turn', () => {
    const block = between(streamSrc, 'onMetric: (metricEv) => {', '\n            },')
    expect(block).toMatch(/silencePoke\.noteProduction/)
    expect(block).toMatch(/getCurrentTurn\(\) === turn/)
  })

  it('production-liveness is behind the default-ON SWITCHROOM_SILENCE_LIVENESS_PRODUCTION kill switch', () => {
    expect(gatewaySrc).toMatch(/SWITCHROOM_SILENCE_LIVENESS_PRODUCTION !== '0'/)
  })

  it('the 300s fallback send gates disable_notification on blockedOnApproval (approval re-ping pings, liveness stays silent)', () => {
    // The 300s fallback is normally a pure-liveness "still working…" status
    // notice and stays SILENT. But the SAME send carries a user-gating re-ping
    // ("waiting for your approval — tap Approve or Deny …") when the turn is
    // parked on an approval card — that must PING. The send site must therefore
    // gate disable_notification on blockedOnApproval, NOT hard-code `true`.
    // Structural guard so a refactor can't silently re-silence the re-ping
    // (the gateway IIFE can't be instantiated in-process — same pattern as the
    // heartbeat-safety assertions above).
    // #2996 P8 PR-C3: the fallback body moved verbatim to liveness-wiring.ts;
    // the send itself is the injected `sendSilenceText(chat, thread, text,
    // silent)` closure (gateway keeps the bot-api touch), so the gate now
    // rides the closure's `silent` argument at the callsite.
    const livenessSrc = readFileSync(resolve(__dirname, '..', 'gateway', 'liveness-wiring.ts'), 'utf-8')
    const block = between(livenessSrc, 'onFrameworkFallback: async (ctx) => {', '\n  }\n}')
    expect(block.length).toBeGreaterThan(100) // sanity: slice found the handler body
    // The signal is derived once, hoisted above the update-status branch so it's
    // in scope at the send site.
    expect(block).toMatch(/const blockedOnApproval = activeStatusReactions/)
    // The send gates on it rather than hard-coding silent.
    expect(block).toMatch(/sendSilenceText\(ctx\.chatId, ctx\.threadId \?\? null, text, blockedOnApproval \? false : true\)/)
  })
})
