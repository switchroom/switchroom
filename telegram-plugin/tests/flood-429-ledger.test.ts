/**
 * Flood-pressure signal, proved against the real 2026-07 incident stream.
 *
 * The governing question for every assertion here: would this have told the
 * operator BEFORE 2026-07-27T20:19:57Z, and would it have stayed quiet on the
 * benign days? A test that passes on synthetic data but cannot answer that is
 * not a test of this feature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyFlood429Pressure,
  foldFlood429Observation,
  isPenaltyEpisode,
  readFlood429Ledger,
  readFlood429LedgerResult,
  recordFlood429,
  flood429LedgerPath,
  flood429LedgerPathFromFloodState,
  FLOOD_429_LEDGER_FILE,
  FLOOD_429_LEDGER_MAX_EPISODES,
  TRIVIAL_PRESSURE_WARN_COUNT,
  type Flood429Episode,
} from '../flood-429-ledger.js'
import { REAL_429_STREAM, at } from './fixtures/real-429-stream.js'

/** Replay the real stream (or a prefix of it) through the write-path fold. */
function replay(untilTs = Number.POSITIVE_INFINITY): Flood429Episode[] {
  let episodes: Flood429Episode[] = []
  for (const obs of REAL_429_STREAM) {
    if (obs.ts > untilTs) break
    episodes = foldFlood429Observation(episodes, obs, obs.ts)
  }
  return episodes
}

const INCIDENT_TS = at('2026-07-27T20:19:56.704Z')

describe('episode folding — the real ban shape', () => {
  it('collapses the 87 re-observations of the 2026-07-27 ban into ONE episode', () => {
    const episodes = replay()
    const incident = episodes.filter(
      (e) => e.firstTs >= at('2026-07-27T20:00:00Z') && isPenaltyEpisode(e),
    )
    expect(incident).toHaveLength(1)
    expect(incident[0].peakRetryAfterSec).toBe(15908)
    expect(incident[0].count).toBe(88)
    expect(incident[0].firstTs).toBe(INCIDENT_TS)
    // Every re-observation implies the SAME expiry as the first — that is
    // what makes them one episode. The 88 observations span 41 minutes yet
    // their implied expiries agree to within a second.
    expect(incident[0].untilTs - (INCIDENT_TS + 15908 * 1000)).toBeLessThan(1000)
    expect(new Date(incident[0].untilTs).toISOString()).toMatch(/^2026-07-28T00:45:0/)
  })

  it('keeps the four real bans distinct rather than merging them', () => {
    const peaks = replay()
      .filter(isPenaltyEpisode)
      .map((e) => e.peakRetryAfterSec)
    expect(peaks).toEqual([21397, 436, 563, 283, 425, 27951, 3713, 15908])
  })

  it('does not classify the benign rate nudges as penalties', () => {
    const trivial = replay().filter((e) => !isPenaltyEpisode(e))
    expect(trivial.length).toBeGreaterThan(0)
    for (const e of trivial) expect(e.peakRetryAfterSec).toBeLessThanOrEqual(5)
  })
})

describe('the signal fires before the incident', () => {
  it('FAILS 20 hours before the 4.4h ban, on the strength of the 2026-07-25 one', () => {
    const t = at('2026-07-27T00:00:00Z')
    expect(t).toBeLessThan(INCIDENT_TS)
    const verdict = classifyFlood429Pressure(replay(t), t)
    expect(verdict?.status).toBe('fail')
    expect(verdict?.reason).toBe('severe_penalty')
    expect(verdict?.detail).toContain('3713')
  })

  it('is already failing at the end of 2026-07-26, the day before', () => {
    const t = at('2026-07-26T23:59:59Z')
    const verdict = classifyFlood429Pressure(replay(t), t)
    expect(verdict?.status).toBe('fail')
  })

  it('FAILS 75 minutes before the 7.8h ban on 2026-07-13, and says it is growing', () => {
    // 00:37 (563s) and 01:42 (283s) are already on the ledger; 21397s from the
    // previous day is still inside the 7-day window.
    const t = at('2026-07-13T02:00:00Z')
    expect(t).toBeLessThan(at('2026-07-13T03:17:47Z'))
    const verdict = classifyFlood429Pressure(replay(t), t)
    expect(verdict?.status).toBe('fail')
    expect(verdict?.reason).toBe('repeat_penalty')
    expect(verdict?.penalties.map((p) => p.peakRetryAfterSec)).toEqual([21397, 436, 563, 283])
  })

  it('names the 4.3x escalation once both bans are on the ledger', () => {
    const t = at('2026-07-28T01:00:00Z') // after the ban window closed
    const verdict = classifyFlood429Pressure(replay(t), t)
    expect(verdict?.reason).toBe('repeat_penalty')
    expect(verdict?.detail).toContain('GROWING')
    expect(verdict?.detail).toContain('3713s → 15908s')
  })

  it('reports the open ban while it is running', () => {
    const t = at('2026-07-27T21:30:00Z')
    const verdict = classifyFlood429Pressure(replay(t), t)
    expect(verdict?.status).toBe('fail')
    expect(verdict?.reason).toBe('ban_open')
    expect(verdict?.detail).toContain('remaining')
  })
})

