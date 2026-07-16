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
import { fmtLocalStamp, resolveEnvTimezone } from '../shared/local-time.js'

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
