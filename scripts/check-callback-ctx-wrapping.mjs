#!/usr/bin/env node
/**
 * Raw grammy CONTEXT calls on the callback (button-tap) path must not grow,
 * and `finalizeCallback` must always be handed the retry/flood seam
 * (switchroom#3891).
 *
 * Why this script exists
 * ----------------------
 * The plugin already has two wrapping guards and BOTH were green while the
 * single most-tapped surface in the product bypassed the retry policy:
 *
 *   - `check-bot-api-wrapping.sh` polices `bot.api.*` / `lockedBot.api.*` /
 *     `ctx.api.*`, and deliberately EXCLUDES `answerCallbackQuery` (its
 *     rationale is THREAD_NOT_FOUND blast radius, which a callback answer
 *     cannot have).
 *   - `check-retry-flood-hooks.mjs` polices `createRetryApiCall(` WIRINGS —
 *     it has nothing to say about a call site that never reaches one.
 *
 * `ctx.answerCallbackQuery(...)` / `ctx.editMessageText(...)` is a THIRD
 * surface neither guard sees. `finalizeCallback` — the helper every terminal
 * button tap routes through — used both of them raw, so:
 *
 *   1. A 429 earned by an operator's tap never reached `onFloodWait`, was
 *      never written to `429-ledger.json`, and never opened a window in
 *      `flood-windows.json`. The flood circuit breaker, the send gate's boot
 *      windows, `switchroom doctor`'s flood-pressure classifier and the
 *      wedge-watchdog's Esc suppression were all classifying flood pressure
 *      from a picture with the taps cut out of it.
 *   2. With no retry, one transient edit failure left the approval card
 *      holding its `reply_markup` — live and tappable over an
 *      already-resolved decision. Observed on agent `clerk`, 2026-07-28:
 *      `finalizeCallback: editMessageText failed: Call to 'editMessageText'
 *      failed!`, after which the operator re-tapped Approve repeatedly and
 *      got only "The user doesn't want to proceed with this tool use".
 *
 * Product rule (CLAUDE.md dev-protocol): "deterministic mechanisms over
 * model-dependent behavior." The FIRST line of defence is the type: `apiCall`
 * is a REQUIRED field on `FinalizeCallbackOptions`, and although the root
 * `tsconfig.json` does not include `telegram-plugin/`, `check-plugin-references.mjs`
 * runs `tsc --noEmit` over plugin source with a widened `include` and fails on
 * ANY error — so a call site that forgets the seam already reds CI.
 *
 * This script is the SECOND line, and it covers what the type cannot:
 *   - the ratchet (rule 2) — the type has nothing to say about the ~150 raw
 *     `ctx.*` calls that never go near `finalizeCallback`;
 *   - the seam rule survives someone widening the field back to optional,
 *     which is precisely the "just default it to a passthrough" shortcut that
 *     produced this bug's shape in the first place.
 *
 * The two rules
 * -------------
 * 1. SEAM — every `finalizeCallback(` CALL SITE in non-test source must pass
 *    `apiCall`. (The declaration is not a call site and is skipped.)
 *
 * 2. RATCHET — the number of raw, UNWRAPPED callback-context calls
 *    (`ctx.answerCallbackQuery` / `ctx.editMessageText` /
 *    `ctx.editMessageReplyMarkup`, with or without the `.api.` infix) in each
 *    non-test source file must EXACTLY match the checked-in inventory in
 *    `scripts/callback-ctx-wrapping-baseline.json`.
 *
 *    Exact match, not a ceiling, and in both directions on purpose:
 *      - going UP fails, so a new bypass can never land silently;
 *      - going DOWN fails until you lower the number in the same PR, so the
 *        inventory can never drift stale and re-admit an old high-water mark.
 *
 *    A call is WRAPPED (and therefore not counted) when a retry-wrapper
 *    invocation — `apiCall(`, `robustApiCall(`, `swallowingApiCall(`,
 *    `nonEssentialApiCall(`, `retryApiCall(`, `retryWithThreadFallback(` —
 *    appears at or before it within the preceding {@link WRAP_LOOKBACK_LINES}
 *    lines. Same heuristic `check-bot-api-wrapping.sh` uses; a false
 *    "wrapped" only under-counts, which the exact-match rule then surfaces as
 *    an inventory mismatch rather than a silent pass.
 *
 * Escape hatch, deliberately narrow: `// allow-raw-callback-ctx: <reason>` on
 * the line IMMEDIATELY preceding the call. The reason is REQUIRED.
 *
 * Why a ratchet rather than "convert all 150 sites now": the remaining raw
 * sites are early-return acks ("Not authorized.", "Bad request") and wizard
 * step transitions, spread over seven files. Converting them is real work with
 * real regression surface and belongs in its own PR — see the follow-up issue
 * referenced from #3891. What must not happen meanwhile is the count growing.
 *
 * The pure decision lives in `evaluateCallbackCtxWrapping()` (exported,
 * unit-tested in `tests/check-callback-ctx-wrapping.test.ts`); `main()` does
 * the I/O.
 *
 * Run: `npm run lint:callback-ctx-wrapping` (also part of `npm run lint`).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  countRawCtxCalls,
  evaluateInventory,
  WRAPPERS as SHARED_WRAPPERS,
  WRAP_LOOKBACK_LINES as SHARED_LOOKBACK,
} from './lib/raw-ctx-scan.mjs'

/** Path of the checked-in inventory, relative to the repo root. */
export const BASELINE_PATH = 'scripts/callback-ctx-wrapping-baseline.json'