describe('the signal stays quiet on the benign days', () => {
  it('says nothing on 2026-07-24 — 7 short 429s, no penalty in the window', () => {
    const t = at('2026-07-24T23:59:59Z')
    const episodes = replay(t)
    expect(episodes.length).toBeGreaterThan(0) // the ledger is not empty
    expect(classifyFlood429Pressure(episodes, t)).toBeNull()
  })

  it('says nothing about the busiest benign day (14 nudges on 2026-07-19)', () => {
    // Isolated to the day's own traffic: the point is that 14 short 429s in
    // 24h are NOT worth waking anyone for. (Replayed in full context the
    // classifier still fails that day — correctly, because four real bans
    // landed six days earlier.)
    const day = REAL_429_STREAM.filter((o) => o.iso.startsWith('2026-07-19'))
    expect(day).toHaveLength(14)
    expect(day.every((o) => o.retryAfterSec <= 5)).toBe(true)
    let episodes: Flood429Episode[] = []
    for (const o of day) episodes = foldFlood429Observation(episodes, o, o.ts)
    const t = at('2026-07-19T23:59:59Z')
    expect(classifyFlood429Pressure(episodes, t)).toBeNull()
  })

  it('says nothing at all for a fleet-typical quiet week', () => {
    const t = at('2026-07-22T12:00:00Z')
    const window = REAL_429_STREAM.filter(
      (o) => o.ts > at('2026-07-15T12:00:00Z') && o.ts <= t,
    )
    expect(window.every((o) => o.retryAfterSec <= 5)).toBe(true)
    let episodes: Flood429Episode[] = []
    for (const o of window) episodes = foldFlood429Observation(episodes, o, o.ts)
    expect(classifyFlood429Pressure(episodes, t)).toBeNull()
  })
})

describe('why raw daily count was rejected', () => {
  /** Real 429s per calendar day, straight off the fixture. */
  function perDay(day: string): number {
    return REAL_429_STREAM.filter((o) => o.iso.startsWith(day)).length
  }

  it('a ">20 429s/day" rule is silent on every day that could have warned', () => {
    // The proposal that started this work. On the real stream it fires on
    // exactly one day: the day of the outage, 4.4 hours too late for the
    // 20:19:57Z ban and only because the ban re-observed itself 87 times.
    for (const day of [
      '2026-07-19', // busiest benign day
      '2026-07-24',
      '2026-07-25', // the 62-minute ban lands here
      '2026-07-26', // last chance to warn
    ]) {
      expect(perDay(day)).toBeLessThan(20)
    }
    expect(perDay('2026-07-27')).toBeGreaterThan(20)
  })

  it('the severity signal fires on 2026-07-25, the day the count rule misses', () => {
    const t = at('2026-07-25T23:45:00Z') // 2 minutes after the 3713s ban
    expect(perDay('2026-07-25')).toBe(4)
    const verdict = classifyFlood429Pressure(replay(t), t)
    expect(verdict?.status).toBe('fail')
    // ~44 hours of warning before the 4.4h outage.
    expect(INCIDENT_TS - t).toBeGreaterThan(43 * 60 * 60 * 1000)
  })
})

