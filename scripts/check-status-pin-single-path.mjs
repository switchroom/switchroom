#!/usr/bin/env node
/**
 * check-status-pin-single-path — architectural fitness function for the
 * status-pin / progress-surface pin subsystem.
 *
 * Why this script exists
 * ----------------------
 * #3831: the retarget expansion (unpin the stale claim, then pin the new
 * message) existed TWICE — once in `gateway/status-pin-retarget.ts` and once
 * inside `status-pin-driver.ts`, where the driver called `decidePinAction`
 * itself and recursed. The two copies had DIFFERENT persistence semantics: the
 * driver's copy never went through `reconcileAndPersistStatusPin`, so whichever
 * copy ran decided whether the durable `status-pins.json` row survived a
 * retarget. The forked copy was unreachable in production for a while, which is
 * exactly why nobody noticed it had drifted.
 *
 * Tests catch a fork that MISBEHAVES. They do not catch a fork that is merely
 * ADDED, sits unreachable, and drifts until someone wires it up. This guard is
 * the deterministic half: a static, source-level check with an explicit
 * allowlist, so growing a second pin/unpin path requires a deliberate,
 * reviewable edit rather than happening by accident.
 *
 * THE SINGLE PATH
 * ---------------
 *   caller (narrative lane / worker feed / turn-end / reaper / boot sweep)
 *     → gateway `reconcileStatusPin(pinKey, chatId, desired)`
 *       → runStatusPinReconcile()   [gateway/status-pin-retarget.ts]
 *            the ONLY decider (decidePinAction) and the ONLY retarget expansion
 *         → reconcileAndPersistStatusPin()  [gateway/status-pin-store.ts]
 *              persist-BEFORE-pin, the ONLY writer of status-pins.json
 *           → executePinLeg()  [status-pin-driver.ts]
 *                executes ONE already-decided leg; cannot express a repin
 *             → createStatusPinApi()  [gateway/status-pin-api.ts]
 *                  the ONLY raw pinChatMessage / unpinChatMessage surface
 *
 * The rules
 * ---------
 *  1. raw-pin-api      A raw `pinChatMessage` / `unpinChatMessage` /
 *                      `unpinAllChatMessages` call outside a sanctioned file
 *                      needs an inline `// allow-raw-pin: <reason>` marker.
 *  2. single-decider   `decidePinAction(` may be called ONLY from the
 *                      orchestrator. No marker escape.
 *  3. single-expansion A `'repin'` action may be NAMED only by the pure
 *                      decision module and the orchestrator — a second
 *                      `kind === 'repin'` branch is the #3831 re-fork.
 *  4. claim-registry   The in-memory claim registry (`statusPinClaims`) may be
 *                      READ anywhere but MUTATED nowhere: it is mutated only by
 *                      handing it to `runStatusPinReconcile`. No marker escape.
 *  5. claim-store-write A raw `persistStatusPins(` / `mutateStatusPinRow(`
 *                      outside the store module needs an inline
 *                      `// allow-raw-pin-store: <reason>` marker.
 *  6. single-wiring    Only one file outside the modules themselves may call
 *                      `runStatusPinReconcile(` / `executePinLeg(` — a second
 *                      composition is a second pin subsystem.
 *  7. single-rights-detector  The pin-rights error class has ONE definition
 *                      (`isPinRightsError` in status-pin.ts). A SECOND exported
 *                      `isPinRightsError` anywhere else is a forked detector that
 *                      drifts — exactly the stale-pin-sweep duplicate this guard
 *                      was extended after deleting. No marker escape. (Named
 *                      folds with OTHER names that check "not enough rights" for
 *                      their own purpose are deliberately untouched.)
 *  8. sweep-no-getchatmember  A `getChatMember(` call inside the stale-pin-sweep
 *                      files is banned: the sweep classifies rights REACTIVELY
 *                      from a real Telegram 400. A proactive precheck wired
 *                      against the chat-lock-wrapped (botInfo-less) bot silently
 *                      forfeited every group cursor. `getChatMember` elsewhere
 *                      (e.g. the reaction admin lookup) is fine. No marker escape.
 *
 * Markers
 * -------
 * A marker may sit on the matched line itself (trailing comment) or on any of
 * the 3 lines immediately preceding it, and MUST carry a non-empty reason.
 * Rules 2, 3 and 4 have no marker escape by design: there is no legitimate
 * second decider, second expansion, or out-of-band claim mutation.
 *
 * Scope: `telegram-plugin/**.ts`, excluding `*.test.ts` and `*.d.ts` (tests
 * legitimately drive the internals directly — that is how the outcome suites
 * observe the real path).
 *
 * Run: `npm run lint:status-pin-single-path` (also part of `npm run lint`).
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const ALLOWLIST_PATH = 'scripts/check-status-pin-single-path-allowlist.txt'

const ORCHESTRATOR = 'telegram-plugin/gateway/status-pin-retarget.ts'
const DECISION = 'telegram-plugin/status-pin.ts'
const DRIVER = 'telegram-plugin/status-pin-driver.ts'
const STORE = 'telegram-plugin/gateway/status-pin-store.ts'

/** Parse `<rule> :: <path> :: <reason>` lines out of the allowlist. */
export function parseAllowlist(text) {
  const byRule = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split('::').map((p) => p.trim())
    if (parts.length < 3 || parts[0].length === 0 || parts[1].length === 0 || parts[2].length === 0) {
      throw new Error(
        `${ALLOWLIST_PATH}: malformed entry (want "<rule> :: <path> :: <reason>"): ${line}`,
      )
    }
    const [rule, path] = parts
    if (!byRule.has(rule)) byRule.set(rule, new Set())
    byRule.get(rule).add(path)
  }
  return byRule
}

