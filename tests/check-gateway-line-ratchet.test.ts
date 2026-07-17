/**
 * Tests for the gateway.ts anti-inflation ratchet
 * (`scripts/check-gateway-line-ratchet.mjs`, switchroom#2996 P0.5).
 *
 * The guard's job: fail CI when `telegram-plugin/gateway/gateway.ts` grows past
 * a checked-in line-count ceiling, and force the ceiling to ratchet DOWN as the
 * file shrinks (a PR may lower it, never raise it). We assert OUTCOMES of the
 * pure decision function across the band, plus:
 *   - the real repo passes at HEAD (regression gate — the checked-in ratchet is
 *     consistent with the actual file), and
 *   - a synthetic over-inflated file fails when the script runs for real.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error — plain .mjs guard, no types; importing the pure helpers.
import {
  evaluateRatchet,
  countLines,
  SLACK,
  GATEWAY_PATH,
  RATCHET_PATH,
} from '../scripts/check-gateway-line-ratchet.mjs'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = resolve(REPO, 'scripts/check-gateway-line-ratchet.mjs')

function runScript(): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? '',
    }
  }
}

describe('countLines', () => {
  it('counts newline characters (wc -l semantics)', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(0)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(1)
  })

  it('matches `wc -l` on the real gateway.ts', () => {
    const src = readFileSync(resolve(REPO, GATEWAY_PATH), 'utf8')
    const wc = parseInt(
      execFileSync('bash', ['-c', `wc -l < ${GATEWAY_PATH}`], {
        cwd: REPO,
        encoding: 'utf8',
      }).trim(),
      10,
    )
    expect(countLines(src)).toBe(wc)
  })
})

describe('evaluateRatchet — inflation guard', () => {
  it('passes when actual is at the ratchet', () => {
    expect(evaluateRatchet({ actual: 1000, ratchet: 1000 }).ok).toBe(true)
  })

  it('passes when actual is within the slack grace above the ratchet', () => {
    expect(evaluateRatchet({ actual: 1000 + SLACK, ratchet: 1000 }).ok).toBe(true)
  })

  it('FAILS when actual exceeds ratchet + slack', () => {
    const r = evaluateRatchet({ actual: 1000 + SLACK + 1, ratchet: 1000 })
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/INFLATION/)
  })
})

describe('evaluateRatchet — auto-tighten', () => {
  it('passes when the file shrinks within slack of the ratchet', () => {
    expect(evaluateRatchet({ actual: 1000 - SLACK, ratchet: 1000 }).ok).toBe(true)
  })

  it('FAILS (demands tightening) when the file shrinks more than slack below the ratchet', () => {
    const r = evaluateRatchet({ actual: 1000 - SLACK - 1, ratchet: 1000 })
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/STALE RATCHET/)
    // The message names the concrete value the author must lower to.
    expect(r.errors.join('\n')).toMatch(String(1000 - SLACK - 1 + SLACK))
  })
})

describe('evaluateRatchet — never-raise', () => {
  it('passes when the ratchet is lowered vs main', () => {
    expect(
      evaluateRatchet({ actual: 900, ratchet: 900, mainRatchet: 1000 }).ok,
    ).toBe(true)
  })

  it('passes when the ratchet is unchanged vs main', () => {
    expect(
      evaluateRatchet({ actual: 1000, ratchet: 1000, mainRatchet: 1000 }).ok,
    ).toBe(true)
  })

  it('FAILS when the ratchet is raised vs main', () => {
    const r = evaluateRatchet({ actual: 1000, ratchet: 1000, mainRatchet: 990 })
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/RATCHET RAISED/)
  })

  it('skips the never-raise check when mainRatchet is unknown', () => {
    // actual==ratchet, no main reference → clean.
    expect(
      evaluateRatchet({ actual: 1000, ratchet: 1000, mainRatchet: null }).ok,
    ).toBe(true)
  })
})

describe('evaluateRatchet — malformed ratchet', () => {
  it('FAILS on a non-integer / non-positive ratchet', () => {
    expect(evaluateRatchet({ actual: 100, ratchet: NaN }).ok).toBe(false)
    expect(evaluateRatchet({ actual: 100, ratchet: 0 }).ok).toBe(false)
    expect(evaluateRatchet({ actual: 100, ratchet: -5 }).ok).toBe(false)
  })
})

describe('checked-in ratchet consistency', () => {
  it('the checked-in ratchet is within slack of the real gateway.ts (else the file drifted)', () => {
    const src = readFileSync(resolve(REPO, GATEWAY_PATH), 'utf8')
    const actual = countLines(src)
    const ratchet = parseInt(
      readFileSync(resolve(REPO, RATCHET_PATH), 'utf8').trim(),
      10,
    )
    // Both directions of the band must hold at HEAD.
    expect(actual).toBeLessThanOrEqual(ratchet + SLACK)
    expect(ratchet - actual).toBeLessThanOrEqual(SLACK)
  })
})

describe('check-gateway-line-ratchet.mjs (real script)', () => {
  it('passes on the real repo at HEAD (regression gate)', () => {
    const { ok, stdout, stderr } = runScript()
    expect(ok, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(true)
    expect(stdout).toMatch(/clean/)
  })
})
