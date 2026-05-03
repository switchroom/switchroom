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
 * This script catches the same class going forward. It runs `tsc
 * --noEmit` against a tsconfig that DOES include the plugin, filters
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

import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// Codes that catch the bug class that broke clerk in PR #599.
// Adding TS6133 (unused declaration) would catch dead variables but
// flag too much pre-existing debt; leave it off for now.
const DANGEROUS_CODES = ['TS2304', 'TS2552', 'TS2722', 'TS2561']

const tmpConfig = resolve(repoRoot, 'tsconfig.plugin-refcheck.json')
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
  ],
}

writeFileSync(tmpConfig, JSON.stringify(tmpConfigBody, null, 2))

let out = ''
try {
  out = execSync(`npx tsc --noEmit -p ${tmpConfig}`, {
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
const dangerous = lines.filter((l) =>
  DANGEROUS_CODES.some((code) => l.includes(`error ${code}`))
)

if (dangerous.length > 0) {
  console.error('plugin-references: found dangerous-class type errors:\n')
  for (const line of dangerous) console.error('  ' + line)
  console.error(
    `\nThese errors mean a reference, invocation, or property is wrong — ` +
    `the kind of bug that ships to production undetected because tsc doesn't ` +
    `cover telegram-plugin/. See scripts/check-plugin-references.mjs for context.`
  )
  process.exit(1)
}

const totalErrors = lines.filter((l) => l.includes('error TS')).length
console.log(
  `plugin-references: clean (no TS2304/TS2552/TS2722/TS2561 errors in plugin source). ` +
  `${totalErrors} other type-debt errors ignored — tracked separately.`
)
process.exit(0)
