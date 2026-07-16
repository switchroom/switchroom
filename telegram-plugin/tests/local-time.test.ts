/**
 * Unit tests for the model-facing local-time primitives in
 * telegram-plugin/shared/local-time.ts.
 *
 * switchroom #tz-fix: `fmtLocalStamp` + `resolveEnvTimezone` are the single
 * source of truth for the LOCAL am/pm timestamps the model now sees on inbound
 * `<channel ts="…">` tags, `forwarded_date`, and the get_recent_messages
 * buffer — replacing the UTC ISO strings that competed with the local-time
 * hint. These pin the deterministic outcome: local am/pm, NEVER a UTC string.
 */

import { describe, expect, it } from 'vitest'
import { fmtLocalStamp, resolveEnvTimezone, renderLogTimestampsLocal } from '../shared/local-time.js'

// 2025-06-15T14:26:40Z — a fixed instant so the local rendering is deterministic.
const MS = 1750000000 * 1000

describe('resolveEnvTimezone', () => {
  it('follows the SWITCHROOM_TIMEZONE → TZ → UTC cascade', () => {
    expect(resolveEnvTimezone({ SWITCHROOM_TIMEZONE: 'Australia/Melbourne', TZ: 'America/New_York' })).toBe(
      'Australia/Melbourne',
    )
    expect(resolveEnvTimezone({ TZ: 'America/New_York' })).toBe('America/New_York')
    expect(resolveEnvTimezone({})).toBe('UTC')
  })
})

describe('fmtLocalStamp', () => {
  it('renders LOCAL am/pm with weekday, ISO date, and zone abbrev — no UTC', () => {
    const out = fmtLocalStamp(MS, 'Australia/Melbourne')
    // e.g. "Sunday 2025-06-16 12:26 AM AEST"
    expect(out).toMatch(/^[A-Za-z]+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:AM|PM) [A-Za-z]{2,5}$/)
    expect(out).not.toContain('UTC')
    expect(out.endsWith('Z')).toBe(false)
  })

  it('reflects the requested zone (different wall clock for a different tz)', () => {
    const melbourne = fmtLocalStamp(MS, 'Australia/Melbourne')
    const newYork = fmtLocalStamp(MS, 'America/New_York')
    expect(melbourne).not.toBe(newYork)
    expect(newYork).toMatch(/ (?:AM|PM) [A-Za-z]{2,5}$/)
  })

  it('is total — an invalid IANA zone degrades to am/pm, never throws', () => {
    // Must not throw out of the inbound path on a misconfigured agent.
    const out = fmtLocalStamp(MS, 'Not/ARealZone')
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })

  it('UTC zone still renders am/pm (24h/"UTC-suffix" form is gone)', () => {
    const out = fmtLocalStamp(MS, 'UTC')
    expect(out).toMatch(/ (?:AM|PM) /)
  })

  it('tracks DST — Australia/Melbourne is AEDT in Jan (summer) and AEST in Jul (winter)', () => {
    // Southern-hemisphere DST: daylight time is the Dec–Mar summer.
    const summer = fmtLocalStamp(Date.UTC(2026, 0, 15, 3, 0, 0), 'Australia/Melbourne') // 15 Jan
    const winter = fmtLocalStamp(Date.UTC(2026, 6, 15, 3, 0, 0), 'Australia/Melbourne') // 15 Jul
    expect(summer).toContain('AEDT')
    expect(winter).toContain('AEST')
    // Both stay am/pm and UTC-free across the transition.
    for (const s of [summer, winter]) {
      expect(s).toMatch(/ (?:AM|PM) /)
      expect(s).not.toContain('UTC')
    }
  })
})

describe('renderLogTimestampsLocal', () => {
  // #tz-fix audit (MEDIUM gap 2): /logs docker lines carry a leading UTC
  // ISO-Z stamp; render it in local am/pm at display time.
  it('rewrites a leading UTC ISO-Z timestamp into local am/pm', () => {
    // 04:09Z in July → Melbourne AEST (UTC+10) → 02:09 PM.
    const out = renderLogTimestampsLocal(
      '2026-07-16T04:09:00.123456789Z gateway boot ok',
      'Australia/Melbourne',
    )
    expect(out).toContain('2026-07-16 02:09 PM AEST')
    expect(out).toContain('gateway boot ok')
    expect(out).not.toContain('T04:09')
    expect(out).not.toContain('Z gateway')
  })

  it('handles a fractionless ISO-Z timestamp', () => {
    const out = renderLogTimestampsLocal('2026-07-16T04:09:00Z hello', 'Australia/Melbourne')
    expect(out).toContain('2026-07-16 02:09 PM AEST hello')
  })

  it('converts every line and preserves non-timestamped lines verbatim', () => {
    const input = [
      '2026-07-16T04:09:00Z first',
      '  continuation line with no timestamp',
      '2026-07-16T05:10:00Z second',
    ].join('\n')
    const out = renderLogTimestampsLocal(input, 'Australia/Melbourne').split('\n')
    expect(out[0]).toContain('02:09 PM AEST first')
    expect(out[1]).toBe('  continuation line with no timestamp')
    expect(out[2]).toContain('03:10 PM AEST second')
  })

  it('preserves a line whose leading token is not a valid ISO-Z stamp', () => {
    const raw = 'not-a-timestamp still here'
    expect(renderLogTimestampsLocal(raw, 'Australia/Melbourne')).toBe(raw)
  })

  it('does not touch a timestamp that is not at line start', () => {
    const raw = 'prefix 2026-07-16T04:09:00Z trailing'
    expect(renderLogTimestampsLocal(raw, 'Australia/Melbourne')).toBe(raw)
  })

  it('returns empty input unchanged', () => {
    expect(renderLogTimestampsLocal('', 'Australia/Melbourne')).toBe('')
  })
})
