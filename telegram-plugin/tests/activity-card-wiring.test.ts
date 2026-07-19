/**
 * Activity-card durability WIRING (deterministic-turn-liveness.md Known Gap 1 +
 * the #2895 review fix). The 20 behavioural tests in activity-card-store.test.ts
 * drive the pure store/reaper in ISOLATION — they prove the routine is correct
 * but say nothing about whether the GATEWAY actually calls it. That is exactly
 * the decision-vs-delivery gap the whole RFC exists to close, applied to its own
 * follow-up: a refactor that drops the `writeActivityCardRecord` call on card
 * open would keep every store test green while silently un-delivering the
 * guarantee.
 *
 * The gateway IIFE can't be instantiated in-process (same constraint as
 * silence-liveness-wiring.test.ts / multitopic-routing-wiring.test.ts), so these
 * are STRUCTURAL assertions that pin the three load-bearing call sites. They
 * COMPLEMENT (never replace) the behavioural store tests — the RFC's "structural
 * grep may not be the SOLE coverage" bar is met because the outcome is proven at
 * the routine level; this only guards the wiring the routine depends on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')
// #2996 P4-B: drainActivitySummary (the card-OPEN persist site) and
// clearActivitySummary (the normal-CLOSE clear site) moved VERBATIM into
// narrative-lane.ts (bodies indented +2 inside the factory — multi-line
// markers below use the lane spelling).
const laneSrc = readFileSync(resolve(__dirname, '..', 'gateway', 'narrative-lane.ts'), 'utf-8')

function between(src: string, startMarker: string, endMarker: string): string {
  const after = src.split(startMarker)[1] ?? ''
  return after.split(endMarker)[0] ?? ''
}

describe('activity-card durability wiring', () => {
  it('the card-OPEN path persists the durable handle (writeActivityCardRecord)', () => {
    // The open branch runs when activityMessageId transitions null → set.
    const openBranch = between(
      laneSrc,
      'if (turn.activityMessageId == null) {',
      'turn.activityLastSentRender = target',
    )
    expect(openBranch.length).toBeGreaterThan(100)
    expect(openBranch).toMatch(/writeActivityCardRecord\(/)
    // Persist is gated on the feature flag, not unconditional.
    expect(openBranch).toMatch(/activityCardPersistEnabled/)
    // Pin honesty: the persisted RECORD mirrors the ACTUAL pin decision, never
    // a bare `pinned: true` (the #2895 review fix). Scope the negative check to
    // the writeActivityCardRecord argument block — the reconcileStatusPin call
    // further down legitimately passes `{ pinned: true }` as the desired state.
    const recordBlock = between(openBranch, 'writeActivityCardRecord(', 'void reconcileStatusPin(')
    expect(recordBlock).toMatch(/pinned: PIN_STATUS_WHILE_WORKING/)
    // Strip comment lines (the code comment legitimately quotes the old
    // `pinned: true` shape it's warning against) before checking the CODE.
    const recordCode = recordBlock
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(recordCode).not.toMatch(/pinned: true/)
  })

  // F6 (persist-intent-first ordering): the durable record must be written in
  // the SAME synchronous block as the send, BEFORE the status-pin reconcile and
  // with NO `await` between the send resolving and the persist — otherwise the
  // crash window in which a sent card has no reapable record reopens. Structural
  // lock (the gateway IIFE can't be instantiated in-process); complements the
  // behavioural store/reaper tests in activity-card-store.test.ts.
  it('(F6) persists the record BEFORE the status-pin reconcile, with no await between send and persist', () => {
    const openBranch = between(
      laneSrc,
      'if (turn.activityMessageId == null) {',
      'turn.activityLastSentRender = target',
    )
    const persistIdx = openBranch.indexOf('writeActivityCardRecord(')
    const pinIdx = openBranch.indexOf('void reconcileStatusPin(')
    expect(persistIdx).toBeGreaterThanOrEqual(0)
    expect(pinIdx).toBeGreaterThanOrEqual(0)
    // Persist-intent-first: the record write precedes the pin reconcile.
    expect(persistIdx).toBeLessThan(pinIdx)
    // No `await` sits between the send returning and the persist — the whole
    // window from `const sent =` to writeActivityCardRecord( is synchronous.
    const sendToPersist = between(openBranch, 'const sent = await robustApiCall', 'writeActivityCardRecord(')
    const codeOnly = sendToPersist
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(codeOnly).not.toMatch(/\bawait\b/)
  })

  // F5 (persist-intent honesty): the persisted `pinned` mirrors the ACTUAL pin
  // decision (PIN_STATUS_WHILE_WORKING), never a bare `pinned: true`. This is
  // also asserted in the OPEN test above; kept as a named F5 lock so a rename or
  // refactor that reintroduces an unconditional `pinned: true` is caught here too.
  it('(F5) the persisted record mirrors the real pin decision, not an unconditional pinned:true', () => {
    const openBranch = between(
      laneSrc,
      'if (turn.activityMessageId == null) {',
      'turn.activityLastSentRender = target',
    )
    const recordBlock = between(openBranch, 'writeActivityCardRecord(', 'void reconcileStatusPin(')
    const recordCode = recordBlock
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(recordCode).toMatch(/pinned: PIN_STATUS_WHILE_WORKING/)
    expect(recordCode).not.toMatch(/pinned: true/)
  })

  it('the normal-CLOSE path clears the durable handle, id-scoped (reap-race guard)', () => {
    const closeBody = between(
      laneSrc,
      'const id = turn.activityMessageId\n      turn.activityMessageId = null',
      'if (CLEAR_STATUS_ON_COMPLETION)',
    )
    expect(closeBody.length).toBeGreaterThan(50)
    expect(closeBody).toMatch(/clearActivityCardRecord\(/)
    // Must pass the id so it only drops THIS card's row (not a fresher upsert).
    expect(closeBody).toMatch(/\n\s*id,\s*\n/)
  })

  it('the boot reaper runs ONLY after the startup mutex is won (never at import time)', () => {
    // #3026: the reaper is now invoked via the mutex-gated orchestrator
    // runBootPinCleanupAndDmSweep() (which awaits it alongside
    // statusPinBootCleanup + queuedCardBootReaper, then runs the DM
    // stale-pin sweep). Invariant unchanged: reachable only post-lock.
    // (1) The orchestrator awaits the reaper.
    const orchestrator = between(
      gatewaySrc,
      'async function runBootPinCleanupAndDmSweep()',
      'dmPinSweepEligible = true',
    )
    expect(orchestrator).toMatch(/await activityCardBootReaper\(\)/)
    // (2) Both orchestrator invocation sites (mutex-won + mutex-fallback)
    // sit AFTER acquireStartupLock.
    const afterLock = between(gatewaySrc, 'await acquireStartupLock({', 'catch (err)')
    expect(afterLock).toMatch(/void runBootPinCleanupAndDmSweep\(\)/)
    // (3) Neither the reaper nor the orchestrator is invoked at module import
    // time — the same losing-double-boot hazard the NOTE at
    // statusPinBootCleanup documents.
    const beforeMain = gatewaySrc.split('await acquireStartupLock({')[0] ?? ''
    expect(beforeMain).not.toMatch(/^\s*void activityCardBootReaper\(\)/m)
    expect(beforeMain).not.toMatch(/^\s*void runBootPinCleanupAndDmSweep\(\)/m)
  })

  it('the reaper wrapper counts a benign-400 as vanished, not finalized (honest boot log)', () => {
    const wrapper = between(
      gatewaySrc,
      'async function activityCardBootReaper()',
      '\n// NOTE: statusPinBootCleanup()',
    )
    expect(wrapper).toMatch(/vanished/)
    expect(wrapper).toMatch(/at-most-once/)
  })
})
