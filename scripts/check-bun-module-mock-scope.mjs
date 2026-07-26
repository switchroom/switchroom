#!/usr/bin/env node
/**
 * check-bun-module-mock-scope
 *
 * Static gate against cross-package module-mock LEAKAGE in the bun test
 * shard (`bun-test-run`).
 *
 * Why this script exists
 * ----------------------
 * Under vitest, `vi.mock(spec, factory)` is scoped to the file that calls it.
 * Under `bun test` it is NOT: bun's vitest-compat layer maps `vi.mock` onto
 * `mock.module`, which is PROCESS-GLOBAL and retroactively rebinds ESM imports
 * that other modules already resolved. CI's `bun-test-run` job runs the whole
 * `telegram-plugin/` surface in ONE bun process (see
 * `telegram-plugin/scripts/bun-test-ci.sh`), so one file's module mock replaces
 * that module for every other test file in the run — in either direction of
 * file order, because the rebinding is retroactive.
 *
 * Proven, not theoretical. PR #3632 (#3627 vault passphrase retry) added
 * `vi.mock('../../src/vault/broker/client.js')` to
 * `telegram-plugin/tests/vault-passphrase-retry.test.ts`. Its
 * "not stubbed in this suite" thrower then answered the broker call made by an
 * unrelated suite three hundred files away, and `bun-test-run` went red on
 *
 *   (fail) createLinearIssue — behaviour (#2312) > surfaces a Linear API error status
 *     Expected substring or pattern: /Linear API 401/
 *     Received: "Couldn't file to Linear: request error:
 *                broker client getViaBrokerStructured() is not stubbed in this suite"
 *
 * The vitest shards stayed green the whole time (file-scoped mocks there), so
 * the runner divergence is invisible to a local `npm run test:vitest`.
 *
 * The rule
 * --------
 * A test/harness file swept by `bun test` may only module-mock a specifier
 * that resolves INSIDE `telegram-plugin/`. Mocking a module under `src/`
 * (shared library code that hundreds of suites transitively import) is
 * rejected.
 *
 * The remedy is the repo's existing bun-safe convention, already written down
 * in `telegram-plugin/tests/session-tail-sidecar-reap.test.ts`: inject a fake
 * through a dependency seam instead of touching the module registry. A DI fake
 * exists only inside the instance the test constructs and cannot leak.
 *
 * What this does NOT catch (deliberate, documented residual)
 * ----------------------------------------------------------
 * An intra-`telegram-plugin/` module mock leaks just as globally. Two of those
 * exist today (`../history.js`, `../gateway/auth-broker-client.js`) and are
 * benign only because no sibling suite exercises the real module. Banning them
 * outright would be a retrofit beyond this gate's evidence; the cross-package
 * boundary is where the demonstrated breakage occurred, and it is the boundary
 * a new mock is most likely to cross. If an intra-plugin mock ever collides,
 * tighten this to a total ban rather than adding an exception.
 *
 * Run: `npm run lint:bun-module-mock-scope` (also part of `npm run lint`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname, relative, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

/**
 * Directories `telegram-plugin/scripts/bun-test-ci.sh` sweeps. Keep in sync
 * with `BUN_TEST_ARGS` there — a dir added to the sweep without being added
 * here is simply un-gated, never falsely failed.
 */
export const SWEPT_DIRS = [
  'telegram-plugin/admin-commands',
  'telegram-plugin/gateway',
  'telegram-plugin/registry',
  'telegram-plugin/secret-detect',
  'telegram-plugin/tests',
]

/** The package boundary a swept file's module mocks must stay inside. */
export const MOCK_BOUNDARY = 'telegram-plugin'

/**
 * Strip `//` line comments and block comments so a file that merely
 * *documents* the hazard (as several deliberately do) is not flagged for it.
 * String-aware enough for this corpus: it tracks quotes and template literals
 * so a `//` inside a string literal is not mistaken for a comment.
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '')
        i += 2
        continue
      }
      if (c === quote) quote = null
      out += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

const MOCK_CALL_RE = /(?:\bvi\.mock|\bmock\.module)\s*\(\s*(['"])([^'"]+)\1/g

/** Every module-mock specifier in `src`, with its 1-based line number. */
export function findModuleMocks(src) {
  const clean = stripComments(src)
  const found = []
  for (const m of clean.matchAll(MOCK_CALL_RE)) {
    const line = clean.slice(0, m.index).split('\n').length
    found.push({ spec: m[2], line })
  }
  return found
}

/**
 * The pure decision. `file` is repo-relative; `spec` is the mock specifier.
 * Returns a violation object, or null when the mock stays in bounds.
 *
 * Bare specifiers (`vi.mock('grammy')`) are package mocks, not first-party
 * modules — out of scope here and left alone.
 */
export function evaluateMock(file, spec, line) {
  if (!spec.startsWith('.')) return null
  const resolved = relative(repoRoot, resolve(dirname(join(repoRoot, file)), spec))
  if (resolved.startsWith(MOCK_BOUNDARY + sep)) return null
  return { file, line, spec, resolved }
}

function walk(dir, acc) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (/\.(test|harness)\.tsx?$/.test(e)) acc.push(full)
  }
  return acc
}

function main() {
  const files = []
  for (const d of SWEPT_DIRS) walk(join(repoRoot, d), files)
  const violations = []
  for (const full of files) {
    const rel = relative(repoRoot, full)
    for (const { spec, line } of findModuleMocks(readFileSync(full, 'utf-8'))) {
      const v = evaluateMock(rel, spec, line)
      if (v) violations.push(v)
    }
  }
  if (violations.length === 0) {
    console.log(
      `check-bun-module-mock-scope: OK — ${files.length} bun-swept test files, ` +
      `no module mock escapes ${MOCK_BOUNDARY}/`,
    )
    return
  }
  for (const v of violations) {
    console.error(
      `${v.file}:${v.line}: module-mocks '${v.spec}' → ${v.resolved}, outside ${MOCK_BOUNDARY}/.\n` +
      `  Under 'bun test' this replaces that module for EVERY test file in the run.\n` +
      `  Inject a fake through a dependency seam instead (see\n` +
      `  telegram-plugin/tests/session-tail-sidecar-reap.test.ts for the pattern).`,
    )
  }
  console.error(`check-bun-module-mock-scope: FAIL — ${violations.length} violation(s)`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
