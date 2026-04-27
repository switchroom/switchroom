/**
 * Unit tests for access-validator.ts — validateStringArray.
 *
 * This function guards access.json fields at load time. The motivating bug:
 * a hand-edit that drops quotes around IDs (`[8248703757]` instead of
 * `["8248703757"]`) produces a valid JSON number array. Array.includes() uses
 * strict equality, so number entries never match the string comparison in the
 * gate — every DM is silently dropped.
 *
 * Run with: npx vitest run telegram-plugin/gateway/access-validator.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateStringArray } from './access-validator.js'

describe('validateStringArray', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  // ─── Happy path ────────────────────────────────────────────────────────────

  it('returns the array unchanged for a valid string array', () => {
    expect(validateStringArray('allowFrom', ['8248703757', '9999'])).toEqual(['8248703757', '9999'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('returns [] for an empty array without warning', () => {
    expect(validateStringArray('allowFrom', [])).toEqual([])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('defaults to [] when value is undefined (missing field)', () => {
    expect(validateStringArray('allowFrom', undefined)).toEqual([])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('defaults to [] when value is null', () => {
    expect(validateStringArray('allowFrom', null)).toEqual([])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  // ─── Bug reproduction: number array ────────────────────────────────────────

  it('rejects a number array (the hand-edit bug) and returns []', () => {
    // This is the exact bug: [8248703757] parses as a number, not a string.
    // Array.includes("8248703757") === false for a number entry — silently drops DMs.
    const result = validateStringArray('allowFrom', [8248703757])
    expect(result).toEqual([])
    expect(stderrSpy).toHaveBeenCalled()
    const msg = String(stderrSpy.mock.calls[0][0])
    expect(msg).toContain('allowFrom')
    expect(msg).toContain('non-string entries')
    expect(msg).toContain('8248703757')
  })

  // ─── Mixed array ──────────────────────────────────────────────────────────

  it('rejects a mixed array (some strings, some numbers) and returns []', () => {
    const result = validateStringArray('allowFrom', ['8248703757', 9999])
    expect(result).toEqual([])
    expect(stderrSpy).toHaveBeenCalled()
    const msg = String(stderrSpy.mock.calls[0][0])
    expect(msg).toContain('non-string entries')
  })

  // ─── Tag in error message ─────────────────────────────────────────────────

  it('includes the tag in the stderr message (gateway)', () => {
    validateStringArray('allowFrom', [123], 'gateway')
    const msg = String(stderrSpy.mock.calls[0][0])
    expect(msg).toContain('telegram gateway')
  })

  it('includes the tag in the stderr message (channel)', () => {
    validateStringArray('allowFrom', [123], 'channel')
    const msg = String(stderrSpy.mock.calls[0][0])
    expect(msg).toContain('telegram channel')
  })

  // ─── Non-array inputs ─────────────────────────────────────────────────────

  it('returns [] without warning for non-array values (object, string, number)', () => {
    expect(validateStringArray('allowFrom', {})).toEqual([])
    expect(validateStringArray('allowFrom', 'oops')).toEqual([])
    expect(validateStringArray('allowFrom', 42)).toEqual([])
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})