/** The helper whose retry seam rule 1 enforces. */
export const FINALIZE = 'finalizeCallback'

/** The option that carries the retry/flood policy into {@link FINALIZE}. */
export const SEAM_OPTION = 'apiCall'

/** Context methods that reach Telegram from a button-tap handler. */
export const CALLBACK_CTX_METHODS = [
  'answerCallbackQuery',
  'editMessageText',
  'editMessageReplyMarkup',
]

/**
 * Retry wrappers whose presence marks a call as already-policed. Re-exported
 * from the shared scanner so this guard and `check-ctx-send-wrapping.mjs`
 * cannot drift apart (switchroom#4599).
 */
export const WRAPPERS = SHARED_WRAPPERS

/** How many preceding lines are searched for a wrapper invocation. */
export const WRAP_LOOKBACK_LINES = SHARED_LOOKBACK

/** Marker that waives ONE raw call site. Reason is mandatory. */
export const EXEMPT_MARKER = 'allow-raw-callback-ctx:'

/**
 * Count raw, unwrapped callback-context calls in one file.
 *
 * @param {string} source
 * @returns {{ count: number, sites: {line: number, text: string}[], errors: string[] }}
 */
export function countRawCallbackCtxCalls(path, source) {
  return countRawCtxCalls(path, source, {
    methods: CALLBACK_CTX_METHODS,
    exemptMarker: EXEMPT_MARKER,
  })
}

/**
 * Rule 1 — every `finalizeCallback(` call site passes the retry seam.
 *
 * @returns {string[]} errors
 */
export function checkFinalizeSeam(path, source) {
  const errors = []
  let from = 0
  for (;;) {
    const idx = source.indexOf(`${FINALIZE}(`, from)
    if (idx === -1) break
    from = idx + FINALIZE.length

    // Skip the DECLARATION (`export async function finalizeCallback(`).
    const before = source.slice(Math.max(0, idx - 40), idx)
    if (/\b(function|const|let|var)\s+$/.test(before)) continue

    // Balance parens to get the argument text.
    let depth = 0
    let args = null
    for (let i = idx + FINALIZE.length; i < source.length; i++) {
      const c = source[i]
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          args = source.slice(idx + FINALIZE.length + 1, i)
          break
        }
      }
    }
    const line = source.slice(0, idx).split('\n').length
    if (args === null) {
      errors.push(`${path}:${line}: unbalanced parentheses after ${FINALIZE}( — cannot verify.`)
      continue
    }
    if (!new RegExp(String.raw`\b${SEAM_OPTION}\s*:`).test(args)) {
      errors.push(
        `${path}:${line}: ${FINALIZE}(...) omits \`${SEAM_OPTION}\`. Pass the gateway's ` +
          `\`robustApiCall\` so the tap's answerCallbackQuery + card repaint transit the ` +
          `one retry/flood policy — otherwise a 429 earned by this tap is never recorded ` +
          `to the flood ledger and one transient failure leaves a dead card looking live ` +
          `(switchroom#3891).`,
      )
    }
  }
  return errors
}

/**
 * Pure guard decision.
 *
 * @param {{path: string, source: string}[]} files
 * @param {Record<string, number>} baseline
 */
export function evaluateCallbackCtxWrapping(files, baseline) {
  const errors = []
  const counted = []

  for (const { path, source } of files) {
    errors.push(...checkFinalizeSeam(path, source))
    const { count, sites, errors: siteErrors } = countRawCallbackCtxCalls(path, source)
    errors.push(...siteErrors)
    counted.push({ path, count, sites })
  }

  const { errors: ratchetErrors, actual } = evaluateInventory(counted, baseline, {
    baselinePath: BASELINE_PATH,
    growMessage: ({ path, count, expected, fresh }) =>
      `${path}: ${count} raw callback-context call(s), inventory says ${expected}. ` +
      `A NEW raw \`ctx.answerCallbackQuery\`/\`editMessageText\`/\`editMessageReplyMarkup\` ` +
      `bypasses the retry/flood policy: its 429s never reach the ledger and a failed ` +
      `repaint leaves a live-looking card (switchroom#3891). Wrap it in \`robustApiCall\`, ` +
      `or mark it \`// ${EXEMPT_MARKER} <reason>\`.\n      Candidates:\n        ` +
      fresh.join('\n        '),
  })
  errors.push(...ratchetErrors)

  return { ok: errors.length === 0, errors, actual }
}

/** Non-test TypeScript sources that could carry a callback-path call. */
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
  const baseline = JSON.parse(readFileSync(resolve(repoRoot, BASELINE_PATH), 'utf-8'))
  const files = []
  for (const rel of listSourceFiles(repoRoot)) {
    let source
    try {
      source = readFileSync(resolve(repoRoot, rel), 'utf-8')
    } catch {
      continue
    }
    if (!source.includes('ctx.') && !source.includes(FINALIZE)) continue
    files.push({ path: relative(repoRoot, resolve(repoRoot, rel)), source })
  }

  const { ok, errors, actual } = evaluateCallbackCtxWrapping(files, baseline.files ?? baseline)
  if (!ok) {
    console.error('check-callback-ctx-wrapping: FAILED\n')
    for (const e of errors) console.error(`  - ${e}\n`)
    console.error('See scripts/check-callback-ctx-wrapping.mjs for the rationale (switchroom#3891).')
    process.exit(1)
  }
  const total = Object.values(actual).reduce((a, b) => a + b, 0)
  console.error(
    `check-callback-ctx-wrapping: clean (${total} raw callback-context call(s) across ` +
      `${Object.keys(actual).length} file(s), all inventoried)`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
