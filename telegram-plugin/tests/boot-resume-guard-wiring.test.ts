/**
 * switchroom#4641 — wiring pin for the gateway-only-respawn guard.
 *
 * `boot-resume-gateway-only-respawn.test.ts` proves the OUTCOME (a live agent
 * process yields zero `resume_interrupted` spool entries) over the real
 * registry, builders and spool, but it supplies the ORDERING itself: gateway.ts
 * is a 24k-line module whose boot block cannot be imported without booting a
 * gateway. This file closes that gap by pinning gateway.ts's own wiring, so a
 * refactor cannot move the guard below the reaper — or drop it — while the
 * outcome suite stays green against its own copy of the sequence.
 *
 * Pinned, in source order inside the labelled `bootResumeInit` block:
 *   1. the label exists and is on the `isGatewayMain` boot-registry block,
 *   2. the guard runs and `break`s out of that label,
 *   3. it precedes the orphan-turn reaper, the interrupted-turn finder, the
 *      resume builders and `writePendingTurnEnv` — i.e. `break` skips ALL of
 *      them, which is exactly what "the agent was never interrupted" means.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf8',
)

/** First index of `needle`, asserted present. */
function idx(needle: string): number {
  const i = SRC.indexOf(needle)
  expect(i, `gateway.ts should contain ${JSON.stringify(needle)}`).toBeGreaterThan(-1)
  return i
}

describe('#4641 boot-resume guard wiring in gateway.ts', () => {
  it('labels the boot-registry block so the guard can exit it', () => {
    expect(SRC).toContain('bootResumeInit: if (isGatewayMain) try {')
  })

  it('calls the guard and breaks out of the whole block', () => {
    expect(SRC).toMatch(
      /if \(shouldSkipBootResumeForGatewayOnlyRespawn\(STATE_DIR\)\) break bootResumeInit/,
    )
    expect(SRC).toContain(
      "import { shouldSkipBootResumeForGatewayOnlyRespawn } from './agent-process-liveness.js'",
    )
  })

  it('runs the guard BEFORE every side effect a gateway-only respawn must skip', () => {
    const guard = idx('shouldSkipBootResumeForGatewayOnlyRespawn(STATE_DIR)')
    // The orphan-turn reaper — what stamped the live turn `ended_via='restart'`.
    expect(guard).toBeLessThan(idx('markOrphanedWithTimeoutClassification(turnsDb'))
    // The interrupted-turn finder + the synthetic that lied to the session.
    expect(guard).toBeLessThan(idx('findLatestTurnIfInterrupted(turnsDb)'))
    expect(guard).toBeLessThan(idx('buildResumeInterruptedInbound({'))
    // The sub-agent "killed by the restart" list.
    expect(guard).toBeLessThan(idx('listNonTerminalSubagentsForTurn(turnsDb'))
    // The one-shot wake-audit env file.
    expect(guard).toBeLessThan(idx('writePendingTurnEnv(agentDir, pending)'))
  })

  it('keeps the guard AFTER the registry is opened, so turn tracking still works', () => {
    // A gateway-only respawn still needs a live turnsDb for the rest of the
    // gateway; the guard skips the boot-resume side effects, not the DB.
    expect(idx('turnsDb = openTurnsDb(agentDir)')).toBeLessThan(
      idx('shouldSkipBootResumeForGatewayOnlyRespawn(STATE_DIR)'),
    )
    expect(idx('applySubagentsSchema(turnsDb)')).toBeLessThan(
      idx('shouldSkipBootResumeForGatewayOnlyRespawn(STATE_DIR)'),
    )
  })
})
