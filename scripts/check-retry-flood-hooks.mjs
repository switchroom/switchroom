#!/usr/bin/env node
/**
 * Every `createRetryApiCall(...)` wiring must consult the flood circuit
 * breaker — BOTH directions (switchroom#3853).
 *
 * Why this script exists
 * ----------------------
 * `createRetryApiCall` is the single retry policy for outbound Telegram calls.
 * It takes two breaker hooks and they are NOT optional in practice:
 *
 *   - `floodWaitRemainingMs` — the READ side. Without it the wiring cannot see
 *     a flood window another path already recorded, so it issues calls INTO a
 *     known-open ban.
 *   - `onFloodWait`          — the WRITE side. Without it a 429 this wiring
 *     earns is never persisted, so every OTHER path stays blind to it.
 *
 * The failure this replaces is documented and expensive. PR #3849 shipped with
 * a body claiming a complete choke point across three wirings while a fourth —
 * `gateway/outbox-sweep.ts`'s — sat with neither hook. That sweep then re-issued
 * one undeliverable `sendMessage` every 5 seconds for the whole of a 15908s
 * (4.4h) flood ban: 228 requests into a window the breaker had recorded and
 * could have answered in one read. The gateway log proves nothing consulted it —
 * `grep -c 'flood window still open' gateway-supervisor.log` = 0 while 228 of
 * the 230 `flood ban of Ns` lines were the same ban counting down.
 *
 * Product rule (CLAUDE.md dev-protocol #4): "deterministic mechanisms over
 * model-dependent behavior." Three reviewers read #3849 and none noticed the
 * fourth site. A checklist item would not have caught it; a lint gate does.
 *
 * The rule
 * --------
 * For each `createRetryApiCall(` CALL SITE in non-test source under
 * `telegram-plugin/` and `src/`, the argument text must mention BOTH
 * `floodWaitRemainingMs` and `onFloodWait`. The declaration itself
 * (`export function createRetryApiCall(`) is not a call site and is skipped.
 *
 * Escape hatch, deliberately narrow: a line within the 5 lines preceding the
 * call may carry `retry-flood-hooks-exempt: <reason>`. The reason is REQUIRED
 * and must be non-empty — an exemption with no stated reason fails just like a
 * missing hook. There are currently ZERO exemptions in the tree; the hatch
 * exists so a future genuine case is recorded in the diff rather than the guard
 * being deleted wholesale.
 *
 * The pure decision lives in `evaluateRetryHookWiring()` (exported, unit-tested
 * in `tests/check-retry-flood-hooks.test.ts`); `main()` does the I/O.
 *
 * Run: `npm run lint:retry-flood-hooks` (also part of `npm run lint`).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

/** The factory whose wirings this guard polices. */
export const FACTORY = 'createRetryApiCall'

/** Both hooks are mandatory — see the docblock for what each one closes. */
export const REQUIRED_HOOKS = ['floodWaitRemainingMs', 'onFloodWait']

/** Marker that waives the requirement for ONE call site. Reason is mandatory. */
export const EXEMPT_MARKER = 'retry-flood-hooks-exempt:'

/** How many preceding lines are searched for the exemption marker. */
export const EXEMPT_LOOKBACK_LINES = 5

/**
 * Extract the argument text of a call whose `(` is at `openIdx`, by matching
 * parentheses. Returns null when the parens never balance (truncated file).
 *
 * Deliberately brace/paren counting rather than a regex: the gateway's wiring
 * spans ~40 lines with nested arrow functions and object literals, which no
 * single-line regex survives.
 */
export function extractCallArgs(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return null
}

