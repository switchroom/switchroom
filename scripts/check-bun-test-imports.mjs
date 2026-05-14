#!/usr/bin/env node
/**
 * Check `.test.ts` files for `bun:test` imports that aren't excluded from
 * vitest's run set.
 *
 * Why this script exists:
 *
 * Five PRs in 24h have been one-line `from "bun:test"` → `from "vitest"`
 * fixes after Core tests on buildkite turned red. Each one:
 *
 *   - PR #1235  — src/cli/google-accounts-yaml.test.ts (RFC G Phase 3a)
 *   - PR #1249  — src/drive/anchors.test.ts (RFC E Phase 1b)
 *   - PR #1250  — src/drive/deep-links.test.ts (RFC E Phase 1a)
 *   - PR #1252  — src/drive/diff-preview.test.ts (RFC E Phase 1c)
 *   - PR #1261  — src/auth/broker/provider.test.ts (RFC G Phase 3b.1)
 *
 * The trap: the project is bun-runtime, so the natural reach is
 * `from "bun:test"`. But files under `src/`, `tests/`, and parts of
 * `telegram-plugin/` are run by vitest, which can't resolve `bun:test`.
 * Failure mode: the whole suite fails to load, all tests show as failed,
 * Core tests goes red on buildkite. Not caught by `tsc --noEmit`.
 *
 * The rule:
 *
 *   If a `.test.ts` file imports from `"bun:test"`, it must be in the
 *   `exclude` list in `vitest.config.ts` — that's the canonical opt-out
 *   for "this test runs under `bun test`, not vitest".
 *
 * Run: `npm run lint:bun-test-imports` (also part of `npm run lint`).
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// Match: `from "bun:test"` or `from 'bun:test'`.
const BUN_TEST_IMPORT_RE = /from\s+['"]bun:test['"]/

// Pull excludes from vitest.config.ts. A simple regex is enough — the
// file is a flat array of string globs prefixed with `**/`.
function loadVitestExcludes() {
  const cfg = readFileSync(resolve(repoRoot, 'vitest.config.ts'), 'utf-8')
  const excludeIdx = cfg.indexOf('exclude: [')
  if (excludeIdx === -1) {
    throw new Error('check-bun-test-imports: could not find `exclude: [` in vitest.config.ts')
  }
  // Take everything until the closing `],` at the start of a line.
  const tail = cfg.slice(excludeIdx)
  const closeIdx = tail.search(/\n\s{0,8}\],/)
  if (closeIdx === -1) {
    throw new Error('check-bun-test-imports: could not find the closing `]` for exclude array')
  }
  const block = tail.slice(0, closeIdx)
  // Extract every "..." or '...' string literal.
  const matches = block.matchAll(/['"]([^'"\n]+)['"]/g)
  return Array.from(matches, (m) => m[1])
}

// Convert a glob pattern (only `**/`-prefix style used in vitest.config.ts)
// to a regex that matches a repo-relative path.
function globToRegex(glob) {
  // We only need to support the patterns actually used:
  //   "**/path/to/file.test.ts"
  //   "**/some/dir/**"
  //   "**/dist/**"
  // Strategy: escape regex metas, then map `**/` → `(.*/)?` and `**` → `.*`.
  let r = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  r = r.replace(/\*\*\//g, '__GS__/').replace(/\*\*/g, '__DS__').replace(/\*/g, '[^/]*')
  r = r.replace(/__GS__\//g, '(?:.*/)?').replace(/__DS__/g, '.*')
  return new RegExp(`^${r}$`)
}

// List every `.test.ts` under `src/`, `tests/`, `telegram-plugin/` —
// matches vitest's default `test.include` glob shape.
function listTestFiles() {
  const out = execSync(
    `git ls-files 'src/*.test.ts' 'src/**/*.test.ts' 'tests/*.test.ts' 'tests/**/*.test.ts' 'telegram-plugin/*.test.ts' 'telegram-plugin/**/*.test.ts'`,
    { cwd: repoRoot, encoding: 'utf-8' },
  )
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const excludes = loadVitestExcludes()
const excludeRegexes = excludes.map(globToRegex)

const offenders = []
for (const relPath of listTestFiles()) {
  let src
  try {
    src = readFileSync(resolve(repoRoot, relPath), 'utf-8')
  } catch {
    continue
  }
  if (!BUN_TEST_IMPORT_RE.test(src)) continue
  // File imports bun:test — must be excluded.
  const excluded = excludeRegexes.some((re) => re.test(relPath))
  if (!excluded) offenders.push(relPath)
}

if (offenders.length > 0) {
  console.error('check-bun-test-imports: the following files import `bun:test` but are NOT excluded from vitest in vitest.config.ts:\n')
  for (const f of offenders) console.error(`  ${f}`)
  console.error('\nEither swap the import to `from "vitest"` (preferred if the file uses no bun-specific APIs like `mock()` or `bun:sqlite`), or add the file to the `exclude` array in vitest.config.ts so it only runs under `bun test`.\n')
  console.error('See scripts/check-bun-test-imports.mjs for the rationale (5 PRs in 24h fixed this same class of bug).')
  process.exit(1)
}

console.log(`check-bun-test-imports: clean (${listTestFiles().length} test files scanned)`)
