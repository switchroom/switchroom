/**
 * switchroom#4641 — wiring pin for the boot-resume generation guard.
 *
 * `boot-resume-gateway-only-respawn.test.ts` proves the OUTCOME (a stamped
 * generation token yields zero `resume_interrupted` spool entries, an unstamped
 * one still resumes) over the real registry, builders and spool, but it
 * supplies the ORDERING itself: gateway.ts is a 24k-line module whose boot
 * block cannot be imported without booting a gateway. This file closes that gap
 * by pinning gateway.ts's own wiring, so a refactor cannot move the guard below
 * the reaper, drop it, or move the token stamp out of the block's tail while
 * the outcome suite stays green against its own copy of the sequence.
 *
 * Pinned, in source order inside the labelled `bootResumeInit` block:
 *   1. the label exists and is on the `isGatewayMain` boot-registry block,
 *   2. the guard runs and `break`s out of that label,
 *   3. it precedes the orphan-turn reaper, the bridge-dead marker consumption,
 *      the interrupted-turn finder, the resume builders, the crash-redelivery
 *      capture and `writePendingTurnEnv` — i.e. `break` skips ALL of them,
 *   4. the break carries a comment naming those skipped effects (the reviewer
 *      MEDIUM: the skip is wider than the resume path and was undocumented),
 *   5. the generation token is stamped as the LAST thing the block does, so a
 *      gateway that dies mid-boot leaves no token behind.
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
      "import { shouldSkipBootResumeForGatewayOnlyRespawn, markBootResumeComplete } from './agent-process-liveness.js'",
    )
  })

  it('runs the guard BEFORE every side effect a gateway-only respawn must skip', () => {
    const guard = idx('shouldSkipBootResumeForGatewayOnlyRespawn(STATE_DIR)')
    // The orphan-turn reaper — what stamped the live turn `ended_via='restart'`.
    expect(guard).toBeLessThan(idx('markOrphanedWithTimeoutClassification(turnsDb'))
    // #3038 bridge-dead escalation marker consumption.
    expect(guard).toBeLessThan(idx('consumeBridgeDeadEscalationMarker('))
    // The interrupted-turn finder + the synthetic that lied to the session.
    expect(guard).toBeLessThan(idx('findLatestTurnIfInterrupted(turnsDb)'))
    expect(guard).toBeLessThan(idx('buildResumeInterruptedInbound({'))
    // The sub-agent "killed by the restart" list.
    expect(guard).toBeLessThan(idx('listNonTerminalSubagentsForTurn(turnsDb'))
    // The crash-redelivery candidate capture.
    expect(guard).toBeLessThan(idx('pendingRedelivery = { turn: pending'))
    // The bridge-dead idle notice.
    expect(guard).toBeLessThan(idx('buildBridgeDeadIdleNoticeInbound({'))
    // The one-shot wake-audit env file.
    expect(guard).toBeLessThan(idx('writePendingTurnEnv(agentDir, pending)'))
  })

  it('documents at the break every effect it skips beyond the resume path', () => {
    // The reviewer MEDIUM: `break bootResumeInit` silently skipped the
    // bridge-dead marker (whose own comment claims it is ALWAYS cleared), the
    // idle notice and the redelivery capture. The break must name them, so the
    // next reader of gateway.ts:1721 is not misled by that stale invariant.
    const line = SRC.split('\n').find((l) => l.includes('break bootResumeInit'))
    expect(line, 'gateway.ts should contain the guarded break').toBeDefined()
    for (const named of [
      'reaper',
      'consumeBridgeDeadEscalationMarker',
      'idle notice',
      'pendingRedelivery',
      'writePendingTurnEnv',
    ]) {
      expect(line!, `the break comment must name ${named}`).toContain(named)
    }
  })

  it('stamps the generation token as the LAST statement of the block', () => {
    // A gateway that crashes mid-boot must leave NO token, so its successor
    // redoes the boot resume (reviewer MAJOR 2). That property is exactly
    // "the stamp is last": everything the block does precedes it.
    const stamp = idx('markBootResumeComplete(STATE_DIR)')
    for (const effect of [
      'markOrphanedWithTimeoutClassification(turnsDb',
      'consumeBridgeDeadEscalationMarker(',
      'findLatestTurnIfInterrupted(turnsDb)',
      'buildResumeInterruptedInbound({',
      'buildBridgeDeadIdleNoticeInbound({',
      'writePendingTurnEnv(agentDir, pending)',
    ]) {
      expect(idx(effect), `${effect} must run before the token stamp`).toBeLessThan(stamp)
    }
    // …and it is inside the block, i.e. before the block's catch clause.
    const blockStart = idx('bootResumeInit: if (isGatewayMain) try {')
    const catchAt = SRC.indexOf('} catch (err) {', stamp)
    expect(blockStart).toBeLessThan(stamp)
    expect(catchAt).toBeGreaterThan(stamp)
    // Nothing else may run between the stamp and the end of the block.
    const afterStamp = SRC.slice(stamp, catchAt)
      .replace('markBootResumeComplete(STATE_DIR)', '')
      .replace(/\/\/[^\n]*/g, '')
      .trim()
    expect(afterStamp, 'no statement may follow the generation-token stamp').toBe('')
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
