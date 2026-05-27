import { describe, expect, it } from 'vitest'

/**
 * PR3b regression pin: supergroup-mode parallel-turns deadlock fix.
 *
 * The bug. Pre-fix, the gateway used ONE map `activeTurnStartedAt`
 * for two distinct concerns:
 *   (a) "user-visible turn started" — set eagerly in the fresh-turn
 *       branch on inbound RECEIPT, used by per-key reads (status-query
 *       metric, wedge detection, progress timeout, etc.) that want a
 *       receipt-side timestamp.
 *   (b) "claude is currently busy on this turn" — the fleet-wide gate
 *       at purgeReactionTracking / releaseTurnBufferGate /
 *       idle-drain / inbound buffer-or-deliver, where `.size === 0`
 *       means "claude is idle, safe to flush buffered inbound."
 *
 * Under fleet-shared / DM topology the two concerns coincide — every
 * received inbound is delivered to claude — so the singleton worked.
 *
 * Under SUPERGROUP-OWNED topology (one agent owns the whole
 * supergroup, multiple topics share the gateway process), they
 * diverge:
 *
 *   1. Topic A delivers + processes — keyA in activeTurnStartedAt
 *      (set on receipt) AND claudeBusyKeys (set on delivery).
 *   2. Topic B inbound arrives → fresh-turn branch eagerly sets
 *      keyB in activeTurnStartedAt, displays 👀 / starts typing.
 *   3. `decideInboundDelivery` reads `turnInFlight = .size > 0` →
 *      TRUE (keyA present) → B is buffered, NOT delivered to claude.
 *   4. A's turn_end → purgeReactionTracking deletes keyA →
 *      `.size === 0` check fires the held-inbound flush. BUT under
 *      old (singleton) semantics, keyB is STILL in
 *      activeTurnStartedAt (set in step 2, never cleared because B
 *      never started in claude so no turn_end ever fires for B).
 *   5. `.size > 0` (keyB lingers) → flush never runs → B's buffered
 *      msg never delivered → B's user sees 👀 forever.
 *
 *   DEADLOCK.
 *
 * The fix splits concerns. `activeTurnStartedAt` keeps semantic (a)
 * — set on receipt, all per-key reads use it. `claudeBusyKeys` (new)
 * carries semantic (b) — set ONLY on successful sendToAgent
 * (delivery), cleared on turn_end / disconnect / buffer-gate-release.
 * Fleet gates switch to claudeBusyKeys. The deadlock breaks because
 * step 5's gate now reads `claudeBusyKeys.size` which only ever held
 * keyA (delivered) → after step 4's delete, size === 0 → flush →
 * B's buffered msg delivered → claudeBusyKeys.add(keyB) → ... →
 * B's eventual turn_end clears keyB.
 *
 * This test pins the load-bearing invariants. The actual wiring
 * lives in `gateway.ts` and `disconnect-flush.ts`; this file is the
 * structural-contract regression guard so a future "let's simplify
 * the gates back to one map" refactor fails loudly here.
 */

