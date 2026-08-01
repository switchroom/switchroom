/**
 * Unit tests for the `check-retry-flood-hooks` lint gate (#3853).
 *
 * The gate exists because #3849 shipped claiming a complete choke point across
 * three `createRetryApiCall` wirings while a fourth sat with neither breaker
 * hook — and that fourth wiring then issued 228 sends into an open 4.4h flood
 * ban. These tests assert the gate would have caught it, and that it cannot be
 * silently defeated by an unexplained exemption.
 */

import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs lint script, no type declarations by design.
import {
  evaluateRetryHookWiring,
  extractCallArgs,
  FACTORY,
} from '../scripts/check-retry-flood-hooks.mjs'

const WIRED = `
const call = createRetryApiCall({
  log: (l) => write(l),
  onFloodWait: (s) => record(s),
  floodWaitRemainingMs: probe,
})
`

/** The exact pre-fix shape of gateway/outbox-sweep.ts:341. */
const UNWIRED = `
const retry = createRetryApiCall({ log: deps.log })
`

const READ_ONLY = `
const call = createRetryApiCall({ floodWaitRemainingMs: probe })
`

const WRITE_ONLY = `
const call = createRetryApiCall({ onFloodWait: (s) => record(s) })
`

describe('evaluateRetryHookWiring', () => {
  it('passes a wiring that carries both hooks', () => {
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: WIRED }])
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.sites).toHaveLength(1)
  })

  it('FAILS the exact pre-fix outbox-sweep wiring, naming both hooks', () => {
    const r = evaluateRetryHookWiring([
      { path: 'telegram-plugin/gateway/outbox-sweep.ts', source: UNWIRED },
    ])
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('outbox-sweep.ts:2')
    expect(r.errors[0]).toContain('floodWaitRemainingMs')
    expect(r.errors[0]).toContain('onFloodWait')
  })

  it('fails a wiring with only the READ hook', () => {
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: READ_ONLY }])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('onFloodWait')
    expect(r.errors[0]).not.toContain('`floodWaitRemainingMs` and')
  })

  it('fails a wiring with only the WRITE hook (the gateway.ts:5877 shape)', () => {
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: WRITE_ONLY }])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('floodWaitRemainingMs')
  })

  it('does NOT flag the declaration of createRetryApiCall itself', () => {
    const src = `export function ${FACTORY}(\n  config: RetryApiCallConfig = {},\n) {}\n`
    const r = evaluateRetryHookWiring([{ path: 'telegram-plugin/retry-api-call.ts', source: src }])
    expect(r.ok).toBe(true)
    expect(r.sites).toHaveLength(0)
  })

  it('honours an exemption WITH a reason', () => {
    const src = `
// retry-flood-hooks-exempt: probe-free by design, the emitter gate short-circuits first
const call = createRetryApiCall({ log })
`
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: src }])
    expect(r.ok).toBe(true)
    expect(r.sites[0].exempt).toBe(true)
    // The site is still RECORDED as missing both hooks — an exemption waives
    // the failure, it does not pretend the wiring is complete.
    expect(r.sites[0].missing).toEqual(['floodWaitRemainingMs', 'onFloodWait'])
  })

  it('REJECTS an exemption with no reason — a bare marker is not a waiver', () => {
    const src = `
// retry-flood-hooks-exempt:
const call = createRetryApiCall({ log })
`
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: src }])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('no reason')
  })

  it('does not let an exemption 6 lines up cover a later call site', () => {
    const src = [
      '// retry-flood-hooks-exempt: stale marker far above',
      '', '', '', '', '', '',
      'const call = createRetryApiCall({ log })',
    ].join('\n')
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: src }])
    expect(r.ok).toBe(false)
  })

  it('checks EVERY call site in a file, not just the first', () => {
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: WIRED + UNWIRED + WIRED }])
    expect(r.sites).toHaveLength(3)
    expect(r.errors).toHaveLength(1)
  })

  it('survives a multi-line wiring with nested parens and arrow functions', () => {
    const src = `
const call = createRetryApiCall({
  log: (line) => process.stderr.write(line),
  onFloodWait: (retryAfterSec, opts) => {
    makeFloodWaitRecorder(PATH)(retryAfterSec)
    try { gate.open(opts, Date.now() + (retryAfterSec * 1000)) } catch { /* x */ }
  },
  floodWaitRemainingMs: makeFloodWaitProbe(floodStatePath(dir)),
})
`
    const r = evaluateRetryHookWiring([{ path: 'a.ts', source: src }])
    expect(r.ok).toBe(true)
  })
})

describe('extractCallArgs', () => {
  it('returns the balanced argument text', () => {
    const src = 'f({ a: g(1, h(2)) })'
    expect(extractCallArgs(src, 1)).toBe('{ a: g(1, h(2)) }')
  })

  it('returns null on unbalanced parens rather than guessing', () => {
    expect(extractCallArgs('f({ a: 1 }', 1)).toBeNull()
  })
})

describe('the real tree', () => {
  it('every createRetryApiCall wiring in the repo carries both hooks', async () => {
    const { readFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const { resolve } = await import('node:path')
    const repoRoot = resolve(import.meta.dirname, '..')
    const listed = execFileSync(
      'git',
      ['ls-files', '--', 'telegram-plugin/**/*.ts', 'src/**/*.ts'],
      { cwd: repoRoot, encoding: 'utf-8' },
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => !p.endsWith('.test.ts') && !p.includes('/tests/') && !p.includes('/uat/'))

    const files = []
    for (const rel of listed) {
      const source = readFileSync(resolve(repoRoot, rel), 'utf-8')
      if (source.includes(FACTORY)) files.push({ path: rel, source })
    }
    const r = evaluateRetryHookWiring(files)
    expect(r.errors).toEqual([])

    // Sanity: the guard is actually finding wirings, not silently scanning zero
    // files (which would make the assertion above vacuous).
    //
    // The floor was 4 until #3863 (shipped in #4113) deleted
    // `shared/bot-runtime.ts`'s `createRobustApiCall` — a fourth wiring with
    // ZERO production callers whose breaker hooks were OPTIONAL (spread in only
    // when the caller passed `floodStatePath`). It was deleted, not re-wired,
    // so the live count is now 3. Do NOT lower this again to make a red build
    // green: a drop below 3 means a real send path lost its wiring — or moved
    // somewhere this scan no longer looks — which is exactly the #3849
    // regression this guard exists to catch. Prove the wiring is gone on
    // purpose first, and record why here.
    expect(r.sites.length).toBeGreaterThanOrEqual(3)

    // A bare count can be satisfied by the WRONG three sites — e.g. a rename or
    // glob change hides the gateway's wirings while three others appear
    // elsewhere. Pin the files that must still carry a wiring, so a scanner
    // blind spot fails loudly by name instead of being masked by the count.
    // Adding a genuinely new wiring is fine — add its file here in the same
    // diff, so a new outbound send path is an acknowledged review decision.
    const paths = r.sites.map((s: { path: string }) => s.path)
    expect([...new Set(paths)].sort()).toEqual([
      'telegram-plugin/gateway/gateway.ts',
      'telegram-plugin/gateway/outbox-sweep.ts',
    ])
    // gateway.ts carries two: `robustApiCall` and `nonEssentialApiCall`.
    expect(paths.filter((p: string) => p === 'telegram-plugin/gateway/gateway.ts')).toHaveLength(2)
  })
})
