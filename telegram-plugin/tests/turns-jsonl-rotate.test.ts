import { describe, expect, it, vi } from 'vitest'

import { maybeRotate, TURNS_JSONL_MAX_BYTES, type RotateFs } from '../gateway/turns-jsonl-rotate.js'

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
