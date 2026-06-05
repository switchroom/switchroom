/**
 * Draft-answer-lane retirement — gateway wiring guards (2026-06-05).
 *
 * The retirement switches the live answer lane from the invisible compose-box
 * draft to a real, mtcute-observable edit-in-place message, default-on. The
 * design review flagged two ways this silently breaks (gateway IIFE can't be
 * instantiated in-process, so these are source-level assertions, same pattern as
 * silence-liveness-wiring.test):
 *
 *  PRIMARY: drop sendMessageDraftFn but FORGET to flip minInitialChars to 1 →
 *  the lane becomes a total no-op (the MAX gate never opens it), losing ALL
 *  answer-lane status AND the #2169 onMetric silence-liveness reset.
 *  SECONDARY: flip the lane to visible but FORGET to broaden the
 *  materialize-as-answer guard → a text-only no-reply turn falls into retract()
 *  and deletes the user's only copy of the answer (a lost-answer bug).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')

describe('draft-retirement wiring', () => {
  it('sendMessageDraftFn is gated on the retirement (the single chokepoint)', () => {
    expect(gatewaySrc).toMatch(/!DRAFT_ANSWER_LANE_RETIRED && typeof _rawSendMessageDraft === 'function'/)
  })

  it('DRAFT_ANSWER_LANE_RETIRED is declared before its first use (no TDZ at boot)', () => {
    const declIdx = gatewaySrc.indexOf('const DRAFT_ANSWER_LANE_RETIRED =')
    const firstUseIdx = gatewaySrc.indexOf('!DRAFT_ANSWER_LANE_RETIRED && typeof _rawSendMessageDraft')
    expect(declIdx).toBeGreaterThan(0)
    expect(firstUseIdx).toBeGreaterThan(declIdx)
  })

  it('PRIMARY GUARD: retired lane uses minInitialChars:1 (visible), never the MAX no-op gate', () => {
    // The config must pick the {minInitialChars:1} branch when retired, so the
    // lane actually opens a real message. The MAX branch is draft-only (legacy).
    expect(gatewaySrc).toMatch(/ANSWER_STREAM_VISIBLE_ENABLED \|\| DRAFT_ANSWER_LANE_RETIRED\s*\n?\s*\?\s*\{ minInitialChars: 1 \}/)
  })

  it('SECONDARY GUARD: the materialize-as-answer guard is broadened in lockstep', () => {
    // A text-only no-reply turn must materialize (ping + delete preview), not
    // retract() the answer away.
    expect(gatewaySrc).toMatch(/\(ANSWER_STREAM_VISIBLE_ENABLED \|\| DRAFT_ANSWER_LANE_RETIRED\)\s*\n?\s*&& !turn\.replyCalled/)
  })

  it('the #2169 onMetric silence-liveness reset is preserved (fires on visible sends now)', () => {
    const onMetric = (gatewaySrc.split('onMetric: (metricEv) => {')[1] ?? '').split('\n            },')[0]
    expect(onMetric).toMatch(/silencePoke\.noteProduction/)
    expect(onMetric).toMatch(/currentTurn === turn/)
  })
})