describe('trivial-pressure tier', () => {
  const base = at('2026-07-01T00:00:00Z')

  function nudges(n: number): Flood429Episode[] {
    let episodes: Flood429Episode[] = []
    for (let i = 0; i < n; i++) {
      // 10 minutes apart — far outside EPISODE_MERGE_MS, so each is its own
      // episode and the count is unambiguous.
      const ts = base + i * 600_000
      episodes = foldFlood429Observation(episodes, { ts, retryAfterSec: 3 }, ts)
    }
    return episodes
  }

  it('warns at the threshold and is silent one below it', () => {
    const t = base + 23 * 60 * 60 * 1000
    expect(classifyFlood429Pressure(nudges(TRIVIAL_PRESSURE_WARN_COUNT - 1), t)).toBeNull()
    const verdict = classifyFlood429Pressure(nudges(TRIVIAL_PRESSURE_WARN_COUNT), t)
    expect(verdict?.status).toBe('warn')
    expect(verdict?.reason).toBe('trivial_pressure')
  })

  it('ages out — the same nudges two days later say nothing', () => {
    const t = base + 48 * 60 * 60 * 1000
    expect(classifyFlood429Pressure(nudges(TRIVIAL_PRESSURE_WARN_COUNT), t)).toBeNull()
  })
})

describe('ledger persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-429-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips through the on-disk file', () => {
    const path = flood429LedgerPath(dir)
    recordFlood429(path, { ts: at('2026-07-25T23:43:07.861Z'), retryAfterSec: 3713 })
    recordFlood429(path, { ts: at('2026-07-27T20:19:56.704Z'), retryAfterSec: 15908 })
    const episodes = readFlood429Ledger(path)
    expect(episodes.map((e) => e.peakRetryAfterSec)).toEqual([3713, 15908])
    const verdict = classifyFlood429Pressure(episodes, at('2026-07-28T01:00:00Z'))
    expect(verdict?.reason).toBe('repeat_penalty')
  })

  it('does not grow under a long ban re-observed 88 times', () => {
    const path = flood429LedgerPath(dir)
    for (const obs of REAL_429_STREAM.filter((o) => o.ts >= INCIDENT_TS)) {
      recordFlood429(path, obs)
    }
    expect(readFlood429Ledger(path)).toHaveLength(1)
    // A whole 4.4h outage costs well under a kilobyte of state.
    expect(readFileSync(path, 'utf-8').length).toBeLessThan(200)
  })

  it('stays bounded when every 429 is a separate episode', () => {
    const path = flood429LedgerPath(dir)
    const start = at('2026-07-01T00:00:00Z')
    for (let i = 0; i < FLOOD_429_LEDGER_MAX_EPISODES + 50; i++) {
      recordFlood429(path, { ts: start + i * 600_000, retryAfterSec: 3 })
    }
    expect(readFlood429Ledger(path)).toHaveLength(FLOOD_429_LEDGER_MAX_EPISODES)
  })

  it('degrades to empty on a corrupt or absent file instead of throwing', () => {
    const path = flood429LedgerPath(dir)
    expect(readFlood429Ledger(path)).toEqual([])
    writeFileSync(path, 'not json at all')
    expect(readFlood429Ledger(path)).toEqual([])
    writeFileSync(path, '[{"nope":1},{"firstTs":1,"untilTs":2,"peakRetryAfterSec":3}]')
    expect(readFlood429Ledger(path)).toHaveLength(1)
  })

  it('separates "never 429\'d" from "cannot read the ledger"', () => {
    const path = flood429LedgerPath(dir)
    expect(readFlood429LedgerResult(path).status).toBe('absent')
    writeFileSync(path, 'not json at all')
    expect(readFlood429LedgerResult(path).status).toBe('corrupt')
    recordFlood429(path, { ts: at('2026-07-25T23:43:07.861Z'), retryAfterSec: 3713 })
    expect(readFlood429LedgerResult(path).status).toBe('ok')
    const boom = readFlood429LedgerResult(path, () => {
      const err = new Error('EACCES: permission denied')
      ;(err as NodeJS.ErrnoException).code = 'EACCES'
      throw err
    })
    expect(boom.status).toBe('unreadable')
    expect(boom.error).toContain('EACCES')
  })

  it('sits beside the flood-wait marker the breaker already writes', () => {
    expect(flood429LedgerPathFromFloodState(join(dir, 'flood-wait.json'))).toBe(
      join(dir, FLOOD_429_LEDGER_FILE),
    )
  })
})
