/**
 * `createRobustApiCall` must stay deleted (#3863).
 *
 * It was a second `createRetryApiCall` wiring in `shared/bot-runtime.ts`,
 * described as "exactly how gateway.ts constructs its robustApiCall". It had
 * ZERO production callers — and, worse, its flood-breaker hooks were OPTIONAL
 * (`floodStatePath` defaulted to absent), so the default construction was a
 * send path blind to the shared flood window: the exact failure
 * `scripts/check-retry-flood-hooks.mjs` exists to prevent, sitting in the file
 * a future caller would naturally reach for.
 *
 * It was also load-bearing DOCUMENTATION: `flood-circuit-breaker.ts` and
 * `flood-429-ledger.ts` both cited it as a live wiring, so the breaker's
 * "every onFloodWait goes through here" completeness argument was partly
 * anchored to dead code.
 *
 * This is a source-level guard on purpose: the defect is the existence of the
 * identifier, and there is no runtime behaviour to assert.
 *
 * The rule is "the name may appear only inside backticks" — i.e. as PROSE in a
 * docblock explaining why it is gone. Any bare occurrence is code (a
 * declaration, an import, a call) and fails.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SEARCH_ROOTS = ['telegram-plugin', 'src', 'bin', 'scripts', 'docs']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor', 'coverage'])
const SEARCH_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (SEARCH_EXTS.has(extname(entry))) yield full
  }
}

describe('#3863 — the dead createRobustApiCall factory', () => {
  it('appears in no source, script or doc file except as backticked prose', () => {
    const selfPath = fileURLToPath(import.meta.url)
    const offenders: string[] = []
    for (const root of SEARCH_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        if (file === selfPath) continue
        // Drop the backticked (prose) occurrences; anything left is code.
        const bare = readFileSync(file, 'utf8').replaceAll('`createRobustApiCall`', '')
        if (bare.includes('createRobustApiCall')) offenders.push(file.slice(REPO_ROOT.length))
      }
    }
    expect(offenders).toEqual([])
  })

  it('is not exported by shared/bot-runtime.ts', async () => {
    const mod = (await import('../shared/bot-runtime.js')) as Record<string, unknown>
    expect(Object.keys(mod)).not.toContain('createRobustApiCall')
  })
})
