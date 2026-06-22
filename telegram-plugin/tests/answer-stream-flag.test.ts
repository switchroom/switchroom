/**
 * Pin the SWITCHROOM_VISIBLE_ANSWER_STREAM contract: default OFF (2026-06-03),
 * opt-in only on a truthy value. Guards against an accidental flip back to
 * default-on (which would reintroduce the unformatted-preliminary flash +
 * delete-on-every-reply — see the gateway gate comment).
 *
 * The draft transport (sendMessageDraft) is permanently retired — the lane is
 * now either VISIBLE (opt-in) or DORMANT (the unconditional default). The
 * resolveAnswerLaneConfig 2-state enumeration is the regression guard.
 */

import { describe, it, expect } from 'vitest'
import { parseVisibleAnswerStreamEnabled, resolveAnswerLaneConfig } from '../answer-stream-flag.js'

describe('parseVisibleAnswerStreamEnabled — default OFF, opt-in', () => {
  it('defaults OFF when unset', () => {
    expect(parseVisibleAnswerStreamEnabled(undefined)).toBe(false)
  })

  it('stays OFF for empty / falsey / unrecognized values', () => {
    for (const v of ['', '   ', '0', 'false', 'off', 'no', 'nope', 'enabled', 'x']) {
      expect(parseVisibleAnswerStreamEnabled(v)).toBe(false)
    }
  })

  it('opts IN only on explicit truthy values (case/space-insensitive)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On', 'YES']) {
      expect(parseVisibleAnswerStreamEnabled(v)).toBe(true)
    }
  })
})

// ── resolveAnswerLaneConfig — TOTAL-ENUMERATION REGRESSION PROOF ─────────────
//
// The draft transport is permanently retired. The input space is now a single
// boolean (visibleEnabled), yielding exactly 2 states: visible or dormant.
// We enumerate ALL of it and assert the full decision table plus the load-bearing
// INVARIANT: opensVisiblePreview === visibleEnabled, ALWAYS.
describe('resolveAnswerLaneConfig — total enumeration (flash-regression proof)', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const ALL = [
    { visibleEnabled: false }, // the DEFAULT (visible off, draft permanently retired → dormant)
    { visibleEnabled: true },  // opt-in visible
  ]

  it('the input space is exactly 2 rows', () => {
    expect(ALL.length).toBe(2)
  })

  it('INVARIANT (the regression guard): opensVisiblePreview === visibleEnabled for EVERY input', () => {
    for (const input of ALL) {
      expect(resolveAnswerLaneConfig(input).opensVisiblePreview).toBe(input.visibleEnabled)
    }
  })

  it('TOTAL: every input returns a defined config and never throws', () => {
    for (const input of ALL) {
      expect(() => resolveAnswerLaneConfig(input)).not.toThrow()
      expect(resolveAnswerLaneConfig(input).state).toBeDefined()
    }
  })

  it('DEFAULT (visible off) → DORMANT: no preview, MAX gate (no flash)', () => {
    expect(resolveAnswerLaneConfig({ visibleEnabled: false })).toEqual({
      minInitialChars: MAX,
      opensVisiblePreview: false,
      state: 'dormant',
    })
  })

  it('visible on → VISIBLE: preview opens on the first chunk (minChars 1)', () => {
    expect(resolveAnswerLaneConfig({ visibleEnabled: true })).toEqual({
      minInitialChars: 1,
      opensVisiblePreview: true,
      state: 'visible',
    })
  })

  it('a visible preview NEVER opens unless explicitly enabled', () => {
    // The exact v0.14.68 failure shape: retiring the draft must NOT open a preview.
    expect(resolveAnswerLaneConfig({ visibleEnabled: false }).opensVisiblePreview).toBe(false)
    expect(resolveAnswerLaneConfig({ visibleEnabled: false }).minInitialChars).toBe(MAX)
  })
})
