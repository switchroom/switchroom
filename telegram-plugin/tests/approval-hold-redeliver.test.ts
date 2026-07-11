/**
 * #3084 follow-up, PR 2 — a held permission card must COME BACK when the flood
 * window closes.
 *
 * Holding instead of auto-denying is only safe if the ask actually returns.
 * This is the half that returns it. The risk it introduces is a BURST: a
 * backlog of held cards all firing the instant the window closes is the one
 * realistic way this design could re-earn the very ban it exists to survive.
 * Hence the per-tick cap, and hence these tests.
 *
 * No fake timers (bun-compatible) — the harness carries a virtual clock.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, readFileSync } from 'node:fs'
import { createHarness, type FaultKind } from './approval-hold-harness.js'
import {
  selectHeldForRedelivery,
  holdReasonFor,
  HELD_CARD_REDELIVERY_CAP,
} from '../gateway/approval-hold.js'

const FOUR_HOURS = 4 * 60 * 60_000
const MINUTE = 60_000

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(opts?: { cap?: number }) {
  const h = createHarness(opts)
  dirs.push(h.stateDir)
  return h
}

describe('held permission cards re-deliver when the window closes', () => {
  it('does not send while the window is open, then sends EXACTLY once when it closes', async () => {
    const h = harness()
    h.banFor(FOUR_HOURS)

    await h.raise('req-1', 'Bash', '{"command":"npm test"}')

    // (a) nothing landed during the ban
    expect(h.sends.length).toBe(0)
    expect(h.pending.get('req-1')?.undeliverable?.reason).toBe('flood_wait')

    // Ticks throughout the ban must not re-drive the send.
    for (let i = 0; i < 20; i++) {
      h.clock.advance(10 * MINUTE)
      await h.tickSettled()
    }
    expect(h.sends.length).toBe(0)
    expect(h.floodRemainingMs()).toBeGreaterThan(0)

    // Window closes.
    h.clock.advance(FOUR_HOURS)
    await h.tickSettled()

    // (d) exactly one card for the whole run — no loss, no duplicate.
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]!.requestId).toBe('req-1')
    // …and we never fired a request into a window we already knew was open.
    expect(h.sentIntoOpenWindow).toBe(false)
  })

  it('clears the hold mark and the blocked record once the card lands', async () => {
    const h = harness()
    h.banFor(FOUR_HOURS)
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')
    expect(h.blockedStore.read()?.requestId).toBe('req-1')

    h.clock.advance(FOUR_HOURS + MINUTE)
    await h.tickSettled()

    expect(h.pending.get('req-1')?.undeliverable).toBeNull()
    expect(h.pending.get('req-1')?.cards.length).toBe(1)
    // The surface must go quiet — the operator can see the card in Telegram now.
    expect(h.blockedStore.read()).toBeNull()
  })

  it('further ticks after a successful re-delivery never post a second card', async () => {
    const h = harness()
    h.banFor(FOUR_HOURS)
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')

    h.clock.advance(FOUR_HOURS + MINUTE)
    await h.tickSettled()
    expect(h.sends.length).toBe(1)

    // The `cards.length === 0` precondition is the double-delivery guard.
    for (let i = 0; i < 5; i++) {
      h.clock.advance(MINUTE)
      await h.tickSettled()
    }
    expect(h.sends.length).toBe(1)
  })

  it('a ban EXTENSION re-holds with the longer window rather than bursting', async () => {
    const h = harness()
    h.banFor(FOUR_HOURS)
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')

    // The window "closes"… but Telegram re-bans on the retry (computeFloodWait
    // only ever GROWS untilTs, so this is self-correcting).
    h.clock.advance(FOUR_HOURS + MINUTE)
    h.banFor(FOUR_HOURS)
    await h.tickSettled()

    expect(h.sends.length).toBe(0)
    expect(h.pending.get('req-1')?.undeliverable?.reason).toBe('flood_wait')

    // The longer window eventually closes and the card lands — once.
    h.clock.advance(FOUR_HOURS + MINUTE)
    await h.tickSettled()
    expect(h.sends.length).toBe(1)
  })

  it('the operator tap resolves the ORIGINAL requestId and the agent continues', async () => {
    const h = harness()
    h.banFor(FOUR_HOURS)
    await h.raise('req-original', 'Bash', '{"command":"npm test"}')

    h.clock.advance(FOUR_HOURS + MINUTE)
    await h.tickSettled()

    h.tap('req-original', 'allow')

    expect(h.verdicts).toEqual([{ requestId: 'req-original', behavior: 'allow' }])
    expect(h.pending.has('req-original')).toBe(false)
    expect(h.blockedStore.read()).toBeNull()
  })
})

describe('the per-tick cap — a backlog must not burst the moment the ban lifts', () => {
  it('sends at most the cap per tick, and drains the rest on later ticks', async () => {
    const h = harness()
    h.banFor(FOUR_HOURS)
    for (let i = 1; i <= 7; i++) {
      await h.raise(`req-${i}`, 'Bash', `{"command":"cmd-${i}"}`)
    }
    expect(h.sends.length).toBe(0)

    h.clock.advance(FOUR_HOURS + MINUTE)

    await h.tickSettled()
    expect(h.sends.length).toBe(HELD_CARD_REDELIVERY_CAP) // 3

    await h.tickSettled()
    expect(h.sends.length).toBe(2 * HELD_CARD_REDELIVERY_CAP) // 6

    await h.tickSettled()
    expect(h.sends.length).toBe(7) // drained — nothing lost

    // And it settles: no eighth send, no duplicates.
    await h.tickSettled()
    expect(h.sends.length).toBe(7)
    expect(new Set(h.sends.map(s => s.requestId)).size).toBe(7)
    expect(h.sentIntoOpenWindow).toBe(false)
  })
})

describe('selectHeldForRedelivery — the guards, directly', () => {
  const held = (cards = 0) => ({
    undeliverable: { since: 1, retryableAt: 2, reason: 'flood_wait' as const },
    cards: new Array(cards).fill({}),
  })

  it('(i) sends NOTHING while the window is still open', () => {
    const sel = selectHeldForRedelivery([['a', held()]], {
      floodRemainingMs: 1,
      inFlight: new Set(),
    })
    expect(sel).toEqual({ send: [], deferred: [] })
  })

  it('(ii) skips entries that already have a landed card (double-delivery guard)', () => {
    const sel = selectHeldForRedelivery([['a', held(1)]], {
      floodRemainingMs: 0,
      inFlight: new Set(),
    })
    expect(sel.send).toEqual([])
  })

  it('(ii) skips entries that are not held at all', () => {
    const sel = selectHeldForRedelivery([['a', { cards: [] }]], {
      floodRemainingMs: 0,
      inFlight: new Set(),
    })
    expect(sel.send).toEqual([])
  })

  it('(iii) skips entries already in flight from a previous tick', () => {
    const sel = selectHeldForRedelivery([['a', held()]], {
      floodRemainingMs: 0,
      inFlight: new Set(['a']),
    })
    expect(sel.send).toEqual([])
  })

  it('(iv) caps the tick and DEFERS the overflow — never silently truncates', () => {
    const entries: Array<[string, ReturnType<typeof held>]> = ['a', 'b', 'c', 'd', 'e'].map(
      id => [id, held()],
    )
    const sel = selectHeldForRedelivery(entries, {
      floodRemainingMs: 0,
      inFlight: new Set(),
      cap: 2,
    })
    expect(sel.send).toEqual(['a', 'b'])
    // The overflow is reported, so the caller can log it. Nothing vanishes.
    expect(sel.deferred).toEqual(['c', 'd', 'e'])
    expect(sel.send.length + sel.deferred.length).toBe(entries.length)
  })
})

/** Source-text pins — gateway.ts is not importable, so pin the wiring. */
describe('gateway wiring — the reaper re-drives held cards', () => {
  const GATEWAY_SRC = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('the send is extracted into postPermissionCard, with two callers', () => {
    expect(GATEWAY_SRC).toContain('function postPermissionCard(')
    // caller 1: the initial delivery in onPermissionRequest
    expect(GATEWAY_SRC).toContain('postPermissionCard(requestId, pendEntry)')
    // caller 2: the reaper's held-card sweep
    expect(GATEWAY_SRC).toContain('postPermissionCard(requestId, pend)')
  })

  it('the reaper runs the held-card sweep', () => {
    expect(GATEWAY_SRC).toContain('function sweepHeldPermissionCards()')
    expect(GATEWAY_SRC).toContain('sweepHeldPermissionCards()')
  })

  it('the sweep gates on the SAME flood probe robustApiCall uses', () => {
    // One source of truth for "is the channel open" — the sweep's check and the
    // retry policy's pre-call short-circuit are two reads of one on-disk window.
    expect(GATEWAY_SRC).toContain('const probeFloodWaitRemainingMs = makeFloodWaitProbe(FLOOD_STATE_PATH)')
    expect(GATEWAY_SRC).toContain('floodWaitRemainingMs: probeFloodWaitRemainingMs')
    expect(GATEWAY_SRC).toContain('const remaining = probeFloodWaitRemainingMs()')
  })

  it('the sweep carries the in-flight guard', () => {
    expect(GATEWAY_SRC).toContain('const heldCardsInFlight = new Set<string>()')
    expect(GATEWAY_SRC).toContain('inFlight: heldCardsInFlight')
    expect(GATEWAY_SRC).toContain('heldCardsInFlight.delete(requestId)')
  })

  it('deferred cards are logged, never silently dropped', () => {
    expect(GATEWAY_SRC).toContain('deferred, NOT dropped')
  })

  // The production code MUST have the same shape the harness models, or the
  // outcome tests above are testing a fiction. These pin the three fan-out fixes.
  it('F1 — the in-flight flag clears ONCE, after Promise.allSettled over every target', () => {
    const at = GATEWAY_SRC.indexOf('function postPermissionCard(')
    const fn = GATEWAY_SRC.slice(at, GATEWAY_SRC.indexOf('\n/**', at))
    expect(fn).toContain('Promise.allSettled(sends)')
    // Exactly one release, and it is the allSettled one — not a per-target
    // .finally inside the fan-out loop.
    expect(fn.match(/heldCardsInFlight\.delete\(requestId\)/g)?.length).toBe(1)
    expect(fn.indexOf('Promise.allSettled(sends)'))
      .toBeLessThan(fn.indexOf('heldCardsInFlight.delete(requestId)'))
  })

  it('F2 — the failure handler never re-marks an entry whose card already landed', () => {
    const at = GATEWAY_SRC.indexOf('function postPermissionCard(')
    const fn = GATEWAY_SRC.slice(at, GATEWAY_SRC.indexOf('\n/**', at))
    expect(fn).toContain('if (live.cards.length > 0) return')
  })

  it('F3/F6 — holdReasonFor decides, and re-delivery is bounded but the hold is not', () => {
    const at = GATEWAY_SRC.indexOf('function postPermissionCard(')
    const fn = GATEWAY_SRC.slice(at, GATEWAY_SRC.indexOf('\n/**', at))
    expect(fn).toContain('const reason = holdReasonFor(e)')
    expect(fn).toContain('live.redeliveryFailures = failures')
    // The cap stops RE-SENDING, never the HOLD. No verdict is ever dispatched here.
    expect(fn).not.toContain("behavior: 'deny'")
    expect(fn).not.toContain("behavior: 'allow'")
  })
})

