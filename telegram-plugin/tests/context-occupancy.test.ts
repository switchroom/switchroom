import { describe, it, expect } from 'bun:test'
import {
  buildContextOccupancy,
  writeContextOccupancySnapshot,
  TIGHT_FRACTION,
} from '../gateway/context-occupancy.js'

describe('buildContextOccupancy', () => {
  it('computes headroom + pct + ok state under the cap', () => {
    const s = buildContextOccupancy(47000, 300000, 123)
    expect(s).toMatchObject({ occupancy: 47000, cap: 300000, headroom: 253000, state: 'ok', computedAt: 123 })
    expect(s.pct).toBeCloseTo(0.1567, 3)
  })

  it('flags "tight" at/above TIGHT_FRACTION of the cap', () => {
    const atThreshold = buildContextOccupancy(Math.ceil(300000 * TIGHT_FRACTION), 300000, 1)
    expect(atThreshold.state).toBe('tight')
    expect(buildContextOccupancy(250000, 300000, 1).state).toBe('tight') // 83% ≥ 80%
    expect(buildContextOccupancy(231000, 300000, 1).state).toBe('ok')    // 77% < 80%
    expect(buildContextOccupancy(239999, 300000, 1).state).toBe('ok')    // just under 80%
  })

  it('no cap → ok, null ratio (occupancy known, no ceiling)', () => {
    const s = buildContextOccupancy(50000, null, 1)
    expect(s).toMatchObject({ occupancy: 50000, cap: null, headroom: null, pct: null, state: 'ok' })
    expect(buildContextOccupancy(50000, 0, 1).cap).toBeNull() // cap<=0 treated as none
  })

  it('unmeasurable occupancy → unknown', () => {
    expect(buildContextOccupancy(NaN, 300000, 1).state).toBe('unknown')
    expect(buildContextOccupancy(-5, 300000, 1).state).toBe('unknown')
  })
})

describe('writeContextOccupancySnapshot', () => {
  it('writes <stateDir>/context-occupancy.json via injected fs', () => {
    let path = ''
    let data = ''
    writeContextOccupancySnapshot('/state/agent', buildContextOccupancy(47000, 300000, 1), {
      mkdir: () => {},
      writeFile: (p, d) => { path = p; data = d },
    })
    expect(path).toBe('/state/agent/context-occupancy.json')
    expect(JSON.parse(data).occupancy).toBe(47000)
  })

  it('never throws when the write fails (best-effort)', () => {
    expect(() =>
      writeContextOccupancySnapshot('/x', buildContextOccupancy(1, 2, 1), {
        mkdir: () => {},
        writeFile: () => { throw new Error('EACCES') },
      }),
    ).not.toThrow()
  })
})
