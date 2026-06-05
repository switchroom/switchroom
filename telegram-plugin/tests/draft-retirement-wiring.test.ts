/**
 * Answer-lane wiring guards — draft retirement + flash decoupling.
 *
 * History:
 *  - v0.14.52 turned the VISIBLE answer-stream OFF by default to remove the
 *    "raw preview appears, formatted reply lands, raw preview deleted" flash.
 *  - v0.14.68 retired the invisible compose-box DRAFT transport. The original
 *    wiring (and the first version of this test) conflated the two flags —
 *    `ANSWER_STREAM_VISIBLE_ENABLED || DRAFT_ANSWER_LANE_RETIRED` — so retiring
 *    the draft (default) silently forced a VISIBLE preview (minInitialChars:1)
 *    even with the visible flag off, re-introducing the flash FLEET-WIDE
 *    (v0.14.68 undid v0.14.52). The first revision of this file pinned that
 *    conflation as a "guard" — i.e. it asserted the bug.
 *  - 2026-06-05 flash-decouple: the VISIBLE preview now gates on the visible
 *    flag ALONE; DRAFT_ANSWER_LANE_RETIRED controls only the TRANSPORT. With
 *    defaults (visible off, draft retired) the lane is DORMANT — no preview, the
 *    reply tool is the single formatted message, no flash. The no-reply text-only
 *    answer is delivered by the turn-flush backstop (the pre-v0.14.68 path).
 *
 * gateway IIFE can't be instantiated in-process, so these are source-level
 * assertions (same pattern as silence-liveness-wiring.test).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')

describe('answer-lane wiring (draft retirement + flash decoupling)', () => {
  it('sendMessageDraftFn is gated on the retirement (the single transport chokepoint)', () => {
    expect(gatewaySrc).toMatch(/!DRAFT_ANSWER_LANE_RETIRED && typeof _rawSendMessageDraft === 'function'/)
  })

  it('DRAFT_ANSWER_LANE_RETIRED is declared before its first use (no TDZ at boot)', () => {
    const declIdx = gatewaySrc.indexOf('const DRAFT_ANSWER_LANE_RETIRED =')
    const firstUseIdx = gatewaySrc.indexOf('!DRAFT_ANSWER_LANE_RETIRED && typeof _rawSendMessageDraft')
    expect(declIdx).toBeGreaterThan(0)
    expect(firstUseIdx).toBeGreaterThan(declIdx)
  })

  it('FLASH GUARD: the VISIBLE preview gates on the visible flag ALONE, never on the draft-retired flag', () => {
    // The minInitialChars:1 (visible-preview) branch must be selected by
    // ANSWER_STREAM_VISIBLE_ENABLED only. Conflating it with the retired-draft
    // default is what re-opened the flash fleet-wide.
    expect(gatewaySrc).toMatch(/\.\.\.\(ANSWER_STREAM_VISIBLE_ENABLED\s*\n?\s*\?\s*\{ minInitialChars: 1 \}/)
  })

  it('FLASH GUARD: the visible-OR-retired conflation is GONE everywhere (it pinned the flash)', () => {
    // No answer-lane path may re-introduce `VISIBLE || RETIRED` — that is the
    // exact regression this fix removes. Asserted globally so neither the config
    // branch nor the materialize-as-answer guard can quietly bring it back.
    expect(gatewaySrc).not.toMatch(/ANSWER_STREAM_VISIBLE_ENABLED \|\| DRAFT_ANSWER_LANE_RETIRED/)
  })

  it('LOST-ANSWER GUARD: materialize-as-answer gates on the visible flag alone (only fires when a preview actually opened)', () => {
    // A text-only no-reply turn materializes (ping + keep) ONLY when a visible
    // preview opened (visible flag on). With visible off the lane never opens
    // (minInitialChars:MAX) so this branch is unreachable and the answer is
    // delivered by turn-flush instead — never retracted away.
    expect(gatewaySrc).toMatch(/\n\s*ANSWER_STREAM_VISIBLE_ENABLED\s*\n\s*&& !turn\.replyCalled/)
  })

  it('LOST-ANSWER GUARD: turn-flush is skipped ONLY when the stream finalized as the answer (so dormant-lane no-reply turns still flush)', () => {
    // flushDecision skips only on streamFinalizedAsAnswer; with the lane dormant
    // that stays false, so decideTurnFlush runs and delivers the no-reply answer.
    expect(gatewaySrc).toMatch(/const flushDecision = streamFinalizedAsAnswer\s*\n?\s*\?/)
  })

  it('the #2169 onMetric silence-liveness reset is still wired (fires on visible sends when opted in)', () => {
    const onMetric = (gatewaySrc.split('onMetric: (metricEv) => {')[1] ?? '').split('\n            },')[0]
    expect(onMetric).toMatch(/silencePoke\.noteProduction/)
    expect(onMetric).toMatch(/currentTurn === turn/)
  })
})
