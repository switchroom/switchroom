/**
 * Outcome-based regression test for the deterministic silent-turn card climb.
 *
 * Phase 4(b) of `reference/rfcs/deterministic-turn-liveness.md`; serves
 * `reference/jobs/know-what-my-agent-is-doing.md` (a busy-but-silent turn must
 * visibly escalate, never freeze).
 *
 * ## What is REAL here, and what is a spy (no overclaim)
 *
 * The gateway is a start-on-import IIFE that cannot be instantiated in-process
 * (the documented constraint behind every `*-wiring` structural test in this
 * suite). So the shipped 0-label tick body was EXTRACTED into
 * `feed-heartbeat-climb.ts` (`runSilentTurnHeartbeatTick`) and the gateway's
 * `feedHeartbeatTick` calls it with its real deps — meaning the function under
 * test IS the production decision logic, byte-for-byte, not a hand-copied
 * mirror. What this test drives:
 *
 *   - REAL: `runSilentTurnHeartbeatTick` + `silentTurnClimbRender` — the shipped
 *     guard placement (0-label check, open-vs-climb split, stale-guard, null
 *     render), the gate SEQUENCE (cardDrainGate → mayDrain → openOrEditCard →
 *     drain), and the rendered card bodies.
 *   - SPY: the injected deps. The `drain` seam is where the gateway's
 *     `drainActivitySummary` → `robustApiCall(bot.api.sendMessage /
 *     bot.api.editMessageText)` lives in production; the spy implements the
 *     drain's transport contract (send when no card id, edit once set) and
 *     records every call with a timestamp. The real `drainActivitySummary` /
 *     grammY transport is NOT executed here — the gateway wiring of the real
 *     deps (and the real drain call) is pinned structurally by
 *     `tests/feed-heartbeat-liveness-open.test.ts`, and end-to-end by the UAT
 *     liveness scenarios.
 *
 * ## What it asserts
 *
 *   1. A ~40s silent tool call produces >=4 card EDITS with a CLIMBING elapsed —
 *      the card never freezes. (Acceptance criterion of the RFC.)
 *   2. Every climb mutation is an EDIT of the already-open card — never a new
 *      send — so no mid-turn mutation can push-notify the device.
 *   3. Each climb edit passes through the full gate sequence in order:
 *      setPendingRender → cardDrainGate → mayDrain → openOrEditCard → drain
 *      (mis-wiring the guards inside the tick body fails this).
 *   4. `mayDrain === false` (drain in flight) suppresses the edit — the
 *      single-flight guard is honoured.
 *   5. The climb yields to model narration: a surfaced tool label
 *      (`mirrorLineCount > 0`) returns `false` (labelled branch owns the tick)
 *      and emits nothing.
 *   6. The stale-guard: a turn younger than `minStaleMs` produces no edit (same
 *      symmetry the labelled branch has).
 *
 * ## Why this FAILS on pre-fix code (its acceptance criterion)
 *
 * Pre-fix, the 0-label branch delegated solely to `openLivenessFeedIfDue`,
 * whose WHEN-gate returns false the moment a card is open — an open 0-label
 * card received ZERO edits during a silent tool. Reverting
 * `runSilentTurnHeartbeatTick` to that behaviour (the open-path delegate with
 * no climb) drives this test's edit count to 0, failing assertion 1 — through
 * the same shipped function the gateway calls. Removing the gateway call site
 * instead is caught by the structural pin in
 * `tests/feed-heartbeat-liveness-open.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import {
  runSilentTurnHeartbeatTick,
  silentTurnClimbRender,
  type SilentTurnTickDeps,
} from '../feed-heartbeat-climb.js'

// The gateway constants that drive the tick cadence (gateway.ts).
const FEED_HEARTBEAT_TICK_MS = 6_000
const FEED_HEARTBEAT_MIN_STALE_MS = 6_000
const FEED_LIVENESS_OPEN_MS = 1_200

/** A recorded transport call with the simulated wall-clock time it happened at. */
interface TransportCall {
  kind: 'sendMessage' | 'editMessageText'
  at: number
  text: string
}

/** Parse the climbing elapsed (in seconds) out of a rendered card header line
 *  (`_6s · 0 tools_`, `_1m05s · 0 tools_`). Returns null if not present. */
function parseHeaderElapsedSeconds(text: string): number | null {
  const m = text.match(/_((?:(\d+)m)?(\d+)s) · \d+ tools?_/)
  if (m == null) return null
  const minutes = m[2] ? Number(m[2]) : 0
  const seconds = Number(m[3])
  return minutes * 60 + seconds
}