/**
 * The multi-target bugs. `resolvePermissionCardTargets()` ends in
 * `allowFrom.map(...)` — it returns N targets, and on the RE-delivery path N>1 is
 * the COMMON case (re-delivery after a multi-hour ban is by construction past the
 * 30-min origin-recovery window, so it falls through to the operator-DM fan-out).
 *
 * A harness pinned at one target cannot see any of these. They were found in
 * review, not by the tests — so they get tests.
 */
describe('N targets — the fan-out cases a single-target harness cannot see', () => {
  const TWO = ['-100200', '-100999']

  // F1. The reaper is fire-and-forget (`void postPermissionCard(...)`), so a send
  // can still be in flight when the NEXT 60s tick fires. If the in-flight flag is
  // cleared per-target, the first target to settle releases it while the second is
  // still sending — and the next tick re-posts to BOTH.
  it('the in-flight flag is NOT released until EVERY target settles', async () => {
    // F1, stated as the invariant it protects. `resolvePermissionCardTargets()`
    // returns N targets. If the flag is cleared per-target, the FIRST target to
    // settle releases it while others are still sending — and the next 60s tick
    // (the reaper is fire-and-forget, so ticks DO overlap in-flight sends)
    // re-selects the request and posts the card all over again.
    const h = createHarness({ targets: TWO })
    dirs.push(h.stateDir)
    h.banFor(FOUR_HOURS)
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')
    await h.settle()
    expect(h.sends.length).toBe(0)

    // Window closes. Target A fails FAST (a transient give-up — note this does
    // not re-open the flood window, so the sweep stays armed); target B HANGS.
    h.clock.advance(FOUR_HOURS + MINUTE)
    h.breakTarget('-100200', 'econnreset')
    h.hangTarget('-100999')

    await h.tick()     // fire-and-forget: A settles, B is still in flight
    await h.flush()    // let A's failure chain run to completion

    // A has settled and B has NOT. The request must STILL be flagged in-flight —
    // this is the whole guard. A per-target clear releases it here.
    expect(h.isInFlight('req-1')).toBe(true)

    // …so an overlapping tick cannot re-select it.
    await h.tick()
    await h.flush()
    await h.tick()
    await h.flush()

    h.releaseTarget('-100999')
    await h.settle()

    // B received exactly one card, and the flag is finally released.
    expect(h.sends.filter(x => x.chatId === '-100999').length).toBe(1)
    expect(h.isInFlight('req-1')).toBe(false)
  })

  // F2. Target A succeeds, target B flood-fails in the SAME fan-out. If the catch
  // re-marks the entry without checking cards.length, we get
  // `cards.length > 0 && undeliverable != null` — which selectHeldForRedelivery
  // skips forever (it has cards), so the mark can never be cleared. Stacked with
  // PR 3's TTL freeze that is a PERMANENT wedge: the agent never unblocks and the
  // dashboard shows "blocked" forever.
  it('a card landing on ONE target while another floods does NOT wedge the entry', async () => {
    const h = createHarness({ targets: TWO })
    dirs.push(h.stateDir)
    h.banTarget('-100999', FOUR_HOURS)   // only this chat is banned
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')
    await h.settle()

    // The card LANDED on the good target — the operator can see and tap it.
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]!.chatId).toBe('-100200')

    // So the ask is NOT undeliverable, and there must be NO blocked record.
    expect(h.pending.get('req-1')?.undeliverable ?? null).toBeNull()
    expect(h.blockedStore.read()).toBeNull()

    // …and it is not re-delivered forever, nor wedged: a tap resolves it.
    for (let i = 0; i < 3; i++) { h.clock.advance(MINUTE); await h.tickSettled() }
    expect(h.sends.length).toBe(1)
    h.tap('req-1', 'allow')
    expect(h.verdicts).toEqual([{ requestId: 'req-1', behavior: 'allow' }])
  })

  it('a PERMANENT failure (400) on every target is NOT held — it falls through', async () => {
    const h = createHarness({ targets: ['-100999'] })
    dirs.push(h.stateDir)
    h.breakTarget('-100999', 'tg_400')
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')
    await h.settle()

    // A 400 will never format, whatever we do. Holding would park the agent
    // forever on a card that can never render.
    expect(h.sends.length).toBe(0)
    expect(h.pending.get('req-1')?.undeliverable ?? null).toBeNull()
    expect(h.blockedStore.read()).toBeNull()
  })

  // F3. A held entry is re-selected every tick. A target that keeps failing would
  // otherwise be re-sent every 60s forever — the amplifier this series exists to
  // avoid. But it must NEVER be abandoned either: a terminal give-up strands the
  // card even after the channel recovers, and turnInFlightForGate() would buffer
  // the operator's normal messages forever with no signal. So: bounded RATE,
  // unbounded RETRY.
  it('re-delivery BACKS OFF but is never abandoned — and the approval stays HELD', async () => {
    const h = createHarness({ targets: ['-100999'] })
    dirs.push(h.stateDir)
    h.breakTarget('-100999', 'econnreset')   // a network partition
    await h.raise('req-1', 'Bash', '{"command":"npm test"}')
    await h.settle()

    expect(h.pending.get('req-1')?.undeliverable?.reason).toBe('transient')

    // Hammer it for two hours of ticks. The backoff must throttle the re-sends…
    for (let i = 0; i < 120; i++) { h.clock.advance(MINUTE); await h.tickSettled() }
    const attempts = h.pending.get('req-1')!.redeliveryFailures!
    expect(attempts).toBeLessThan(20)   // NOT ~120 — the backoff is working

    // …and no verdict was ever fabricated.
    expect(h.verdicts).toEqual([])
    expect(h.blockedStore.read()?.requestId).toBe('req-1')

    // THE CHANNEL RECOVERS. The card must come back — never abandoned.
    h.healTarget('-100999')
    for (let i = 0; i < 40; i++) { h.clock.advance(MINUTE); await h.tickSettled() }
    expect(h.sends.length).toBe(1)
    expect(h.pending.get('req-1')?.undeliverable ?? null).toBeNull()
    expect(h.blockedStore.read()).toBeNull()
  })
})

