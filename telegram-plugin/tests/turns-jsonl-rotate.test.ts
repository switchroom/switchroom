import { describe, expect, it, vi } from 'vitest'

import {
  maybeRotate,
  resolveTurnsJsonlPath,
  DEFAULT_AGENT_STATE_DIR,
  TURNS_JSONL_MAX_BYTES,
  type RotateFs,
} from '../gateway/turns-jsonl-rotate.js'

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
