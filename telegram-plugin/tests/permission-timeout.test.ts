/**
 * Unit tests for the pure permission-timeout helpers (no-repeat-on-timeout).
 *
 * Pins the behaviour that closes the marko Rentals-budget retry loop
 * (2026-06-17): a TTL auto-deny must be distinguishable from a real denial,
 * and an identical retry shortly after a timeout (operator still absent) must
 * be recognisable so the gateway can suppress the duplicate card.
 */

import { describe, it, expect } from 'vitest'
import {
  permissionSignature,
  timeoutDenyMessage,
  duplicateDenyMessage,
  isRecentTimeoutDuplicate,
} from '../gateway/permission-timeout.js'

describe('permissionSignature', () => {
  it('is stable for the same tool + input', () => {
    expect(permissionSignature('mcp__meta_ads__set_budget', '{"id":"1","budget":1400}'))
      .toBe(permissionSignature('mcp__meta_ads__set_budget', '{"id":"1","budget":1400}'))
  })

  it('differs when the tool differs', () => {
    expect(permissionSignature('toolA', 'x')).not.toBe(permissionSignature('toolB', 'x'))
  })

  it('differs when the input differs', () => {
    expect(permissionSignature('t', 'Rentals $14')).not.toBe(permissionSignature('t', 'Land $60'))
  })

  it('does not collide across the tool/input boundary (NUL-separated)', () => {
    // A space separator would make ("a b","c") and ("a","b c") collide.
    expect(permissionSignature('a b', 'c')).not.toBe(permissionSignature('a', 'b c'))
  })
})

describe('timeoutDenyMessage', () => {
  it('names the timeout, the minutes, and tells the model not to retry', () => {
    const msg = timeoutDenyMessage(10)
    expect(msg).toContain('10 minutes')
    expect(msg).toMatch(/timeout/i)
    expect(msg).toMatch(/not a denial/i)
    expect(msg).toMatch(/do not retry/i)
  })

  it('is a non-empty string (wire-validator requires non-empty)', () => {
    expect(timeoutDenyMessage(5).length).toBeGreaterThan(0)
  })
})

describe('duplicateDenyMessage', () => {
  it('tells the model to stop re-requesting and is non-empty', () => {
    expect(duplicateDenyMessage).toMatch(/do not keep re-requesting/i)
    expect(duplicateDenyMessage.length).toBeGreaterThan(0)
  })
})

describe('isRecentTimeoutDuplicate', () => {
  const WINDOW = 60 * 60_000
  const NOW = 1_000_000_000_000

  it('false when the signature was never recorded', () => {
    expect(isRecentTimeoutDuplicate(new Map(), 'sig', NOW, WINDOW)).toBe(false)
  })

  it('true when the signature timed out within the window', () => {
    const m = new Map([['sig', NOW - 5 * 60_000]])
    expect(isRecentTimeoutDuplicate(m, 'sig', NOW, WINDOW)).toBe(true)
  })

  it('false when the timeout is older than the window', () => {
    const m = new Map([['sig', NOW - 2 * WINDOW]])
    expect(isRecentTimeoutDuplicate(m, 'sig', NOW, WINDOW)).toBe(false)
  })

  it('true exactly at the window boundary', () => {
    const m = new Map([['sig', NOW - WINDOW]])
    expect(isRecentTimeoutDuplicate(m, 'sig', NOW, WINDOW)).toBe(true)
  })

  it('only matches the exact signature', () => {
    const m = new Map([[permissionSignature('t', 'Rentals'), NOW]])
    expect(isRecentTimeoutDuplicate(m, permissionSignature('t', 'Land'), NOW, WINDOW)).toBe(false)
    expect(isRecentTimeoutDuplicate(m, permissionSignature('t', 'Rentals'), NOW, WINDOW)).toBe(true)
  })
})
