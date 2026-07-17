#!/usr/bin/env node
/**
 * Anti-inflation ratchet for `telegram-plugin/gateway/gateway.ts`
 * (switchroom#2996 P0.5).
 *
 * Why this script exists
 * ----------------------
 * gateway.ts is the dominant reliability-defect magnet, and it has been
 * *growing during its own decomposition*: 28.8k (issue #2996 filed) →
 * 29.0k → 26.7k (after #3013) → 32.1k. Eight extraction PRs (#3006–#3013)
 * landed real seams, but unrelated feature work re-inflated the file faster
 * than the extractions drained it. The structural conclusion of the
 * decomposition plan: extraction alone will NOT shrink this file unless new
 * inline code stops landing in it.
 *
 * Product rule (CLAUDE.md dev-protocol #4): "deterministic mechanisms over
 * model-dependent behavior." A code-review convention ("please don't add
 * inline code to gateway.ts") is discipline; it demonstrably failed. This
 * script is the deterministic replacement: a checked-in line-count ceiling
 * (the "ratchet") that CI enforces on every PR.
 *
 * The rule (a monotonically-tightening band)
 * ------------------------------------------
 * Let `actual` = current line count of gateway.ts, `ratchet` = the checked-in
 * ceiling in `scripts/gateway-line-ratchet.txt`, and `SLACK` a small grace.
 *
 *   1. INFLATION   — FAIL if `actual > ratchet + SLACK`.
 *      You may not grow gateway.ts past its ceiling (plus a tiny grace for a
 *      refactor that temporarily adds a few lines before deleting more).
 *      Move code OUT into a module; do not add inline bodies.
 *
 *   2. AUTO-TIGHTEN — FAIL if `ratchet - actual > SLACK`.
 *      When the file shrinks more than SLACK below the ceiling, you MUST lower
 *      the ratchet in the same PR. This is what makes it *ratchet*: every
 *      extraction that removes lines is forced to record the new, lower ceiling,
 *      so the file can never silently re-inflate back up to an old high-water
 *      mark. Keeps `ratchet` within SLACK of `actual` at all times.
 *
 *   3. NEVER-RAISE — FAIL if `ratchet > mainRatchet` (best-effort; enforced
 *      whenever the `origin/main` copy of the ratchet file is readable, i.e.
 *      in CI). A PR may LOWER the ratchet, never RAISE it. Combined with (1),
 *      this closes the slow-creep loophole (raise ceiling → add code → repeat).
 *
 * Net effect: the ceiling is a one-way ratchet that only clicks downward as
 * the P2–P8 extractions drain the file, and CI reds the moment new inline code
 * would push it back up.
 *
 * The pure decision lives in `evaluateRatchet()` (exported, unit-tested in
 * `tests/check-gateway-line-ratchet.test.ts`); `main()` does the I/O.
 *
 * Run: `npm run lint:gateway-line-ratchet` (also part of `npm run lint`).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export const GATEWAY_PATH = 'telegram-plugin/gateway/gateway.ts'
export const RATCHET_PATH = 'scripts/gateway-line-ratchet.txt'

/**
 * Grace, in lines. Small on purpose: big enough to absorb a legitimate
 * in-flight refactor that temporarily adds a handful of lines before deleting
 * more, tight enough that it can't be used to smuggle a feature in inline.
 */
export const SLACK = 50

/**
 * Count lines using `wc -l` semantics (number of newline characters), so the
 * checked-in ratchet value matches what a developer sees from `wc -l`.
 */
export function countLines(content) {
  let n = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) n++
  }
  return n
}

/**
 * Pure ratchet decision. Returns `{ ok, errors: string[] }`.
 *
 * @param {object} p
 * @param {number} p.actual        current gateway.ts line count
 * @param {number} p.ratchet       checked-in ceiling
 * @param {number} p.slack         grace band
 * @param {number|null} p.mainRatchet  ceiling on origin/main, or null if unknown
 */
