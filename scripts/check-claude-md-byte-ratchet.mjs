#!/usr/bin/env node
/**
 * Anti-inflation ratchet for the rendered agent `CLAUDE.md` prompt surface.
 *
 * Why this script exists
 * ----------------------
 * `tests/scaffold.persona.test.ts` used to carry a bare byte ceiling as a
 * magic number, and the ceiling's own comment history is the argument for
 * this file: 26000 → 32000 → 33000 → (28000) → 32000 → 33500 → 37500 →
 * 40000. Every time a new always-loaded fragment breached it, the remedy
 * chosen was to RAISE the number. That is backwards — the ceiling exists to
 * make prompt growth expensive, and a ceiling you may raise costs nothing.
 *
 * Raising this number is NOT the remedy for a larger prompt. The remedies,
 * in order of preference, are:
 *   1. Move procedure into a skill that loads on demand (progressive
 *      disclosure) instead of into the always-loaded prompt.
 *   2. Put tool usage instructions in the TOOL DESCRIPTION, not the prompt.
 *   3. Delete a rule that duplicates another rule. Overlapping and
 *      conflicting instructions across layers make the model deliberate
 *      more, not behave better.
 *
 * (Rationale: Anthropic's context-engineering guidance for Claude 5 models —
 * they removed ~80% of Claude Code's own system prompt with no measurable
 * eval loss. Judgement criteria beat rule lists; progressive disclosure beats
 * putting it all upfront.)
 *
 * The rule (a monotonically-tightening band)
 * ------------------------------------------
 * Same shape as `check-gateway-line-ratchet.mjs` (switchroom#2996 P0.5),
 * which is the precedent this follows — bytes instead of lines:
 *
 *   1. INFLATION    — FAIL if `actual > ratchet + SLACK`.
 *   2. AUTO-TIGHTEN — FAIL if `ratchet - actual > SLACK`. A PR that shrinks
 *      the prompt MUST record the new, lower ceiling, so it can never
 *      silently re-inflate to an old high-water mark.
 *   3. NEVER-RAISE  — FAIL if `ratchet > mainRatchet` (best-effort; enforced
 *      whenever the `origin/main` copy is readable, i.e. in CI). A PR may
 *      LOWER the ratchet, never RAISE it.
 *
 * Enforcement point differs from the gateway ratchet: computing `actual`
 * requires RENDERING a profile through `scaffoldAgent`, which is TypeScript,
 * so the check runs inside the required `vitest` job (see
 * `tests/scaffold.persona.test.ts`) rather than as a standalone `npm run
 * lint` guard. The pure decision below is unit-tested in
 * `tests/check-claude-md-byte-ratchet.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const RATCHET_PATH = 'scripts/claude-md-byte-ratchet.txt'

/**
 * The stack the ratchet tracks: a root-tier agent on the DEFAULT profile —
 * the full admin surface PLUS the root-tier host-access block on top of the
 * largest profile body. Guard headroom where it actually matters.
 */
export const RATCHET_SUBJECT = 'rendered CLAUDE.md (root-tier + default profile)'

/**
 * Grace, in bytes. Small on purpose: enough to absorb a legitimate in-flight
 * edit that adds a sentence before deleting a paragraph, tight enough that it
 * can't be used to smuggle a new always-loaded section in (the smallest
 * fragment ever added was ~1.2KB).
 */
export const SLACK = 500

/**
 * Pure ratchet decision. Returns `{ ok, errors: string[] }`.
 *
 * @param {object} p
 * @param {number} p.actual        current rendered byte count
 * @param {number} p.ratchet       checked-in ceiling
 * @param {number} p.slack         grace band
 * @param {number|null} p.mainRatchet  ceiling on origin/main, or null if unknown
 * @param {boolean} p.autoTighten  apply rule 2. False for secondary stacks
 *                                 (e.g. a small profile) that legitimately
 *                                 sit far below the worst-case ceiling.
 */
export function evaluateRatchet({
  actual,
  ratchet,
  slack = SLACK,
  mainRatchet = null,
  autoTighten = true,
}) {
  const errors = []

  if (!Number.isInteger(ratchet) || ratchet <= 0) {
    errors.push(
      `ratchet value in ${RATCHET_PATH} is not a positive integer (got ${JSON.stringify(ratchet)}).`,
    )
    return { ok: false, errors }
  }

  // 1. INFLATION
  if (actual > ratchet + slack) {
    errors.push(
      `INFLATION: ${RATCHET_SUBJECT} is ${actual} bytes, exceeding the ratchet ` +
        `ceiling ${ratchet} (+${slack} grace). Raising the ceiling is NOT the remedy. ` +
        `Move the procedure into a skill that loads on demand, put tool instructions ` +
        `in the tool description, or delete a rule that duplicates another one. ` +
        `See scripts/check-claude-md-byte-ratchet.mjs for why.`,
    )
  }

  // 2. AUTO-TIGHTEN
  if (autoTighten && ratchet - actual > slack) {
    const suggested = actual + slack
    errors.push(
      `STALE RATCHET: ${RATCHET_SUBJECT} shrank to ${actual} bytes but the ratchet is ` +
        `still ${ratchet}. Lower it in ${RATCHET_PATH} to ${suggested} or less (ratchets ` +
        `only ever go down). This records the new, lower ceiling so the prompt can't ` +
        `silently re-inflate to an old high-water mark.`,
    )
  }

  // 3. NEVER-RAISE (best-effort)
  if (mainRatchet != null && Number.isInteger(mainRatchet) && ratchet > mainRatchet) {
    errors.push(
      `RATCHET RAISED: the ratchet in ${RATCHET_PATH} is ${ratchet}, higher than ` +
        `origin/main's ${mainRatchet}. A PR may only LOWER the CLAUDE.md byte ratchet, ` +
        `never raise it. Revert the increase and cut prompt instead.`,
    )
  }

  return { ok: errors.length === 0, errors }
}

/** Repo root, resolved from this file's location. */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Read the checked-in ceiling. Throws if unreadable — a missing ratchet is a bug. */
export function readRatchet(root = repoRoot()) {
  return parseInt(readFileSync(resolve(root, RATCHET_PATH), 'utf-8').trim(), 10)
}

/**
 * Best-effort read of the ratchet as it exists on origin/main, so NEVER-RAISE
 * can be enforced. Returns null when origin/main isn't reachable (fresh clone,
 * shallow checkout, first introduction of the file) rather than failing.
 */
export function readMainRatchet(root = repoRoot()) {
  try {
    const out = execFileSync('git', ['show', `origin/main:${RATCHET_PATH}`], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const v = parseInt(out.trim(), 10)
    return Number.isInteger(v) ? v : null
  } catch {
    return null
  }
}
