/**
 * Unit tests for the #3891 callback-path wrapping guard.
 *
 * The guard replaces a review convention that demonstrably failed: two
 * existing lint gates were green for the whole life of `finalizeCallback`
 * while it called `ctx.answerCallbackQuery` / `ctx.editMessageText` raw, so
 * every operator button tap sat outside the retry/flood policy. These tests
 * pin the two rules and the escape hatch, then run the guard over the real
 * tree so a stale inventory reds here as well as in lint.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateCallbackCtxWrapping,
  countRawCallbackCtxCalls,
  checkFinalizeSeam,
  BASELINE_PATH,
} from '../scripts/check-callback-ctx-wrapping.mjs'

describe('rule 1 — finalizeCallback must be handed the retry seam', () => {
  it('flags a call site with no apiCall', () => {
    const errs = checkFinalizeSeam(
      'x.ts',
      `await finalizeCallback(ctx, { ackText: 'ok', newText: 'y' })`,
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('omits `apiCall`')
  })

  it('accepts a call site that passes apiCall, including multi-line', () => {
    const errs = checkFinalizeSeam(
      'x.ts',
      [
        'await finalizeCallback(ctx, {',
        "  ackText: 'ok',",
        '  apiCall: robustApiCall,',
        "  newText: 'y',",
        '})',
      ].join('\n'),
    )
    expect(errs).toEqual([])
  })

  it('does NOT flag the declaration of finalizeCallback itself', () => {
    const errs = checkFinalizeSeam(
      'x.ts',
      'export async function finalizeCallback(\n  ctx: FinalizeCallbackContext,\n): Promise<void> {}',
    )
    expect(errs).toEqual([])
  })

  it('is not fooled by an `apiCall` mentioned only in a NEIGHBOURING call', () => {
    // The seam must be inside THIS call's arguments; a sibling call carrying
    // it does not make this one safe.
    const errs = checkFinalizeSeam(
      'x.ts',
      [
        "await finalizeCallback(ctx, { ackText: 'a', newText: 'b' })",
        "await finalizeCallback(ctx, { ackText: 'c', newText: 'd', apiCall: robustApiCall })",
      ].join('\n'),
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('x.ts:1')
  })
})

describe('rule 2 — raw callback-context calls are counted, wrapped ones are not', () => {
  it('counts a bare ctx.answerCallbackQuery / editMessageText / editMessageReplyMarkup', () => {
    const { count } = countRawCallbackCtxCalls(
      'x.ts',
      [
        "await ctx.answerCallbackQuery({ text: 'no' })",
        "await ctx.editMessageText('x')",
        'await ctx.editMessageReplyMarkup({})',
      ].join('\n'),
    )
    expect(count).toBe(3)
  })

  it('counts the ctx.api.* infix form too', () => {
    const { count } = countRawCallbackCtxCalls('x.ts', "await ctx.api.editMessageText(1, 2, 'x')")
    expect(count).toBe(1)
  })

  it('does NOT count a call inside a robustApiCall / apiCall closure', () => {
    const { count } = countRawCallbackCtxCalls(
      'x.ts',
      [
        'await robustApiCall(',
        '  () =>',
        "    ctx.editMessageText('x', {}),",
        '  { verb: '.concat("'editMessageText' },"),
        ')',
      ].join('\n'),
    )
    expect(count).toBe(0)
  })

  it('does NOT count a mention inside a comment', () => {
    const { count } = countRawCallbackCtxCalls(
      'x.ts',
      ' * pre-#265 this did `await ctx.answerCallbackQuery()` unconditionally',
    )
    expect(count).toBe(0)
  })

  it('honours the escape hatch when a reason is given', () => {
    const r = countRawCallbackCtxCalls(
      'x.ts',
      [
        '// allow-raw-callback-ctx: early-return auth reject, nothing to retry',
        "await ctx.answerCallbackQuery({ text: 'Not authorized.' })",
      ].join('\n'),
    )
    expect(r.count).toBe(0)
    expect(r.errors).toEqual([])
  })

  it('rejects the escape hatch with no reason', () => {
    const r = countRawCallbackCtxCalls(
      'x.ts',
      ['// allow-raw-callback-ctx:', 'await ctx.answerCallbackQuery({})'].join('\n'),
    )
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('with no reason')
  })
})

describe('the ratchet', () => {
  const raw = (n) => Array.from({ length: n }, () => 'await ctx.answerCallbackQuery({})').join('\n')

  it('passes when the count matches the inventory exactly', () => {
    const r = evaluateCallbackCtxWrapping([{ path: 'a.ts', source: raw(3) }], { 'a.ts': 3 })
    expect(r.ok).toBe(true)
  })

  it('FAILS when a new raw call lands (count above the inventory)', () => {
    const r = evaluateCallbackCtxWrapping([{ path: 'a.ts', source: raw(4) }], { 'a.ts': 3 })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('inventory says 3')
  })

  it('FAILS for a file with no inventory entry at all', () => {
    const r = evaluateCallbackCtxWrapping([{ path: 'new.ts', source: raw(1) }], {})
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('inventory says 0')
  })

  it('FAILS when calls were removed but the inventory was not lowered', () => {
    const r = evaluateCallbackCtxWrapping([{ path: 'a.ts', source: raw(1) }], { 'a.ts': 3 })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('lower the number')
  })

  it('FAILS when an inventoried file is gone from the tree (renamed / deleted)', () => {
    const r = evaluateCallbackCtxWrapping([{ path: 'b.ts', source: raw(1) }], { 'a.ts': 3, 'b.ts': 1 })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('Remove the entry'))).toBe(true)
  })

  it('FAILS with the lower-the-number message when a scanned file was fully converted', () => {
    const r = evaluateCallbackCtxWrapping([{ path: 'a.ts', source: '// clean' }], { 'a.ts': 3 })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('lower the number')
  })
})

describe('the real tree', () => {
  it('matches the checked-in inventory and every finalizeCallback carries the seam', async () => {
    const { readFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const { resolve } = await import('node:path')
    const repoRoot = resolve(import.meta.dirname, '..')
    const baseline = JSON.parse(readFileSync(resolve(repoRoot, BASELINE_PATH), 'utf-8')).files

    const listed = execFileSync(
      'git',
      ['ls-files', '--', 'telegram-plugin/**/*.ts', 'src/**/*.ts'],
      { cwd: repoRoot, encoding: 'utf-8' },
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(
        (p) =>
          !p.endsWith('.test.ts') &&
          !p.endsWith('.d.ts') &&
          !p.includes('/tests/') &&
          !p.includes('/uat/'),
      )

    const files = []
    for (const rel of listed) {
      let source
      try {
        source = readFileSync(resolve(repoRoot, rel), 'utf-8')
      } catch {
        continue
      }
      if (!source.includes('ctx.') && !source.includes('finalizeCallback')) continue
      files.push({ path: rel, source })
    }

    const r = evaluateCallbackCtxWrapping(files, baseline)
    expect(r.errors).toEqual([])
    // Sanity: the guard is actually scanning real files, so the assertion
    // above is not vacuously true on an empty set.
    expect(Object.keys(r.actual).length).toBeGreaterThanOrEqual(5)
  })

  it('inline-keyboard-callbacks.ts has ZERO raw callback-context calls', async () => {
    // The regression this whole PR exists for. If `finalizeCallback` ever
    // reaches for `ctx.*` directly again, this reds — no inventory edit can
    // hide it, because the file is deliberately absent from the inventory.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const repoRoot = resolve(import.meta.dirname, '..')
    const rel = 'telegram-plugin/inline-keyboard-callbacks.ts'
    const source = readFileSync(resolve(repoRoot, rel), 'utf-8')
    expect(countRawCallbackCtxCalls(rel, source).count).toBe(0)
  })
})