/**
 * The pure decision: given the source of one file, produce the violations.
 * Exported so `tests/check-status-pin-single-path.test.ts` can drive it over
 * synthetic sources without touching the working tree.
 */
export function findViolations({ path, source, allow }) {
  const lines = source.split('\n')
  const out = []
  const allowed = (rule) => allow.get(rule)?.has(path) === true

  /** Is there a `// <marker>: <reason>` on this line or the 3 above it? */
  const hasMarker = (idx, marker) => {
    const re = new RegExp(`//\\s*${marker}:\\s*\\S`)
    for (let i = Math.max(0, idx - 3); i <= idx; i++) {
      if (re.test(lines[i])) return true
    }
    return false
  }

  /** Skip whole-line comments so a docblock mentioning a symbol is not a hit. */
  const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isCommentLine(line)) continue
    const at = `${path}:${i + 1}`

    // 1. raw pin API
    if (
      !allowed('raw-pin-api') &&
      /\b(un)?pin(All)?Chat(Message|Messages)\s*\(/.test(line) &&
      !hasMarker(i, 'allow-raw-pin')
    ) {
      out.push({
        rule: 'raw-pin-api',
        at,
        line: line.trim(),
        fix:
          'Route this through the unified path: call the gateway\'s ' +
          '`reconcileStatusPin(pinKey, chatId, { pinned, messageId })`, which ' +
          'drives runStatusPinReconcile → reconcileAndPersistStatusPin → ' +
          'executePinLeg → gateway/status-pin-api.ts. Only that path keeps the ' +
          'in-memory claim, the durable status-pins.json row and Telegram in ' +
          'agreement, so the reaper and the boot sweep can clean up after a ' +
          'crash. If this call genuinely cannot go through it, add ' +
          '`// allow-raw-pin: <reason>` on or immediately above the line.',
      })
    }

    // 2. single decider
    if (path !== ORCHESTRATOR && path !== DECISION && /\bdecidePinAction\s*\(/.test(line)) {
      out.push({
        rule: 'single-decider',
        at,
        line: line.trim(),
        fix:
          'Only `runStatusPinReconcile` (gateway/status-pin-retarget.ts) may ' +
          'decide a pin action. A second caller of decidePinAction is exactly ' +
          'the #3831 fork: two deciders whose persistence semantics drift. Call ' +
          'the gateway\'s `reconcileStatusPin(...)` instead.',
      })
    }

    // 3. single expansion
    if (path !== ORCHESTRATOR && path !== DECISION && /['"]repin['"]/.test(line)) {
      out.push({
        rule: 'single-expansion',
        at,
        line: line.trim(),
        fix:
          'The retarget (unpin the stale claim, then pin the new message) is ' +
          'expanded in exactly ONE place: `runStatusPinReconcile` in ' +
          'gateway/status-pin-retarget.ts, which persists each leg separately so ' +
          'a crash between them still leaves a recoverable durable row. Do not ' +
          'name or re-implement a `repin` anywhere else — drive the retarget by ' +
          'asking for the new messageId via `reconcileStatusPin(...)`.',
      })
    }

    // 4. claim registry mutation
    if (/\bstatusPinClaims\s*\.\s*(set|delete|clear)\s*\(/.test(line)) {
      out.push({
        rule: 'claim-registry',
        at,
        line: line.trim(),
        fix:
          'The claim registry is mutated ONLY by handing it to ' +
          '`runStatusPinReconcile({ ..., claims: statusPinClaims })`, which ' +
          'commits each leg as it lands so the in-memory claim never disagrees ' +
          'with the durable row. Writing it directly re-creates #3809 (a claim ' +
          'the reaper can never act on). Read it freely; do not mutate it.',
      })
    }

    // 5. raw durable-store write
    if (
      !allowed('claim-store-write') &&
      /\b(persistStatusPins|mutateStatusPinRow)\s*\(/.test(line) &&
      !hasMarker(i, 'allow-raw-pin-store')
    ) {
      out.push({
        rule: 'claim-store-write',
        at,
        line: line.trim(),
        fix:
          'status-pins.json is written by `reconcileAndPersistStatusPin` ' +
          '(gateway/status-pin-store.ts), which owns the persist-BEFORE-pin ' +
          'ordering a crash-safe recovery depends on. Go through ' +
          '`reconcileStatusPin(...)`. If this row genuinely has no pin leg (e.g. ' +
          'a bookkeeping-only row), add `// allow-raw-pin-store: <reason>` on or ' +
          'immediately above the line.',
      })
    }

    // 6. single wiring
    if (
      !allowed('single-wiring') &&
      path !== ORCHESTRATOR &&
      path !== DRIVER &&
      path !== STORE &&
      /\b(runStatusPinReconcile|executePinLeg)\s*\(/.test(line)
    ) {
      out.push({
        rule: 'single-wiring',
        at,
        line: line.trim(),
        fix:
          'Composing the orchestrator and the driver a second time creates a ' +
          'second pin subsystem with its own claim registry — the #3831 class of ' +
          'bug. There is one wiring, in telegram-plugin/gateway/gateway.ts; use ' +
          'its `reconcileStatusPin(...)`. If a genuinely separate subsystem is ' +
          `intended, add the file under \`single-wiring\` in ${ALLOWLIST_PATH}.`,
      })
    }

    // 7. single rights-detector — ONE `isPinRightsError` definition, in
    //    status-pin.ts. A second EXPORTED definition anywhere else is a forked
    //    detector that drifts (the deleted stale-pin-sweep copy). No escape.
    if (
      path !== DECISION &&
      /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+isPinRightsError\b/.test(line)
    ) {
      out.push({
        rule: 'single-rights-detector',
        at,
        line: line.trim(),
        fix:
          'The pin-rights error class has exactly ONE detector: ' +
          '`isPinRightsError` in telegram-plugin/status-pin.ts. A second exported ' +
          'copy is a fork that drifts from the source of truth (the reason the ' +
          'stale-pin-sweep duplicate was deleted). Import it from ' +
          "'../status-pin.js' instead of re-defining it. A fold with a DIFFERENT " +
          'name for a different purpose is fine — only a second `isPinRightsError` ' +
          'symbol is banned.',
      })
    }

    // 8. no proactive getChatMember precheck in the stale-pin sweep — rights are
    //    classified REACTIVELY from a real Telegram 400. A precheck against the
    //    chat-lock-wrapped (botInfo-less) bot forfeited every group cursor
    //    without a single unpin. getChatMember elsewhere is legitimate. No escape.
    if (path.includes('stale-pin-sweep') && /\bgetChatMember\s*\(/.test(line)) {
      out.push({
        rule: 'sweep-no-getchatmember',
        at,
        line: line.trim(),
        fix:
          'The stale-pin sweep must NOT re-introduce a proactive getChatMember ' +
          'rights precheck. It runs against the chat-lock-wrapped bot, which ' +
          'carries only `.api` (no `.botInfo`), so a precheck always resolved to ' +
          '"no rights" and forfeited every group cursor without ever attempting ' +
          'an unpin. Rights are classified REACTIVELY: attempt the unpin and fold ' +
          "Telegram's honest `400 not enough rights` via `isPinRightsError`. " +
          '(getChatMember in non-sweep code — e.g. the reaction admin lookup — is ' +
          'unaffected by this rule.)',
      })
    }
  }
  return out
}

function listFiles() {
  const out = execSync(`git ls-files 'telegram-plugin/*.ts' 'telegram-plugin/**/*.ts'`, {
    cwd: repoRoot,
    encoding: 'utf-8',
  })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith('.test.ts') && !l.endsWith('.d.ts'))
}

function main() {
  const allow = parseAllowlist(readFileSync(resolve(repoRoot, ALLOWLIST_PATH), 'utf-8'))
  const violations = []
  for (const path of listFiles()) {
    const source = readFileSync(resolve(repoRoot, path), 'utf-8')
    violations.push(...findViolations({ path, source, allow }))
  }

  if (violations.length === 0) {
    console.log('check-status-pin-single-path: clean (one pin path, as designed)')
    return
  }

  console.error(
    `\ncheck-status-pin-single-path: ${violations.length} violation(s) — ` +
      'the status-pin subsystem must have exactly ONE implementation.\n',
  )
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.at}`)
    console.error(`      ${v.line}`)
    console.error(`      → ${v.fix}\n`)
  }
  console.error(
    `Sanctioned files live in ${ALLOWLIST_PATH}. Adding one is a deliberate,\n` +
      'reviewable edit — that is the point. See the docblock at the top of this\n' +
      'script for the single path, and CLAUDE.md → "Progress surfaces and pins".\n',
  )
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