export function evaluateRatchet({ actual, ratchet, slack = SLACK, mainRatchet = null }) {
  const errors = []

  if (!Number.isInteger(ratchet) || ratchet <= 0) {
    errors.push(
      `ratchet value in ${RATCHET_PATH} is not a positive integer (got ${JSON.stringify(ratchet)}).`,
    )
    // Can't reason further without a valid ceiling.
    return { ok: false, errors }
  }

  // 1. INFLATION
  if (actual > ratchet + slack) {
    errors.push(
      `INFLATION: ${GATEWAY_PATH} is ${actual} lines, which exceeds the ratchet ` +
        `ceiling ${ratchet} (+${slack} grace). Do not add inline code to gateway.ts — ` +
        `move the new logic into a module (see switchroom#2996). If you genuinely ` +
        `must grow the file, that is a design decision, not a lint override.`,
    )
  }

  // 2. AUTO-TIGHTEN
  if (ratchet - actual > slack) {
    const suggested = actual + slack
    errors.push(
      `STALE RATCHET: ${GATEWAY_PATH} shrank to ${actual} lines but the ratchet is ` +
        `still ${ratchet}. Lower it in ${RATCHET_PATH} to ${suggested} or less (ratchets ` +
        `only ever go down). This records the new, lower ceiling so the file can't ` +
        `silently re-inflate to an old high-water mark.`,
    )
  }

  // 3. NEVER-RAISE (best-effort)
  if (mainRatchet != null && Number.isInteger(mainRatchet) && ratchet > mainRatchet) {
    errors.push(
      `RATCHET RAISED: the ratchet in ${RATCHET_PATH} is ${ratchet}, higher than ` +
        `origin/main's ${mainRatchet}. A PR may only LOWER the gateway.ts ratchet, ` +
        `never raise it. Revert the increase; extract code instead.`,
    )
  }

  return { ok: errors.length === 0, errors }
}

function readMainRatchet(repoRoot) {
  // Best-effort: read the ratchet file as it exists on origin/main so we can
  // enforce NEVER-RAISE. In CI the PR checkout has origin/main fetched; when
  // it isn't reachable (fresh clone, first introduction of the file, shallow
  // checkout, detached local dir) we skip this sub-check rather than fail.
  try {
    const out = execFileSync('git', ['show', `origin/main:${RATCHET_PATH}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const v = parseInt(out.trim(), 10)
    return Number.isInteger(v) ? v : null
  } catch {
    return null
  }
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  let ratchetRaw
  try {
    ratchetRaw = readFileSync(resolve(repoRoot, RATCHET_PATH), 'utf-8')
  } catch (err) {
    console.error(
      `check-gateway-line-ratchet: cannot read ${RATCHET_PATH}: ${err?.message ?? err}`,
    )
    process.exit(1)
  }
  const ratchet = parseInt(ratchetRaw.trim(), 10)

  let src
  try {
    src = readFileSync(resolve(repoRoot, GATEWAY_PATH), 'utf-8')
  } catch (err) {
    console.error(
      `check-gateway-line-ratchet: cannot read ${GATEWAY_PATH}: ${err?.message ?? err}`,
    )
    process.exit(1)
  }
  const actual = countLines(src)
  const mainRatchet = readMainRatchet(repoRoot)

  const { ok, errors } = evaluateRatchet({ actual, ratchet, slack: SLACK, mainRatchet })

  if (!ok) {
    console.error('check-gateway-line-ratchet: FAILED\n')
    for (const e of errors) console.error(`  - ${e}\n`)
    console.error(
      `See scripts/check-gateway-line-ratchet.mjs for the rationale ` +
        `(switchroom#2996 P0.5 anti-inflation ratchet).`,
    )
    process.exit(1)
  }

  console.log(
    `check-gateway-line-ratchet: clean (${GATEWAY_PATH} = ${actual} lines, ` +
      `ratchet ${ratchet}, slack ${SLACK}${mainRatchet != null ? `, main ${mainRatchet}` : ', main unknown'})`,
  )
}

// Only run the I/O + process.exit path when invoked as a script, so the module
// can be imported side-effect-free by the unit test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
