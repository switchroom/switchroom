/**
 * switchroom#4641 — wiring pin for the boot-resume generation guard.
 *
 * `boot-resume-gateway-only-respawn.test.ts` proves the OUTCOME (a stamped
 * generation token yields zero `resume_interrupted` spool entries, an unstamped
 * one still resumes) over the real registry, builders and spool, but it
 * supplies the ORDERING itself: gateway.ts is a 24k-line module whose boot
 * block cannot be imported without booting a gateway. This file closes that gap
 * by pinning gateway.ts's own wiring, so a refactor cannot move the guard below
 * the reaper, drop it, or move the token stamp back inside the block while
 * the outcome suite stays green against its own copy of the sequence.
 *
 * Pinned:
 *   1. the label exists and is on the `isGatewayMain` boot-registry block,
 *   2. the guard runs and `break`s out of that label,
 *   3. it precedes the orphan-turn reaper, the bridge-dead marker consumption,
 *      the interrupted-turn finder, the resume builders, the crash-redelivery
 *      capture and `writePendingTurnEnv` — i.e. `break` skips ALL of them,
 *   4. the break carries a comment naming those skipped effects (the reviewer
 *      MEDIUM: the skip is wider than the resume path and was undocumented),
 *   5. THE STAMP FOLLOWS THE DURABLE PUT. The `bootResumeInit` block only
 *      builds `bootResumeInbound` in MEMORY; the resume becomes crash-
 *      survivable ~8k lines later at `inboundSpool.put(...)`. Stamping at the
 *      tail of the block (the shape this PR's first revision shipped) means a
 *      crash in between leaves a token, no `agent-process.json`, and a
 *      successor that suppresses a turn already stamped `ended_via='restart'`
 *      — silent, permanent work loss. So: the stamp must NOT appear inside the
 *      block at all, must come after the put and after `markTurnResumed`, and
 *      must be UNCONDITIONAL (top-level, gated only on `isGatewayMain`) so a
 *      boot with nothing to resume still writes a token. Same rule
 *      `markTurnResumed` already obeys — see turns-schema.ts's "the caller
 *      must stamp only AFTER the resume inbound is durably spooled".
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

  it('stamps the generation token AFTER the durable spool put, never inside the block', () => {
    // The invariant this pins, and why it is NOT "the stamp is last in the
    // block": the block builds `bootResumeInbound` in memory only. Stamping at
    // its tail marks the generation done while the resume is still nowhere on
    // disk, so a crash before the put leaves a token + no `agent-process.json`
    // + a turn stamped `ended_via='restart'` and `resumed_at` NULL — and the
    // successor returns `gateway-only-respawn-no-record` and drops it forever.
    const durablePut = idx('inboundSpool.put(bootResumeInbound.agent, bootResumeInbound.msg)')
    const stamps = [...SRC.matchAll(/markBootResumeComplete\(STATE_DIR\)/g)].map((m) => m.index!)
    expect(stamps.length, 'exactly one token stamp site in gateway.ts').toBe(1)
    const stamp = stamps[0]!

    // 1. It is OUTSIDE the bootResumeInit block: the block's `} catch (err) {`
    //    closes long before the stamp.
    const blockStart = idx('bootResumeInit: if (isGatewayMain) try {')
    const blockEnd = SRC.indexOf('} catch (err) {', blockStart)
    expect(blockEnd).toBeGreaterThan(blockStart)
    expect(
      stamp,
      'the token stamp must NOT live inside the bootResumeInit block — the block only builds the resume in memory',
    ).toBeGreaterThan(blockEnd)

    // 2. It follows the durable put, and the at-most-once `markTurnResumed`
    //    ledger that obeys the identical ordering rule.
    expect(durablePut, 'the durable spool put must precede the token stamp').toBeLessThan(stamp)
    expect(idx('markTurnResumed(turnsDb, resumeTurnKey)')).toBeLessThan(stamp)

    // 3. It is top-level (zero indentation, so not nested inside
    //    `if (isGatewayMain && bootResumeInbound != null)`) and independent of
    //    whether there was anything to resume — a boot that found nothing must
    //    still stamp, or a later gateway-only respawn reaps a
    //    meanwhile-started live turn — but it IS gated on the block not having
    //    thrown. gateway.ts's block-level `catch` swallows and lets init
    //    continue, so an ungated stamp marks the generation done after the
    //    reaper has already durably ended a turn that was never spooled.
    const stampLine = SRC.split('\n').find((l) => l.includes('markBootResumeComplete(STATE_DIR)'))!
    expect(stampLine).toMatch(
      /^if \(isGatewayMain && !bootResumeThrew\) markBootResumeComplete\(STATE_DIR\)/,
    )

    // 4. Nothing durable-resume-related may sneak between the put and the
    //    stamp except the resumed_at ledger — i.e. the stamp closes that
    //    sequence rather than floating somewhere later in module init.
    const between = SRC.slice(durablePut + 1, stamp)
    expect(between, 'no second spool put may separate the durable put from the stamp')
      .not.toContain('inboundSpool.put(bootResumeInbound')
    expect(
      between.split('\n').length,
      'the stamp must sit immediately after the resume-commit block, not drift away from it',
    ).toBeLessThan(40)
  })

  it('does not re-join the stamp onto writePendingTurnEnv inside the block', () => {
    // The exact regression shape: `writePendingTurnEnv(agentDir, pending); markBootResumeComplete(STATE_DIR)`
    // — joined onto one line to satisfy the gateway line ratchet. The ratchet
    // is not a licence to stamp early.
    const envLine = SRC.split('\n').find((l) => l.includes('writePendingTurnEnv(agentDir, pending)'))!
    expect(
      envLine,
      'the generation token must not be stamped alongside writePendingTurnEnv (still in-memory-only territory)',
    ).not.toContain('markBootResumeComplete')
  })

  it("sets bootResumeThrew in the block's own catch, and nowhere else", () => {
    // The catch is a SWALLOW: it logs, nulls turnsDb and lets module init run
    // on to the stamp. By then the reaper may already have durably written
    // `ended_via='restart'` with nothing spooled, so the catch must record the
    // failure and the stamp must honour it. Pinned by source text because the
    // block is module-init code this suite cannot import.
    const blockStart = idx('bootResumeInit: if (isGatewayMain) try {')
    const catchAt = SRC.indexOf('} catch (err) {', blockStart)
    const stamp = idx('markBootResumeComplete(STATE_DIR)')

    const sets = [...SRC.matchAll(/bootResumeThrew = true/g)].map((m) => m.index!)
    expect(sets.length, 'exactly one assignment site').toBe(1)
    expect(sets[0]!, "the assignment must be in the block's catch").toBeGreaterThan(catchAt)
    expect(sets[0]!, 'and before the stamp reads it').toBeLessThan(stamp)

    // The catch must not early-return/exit instead: init continues, which is
    // precisely why the flag is needed.
    const catchBody = SRC.slice(catchAt, SRC.indexOf('\n}\n', catchAt) + 2)
    expect(catchBody).toContain('turnsDb = null')
    expect(catchBody).not.toContain('process.exit')

    const decl = SRC.indexOf('let bootResumeThrew = false')
    expect(decl, 'declared before the block so the stamp can read it').toBeGreaterThan(-1)
    expect(decl).toBeLessThan(blockStart)
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
