/**
 * Tests for `scripts/check-plugin-references.mjs` — specifically the compiler
 * it runs.
 *
 * The bug these pin (2026-08-15): the script invoked a bare `npx tsc`. `npx`
 * prefers `./node_modules/.bin/tsc` only when that file exists; when it does
 * not (fresh worktree checked before `bun install`, symlinked/partial
 * `node_modules`, a run from another cwd) npx goes to the NETWORK and installs
 * the registry package literally named `tsc` — which is not TypeScript. It is
 * `tsc@2.0.4`, "A deprecated release of the TypeScript compiler", a stub that
 * prints a banner and exits. Its output contains no `error TS` lines, so the
 * script's filter counted zero errors and printed "plugin-references: clean".
 * The guard silently stopped guarding while reporting success.
 *
 * Reproduced before the fix: with `node_modules/.bin/tsc` moved aside, the
 * script exited 0 "clean" and left
 * `$npm_config_cache/_npx/<hash>/package.json` = `{"dependencies":{"tsc":"^2.0.4"}}`.
 *
 * These assert OUTCOMES, not code shape:
 *  1. the compiler the guard resolves IS the repo-pinned TypeScript (same
 *     version as the `typescript` dependency), and
 *  2. with a hostile `npx` first on `PATH`, the script still passes — proving
 *     it never consults `npx` at all. Under the old code the shim's output
 *     would have been parsed as tsc output and failed the run.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
// @ts-expect-error — plain .mjs guard, no types; importing the pure helper.
import { resolveTscBin } from '../scripts/check-plugin-references.mjs'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = resolve(REPO, 'scripts/check-plugin-references.mjs')

function runScript(env: NodeJS.ProcessEnv): {
  ok: boolean
  stdout: string
  stderr: string
} {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? '',
    }
  }
}

describe('resolveTscBin', () => {
  it('resolves the repo-pinned TypeScript, not a PATH/registry lookup', () => {
    const bin = resolveTscBin() as string
    expect(bin).toMatch(/[/\\]typescript[/\\]bin[/\\]tsc$/)

    // The version the guard would actually run must equal the version of the
    // `typescript` dependency this repo installed. `npx tsc` on a machine
    // without `node_modules/.bin/tsc` resolves the squatted `tsc@2.0.4`
    // package instead, which cannot satisfy this.
    const reported = execFileSync(process.execPath, [bin, '--version'], {
      encoding: 'utf8',
    }).trim()
    const require = createRequire(import.meta.url)
    const pinned = require('typescript/package.json').version as string
    expect(reported).toBe(`Version ${pinned}`)
  })
})

describe('check-plugin-references.mjs', () => {
  it(
    'passes with a hostile `npx` first on PATH (it never shells out to npx)',
    () => {
      // Deliberately NOT os.tmpdir(): dev hosts and CI runners mount /tmp
      // `noexec` (see CLAUDE.md > Tests), and a shim that cannot be exec'd
      // would make this test vacuous. node_modules/.cache is exec-capable
      // wherever the repo's own binaries are, and is gitignored.
      const cacheRoot = join(REPO, 'node_modules', '.cache')
      mkdirSync(cacheRoot, { recursive: true })
      const dir = mkdtempSync(join(cacheRoot, 'plugin-refcheck-npx-'))
      try {
        // A shim that, if invoked, emits a line the script's filter counts as
        // a tsc error. Old code (`npx tsc ...`) would have picked this up and
        // exited 1; the fixed code must never call it.
        const shim = join(dir, 'npx')
        writeFileSync(
          shim,
          '#!/bin/sh\necho "poisoned.ts(1,1): error TS9999: hostile npx shim ran."\nexit 2\n'
        )
        chmodSync(shim, 0o755)

        // Non-vacuity: the shim must really be runnable, otherwise "the
        // script didn't emit TS9999" would prove nothing.
        let shimOut = ''
        try {
          execFileSync(shim, [], { encoding: 'utf8' })
        } catch (err) {
          shimOut = (err as { stdout?: Buffer | string }).stdout?.toString() ?? ''
        }
        expect(shimOut).toContain('TS9999')

        const res = runScript({
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
        })

        expect(res.stdout + res.stderr).not.toContain('TS9999')
        expect(res.stdout).toContain('plugin-references: clean')
        expect(res.ok).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    180_000
  )
})
