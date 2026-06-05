/**
 * Pin the SWITCHROOM_VISIBLE_ANSWER_STREAM contract: default OFF (2026-06-03),
 * opt-in only on a truthy value. Guards against an accidental flip back to
 * default-on (which would reintroduce the unformatted-preliminary flash +
 * delete-on-every-reply — see the gateway gate comment).
 */

import { describe, it, expect } from 'vitest'
import { parseVisibleAnswerStreamEnabled, parseDraftLaneRetiredEnabled, resolveAnswerLaneConfig } from '../answer-stream-flag.js'

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

describe('parseDraftLaneRetiredEnabled — default RETIRED (2026-06-05), kill-switch off', () => {
  it('defaults to RETIRED (true) when unset — the draft lane is gone by default', () => {
    expect(parseDraftLaneRetiredEnabled(undefined)).toBe(true)
  })

  it('stays RETIRED for any non-disable value (including unrecognized)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '', '   ', 'whatever', 'retired']) {
      expect(parseDraftLaneRetiredEnabled(v)).toBe(true)
    }
  })

  it('restores the legacy draft (false) ONLY on an explicit disable (case/space-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off', 'NO']) {
      expect(parseDraftLaneRetiredEnabled(v)).toBe(false)
    }
  })
})

// ── resolveAnswerLaneConfig — TOTAL-ENUMERATION REGRESSION PROOF ─────────────
//
// This is the behavioural guard for the flash regression (the gateway IIFE is
// not importable, so the decision lives in this pure function and the gateway
// delegates to it). The input space is finite — visibleEnabled × draftFnAvailable
// = 4 — so we enumerate ALL of it and assert the full decision table plus the
// load-bearing INVARIANT: opensVisiblePreview === visibleEnabled, ALWAYS. That
// invariant is exactly what v0.14.68 broke (it made the preview depend on the
// draft flag), so a future change that re-conflates them fails here, not in prod.
describe('resolveAnswerLaneConfig — total enumeration (flash-regression proof)', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const ALL = [
    { visibleEnabled: false, draftFnAvailable: false }, // the DEFAULT (visible off, draft retired)
    { visibleEnabled: false, draftFnAvailable: true }, // draft kill switch on
    { visibleEnabled: true, draftFnAvailable: false }, // opt-in visible
    { visibleEnabled: true, draftFnAvailable: true }, // visible wins over draft
  ]

  it('the input space is exactly 4 rows (2×2)', () => {
    expect(ALL.length).toBe(4)
  })

  it('INVARIANT (the regression guard): opensVisiblePreview === visibleEnabled for EVERY draftFnAvailable', () => {
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

  it('DEFAULT (visible off, draft retired) → DORMANT: no preview, no draft, MAX gate (no flash)', () => {
    expect(resolveAnswerLaneConfig({ visibleEnabled: false, draftFnAvailable: false })).toEqual({
      minInitialChars: MAX,
      usesDraftTransport: false,
      opensVisiblePreview: false,
      state: 'dormant',
    })
  })

  it('visible off + draft transport available → DRAFT: no visible preview, draft renders', () => {
    expect(resolveAnswerLaneConfig({ visibleEnabled: false, draftFnAvailable: true })).toEqual({
      minInitialChars: MAX,
      usesDraftTransport: true,
      opensVisiblePreview: false,
      state: 'draft',
    })
  })

  it('visible on → VISIBLE: preview opens on the first chunk (minChars 1), no draft', () => {
    for (const draftFnAvailable of [false, true]) {
      expect(resolveAnswerLaneConfig({ visibleEnabled: true, draftFnAvailable })).toEqual({
        minInitialChars: 1,
        usesDraftTransport: false,
        opensVisiblePreview: true,
        state: 'visible',
      })
    }
  })

  it('a visible preview NEVER opens unless explicitly enabled (no draftFnAvailable forces it on)', () => {
    // The exact v0.14.68 failure shape: retiring the draft (draftFnAvailable=false)
    // must NOT open a visible preview.
    expect(resolveAnswerLaneConfig({ visibleEnabled: false, draftFnAvailable: false }).opensVisiblePreview).toBe(false)
    expect(resolveAnswerLaneConfig({ visibleEnabled: false, draftFnAvailable: false }).minInitialChars).toBe(MAX)
  })
})
