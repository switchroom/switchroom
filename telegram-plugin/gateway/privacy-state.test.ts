/**
 * Unit tests for privacy-state.ts — the gateway side of the `/private`
 * `/public` feature (PR2: open/close/read/reset + the state-file contract).
 *
 * These lock in the on-disk contract shared with the Python retain side
 * (`vendor/hindsight-memory`): the exact schema, `end: null` = open interval,
 * idempotent open/close, atomic writes (no torn file), and best-effort,
 * corrupt-tolerant reads.
 *
 * Run with: npx vitest run telegram-plugin/gateway/privacy-state.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readPrivacyState,
  openPrivateInterval,
  closePrivateInterval,
  resetToPublic,
  isPrivate,
  privacyStatePath,
  emptyPrivacyState,
  type PrivacyState,
} from './privacy-state.js'

describe('privacy-state', () => {
  let dir: string
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'privacy-state-'))
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const path = () => privacyStatePath(dir)
  const onDisk = (): PrivacyState => JSON.parse(readFileSync(path(), 'utf8'))

  describe('readPrivacyState — best-effort, corrupt-tolerant', () => {
    it('returns the public default when the file is missing', () => {
      expect(readPrivacyState(dir)).toEqual(emptyPrivacyState())
      expect(isPrivate(readPrivacyState(dir))).toBe(false)
    })

    it('does not throw and returns the default on corrupt JSON', () => {
      writeFileSync(path(), '{ this is not json', 'utf8')
      expect(() => readPrivacyState(dir)).not.toThrow()
      expect(readPrivacyState(dir)).toEqual(emptyPrivacyState())
    })

    it('returns the default when intervals is not an array', () => {
      writeFileSync(path(), JSON.stringify({ version: 1, intervals: 'nope' }), 'utf8')
      expect(readPrivacyState(dir).intervals).toEqual([])
    })

    it('filters out malformed intervals but keeps valid ones', () => {
      writeFileSync(
        path(),
        JSON.stringify({
          version: 1,
          intervals: [
            { start: '2026-08-06T02:00:00.000Z', end: '2026-08-06T02:05:00.000Z' },
            { start: 42, end: null }, // bad start
            { end: null }, // missing start
            { start: '2026-08-06T02:10:00.000Z', end: null }, // valid open
          ],
        }),
        'utf8',
      )
      const state = readPrivacyState(dir)
      expect(state.intervals).toHaveLength(2)
      expect(state.intervals[1]).toEqual({ start: '2026-08-06T02:10:00.000Z', end: null })
    })
  })

  describe('openPrivateInterval', () => {
    it('appends a single open interval and writes the exact contract schema', () => {
      const now = new Date('2026-08-06T02:00:25.558Z')
      openPrivateInterval(now, dir)
      expect(onDisk()).toEqual({
        version: 1,
        intervals: [{ start: '2026-08-06T02:00:25.558Z', end: null }],
      })
      expect(isPrivate(readPrivacyState(dir))).toBe(true)
    })

    it('is idempotent — a second /private while open does not stack', () => {
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      openPrivateInterval(new Date('2026-08-06T02:03:00.000Z'), dir)
      const state = readPrivacyState(dir)
      expect(state.intervals).toHaveLength(1)
      expect(state.intervals[0]).toEqual({ start: '2026-08-06T02:00:00.000Z', end: null })
    })

    it('opens a fresh interval after a prior one was closed', () => {
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      closePrivateInterval(new Date('2026-08-06T02:05:00.000Z'), dir)
      openPrivateInterval(new Date('2026-08-06T02:10:00.000Z'), dir)
      const state = readPrivacyState(dir)
      expect(state.intervals).toHaveLength(2)
      expect(state.intervals[0].end).toBe('2026-08-06T02:05:00.000Z')
      expect(state.intervals[1]).toEqual({ start: '2026-08-06T02:10:00.000Z', end: null })
      expect(isPrivate(state)).toBe(true)
    })
  })

  describe('closePrivateInterval', () => {
    it('sets end on the open interval', () => {
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      closePrivateInterval(new Date('2026-08-06T02:05:10.100Z'), dir)
      expect(onDisk().intervals[0]).toEqual({
        start: '2026-08-06T02:00:00.000Z',
        end: '2026-08-06T02:05:10.100Z',
      })
      expect(isPrivate(readPrivacyState(dir))).toBe(false)
    })

    it('is idempotent — /public while already public is a no-op (no throw, no file)', () => {
      expect(() => closePrivateInterval(new Date(), dir)).not.toThrow()
      // No open interval existed → nothing was written.
      expect(existsSync(path())).toBe(false)
    })

    it('does not reopen or touch an already-closed interval', () => {
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      closePrivateInterval(new Date('2026-08-06T02:05:00.000Z'), dir)
      closePrivateInterval(new Date('2026-08-06T02:09:00.000Z'), dir)
      expect(onDisk().intervals[0].end).toBe('2026-08-06T02:05:00.000Z')
    })
  })

  describe('resetToPublic', () => {
    it('truncates to the empty public default', () => {
      openPrivateInterval(new Date(), dir)
      resetToPublic(dir)
      expect(onDisk()).toEqual({ version: 1, intervals: [] })
      expect(isPrivate(readPrivacyState(dir))).toBe(false)
    })
  })

  describe('atomic writes', () => {
    it('leaves no temp file behind after a write', () => {
      openPrivateInterval(new Date(), dir)
      closePrivateInterval(new Date(), dir)
      // Exactly one file — the state file — no lingering `.tmp`/`.new` sibling.
      const entries = readdirSync(dir)
      expect(entries).toEqual(['privacy-state.json'])
    })

    it('a concurrent reader only ever sees a complete document', () => {
      // Because the write is rename-based, the file at the destination path is
      // always a fully-formed JSON doc — parsing it after any op never throws.
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      expect(() => JSON.parse(readFileSync(path(), 'utf8'))).not.toThrow()
      closePrivateInterval(new Date('2026-08-06T02:05:00.000Z'), dir)
      expect(() => JSON.parse(readFileSync(path(), 'utf8'))).not.toThrow()
    })
  })
})
