import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  maybeRotate,
  resolveAgentStateDir,
  resolveTurnsJsonlPath,
  DEFAULT_AGENT_STATE_DIR,
  TURNS_JSONL_MAX_BYTES,
  type RotateFs,
} from '../gateway/turns-jsonl-rotate.js'

const GATEWAY_SRC = readFileSync(
  resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('maybeRotate — turns.jsonl size cap', () => {
  const mkFs = (size: number | undefined) => {
    const rename = vi.fn()
    const fs: RotateFs = { statSize: () => size, rename }
    return { fs, rename }
  }

  it('does not rotate below the cap', () => {
    const { fs, rename } = mkFs(TURNS_JSONL_MAX_BYTES - 1)
    expect(maybeRotate('/state/agent/turns.jsonl', fs)).toBe(false)
    expect(rename).not.toHaveBeenCalled()
  })

  it('rotates at/over the cap → renames to <path>.1', () => {
    const { fs, rename } = mkFs(TURNS_JSONL_MAX_BYTES)
    expect(maybeRotate('/state/agent/turns.jsonl', fs)).toBe(true)
    expect(rename).toHaveBeenCalledWith('/state/agent/turns.jsonl', '/state/agent/turns.jsonl.1')
  })

  it('absent file (statSize undefined) → no rotation', () => {
    const { fs, rename } = mkFs(undefined)
    expect(maybeRotate('/state/agent/turns.jsonl', fs)).toBe(false)
    expect(rename).not.toHaveBeenCalled()
  })

  it('rotation is bounded to one generation (overwrites <path>.1)', () => {
    // A second rotation renames onto the same .1 target — no unbounded
    // accumulation of generations.
    const { fs, rename } = mkFs(TURNS_JSONL_MAX_BYTES * 3)
    maybeRotate('/a/turns.jsonl', fs)
    maybeRotate('/a/turns.jsonl', fs)
    expect(rename).toHaveBeenNthCalledWith(1, '/a/turns.jsonl', '/a/turns.jsonl.1')
    expect(rename).toHaveBeenNthCalledWith(2, '/a/turns.jsonl', '/a/turns.jsonl.1')
  })
})

describe('resolveTurnsJsonlPath — the turn record must follow the state dir', () => {
  // Regression: the path was hard-coded to `/state/agent/turns.jsonl`, so a test
  // that isolated TELEGRAM_STATE_DIR / SWITCHROOM_AGENT_STATE_DIR into a tmpdir
  // still appended its synthetic turn rows into the PRODUCTION turn record of
  // whichever agent container it ran in — which the fleet-health L0 sensor then
  // scored as that agent's real production failures.
  it('honours SWITCHROOM_AGENT_STATE_DIR', () => {
    expect(resolveTurnsJsonlPath({ SWITCHROOM_AGENT_STATE_DIR: '/tmp/iso-123' })).toBe(
      '/tmp/iso-123/turns.jsonl',
    )
  })

  it('strips a trailing slash rather than doubling it', () => {
    expect(resolveTurnsJsonlPath({ SWITCHROOM_AGENT_STATE_DIR: '/tmp/iso-123/' })).toBe(
      '/tmp/iso-123/turns.jsonl',
    )
  })

  it('falls back to the container default when unset or blank', () => {
    expect(resolveTurnsJsonlPath({})).toBe(`${DEFAULT_AGENT_STATE_DIR}/turns.jsonl`)
    expect(resolveTurnsJsonlPath({ SWITCHROOM_AGENT_STATE_DIR: '   ' })).toBe(
      `${DEFAULT_AGENT_STATE_DIR}/turns.jsonl`,
    )
  })
})

describe('resolveAgentStateDir — ONE normaliser for every writer in the state dir', () => {
  // The gateway had two writers into this dir 26 lines apart reading the env
  // var two different ways: the turn record via the normaliser, the
  // context-occupancy snapshot via a bare `process.env.X ?? '/state/agent'`.
  // For a value like `/x/ ` those resolve to different directories, so the two
  // artifacts of the same turn land in two places.
  it('trims, strips a trailing slash, and treats blank as unset', () => {
    expect(resolveAgentStateDir({ SWITCHROOM_AGENT_STATE_DIR: '/x' })).toBe('/x')
    expect(resolveAgentStateDir({ SWITCHROOM_AGENT_STATE_DIR: '  /x/  ' })).toBe('/x')
    expect(resolveAgentStateDir({ SWITCHROOM_AGENT_STATE_DIR: '/x///' })).toBe('/x')
    expect(resolveAgentStateDir({ SWITCHROOM_AGENT_STATE_DIR: '  ' })).toBe(DEFAULT_AGENT_STATE_DIR)
    expect(resolveAgentStateDir({})).toBe(DEFAULT_AGENT_STATE_DIR)
  })

  it('the turn record and the state dir agree for any messy value', () => {
    const env = { SWITCHROOM_AGENT_STATE_DIR: ' /tmp/iso-9/ ' }
    expect(resolveTurnsJsonlPath(env)).toBe(`${resolveAgentStateDir(env)}/turns.jsonl`)
  })
})

describe('gateway.ts call sites — the defect site itself, not just the helper', () => {
  // The bug was a hard-coded literal at the CALLSITE. A unit test of the pure
  // helper passes with the literal re-inlined, so these read the real source.
  // Source-text assertions are the repo's cheap deterministic pattern for
  // pinning a callsite (see per-topic-current-turn.test.ts).
  it('emitTurnRecord resolves the path — the hard-coded literal is gone', () => {
    const body = GATEWAY_SRC.split('function emitTurnRecord(')[1]?.split('\n}')[0] ?? ''
    expect(body.length).toBeGreaterThan(50)
    expect(body).toMatch(/const turnsPath = resolveTurnsJsonlPath\(\)/)
    // The append + the rotate both use the RESOLVED path, not a literal.
    expect(body).toMatch(/appendFileSync\(turnsPath, /)
    expect(body).toMatch(/maybeRotate\(turnsPath, /)
    expect(body).not.toMatch(/turns\.jsonl/)
  })

  it('no hard-coded turns.jsonl path survives anywhere in gateway.ts', () => {
    const hits = GATEWAY_SRC.match(/['"`][^'"`\n]*\/turns\.jsonl['"`]/g) ?? []
    expect(hits, `hard-coded turns.jsonl path(s): ${JSON.stringify(hits)}`).toEqual([])
  })

  it('every state-dir read in gateway.ts goes through resolveAgentStateDir', () => {
    // Consistency, not style: a second inline `process.env.X ?? '/state/agent'`
    // silently opts that writer out of trim + trailing-slash normalisation.
    const inline = GATEWAY_SRC.match(/process\.env\.SWITCHROOM_AGENT_STATE_DIR/g) ?? []
    expect(inline, `inline state-dir read(s) in gateway.ts: ${inline.length}`).toEqual([])
    expect(GATEWAY_SRC).toMatch(/resolveAgentStateDir\(\)/)
  })
})