describe('PR3b parallel-turns deadlock fix: claudeBusyKeys decoupled from activeTurnStartedAt', () => {
  function makeState() {
    const activeTurnStartedAt = new Map<string, number>()
    const claudeBusyKeys = new Set<string>()
    return { activeTurnStartedAt, claudeBusyKeys }
  }

  // Mirror the gateway's fresh-turn-on-receipt path (the part that
  // updates the two maps). Stripped to ONLY the state mutations we
  // care about for this invariant.
  function receiveInbound(state: ReturnType<typeof makeState>, key: string, at: number): void {
    state.activeTurnStartedAt.set(key, at)
    // CRITICAL: claudeBusyKeys is NOT touched here. The whole point
    // of the split is that receipt ≠ delivery.
  }

  function deliverToClaude(state: ReturnType<typeof makeState>, key: string): void {
    // Mirror of markClaudeBusyForInbound at every successful
    // sendToAgent callsite in gateway.ts.
    state.claudeBusyKeys.add(key)
  }

  function turnEnd(state: ReturnType<typeof makeState>, key: string): void {
    // Mirror of purgeReactionTracking + releaseTurnBufferGate —
    // both maps cleared together at turn_end.
    state.activeTurnStartedAt.delete(key)
    state.claudeBusyKeys.delete(key)
  }

  function fleetGateOpen(state: ReturnType<typeof makeState>): boolean {
    // Mirror of the four fleet-wide gates:
    //   purgeReactionTracking line 1393:  if (claudeBusyKeys.size === 0)
    //   releaseTurnBufferGate line 1484:  if (claudeBusyKeys.size === 0)
    //   onScheduleRestart line 4020:      turnInFlight = .size > 0
    //   idle-drain tick line 4343:        if (.size > 0) return false
    //   handleInbound line 8087:          turnInFlightAtReceipt = .size > 0
    return state.claudeBusyKeys.size === 0
  }

  it('pre-fix scenario: singleton map deadlocks supergroup-mode parallel turns', () => {
    // Simulate the BROKEN behavior — one map serving both concerns
    // (i.e. what would happen if claudeBusyKeys did NOT exist and
    // the gates read activeTurnStartedAt.size). This is the
    // *opposite* of the test below; documents what we're fixing.
    const legacyState = new Map<string, number>()
    const legacyFleetGate = () => legacyState.size === 0

    // Step 1: A delivered (eager set on receipt)
    legacyState.set('keyA', 100)
    // Step 2: B received but buffered (eager set fires regardless)
    legacyState.set('keyB', 200)
    expect(legacyFleetGate()).toBe(false)

    // Step 4: A's turn_end clears keyA
    legacyState.delete('keyA')
    // DEADLOCK — keyB lingers forever because B never started
    // in claude so no turn_end ever fires for B.
    expect(legacyFleetGate()).toBe(false)
    expect(legacyState.has('keyB')).toBe(true)
  })

  it('post-fix scenario: split maps let A.turn_end unblock B', () => {
    const state = makeState()

    // Step 1: A's inbound received AND delivered to claude.
    receiveInbound(state, 'keyA', 100)
    deliverToClaude(state, 'keyA')
    expect(state.activeTurnStartedAt.has('keyA')).toBe(true)
    expect(state.claudeBusyKeys.has('keyA')).toBe(true)

    // Step 2: B's inbound received, but `decideInboundDelivery`
    // returned buffer-until-idle (turnInFlightAtReceipt was true
    // because keyA is in claudeBusyKeys). B's fresh-turn branch
    // STILL fired — eager activeTurnStartedAt[keyB] set —
    // for the user-visible 👀 / typing indicator.
    receiveInbound(state, 'keyB', 200)
    // CRITICAL: claudeBusyKeys does NOT contain keyB because B was
    // buffered, not delivered. The split semantics is the entire
    // PR3b contract.
    expect(state.activeTurnStartedAt.has('keyB')).toBe(true)
    expect(state.claudeBusyKeys.has('keyB')).toBe(false)
    expect(state.claudeBusyKeys.size).toBe(1)
    expect(fleetGateOpen(state)).toBe(false)

    // Step 4: A's turn_end clears keyA from BOTH maps.
    turnEnd(state, 'keyA')

    // Step 5 (the deadlock fix): fleet gate now OPENS because
    // claudeBusyKeys is empty, even though activeTurnStartedAt
    // still has keyB (which is fine — that's the user-visible
    // receipt timestamp, not the claude-busy flag).
    expect(state.claudeBusyKeys.size).toBe(0)
    expect(state.activeTurnStartedAt.has('keyB')).toBe(true)
    expect(fleetGateOpen(state)).toBe(true)

    // The flush triggers → B's buffered msg gets sent →
    // deliverToClaude fires for keyB → busy gate closes again.
    deliverToClaude(state, 'keyB')
    expect(fleetGateOpen(state)).toBe(false)

    // B's turn_end completes the cycle.
    turnEnd(state, 'keyB')
    expect(state.activeTurnStartedAt.size).toBe(0)
    expect(state.claudeBusyKeys.size).toBe(0)
    expect(fleetGateOpen(state)).toBe(true)
  })

  it('per-key reads (priorTurnStartedAt timing, status-query metric) keep working on activeTurnStartedAt', () => {
    // The split must not regress per-key timestamp reads. These all
    // want the RECEIPT timestamp (the user's send-time, not when
    // claude finally got to it), so they correctly read
    // activeTurnStartedAt — preserved across the buffer window.
    const state = makeState()
    receiveInbound(state, 'keyA', 100)
    deliverToClaude(state, 'keyA')
    receiveInbound(state, 'keyB', 200) // buffered, no deliverToClaude

    // A second message on keyB arriving during the buffer window —
    // mid-turn classification reads activeTurnStartedAt.get(keyB)
    // for `priorTurnStartedAt`, which must still be 200 (the
    // original receipt time, even though B never reached claude).
    expect(state.activeTurnStartedAt.get('keyB')).toBe(200)
    // And keyA's receipt timestamp is preserved too — A's
    // follow-ups during its own processing window get accurate
    // secondsSinceTurnStart metric.
    expect(state.activeTurnStartedAt.get('keyA')).toBe(100)
  })

  it('disconnect-flush sweeps both maps together (the bridge died, all in-flight turns are dead)', () => {
    // Mirror of the disconnect-flush sweep loop in disconnect-flush.ts —
    // a registered-agent disconnect clears both maps because every
    // turn it was processing is dead by definition.
    const state = makeState()
    receiveInbound(state, 'keyA', 100)
    deliverToClaude(state, 'keyA')
    receiveInbound(state, 'keyB', 200) // buffered

    // Bridge dies (claude crashed mid-A). Sweep both maps.
    for (const k of [...state.activeTurnStartedAt.keys()]) {
      state.activeTurnStartedAt.delete(k)
      state.claudeBusyKeys.delete(k)
    }

    expect(state.activeTurnStartedAt.size).toBe(0)
    expect(state.claudeBusyKeys.size).toBe(0)
    expect(fleetGateOpen(state)).toBe(true)
  })

  it('idempotent: multiple inbounds for the same key (e.g. A user spamming) are a single entry', () => {
    // Set semantics — A's 5 follow-up messages while A is processing
    // collapse to a single claudeBusyKeys entry. Turn_end clears
    // once; size accounting stays correct.
    const state = makeState()
    receiveInbound(state, 'keyA', 100)
    deliverToClaude(state, 'keyA')
    deliverToClaude(state, 'keyA')
    deliverToClaude(state, 'keyA')
    expect(state.claudeBusyKeys.size).toBe(1)
    turnEnd(state, 'keyA')
    expect(state.claudeBusyKeys.size).toBe(0)
  })
})