/** 1-based line number of `idx` in `src`. */
function lineOf(src, idx) {
  let n = 1
  for (let i = 0; i < idx && i < src.length; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

/**
 * Pure guard decision over a set of `{ path, source }` files.
 *
 * @param {{path: string, source: string}[]} files
 * @returns {{ ok: boolean, errors: string[], sites: {path:string,line:number,exempt:boolean,missing:string[]}[] }}
 */
export function evaluateRetryHookWiring(files) {
  const errors = []
  const sites = []

  for (const { path, source } of files) {
    const lines = source.split('\n')
    let from = 0
    for (;;) {
      const idx = source.indexOf(`${FACTORY}(`, from)
      if (idx === -1) break
      from = idx + FACTORY.length

      // Skip the DECLARATION (`export function createRetryApiCall(`) — it is
      // the thing being wired, not a wiring of it.
      const before = source.slice(Math.max(0, idx - 40), idx)
      if (/\b(function|const|let|var)\s+$/.test(before) || /\bfunction\s+$/.test(before)) {
        continue
      }

      const line = lineOf(source, idx)
      const openIdx = idx + FACTORY.length
      const args = extractCallArgs(source, openIdx)
      if (args === null) {
        errors.push(`${path}:${line}: unbalanced parentheses after ${FACTORY}( — cannot verify.`)
        continue
      }

      // Exemption lookback (lines are 1-based; `line` is the call's own line).
      let exempt = false
      let exemptReason = ''
      for (let l = Math.max(1, line - EXEMPT_LOOKBACK_LINES); l <= line; l++) {
        const text = lines[l - 1] ?? ''
        const at = text.indexOf(EXEMPT_MARKER)
        if (at === -1) continue
        exempt = true
        exemptReason = text.slice(at + EXEMPT_MARKER.length).trim()
        break
      }

      const missing = REQUIRED_HOOKS.filter((h) => !args.includes(h))
      sites.push({ path, line, exempt, missing })

      if (exempt) {
        if (exemptReason === '') {
          errors.push(
            `${path}:${line}: '${EXEMPT_MARKER}' with no reason. State WHY this ` +
              `${FACTORY} wiring may skip the flood breaker, in the marker itself.`,
          )
        }
        continue
      }
      if (missing.length > 0) {
        errors.push(
          `${path}:${line}: ${FACTORY}(...) omits ${missing.map((m) => `\`${m}\``).join(' and ')}. ` +
            `Every retry wiring must both READ the persisted flood window ` +
            `(\`floodWaitRemainingMs\`, e.g. \`makeFloodWaitProbe(floodStatePath(stateDir))\`) and ` +
            `WRITE the ones it earns (\`onFloodWait\`, e.g. \`makeFloodWaitRecorder(...)\`). ` +
            `A wiring missing the read hammers a ban it cannot see (switchroom#3853, 228 sends ` +
            `into an open 4.4h ban); one missing the write hides its 429s from every other path.`,
        )
      }
    }
  }

  return { ok: errors.length === 0, errors, sites }
}

/** Non-test TypeScript sources that could wire the factory. */
function listSourceFiles(repoRoot) {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'telegram-plugin/**/*.ts', 'src/**/*.ts'],
    { cwd: repoRoot, encoding: 'utf-8' },
  )
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !p.endsWith('.test.ts') && !p.endsWith('.d.ts'))
    .filter((p) => !p.includes('/tests/') && !p.includes('/uat/'))
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const files = []
  for (const rel of listSourceFiles(repoRoot)) {
    let source
    try {
      source = readFileSync(resolve(repoRoot, rel), 'utf-8')
    } catch {
      continue
    }
    if (!source.includes(FACTORY)) continue
    files.push({ path: relative(repoRoot, resolve(repoRoot, rel)), source })
  }

  const { ok, errors, sites } = evaluateRetryHookWiring(files)
  if (!ok) {
    console.error('check-retry-flood-hooks: FAILED\n')
    for (const e of errors) console.error(`  - ${e}\n`)
    console.error('See scripts/check-retry-flood-hooks.mjs for the rationale (switchroom#3853).')
    process.exit(1)
  }
  console.error(
    `check-retry-flood-hooks: clean (${sites.length} ${FACTORY} wiring(s) checked, ` +
      `${sites.filter((s) => s.exempt).length} exempt)`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
