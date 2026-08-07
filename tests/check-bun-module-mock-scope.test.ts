/**
 * Unit tests for the `check-bun-module-mock-scope` lint gate.
 *
 * The gate exists because bun's `vi.mock` is process-global (see the script
 * header for the PR #3632 breakage it reproduces). These tests pin the pure
 * decision — comment stripping, specifier discovery, boundary evaluation — so
 * the gate itself can't silently stop gating.
 */

import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs lint script, no type declarations
import { stripComments, findModuleMocks, evaluateMock } from '../scripts/check-bun-module-mock-scope.mjs'

const SWEPT = 'telegram-plugin/tests/example.test.ts'

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments("a // gone\nb")).toBe('a \nb')
    expect(stripComments('a /* gone */ b')).toBe('a  b')
  })

  it('leaves `//` inside string and template literals alone', () => {
    expect(stripComments("const u = 'https://x'")).toBe("const u = 'https://x'")
    expect(stripComments('const u = `https://x`')).toBe('const u = `https://x`')
  })

  it('does not choke on an escaped quote', () => {
    expect(stripComments("const s = 'it\\'s' // gone")).toBe("const s = 'it\\'s' ")
  })
})

describe('findModuleMocks', () => {
  it('finds vi.mock and mock.module specifiers with line numbers', () => {
    const src = ["import x from 'y'", "vi.mock('../a.js', () => ({}))", "mock.module('../b.js', () => ({}))"].join('\n')
    expect(findModuleMocks(src)).toEqual([
      { spec: '../a.js', line: 2 },
      { spec: '../b.js', line: 3 },
    ])
  })

  it('IGNORES a mock that only appears in prose — a file may document the hazard', () => {
    // Several suites explain in comments why they do NOT module-mock. Flagging
    // that comment would punish exactly the files doing the right thing.
    const src = "// We do NOT vi.mock('../../src/vault/broker/client.js') — it leaks.\nconst a = 1"
    expect(findModuleMocks(src)).toEqual([])
  })

  it('tolerates whitespace between the callee and the specifier', () => {
    expect(findModuleMocks("vi.mock(\n  '../a.js',\n)")).toEqual([{ spec: '../a.js', line: 1 }])
  })
})

describe('evaluateMock', () => {
  it('REJECTS a mock that escapes telegram-plugin/ (the #3632 regression)', () => {
    const v = evaluateMock(SWEPT, '../../src/vault/broker/client.js', 41)
    expect(v).not.toBeNull()
    expect(v.resolved).toBe('src/vault/broker/client.js')
    expect(v.line).toBe(41)
  })

  it('allows a mock that stays inside telegram-plugin/ and is not separately banned', () => {
    expect(evaluateMock(SWEPT, '../gateway/auth-broker-client.js', 58)).toBeNull()
  })

  it('REJECTS a module-mock of history.js — the #4488/#4491 collision', () => {
    // `tests/captured-answer-resume.test.ts` used to `vi.mock('../history.js', ...)`
    // with a default stub that always returned false. Under bun's process-global
    // `mock.module`, that leaked into `tests/history.test.ts`'s calls to the REAL
    // `hasOutboundWithText`, producing the exact "Expected: true / Received: false"
    // signature CI saw intermittently. This gate must reject that mock outright,
    // not merely allow it because the specifier resolves inside telegram-plugin/.
    const v = evaluateMock(SWEPT, '../history.js', 8)
    expect(v).not.toBeNull()
    expect(v.banned).toBe(true)
    expect(v.resolved).toBe('telegram-plugin/history.js')

    // Any relative depth / .ts spelling of the same module is caught too.
    expect(evaluateMock('telegram-plugin/gateway/sub/x.test.ts', '../../history.ts', 1)?.banned).toBe(true)
  })

  it('allows a bare package specifier (not a first-party module)', () => {
    expect(evaluateMock(SWEPT, 'grammy', 1)).toBeNull()
  })

  it('is not fooled by a path that merely starts with the boundary name', () => {
    // `telegram-plugin-extras/` must NOT be accepted as inside
    // `telegram-plugin/` — the check is a path-segment boundary, not a prefix.
    const v = evaluateMock('telegram-plugin/tests/x.test.ts', '../../telegram-plugin-extras/y.js', 3)
    expect(v).not.toBeNull()
    expect(v.resolved).toBe('telegram-plugin-extras/y.js')
  })
})
