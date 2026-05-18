import { describe, it, expect } from 'vitest'
import {
  latestHostdPhase,
  formatUpdateStatusLine,
} from '../gateway/update-status-line.js'

const T0 = 1_000_000_000_000

describe('latestHostdPhase', () => {
  it('returns null for empty / no-banner tail', () => {
    expect(latestHostdPhase(undefined)).toBeNull()
    expect(latestHostdPhase('')).toBeNull()
    expect(latestHostdPhase('Applying switchroom config...\nWrote compose')).toBeNull()
  })

  it('returns the LAST ▸ banner (deterministic, last wins)', () => {
    const tail =
      '▸ pull-images\n some docker output\n▸ apply-config\n▸ recreate-containers\n'
    expect(latestHostdPhase(tail)).toBe('recreate-containers')
  })

  it('tolerates leading/trailing whitespace around the banner', () => {
    expect(latestHostdPhase('  ▸   doctor   \n')).toBe('doctor')
  })
})

describe('formatUpdateStatusLine', () => {
  it('in-progress with a phase: shows phase + elapsed + report-back tail', () => {
    const line = formatUpdateStatusLine(
      { result: 'started', stdout_tail: '▸ pull-images\n▸ apply-config\n' },
      T0,
      T0 + 2 * 60_000 + 5_000, // ~2m
    )
    expect(line).toContain('Fleet update in progress')
    expect(line).toContain('phase: apply-config')
    expect(line).toContain('~2m')
    expect(line).toMatch(/report the result here/i)
    expect(line).not.toMatch(/still working|no update from agent/i)
  })

  it('in-progress before any banner: "starting"', () => {
    const line = formatUpdateStatusLine(
      { result: 'started', stdout_tail: 'Image ... Pulling' },
      T0,
      T0 + 30_000,
    )
    expect(line).toContain('Fleet update in progress')
    expect(line).toContain('starting')
    expect(line).not.toContain('phase:')
    expect(line).toContain('~1m') // min 1m floor
  })

  it('elapsed rounds to nearest minute, floored at 1', () => {
    expect(formatUpdateStatusLine({ result: 'started' }, T0, T0 + 5_000)).toContain('~1m')
    expect(
      formatUpdateStatusLine({ result: 'started' }, T0, T0 + 7 * 60_000 + 40_000),
    ).toContain('~8m')
  })

  it('terminal-but-gateway-alive: stops claiming in-progress, defers to verdict path', () => {
    const line = formatUpdateStatusLine(
      { result: 'error', stderr_tail: 'boom' },
      T0,
      T0 + 3 * 60_000,
    )
    expect(line).toContain('finishing')
    expect(line).toContain('`error`')
    expect(line).not.toContain('in progress')
  })
})
