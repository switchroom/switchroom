/**
 * Pin the SWITCHROOM_VISIBLE_ANSWER_STREAM contract: default OFF (2026-06-03),
 * opt-in only on a truthy value. Guards against an accidental flip back to
 * default-on (which would reintroduce the unformatted-preliminary flash +
 * delete-on-every-reply — see the gateway gate comment).
 */

import { describe, it, expect } from 'vitest'
import { parseVisibleAnswerStreamEnabled, parseDraftLaneRetiredEnabled } from '../answer-stream-flag.js'

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