/**
 * Test double for the turn's card surface + injected deps. The `drain` spy
 * implements the drain's transport contract — `sendMessage` (an OPEN, the only
 * mutation that push-notifies) when no card id exists, `editMessageText` (a
 * silent card EDIT) once it does — standing in for `drainActivitySummary` →
 * `robustApiCall(bot.api.*)`. Also records the gate-call ORDER per tick so the
 * shipped sequence is pinned, and simulates the shared OPEN path
 * (`openLivenessFeedIfDue`) opening the placeholder card.
 */
class TurnHarness {
  calls: TransportCall[] = []
  order: string[] = []
  activityMessageId: number | null = null
  pendingRender: string | null = null
  mayDrainResult = true
  private nextId = 100
  now = 0

  /** The real gateway wires these exact seams; each spy records its call. */
  deps(openRender: () => string | null): SilentTurnTickDeps {
    return {
      openLivenessFeedIfDue: () => {
        this.order.push('openLivenessFeedIfDue')
        // Mirror of the shared OPEN path's contract: opens once, past its
        // threshold, via a fresh sendMessage.
        if (this.activityMessageId != null) return
        const rendered = openRender()
        if (rendered == null) return
        this.activityMessageId = this.nextId++
        this.calls.push({ kind: 'sendMessage', at: this.now, text: rendered })
      },
      setPendingRender: (rendered) => {
        this.order.push('setPendingRender')
        this.pendingRender = rendered
      },
      cardDrainGate: (run) => {
        this.order.push('cardDrainGate')
        run()
      },
      mayDrain: () => {
        this.order.push('mayDrain')
        return this.mayDrainResult
      },
      openOrEditCard: (apply) => {
        this.order.push('openOrEditCard')
        apply()
      },
      drain: () => {
        this.order.push('drain')
        // drainActivitySummary's transport contract: OPEN when no card id,
        // EDIT in place once set. Here the card is always open (the tick only
        // reaches drain via the climb), so this is always an edit.
        const text = this.pendingRender ?? ''
        if (this.activityMessageId == null) {
          this.activityMessageId = this.nextId++
          this.calls.push({ kind: 'sendMessage', at: this.now, text })
        } else {
          this.calls.push({ kind: 'editMessageText', at: this.now, text })
        }
      },
    }
  }

  get sends(): TransportCall[] {
    return this.calls.filter((c) => c.kind === 'sendMessage')
  }
  get edits(): TransportCall[] {
    return this.calls.filter((c) => c.kind === 'editMessageText')
  }
}

/** Drive the REAL tick across a silent window, the way the gateway's 6s
 *  setInterval does: same view fields, real deps thunks. */
function runSilentWindow(harness: TurnHarness, turnStart: number, windowMs: number): void {
  const deps = harness.deps(() => 'placeholder')
  for (let now = turnStart; now <= turnStart + windowMs; now += FEED_HEARTBEAT_TICK_MS) {
    harness.now = now
    const handled = runSilentTurnHeartbeatTick(
      {
        mirrorLineCount: 0,
        activityMessageId: harness.activityMessageId,
        labeledToolCount: 0,
        ageMs: now - turnStart,
        minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
      },
      deps,
    )
    expect(handled).toBe(true) // 0-label turn: this branch owns every tick
  }
}

