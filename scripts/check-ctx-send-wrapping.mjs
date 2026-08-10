#!/usr/bin/env node
/**
 * Raw grammy CONTEXT *sends* (`ctx.reply`, `ctx.replyWithRichMessage`, …) must
 * not grow (switchroom#4599).
 *
 * Why this script exists
 * ----------------------
 * `check-bot-api-wrapping.sh` polices `bot.api.*` / `lockedBot.api.*` /
 * `ctx.api.*`. Its own docblock — and, until #4599, the docblock of
 * `gateway/system-message-observer.ts` — claimed that this made
 * `robustApiCall` the chokepoint every outbound send transits. It is not, and
 * structurally never was:
 *
 *   - the pattern is anchored on `\.api\.`, so `ctx.reply(` and
 *     `ctx.replyWithRichMessage(` can never match it, no matter which verbs
 *     are added to the verb list;
 *   - `sendRichMessage` was missing from the verb list entirely (added to the
 *     bash guard in the same PR as this file).
 *
 * The measured consequence: every slash-command card (`/usage`, `/model`,
 * `/auth`, `/approvals`, `/start`, `/help`) is posted by `switchroomReply` →
 * `ctx.replyWithRichMessage`, which never entered `robustApiCall`, so the
 * #4571 outbound observer never saw it and the card left no history row. A
 * native Telegram reply to such a card resolved to an id with no text —
 * reproduced live on agent `overlord`, message id 20938. Fixed in #4599 by
 * moving the observer to the grammy API transformer layer; this guard exists
 * so the CLASS of bypass cannot silently regrow.
 *
 * These calls are not cosmetic. grammy's `Context.reply` auto-injects
 * `message_thread_id` when the inbound message is a topic message
 * (`node_modules/grammy/out/context.js:676-687`), so every one of them is in
 * the THREAD_NOT_FOUND blast radius that `robustApiCall`'s
 * `retryWithThreadFallback` exists to absorb, and every 429 one earns bypasses
 * the flood ledger.
 *
 * Why a RATCHET rather than the bash guard's hard fail
 * ----------------------------------------------------
 * There are 31 such call sites today. They are genuinely in the blast radius,
 * so annotating them all `allow-raw-bot-api: <reason>` would be a blanket
 * waiver dressed up as triage — it would assert the calls are FINE, which is
 * the opposite of true. Wrapping all 31 is a real refactor with real
 * regression surface and belongs in its own PR. So this uses the exact-match
 * inventory mechanism #3891 established for the callback path: the existing
 * 31 are recorded as a BACKLOG, and any NEW one fails CI.
 *
 * Rules
 * -----
 * The counting rules, wrapper list and lookback are shared with
 * `check-callback-ctx-wrapping.mjs` via `scripts/lib/raw-ctx-scan.mjs` — see
 * that file. Per-file counts must EXACTLY match
 * `scripts/ctx-send-wrapping-baseline.json`, in both directions.
 *
 * Escape hatch, deliberately narrow: `// allow-raw-ctx-send: <reason>` on the
 * line IMMEDIATELY preceding the call. The reason is REQUIRED.
 *
 * Run: `npm run lint:ctx-send-wrapping` (also part of `npm run lint`).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { countRawCtxCalls, evaluateInventory } from './lib/raw-ctx-scan.mjs'

/** Path of the checked-in inventory, relative to the repo root. */
export const BASELINE_PATH = 'scripts/ctx-send-wrapping-baseline.json'

/**
 * Context methods that POST a new message to Telegram. Longest-first so the
 * `reply` alternative cannot shadow a `replyWith…` sibling. Listed beyond what
 * the tree uses today on purpose: the point of the guard is the class.
 */
export const SEND_CTX_METHODS = [
  'replyWithRichMessageDraft',
  'replyWithRichMessage',
  'replyWithMediaGroup',
  'replyWithAnimation',
  'replyWithDocument',
  'replyWithSticker',
  'replyWithPhoto',
  'replyWithVideo',
  'replyWithVoice',
  'replyWithAudio',
  'reply',
]

/** Marker that waives ONE raw send site. Reason is mandatory. */
export const EXEMPT_MARKER = 'allow-raw-ctx-send:'

/**
 * Count raw, unwrapped context sends in one file.
 *
 * `allowApiInfix` is false: `ctx.api.sendMessage(...)` is the bash guard's
 * jurisdiction, and double-counting it here would make the two ratchets fight.
 */
export function countRawCtxSends(path, source) {
  return countRawCtxCalls(path, source, {
    methods: SEND_CTX_METHODS,
    exemptMarker: EXEMPT_MARKER,
    allowApiInfix: false,
  })
}

/**
 * Pure guard decision.
 *
 * @param {{path: string, source: string}[]} files
 * @param {Record<string, number>} baseline
 */
export function evaluateCtxSendWrapping(files, baseline) {
  const errors = []
  const counted = []

  for (const { path, source } of files) {
    const { count, sites, errors: siteErrors } = countRawCtxSends(path, source)
    errors.push(...siteErrors)
    counted.push({ path, count, sites })
  }

  const { errors: ratchetErrors, actual } = evaluateInventory(counted, baseline, {
    baselinePath: BASELINE_PATH,
    growMessage: ({ path, count, expected, fresh }) =>
      `${path}: ${count} raw context send(s), inventory says ${expected}. ` +
      `A NEW raw \`ctx.reply\`/\`ctx.replyWithRichMessage\` bypasses \`robustApiCall\`: ` +
      `grammy auto-injects \`message_thread_id\` so it is in the THREAD_NOT_FOUND blast ` +
      `radius with no \`retryWithThreadFallback\`, its 429s never reach the flood ledger, ` +
      `and the card it posts leaves no history row for a quote-reply to resolve ` +
      `(switchroom#4599). Route it through \`robustApiCall\`, or mark it ` +
      `\`// ${EXEMPT_MARKER} <reason>\`.\n      Candidates:\n        ` +
      fresh.join('\n        '),
  })
  errors.push(...ratchetErrors)

  return { ok: errors.length === 0, errors, actual }
}

/** Non-test TypeScript sources that could carry a context send. */
export function listSourceFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '--', 'telegram-plugin/**/*.ts', 'src/**/*.ts'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  })
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
    if (!source.includes('ctx.reply')) continue
    files.push({ path: relative(repoRoot, resolve(repoRoot, rel)), source })
  }

  const { ok, errors, actual } = evaluateCtxSendWrapping(files, baseline.files ?? baseline)
  if (!ok) {
    console.error('check-ctx-send-wrapping: FAILED\n')
    for (const e of errors) console.error(`  - ${e}\n`)
    console.error('See scripts/check-ctx-send-wrapping.mjs for the rationale (switchroom#4599).')
    process.exit(1)
  }
  const total = Object.values(actual).reduce((a, b) => a + b, 0)
  console.error(
    `check-ctx-send-wrapping: clean (${total} raw context send(s) across ` +
      `${Object.keys(actual).length} file(s), all inventoried)`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
