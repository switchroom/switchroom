import { describe, it, expect } from 'vitest'
import {
  normalizeTemporal,
  normalizeUtcDatetimes,
  normalizeRelativeDays,
} from '../temporal-normalize.js'

// All cases run in the agent's configured tz with a FIXED nowMs — the pure
// signature means no env / clock mocking is needed.
const TZ = 'Australia/Melbourne'
// Midday Melbourne on Thursday 2026-07-23 (AEST, UTC+10): 02:00Z = 12:00 local.
const NOW_THU_23_JUL = Date.UTC(2026, 6, 23, 2, 0, 0)

describe('normalizeRelativeDays — relative-day accuracy (#3501)', () => {
  it('1. stale-forward: "closed tomorrow (Thu 23 Jul)" on Thu 23 Jul → "today"', () => {
    // The reported incident.
    const out = normalizeRelativeDays('closed tomorrow (Thu 23 Jul)', TZ, NOW_THU_23_JUL)
    expect(out).toBe('closed today (Thu 23 Jul)')
  })

  it('2. stale-backward: "today (Wed 22 Jul)" on Thu 23 Jul → "yesterday"', () => {
    const out = normalizeRelativeDays('sent today (Wed 22 Jul)', TZ, NOW_THU_23_JUL)
    expect(out).toBe('sent yesterday (Wed 22 Jul)')
  })

  it('3. "yesterday" wrong forward: "(Fri 24 Jul)" → "tomorrow"', () => {
    const out = normalizeRelativeDays('due yesterday (Fri 24 Jul)', TZ, NOW_THU_23_JUL)
    expect(out).toBe('due tomorrow (Fri 24 Jul)')
  })

  it('4. correct word untouched — byte-identical', () => {
    const src = 'ships today (Thu 23 Jul)'
    expect(normalizeRelativeDays(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('5. relative word with NO adjacent date — untouched', () => {
    const src = "I'll get to it today, promise."
    expect(normalizeRelativeDays(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('6. multi-date message — each pair resolved independently', () => {
    const out = normalizeRelativeDays(
      'opened tomorrow (Thu 23 Jul), closes tomorrow (Fri 24 Jul)',
      TZ,
      NOW_THU_23_JUL,
    )
    // First pair is actually today; second is genuinely tomorrow.
    expect(out).toBe('opened today (Thu 23 Jul), closes tomorrow (Fri 24 Jul)')
  })

  it('7. midnight boundary: UTC date (22nd) disagrees with Melbourne date (23rd)', () => {
    // 2026-07-22T23:00Z is already Thu 23 Jul 09:00 in Melbourne.
    const now = Date.UTC(2026, 6, 22, 23, 0, 0)
    const out = normalizeRelativeDays('reminder tomorrow (Thu 23 Jul)', TZ, now)
    expect(out).toBe('reminder today (Thu 23 Jul)')
  })

  it('16. weekday repair: "(Wed 23 Jul)" when 23 Jul is a Thursday → "(Thu 23 Jul)"', () => {
    const out = normalizeRelativeDays('meeting today (Wed 23 Jul)', TZ, NOW_THU_23_JUL)
    expect(out).toBe('meeting today (Thu 23 Jul)')
  })

  it('numeric date form 23/07 (DD/MM) resolves like a named date', () => {
    const out = normalizeRelativeDays('billed tomorrow (23/07)', TZ, NOW_THU_23_JUL)
    expect(out).toBe('billed today (23/07)')
  })

  it('ISO yyyy-mm-dd adjacent date resolves', () => {
    const out = normalizeRelativeDays('expires tomorrow 2026-07-22', TZ, NOW_THU_23_JUL)
    expect(out).toBe('expires yesterday 2026-07-22')
  })

  it('time-of-day word with diff==0 (today) is kept as-is', () => {
    const src = 'closing tonight (Thu 23 Jul)'
    expect(normalizeRelativeDays(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('REVIEW FIX 2 — time-of-day word with diff≠0 is left UNTOUCHED (never remapped)', () => {
    // "tonight" next to tomorrow's date must NOT become "tomorrow" — it is left
    // exactly as written.
    const src = 'party tonight (Fri 24 Jul)'
    expect(normalizeRelativeDays(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('out-of-range relative word (diff > 1) is left untouched, NOT auto-deleted', () => {
    const src = 'launch tomorrow (Mon 3 Aug)'
    expect(normalizeRelativeDays(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('preserves original casing on rewrite', () => {
    const out = normalizeRelativeDays('Tomorrow (Thu 23 Jul) we ship', TZ, NOW_THU_23_JUL)
    expect(out).toBe('Today (Thu 23 Jul) we ship')
  })

  it('excludes blockquote (>) lines from rewriting (quoted third-party text)', () => {
    const src = '> forwarded: closed tomorrow (Thu 23 Jul)'
    expect(normalizeRelativeDays(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })
})

describe('normalizeUtcDatetimes — no raw UTC outbound (#3501)', () => {
  it('8. ISO-Z → local: 2026-07-23T09:15:00Z → Thu 23 Jul 7:15 pm AEST', () => {
    const out = normalizeUtcDatetimes('window opens 2026-07-23T09:15:00Z', TZ, NOW_THU_23_JUL)
    expect(out).toBe('window opens Thu 23 Jul 7:15 pm AEST')
  })

  it('9a. +00:00 offset variant', () => {
    const out = normalizeUtcDatetimes('at 2026-07-23T09:15:00+00:00 sharp', TZ, NOW_THU_23_JUL)
    expect(out).toBe('at Thu 23 Jul 7:15 pm AEST sharp')
  })

  it('9b. no-seconds and fractional-seconds variants', () => {
    expect(normalizeUtcDatetimes('t=2026-07-23T09:15Z', TZ, NOW_THU_23_JUL)).toBe('t=Thu 23 Jul 7:15 pm AEST')
    expect(normalizeUtcDatetimes('t=2026-07-23T09:15:00.500Z', TZ, NOW_THU_23_JUL)).toBe(
      't=Thu 23 Jul 7:15 pm AEST',
    )
  })

  it('10. labelled "14:00 UTC" → local time-only', () => {
    // 14:00Z on the 23rd is 00:00 (midnight) of the 24th in Melbourne.
    const out = normalizeUtcDatetimes('cutoff 14:00 UTC', TZ, NOW_THU_23_JUL)
    expect(out).toBe('cutoff 12:00 am AEST')
  })

  it('10b. labelled "2 pm GMT" → local', () => {
    const out = normalizeUtcDatetimes('call at 2 pm GMT', TZ, NOW_THU_23_JUL)
    expect(out).toBe('call at 12:00 am AEST')
  })

  it('11. DST: an AEDT-side instant renders AEDT wall clock', () => {
    // 2026-01-15T09:15:00Z, Melbourne is on AEDT (UTC+11).
    const summerNow = Date.UTC(2026, 0, 15, 2, 0, 0)
    const out = normalizeUtcDatetimes('summer 2026-01-15T09:15:00Z', TZ, summerNow)
    expect(out).toBe('summer Thu 15 Jan 8:15 pm AEDT')
  })

  it('12. already-local text ("7:15 pm AEST") — untouched', () => {
    const src = 'opens 7:15 pm AEST'
    expect(normalizeUtcDatetimes(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('REVIEW — "9 to 5 GMT" (bare labelled hour, no minutes/ampm) is NOT converted', () => {
    const src = 'hours are 9 to 5 GMT'
    expect(normalizeUtcDatetimes(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })
})

describe('temporal masking — false-positive guards (#3501)', () => {
  it('13a. ISO inside an inline code span — untouched', () => {
    const src = 'log line `2026-07-23T09:15:00Z` seen'
    expect(normalizeTemporal(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('13b. ISO inside a fenced code block — untouched', () => {
    const src = 'trace:\n```\nts=2026-07-23T09:15:00Z\n```\nend'
    expect(normalizeTemporal(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('REVIEW FIX 1 (failing-first) — ISO inside a markdown link href is untouched', () => {
    const src = 'see [log](https://x/2026-07-23T09:15:00Z) for detail'
    expect(normalizeTemporal(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('REVIEW FIX 1 — ISO inside an angle-bracket autolink is untouched', () => {
    const src = 'ref <https://x/2026-07-23T09:15:00Z> here'
    expect(normalizeTemporal(src, TZ, NOW_THU_23_JUL)).toBe(src)
  })

  it('but a bare ISO in prose alongside a masked one IS still converted', () => {
    const out = normalizeTemporal(
      'live 2026-07-23T09:15:00Z, code `2026-07-23T09:15:00Z`',
      TZ,
      NOW_THU_23_JUL,
    )
    expect(out).toBe('live Thu 23 Jul 7:15 pm AEST, code `2026-07-23T09:15:00Z`')
  })
})

describe('normalizeTemporal — composition, idempotency, robustness (#3501)', () => {
  it('runs UTC→local first, then relative-day on the produced date', () => {
    // The UTC pass yields "Thu 23 Jul …"; the relative pass then sees that date
    // adjacent to "tomorrow" and corrects it to "today".
    const out = normalizeTemporal('tomorrow 2026-07-22T09:15:00Z', TZ, NOW_THU_23_JUL)
    // 2026-07-22T09:15Z → Wed 22 Jul 7:15 pm AEST; 22 Jul is yesterday.
    expect(out).toBe('yesterday Wed 22 Jul 7:15 pm AEST')
  })

  it('14. idempotent: f(f(x)) === f(x) for every representative fixture', () => {
    const fixtures = [
      'closed tomorrow (Thu 23 Jul)',
      'window opens 2026-07-23T09:15:00Z',
      'cutoff 14:00 UTC',
      'meeting today (Wed 23 Jul)',
      'plain prose with no temporal content at all',
      'see [log](https://x/2026-07-23T09:15:00Z)',
    ]
    for (const f of fixtures) {
      const once = normalizeTemporal(f, TZ, NOW_THU_23_JUL)
      const twice = normalizeTemporal(once, TZ, NOW_THU_23_JUL)
      expect(twice).toBe(once)
    }
  })

  it('15. invalid tz — no-op, never throws (both passes)', () => {
    const src = 'closed tomorrow (Thu 23 Jul), at 2026-07-23T09:15:00Z'
    expect(() => normalizeTemporal(src, 'Not/AZone', NOW_THU_23_JUL)).not.toThrow()
    expect(normalizeTemporal(src, 'Not/AZone', NOW_THU_23_JUL)).toBe(src)
  })

  it('empty / whitespace input is returned unchanged', () => {
    expect(normalizeTemporal('', TZ, NOW_THU_23_JUL)).toBe('')
    expect(normalizeUtcDatetimes('', TZ, NOW_THU_23_JUL)).toBe('')
    expect(normalizeRelativeDays('', TZ, NOW_THU_23_JUL)).toBe('')
  })

  it('reproduces the cron/mail-watcher incident end-to-end', () => {
    // The exact shape of the reported cron notification.
    const incident = 'Heads up: the office is closed tomorrow (Thu 23 Jul).'
    const out = normalizeTemporal(incident, TZ, NOW_THU_23_JUL)
    expect(out).toBe('Heads up: the office is closed today (Thu 23 Jul).')
  })
})
