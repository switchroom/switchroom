/**
 * Unit tests for `parseInterruptMarker` — the `!`-prefix interrupt
 * detector for the steer-or-queue-mid-flight JTBD (#575).
 *
 * The gateway-side wiring (bypass-coalesce, SIGINT, forward-stripped)
 * is covered by integration tests; these focus on the pure parsing
 * contract so the rule stays unambiguous.
 */

import { describe, it, expect } from 'bun:test'
import { parseInterruptMarker } from '../interrupt-marker.js'

describe('parseInterruptMarker — positive cases (interrupt fires)', () => {
  it('fires on a leading `!` with body', () => {
    const r = parseInterruptMarker('!stop and do this instead')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('stop and do this instead')
    expect(r.emptyBody).toBe(false)
  })

  it('fires on `! body` with space after the marker', () => {
    const r = parseInterruptMarker('! drop everything')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('drop everything')
  })

  it('fires on leading whitespace + `!`', () => {
    const r = parseInterruptMarker('   ! cancel')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('cancel')
  })

  it('strips ALL leading whitespace after the marker, not just one space', () => {
    const r = parseInterruptMarker('!\n\n  newline-prefixed body')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('newline-prefixed body')
  })

  it('flags emptyBody when only `!` is sent', () => {
    const r = parseInterruptMarker('!')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('')
    expect(r.emptyBody).toBe(true)
  })

  it('flags emptyBody when `!` is followed by only whitespace', () => {
    const r = parseInterruptMarker('!   \n  ')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('')
    expect(r.emptyBody).toBe(true)
  })
})

describe('parseInterruptMarker — negative cases (no interrupt)', () => {
  it('does NOT fire on doubled `!!` (typo / emphasis)', () => {
    const r = parseInterruptMarker('!!emphasis on this')
    expect(r.isInterrupt).toBe(false)
    expect(r.body).toBe('!!emphasis on this')
  })

  it('does NOT fire on `!!!` or any longer run of bangs', () => {
    expect(parseInterruptMarker('!!!hold on').isInterrupt).toBe(false)
    expect(parseInterruptMarker('!!!!').isInterrupt).toBe(false)
  })

  it('does NOT fire when `!` is mid-string', () => {
    const r = parseInterruptMarker('whoops! actually')
    expect(r.isInterrupt).toBe(false)
    expect(r.body).toBe('whoops! actually')
  })

  it('does NOT fire on markdown-style `*!*`', () => {
    const r = parseInterruptMarker('*!* keep going')
    expect(r.isInterrupt).toBe(false)
  })

  it('does NOT fire on `/` slash-commands (reserved for bot commands)', () => {
    const r = parseInterruptMarker('/stop the agent')
    expect(r.isInterrupt).toBe(false)
  })

  it('does NOT fire on uppercase STOP / cancel keywords', () => {
    expect(parseInterruptMarker('STOP').isInterrupt).toBe(false)
    expect(parseInterruptMarker('cancel that').isInterrupt).toBe(false)
  })

  it('does NOT fire on empty text', () => {
    const r = parseInterruptMarker('')
    expect(r.isInterrupt).toBe(false)
    expect(r.body).toBe('')
  })

  it('does NOT fire on whitespace-only text', () => {
    const r = parseInterruptMarker('   \n  \t  ')
    expect(r.isInterrupt).toBe(false)
  })

  it('passes through normal prose unchanged', () => {
    const original = 'Hi, can you check the calendar for next week?'
    const r = parseInterruptMarker(original)
    expect(r.isInterrupt).toBe(false)
    expect(r.body).toBe(original)
  })
})

describe('parseInterruptMarker — body preservation', () => {
  it('preserves multi-line bodies after the marker', () => {
    const r = parseInterruptMarker('!\nLine 1\nLine 2')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('Line 1\nLine 2')
  })

  it('preserves embedded `!` inside the body', () => {
    const r = parseInterruptMarker('! WAIT! actually do X')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('WAIT! actually do X')
  })

  it('preserves trailing whitespace inside the body', () => {
    // Caller may want to display verbatim; we don't trimEnd in the
    // body — only the leading whitespace after the marker.
    const r = parseInterruptMarker('!keep this   ')
    expect(r.isInterrupt).toBe(true)
    expect(r.body).toBe('keep this   ')
  })
})
