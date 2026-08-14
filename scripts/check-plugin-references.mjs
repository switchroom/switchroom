#!/usr/bin/env node
/**
 * Check telegram-plugin source for undeclared-identifier (TS2304) and
 * related "name not found" errors that the main `npm run lint` misses.
 *
 * Why this script exists:
 *
 * The repo's `tsconfig.json` does not include `telegram-plugin/` in its
 * `include` array (the file is bun-bundled, not tsc-compiled), so the
 * 7000-line gateway.ts is invisible to the type checker. PR #599 (the
 * #546 dedup fix, commit 5bed5b7) added 4 read sites of `outboundDedup`
 * but never declared the variable. `npm run lint` was clean. The bug
 * shipped to main and broke every reply on every agent — the agent's
 * own prose quoted "outboundDedup is not defined" inside ANOTHER reply
 * call (which also threw).
 *
 * This script catches the same class going forward. It runs the
 * REPO-PINNED `tsc --noEmit` (never `npx tsc` — see `resolveTscBin()`
 * below for why that distinction is load-bearing) against a tsconfig
 * that DOES include the plugin, filters
 * the output to ONLY the dangerous error codes (undeclared names,
 * cannot-invoke-undefined, typo-suggestions), and exits non-zero if
 * any are found.
 *
 * The 50+ pre-existing type-debt errors in plugin source (TS2345 type
 * mismatches, TS2339 missing properties, etc.) are NOT failed on here
 * — they're real but not the bug class that breaks production. A
 * follow-up issue tracks cleaning them up so the full tsc check can
 * be enabled.
 *
 * Codes filtered (pick the ones that mean "ReferenceError-class bug"):
 *   TS2304 — Cannot find name 'X'
 *   TS2552 — Cannot find name 'X'. Did you mean 'Y'?
 *   TS2722 — Cannot invoke an object which is possibly 'undefined'
 *   TS2561 — Object literal may only specify known properties, but 'X'
 *            does not exist in type 'Y'. Did you mean to write 'Z'?
 *
 * Run: `npm run lint:plugin-references` (also part of `npm run lint`).
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

/**
 * Resolve the REPO-PINNED TypeScript compiler.
 *
 * This used to be a bare `npx tsc`, and that was a silent-false-pass bug.
 * `npx` only prefers `./node_modules/.bin/tsc` when it is there; when it
 * is not (a fresh worktree checked before `bun install`, a symlinked or
 * partially-installed `node_modules`, a run from a different cwd), npx
 * goes to the NETWORK and installs whatever package is named `tsc` — which
 * on the public registry is NOT TypeScript. It is `tsc@2.0.4`,
 * "A deprecated release of the TypeScript compiler", a squatted stub that
 * prints a banner and exits. Its output contains no `error TS` lines, so
 * this script's filter found zero errors and printed
 * "plugin-references: clean" — a guard that had stopped guarding, reporting
 * success. (Reproduced on 2026-08-15: with `node_modules/.bin/tsc` moved
 * aside, this script exited 0 "clean" and left
 * `~/.npm/_npx/<hash>/package.json` = `{"dependencies":{"tsc":"^2.0.4"}}`.)
 *
 * Same hazard class the repo already guards for Playwright in
 * `scripts/check-no-unpinned-npx-playwright.mjs`: a bare `npx <name>` is an
 * unpinned network fetch of an arbitrary registry package into a trusted path.
 *
 * So: resolve `typescript/bin/tsc` through node resolution from this file and
 * run it with `process.execPath`. No PATH lookup, no shell, no network. If
 * TypeScript is not installed we exit NON-ZERO with an actionable message —
 * a missing compiler must never read as "clean".
 */
export function resolveTscBin() {
  const require = createRequire(import.meta.url)
  return require.resolve('typescript/bin/tsc')
}

// Codes that catch the bug class that broke clerk in PR #599.
// Adding TS6133 (unused declaration) would catch dead variables but
// flag too much pre-existing debt; leave it off for now.
const DANGEROUS_CODES = ['TS2304', 'TS2552', 'TS2722', 'TS2561']

// Per-process name: the config has to sit at repoRoot (its `extends` and the
// `include` globs are repo-relative), but two concurrent runs — `npm run lint`
// alongside the vitest suite, which drives this script end to end — would
// otherwise share one path and delete each other's file mid-type-check.
const tmpConfig = resolve(repoRoot, `tsconfig.plugin-refcheck.${process.pid}.json`)
const tmpConfigBody = {
  extends: './tsconfig.json',
  // Override include so plugin source is in scope. Tests excluded —
  // their type debt is separate; in-scope tests would balloon the
  // false-positive count.
  include: [
    'src/**/*.ts',
    'bin/**/*.ts',
    'scripts/**/*.ts',
    'telegram-plugin/**/*.ts',
  ],
  exclude: [
    'node_modules',
    'dist',
    'telegram-plugin/tests/**/*',
    'telegram-plugin/dist/**/*',
    // Plugin tests also live as `*.test.ts` co-located in non-tests
    // dirs (e.g. gateway/access-validator.test.ts). Same type-debt
    // exclusion rationale as telegram-plugin/tests/.
    'telegram-plugin/**/*.test.ts',
  ],
}

function main() {
  let tscBin
  try {
    tscBin = resolveTscBin()
  } catch {
    console.error(
      'plugin-references: cannot resolve the repo-pinned TypeScript compiler ' +
      "(`typescript/bin/tsc`).\n\nRun `bun install` first. This check does NOT " +
      'fall back to `npx tsc`: the registry package named `tsc` is a deprecated ' +
      'stub, not TypeScript, and running it would report a false "clean".'
    )
    process.exit(1)
  }

  writeFileSync(tmpConfig, JSON.stringify(tmpConfigBody, null, 2))

  let out = ''
  try {
    out = execFileSync(process.execPath, [tscBin, '--noEmit', '-p', tmpConfig], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    out = (err.stdout || '') + (err.stderr || '')
  } finally {
    if (existsSync(tmpConfig)) unlinkSync(tmpConfig)
  }

  const lines = out.split('\n')
  const allErrors = lines.filter((l) => l.includes('error TS'))

  // As of #623, all 52 pre-existing type-debt errors in plugin source
  // have been cleaned up. The check now fails on ANY tsc error — not
  // just the four "dangerous-class" codes that were originally filtered.
  // If you hit a new error here, fix it (don't broaden the filter
  // again). DANGEROUS_CODES kept for backwards-compat / diagnostic
  // labelling.
  if (allErrors.length > 0) {
    const dangerous = allErrors.filter((l) =>
      DANGEROUS_CODES.some((code) => l.includes(`error ${code}`))
    )
    if (dangerous.length > 0) {
      console.error('plugin-references: found dangerous-class type errors:\n')
      for (const line of dangerous) console.error('  ' + line)
      console.error(
        `\nThese errors mean a reference, invocation, or property is wrong — ` +
        `the kind of bug that ships to production undetected because tsc doesn't ` +
        `cover telegram-plugin/. See scripts/check-plugin-references.mjs for context.\n`
      )
    }
    const other = allErrors.filter((l) => !dangerous.includes(l))
    if (other.length > 0) {
      console.error('plugin-references: tsc errors in plugin source:\n')
      for (const line of other) console.error('  ' + line)
      console.error(
        `\nThe lint check now enforces a fully clean tsc over plugin source ` +
        `(see #623). Fix the error rather than re-introducing a filter.`
      )
    }
    process.exit(1)
  }

  console.log('plugin-references: clean (no tsc errors in plugin source — strict since #623).')
  process.exit(0)
}

// Only run the check when invoked directly — tests import `resolveTscBin`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
