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
  approvalTtlMs,
  PERMISSION_TTL_MS,
  PERMISSION_TTL_DEFAULT_MS,
  HOSTD_PERMISSION_TTL_MS,
  ttlForTool,
  buildTimedOutCardEdits,
  buildCancelledCardEdits,
  CANCELLED_FOOTER,
  isStaleTap,
  STALE_TAP_NOTICE,
  TIMED_OUT_FOOTER,
} from '../gateway/permission-timeout.js'

describe('approvalTtlMs (config-driven approval-card lifetime)', () => {
  it('defaults to 60 minutes when unset', () => {
    expect(approvalTtlMs({})).toBe(60 * 60_000)
    expect(PERMISSION_TTL_DEFAULT_MS).toBe(60 * 60_000)
  })

  it('honours a configured value (threaded as SWITCHROOM_TG_APPROVAL_TIMEOUT_MS ms)', () => {
    expect(approvalTtlMs({ SWITCHROOM_TG_APPROVAL_TIMEOUT_MS: '1800000' })).toBe(1_800_000)
  })

  it('falls back to the 60-min default on blank / garbage / non-positive', () => {
    const d = 60 * 60_000
    expect(approvalTtlMs({ SWITCHROOM_TG_APPROVAL_TIMEOUT_MS: '' })).toBe(d)
    expect(approvalTtlMs({ SWITCHROOM_TG_APPROVAL_TIMEOUT_MS: 'abc' })).toBe(d)
    expect(approvalTtlMs({ SWITCHROOM_TG_APPROVAL_TIMEOUT_MS: '0' })).toBe(d)
    expect(approvalTtlMs({ SWITCHROOM_TG_APPROVAL_TIMEOUT_MS: '-5' })).toBe(d)
  })

  it('the default permission-card lifetime is at least 60 min', () => {
    // With no env override at module load, PERMISSION_TTL_MS is the default.
    expect(PERMISSION_TTL_MS).toBeGreaterThanOrEqual(60 * 60_000)
  })

  it('hostd verbs never get a shorter window than the default card', () => {
    expect(HOSTD_PERMISSION_TTL_MS).toBeGreaterThanOrEqual(PERMISSION_TTL_MS)
    expect(HOSTD_PERMISSION_TTL_MS).toBeGreaterThanOrEqual(30 * 60_000)
  })
})

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

// ─── Bug 2 — per-tool TTL, timed-out card hygiene, stale-tap honesty ────────

describe('ttlForTool (Bug 2 fix #2)', () => {
  it('gives hostd gated verbs at least a 30-min window (>= the default card)', () => {
    for (const tool of [
      'mcp__hostd__rollout',
      'mcp__hostd__update_apply',
      'mcp__hostd__agent_restart',
      'mcp__hostd__agent_exec',
      'mcp__hostd__config_propose_edit',
    ]) {
      expect(ttlForTool(tool)).toBe(HOSTD_PERMISSION_TTL_MS)
      expect(ttlForTool(tool)).toBeGreaterThanOrEqual(30 * 60_000)
    }
  })

  it('applies the config-driven default (60 min) to non-hostd tools', () => {
    expect(ttlForTool('Bash')).toBe(PERMISSION_TTL_MS)
    expect(ttlForTool('Bash')).toBe(60 * 60_000)
    expect(ttlForTool('mcp__perplexity__search')).toBe(PERMISSION_TTL_MS)
    expect(ttlForTool('mcp__agent-config__schedule_add')).toBe(PERMISSION_TTL_MS)
    expect(ttlForTool(undefined)).toBe(PERMISSION_TTL_MS)
  })

  it('hostd TTL is never shorter than the default (the 60-min raise subsumes the old 30-min floor)', () => {
    expect(HOSTD_PERMISSION_TTL_MS).toBeGreaterThanOrEqual(PERMISSION_TTL_MS)
  })
})

describe('buildTimedOutCardEdits (Bug 2 fix #1 — strip stale keyboard)', () => {
  it('marks every recorded card for keyboard-strip and appends the footer', () => {
    const cards = [
      { chatId: '111', messageId: 5 },
      { chatId: '222', messageId: 9 },
    ]
    const edits = buildTimedOutCardEdits('🔐 **Overlord** wants to roll the fleet', cards)
    expect(edits).toHaveLength(2)
    for (const [i, edit] of edits.entries()) {
      // The keyboard MUST be stripped — a live Approve on a dead request_id is
      // exactly the bug.
      expect(edit.stripKeyboard).toBe(true)
      expect(edit.chatId).toBe(cards[i]!.chatId)
      expect(edit.messageId).toBe(cards[i]!.messageId)
      expect(edit.text).toContain('roll the fleet')
      expect(edit.text).toContain('Timed out — re-request to act')
      expect(edit.text.endsWith(TIMED_OUT_FOOTER)).toBe(true)
    }
  })

  it('returns no edits when there were no recorded cards', () => {
    expect(buildTimedOutCardEdits('body', [])).toEqual([])
  })
})

describe('buildCancelledCardEdits (#3020 — halt cancels pending cards)', () => {
  it('marks every recorded card for keyboard-strip and appends the cancelled footer', () => {
    const cards = [
      { chatId: '111', messageId: 5 },
      { chatId: '222', messageId: 9 },
    ]
    const edits = buildCancelledCardEdits('🔐 **Overlord** wants to roll the fleet', cards)
    expect(edits).toHaveLength(2)
    for (const [i, edit] of edits.entries()) {
      // Same contract as the timeout path: a live Approve after the halt
      // would dispatch a verdict into an idle session.
      expect(edit.stripKeyboard).toBe(true)
      expect(edit.chatId).toBe(cards[i]!.chatId)
      expect(edit.messageId).toBe(cards[i]!.messageId)
      expect(edit.text).toContain('roll the fleet')
      expect(edit.text.endsWith(CANCELLED_FOOTER)).toBe(true)
    }
  })

  it('returns no edits when there were no recorded cards', () => {
    expect(buildCancelledCardEdits('body', [])).toEqual([])
  })
})

describe('isStaleTap (Bug 2 fix #3 — do not dispatch a verdict for a dead id)', () => {
  it('is stale when no pending entry exists for the tapped request_id', () => {
    // hasPending=false ⇒ the reaper already auto-denied + deleted it.
    expect(isStaleTap(false)).toBe(true)
  })

  it('is NOT stale (live id) when a pending entry still exists', () => {
    expect(isStaleTap(true)).toBe(false)
  })

  it('exposes an honest operator notice for the stale path', () => {
    expect(STALE_TAP_NOTICE).toMatch(/already resolved/i)
    expect(STALE_TAP_NOTICE).toMatch(/ask again/i)
  })
})