/**
 * THE CLASSIFIER, driven end-to-end through the REAL retry policy.
 *
 * The first version of holdReasonFor() was an allowlist of marker strings on the
 * premise that a network partition or a Telegram 5xx would surface as a give-up.
 * The premise was FALSE — retryApiCall re-throws a 5xx GrammyError raw (its
 * network-retry branch is guarded by `!isGrammyErr`), and re-throws a raw network
 * error on the last attempt. So the allowlist FAILED OPEN: a single routine 502 at
 * send time reproduced 2026-07-11 in full — no card, no mark, TTL fires, agent told
 * the operator declined.
 *
 * These drive the real errors through the real policy. This is the test that would
 * have caught it, and the reason the harness must throw real faults rather than
 * the conclusion it expects.
 */
describe('holdReasonFor — every real failure class, through the real retry policy', () => {
  const TRANSIENT: FaultKind[] = ['tg_502', 'tg_500', 'econnreset', 'fetch_failed']
  const PERMANENT: FaultKind[] = ['tg_400', 'tg_403']

  for (const kind of TRANSIENT) {
    it(`${kind} is HELD — the operator never got to answer`, async () => {
      const h = createHarness({ targets: ['-100999'] })
      dirs.push(h.stateDir)
      h.breakTarget('-100999', kind)
      await h.raise('req-1', 'Bash', '{"command":"npm test"}')
      await h.settle()

      expect(h.sends.length).toBe(0)
      expect(h.pending.get('req-1')?.undeliverable?.reason).toBe('transient')
      expect(h.blockedStore.read()?.requestId).toBe('req-1')

      // …and past the 60-minute TTL, still no fabricated verdict.
      for (let i = 0; i <= 61; i++) { await h.tickSettled(); h.clock.advance(MINUTE) }
      expect(h.verdicts).toEqual([])
      expect(h.pending.has('req-1')).toBe(true)
    })
  }

  for (const kind of PERMANENT) {
    it(`${kind} is NOT held — it will never render, so it falls through`, async () => {
      const h = createHarness({ targets: ['-100999'] })
      dirs.push(h.stateDir)
      h.breakTarget('-100999', kind)
      await h.raise('req-1', 'Bash', '{"command":"npm test"}')
      await h.settle()

      expect(h.sends.length).toBe(0)
      expect(h.pending.get('req-1')?.undeliverable ?? null).toBeNull()
      expect(h.blockedStore.read()).toBeNull()
    })
  }

  it('an UNKNOWN error class fails CLOSED — held, not auto-denied', () => {
    // The whole polarity of the fix. Anything we do not positively recognise as
    // permanent is held. A held approval is visible and recoverable; a fabricated
    // denial is neither.
    expect(holdReasonFor(new Error('something nobody has seen before'))).toBe('transient')
    expect(holdReasonFor({ weird: true })).toBe('transient')
    expect(holdReasonFor(undefined)).toBe('transient')
    // …and a rate-limit is the most transient failure there is — never permanent.
    expect(holdReasonFor(Object.assign(new Error('x'), { error_code: 429 }))).toBe('transient')
    // Only these two fall through.
    expect(holdReasonFor(Object.assign(new Error('x'), { error_code: 400 }))).toBeNull()
    expect(holdReasonFor(Object.assign(new Error('x'), { error_code: 403 }))).toBeNull()
  })
})