describe('deterministic silent-turn card climb — real tick against a spy transport', () => {
  it('a ~40s silent tool call yields >=4 card edits with climbing elapsed (never freezes)', () => {
    const harness = new TurnHarness()
    const turnStart = 1_000_000 // arbitrary simulated epoch
    // Pre-open the card the way production does (early open ~1.2s in via the
    // shared OPEN path) — the freeze reproduced specifically on an OPEN card.
    harness.now = turnStart + FEED_LIVENESS_OPEN_MS
    harness.deps(() => 'placeholder').openLivenessFeedIfDue()
    expect(harness.activityMessageId).not.toBeNull()

    runSilentWindow(harness, turnStart, 40_000)

    // Exactly one OPEN (the pre-opened card) — the climb never sends.
    expect(harness.sends.length).toBe(1)

    // The acceptance criterion: the card is EDITED at least 4 times across the gap.
    expect(
      harness.edits.length,
      `expected >=4 climbing card edits across a 40s silent tool, got ${harness.edits.length} ` +
        `(pre-fix code freezes the 0-label card and produces 0 edits)`,
    ).toBeGreaterThanOrEqual(4)

    // The elapsed on each successive edit strictly climbs — no frozen counter.
    const elapsedSeries = harness.edits
      .map((c) => parseHeaderElapsedSeconds(c.text))
      .filter((n): n is number => n != null)
    expect(elapsedSeries.length).toBe(harness.edits.length)
    for (let i = 1; i < elapsedSeries.length; i++) {
      expect(
        elapsedSeries[i],
        `card elapsed must climb: edit[${i}]=${elapsedSeries[i]}s not > edit[${i - 1}]=${elapsedSeries[i - 1]}s`,
      ).toBeGreaterThan(elapsedSeries[i - 1])
    }

    // Worst-case visible-update gap stays within ~two tick windows (RFC bound).
    const editTimes = [harness.sends[0].at, ...harness.edits.map((c) => c.at)]
    for (let i = 1; i < editTimes.length; i++) {
      expect(editTimes[i] - editTimes[i - 1]).toBeLessThanOrEqual(2 * FEED_HEARTBEAT_TICK_MS)
    }
  })

  it('every climb mutation is an editMessageText, never a new sendMessage (edits do not push-notify)', () => {
    const harness = new TurnHarness()
    const turnStart = 2_000_000
    harness.now = turnStart + FEED_LIVENESS_OPEN_MS
    harness.deps(() => 'placeholder').openLivenessFeedIfDue()
    runSilentWindow(harness, turnStart, 40_000)

    expect(harness.calls[0].kind).toBe('sendMessage')
    for (const call of harness.calls.slice(1)) {
      expect(call.kind).toBe('editMessageText')
    }
  })

  it('each climb edit passes the full shipped gate sequence in order (pendingRender → cardDrainGate → mayDrain → openOrEditCard → drain)', () => {
    const harness = new TurnHarness()
    harness.activityMessageId = 55 // card already open
    harness.now = 12_000
    runSilentTurnHeartbeatTick(
      {
        mirrorLineCount: 0,
        activityMessageId: harness.activityMessageId,
        labeledToolCount: 0,
        ageMs: 12_000,
        minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
      },
      harness.deps(() => null),
    )
    expect(harness.order).toEqual([
      'setPendingRender',
      'cardDrainGate',
      'mayDrain',
      'openOrEditCard',
      'drain',
    ])
  })

  it('a drain already in flight (mayDrain=false) suppresses the edit — single-flight honoured', () => {
    const harness = new TurnHarness()
    harness.activityMessageId = 55
    harness.mayDrainResult = false
    harness.now = 12_000
    runSilentTurnHeartbeatTick(
      {
        mirrorLineCount: 0,
        activityMessageId: 55,
        labeledToolCount: 0,
        ageMs: 12_000,
        minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
      },
      harness.deps(() => null),
    )
    expect(harness.edits.length).toBe(0)
    // The gate was consulted, then the drain was NOT reached.
    expect(harness.order).toContain('mayDrain')
    expect(harness.order).not.toContain('drain')
  })

  it('the climb yields to model narration (a surfaced tool label hands the tick to the labelled branch)', () => {
    const harness = new TurnHarness()
    harness.activityMessageId = 55
    const handled = runSilentTurnHeartbeatTick(
      {
        mirrorLineCount: 3, // narration / tool labels surfaced
        activityMessageId: 55,
        labeledToolCount: 2,
        ageMs: 30_000,
        minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
      },
      harness.deps(() => null),
    )
    expect(handled).toBe(false) // labelled branch owns the tick
    expect(harness.calls.length).toBe(0)
    expect(harness.order.length).toBe(0)
  })

  it('the stale-guard: a turn younger than minStaleMs produces no climb edit (labelled-branch symmetry)', () => {
    const harness = new TurnHarness()
    harness.activityMessageId = 55
    const handled = runSilentTurnHeartbeatTick(
      {
        mirrorLineCount: 0,
        activityMessageId: 55,
        labeledToolCount: 0,
        ageMs: FEED_HEARTBEAT_MIN_STALE_MS - 1,
        minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
      },
      harness.deps(() => null),
    )
    expect(handled).toBe(true) // still the 0-label branch's tick
    expect(harness.calls.length).toBe(0)
  })

  it('the climb does not OPEN a card — no card yet delegates to the one shared OPEN path', () => {
    const harness = new TurnHarness()
    harness.now = 20_000
    runSilentTurnHeartbeatTick(
      {
        mirrorLineCount: 0,
        activityMessageId: null,
        labeledToolCount: 0,
        ageMs: 20_000,
        minStaleMs: FEED_HEARTBEAT_MIN_STALE_MS,
      },
      harness.deps(() => 'open-render'),
    )
    // Delegated to openLivenessFeedIfDue; nothing else ran.
    expect(harness.order).toEqual(['openLivenessFeedIfDue'])
    expect(harness.sends.length).toBe(1) // the OPEN path opened it
    expect(harness.edits.length).toBe(0)
  })

  it('silentTurnClimbRender refuses when no card is open (opening is reply-is-last gated elsewhere)', () => {
    expect(
      silentTurnClimbRender({ mirrorLineCount: 0, activityMessageId: null, labeledToolCount: 0, ageMs: 30_000 }),
    ).toBeNull()
  })
})
