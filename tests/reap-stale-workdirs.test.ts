/**
 * Tests for the self-hosted runner guard `scripts/ci/reap-stale-workdirs.sh`
 * (switchroom#3335 — UAT runner git-clean D-state wedge cleanup).
 *
 * The guard sweeps stale `switchroom.wedged-*` remnants that manual recovery
 * renames aside on the persistent `_work` tree. We assert OUTCOMES against a
 * real temp dir driven through the actual script:
 *   - a STALE (old-mtime) wedged remnant is removed,
 *   - a FRESH wedged remnant is KEPT (forensics retention),
 *   - non-matching siblings (the live checkout, unrelated dirs) are untouched,
 *   - a missing reap root is a clean no-op (never fails the job).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'ci', 'reap-stale-workdirs.sh')

function runReap(reapRoot: string, env: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf-8',
    env: { ...process.env, REAP_ROOT: reapRoot, ...env },
  })
}

/** Backdate a path's mtime by `days` days. */
function ageDir(path: string, days: number): void {
  const when = (Date.now() - days * 86_400_000) / 1000
  utimesSync(path, when, when)
}

describe('reap-stale-workdirs.sh', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reap-workdirs-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('removes a stale (old) switchroom.wedged-* remnant', () => {
    const stale = join(root, 'switchroom.wedged-20260718')
    mkdirSync(stale)
    writeFileSync(join(stale, 'node_modules-remnant'), 'x')
    ageDir(stale, 5)
    const out = runReap(root)
    expect(existsSync(stale)).toBe(false)
    expect(out).toContain('1 stale remnant(s) matched, 1 removed')
  })

  it('keeps a FRESH wedged remnant for forensics (age gate)', () => {
    const fresh = join(root, 'switchroom.wedged-today')
    mkdirSync(fresh)
    // mtime = now → younger than the 1-day default retention.
    const out = runReap(root)
    expect(existsSync(fresh)).toBe(true)
    expect(out).toContain('0 stale remnant(s) matched, 0 removed')
  })

  it('respects REAP_RETAIN_DAYS override (reap even fresh when set to 0)', () => {
    const fresh = join(root, 'switchroom.wedged-today')
    mkdirSync(fresh)
    runReap(root, { REAP_RETAIN_DAYS: '0' })
    expect(existsSync(fresh)).toBe(false)
  })

  it('never touches the live checkout or unrelated siblings', () => {
    const live = join(root, 'switchroom')
    const other = join(root, 'some-other-repo')
    mkdirSync(live)
    mkdirSync(other)
    ageDir(live, 5)
    ageDir(other, 5)
    runReap(root)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('only sweeps the top level, not nested wedged dirs (maxdepth 1)', () => {
    const nestedParent = join(root, 'sub')
    mkdirSync(nestedParent)
    const nested = join(nestedParent, 'switchroom.wedged-old')
    mkdirSync(nested)
    ageDir(nested, 5)
    runReap(root)
    expect(existsSync(nested)).toBe(true)
  })

  it('is a clean no-op when the reap root is absent (never fails the job)', () => {
    const out = runReap(join(root, 'does-not-exist'))
    expect(out).toContain('nothing to do')
  })
})
