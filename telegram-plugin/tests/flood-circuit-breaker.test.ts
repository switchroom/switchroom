import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeFloodWait,
  floodWaitRemainingMs,
  isFloodWaitActive,
  readFloodState,
  writeFloodState,
  makeFloodWaitRecorder,
  suppressNonEssentialSendMs,
  floodStatePath,
  type FloodWaitState,
} from '../flood-circuit-breaker.js'

describe('#2923 flood circuit-breaker', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flood-cb-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records a flood-wait window from retry_after', () => {
    const now = 1_000_000
    const s = computeFloodWait(null, 4116, now)
    expect(s.untilTs).toBe(now + 4116_000)
    expect(s.retryAfterSec).toBe(4116)
    expect(isFloodWaitActive(s, now)).toBe(true)
    expect(isFloodWaitActive(s, s.untilTs + 1)).toBe(false)
  })

  it('EXTENDS (never shrinks) an existing window on a fresh, shorter 429', () => {
    const now = 1_000_000
    const long = computeFloodWait(null, 4000, now)
    // A later 429 reporting a shorter ban must not pull the expiry earlier.
    const shorter = computeFloodWait(long, 10, now + 1000)
    expect(shorter.untilTs).toBe(long.untilTs)
  })

  it('floodWaitRemainingMs is 0 for no state / expired state', () => {
    expect(floodWaitRemainingMs(null, 5)).toBe(0)
    const expired: FloodWaitState = { untilTs: 100, retryAfterSec: 1, recordedTs: 0 }
    expect(floodWaitRemainingMs(expired, 200)).toBe(0)
  })

  it('persists + reads back the window; corrupt marker → null', () => {
    const p = floodStatePath(dir)
    expect(readFloodState(p)).toBeNull()
    const s = computeFloodWait(null, 60, 1000)
    writeFloodState(p, s)
    expect(readFloodState(p)).toEqual(s)
    writeFileSync(p, '{bad')
    expect(readFloodState(p)).toBeNull()
  })

  it('makeFloodWaitRecorder persists the window (the onFloodWait hook)', () => {
    const p = floodStatePath(dir)
    const record = makeFloodWaitRecorder(p, () => 500_000)
    record(4116)
    const s = readFloodState(p)
    expect(s).not.toBeNull()
    expect(s!.untilTs).toBe(500_000 + 4116_000)
  })

  it('suppressNonEssentialSendMs > 0 while a ban is open, 0 after it lifts', () => {
    const p = floodStatePath(dir)
    writeFloodState(p, computeFloodWait(null, 68 * 60, 1_000_000))
    // A restart mid-ban: the boot card must be suppressed.
    expect(suppressNonEssentialSendMs(p, 1_000_000)).toBeGreaterThan(0)
    // After the window: send proceeds.
    expect(suppressNonEssentialSendMs(p, 1_000_000 + 68 * 60_000 + 1)).toBe(0)
  })
})
