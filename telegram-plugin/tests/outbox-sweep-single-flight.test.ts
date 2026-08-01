/**
 * Regression: switchroom #3864 — the outbox sweep tick had no overlap guard.
 *
 * `startOutboxSweep` fires a tick every `OUTBOX_SWEEP_INTERVAL_MS` and `void`s
 * the sweep it starts. A sweep slower than the interval (a flood-throttled
 * Telegram, a big backlog, slow disk) therefore had the NEXT tick start a
 * SECOND concurrent sweep body over the same outbox directory — and the one
 * after that a third. The per-record rename mutex in `../outbox.ts` stopped a
 * single record being double-SENT, but nothing stopped the bodies from
 * multiplying: they race the same journal / dedup / backoff state and multiply
 * wire pressure at exactly the moment the sweep should be issuing less.
 *
 * `createOutboxSweepTick` now single-flights: while a sweep is in flight, a
 * tick is skipped outright.
 *
 * Outcome asserted: the number of sweep BODIES actually started. Without the
 * guard the second tick starts a second body and `runs` is 2 — this test fails.
 */

import { describe, it, expect } from 'vitest'
import { createOutboxSweepTick, createSweepBackoff } from '../gateway/outbox-sweep.js'
import type { OutboxSweepSummary } from '../gateway/outbox-sweep.js'

const OK: OutboxSweepSummary = { scanned: 0, delivered: 0, skipped: 0, sendFailures: 0 }

/** A sweep whose completion the test controls. */
function controllableSweep() {
  let runs = 0
  const pending: Array<(s: OutboxSweepSummary) => void> = []
  const runSweep = () => {
    runs++
    return new Promise<OutboxSweepSummary>((resolve) => pending.push(resolve))
  }
  return {
    runSweep,
    runs: () => runs,
    /** Complete the oldest in-flight sweep and let its .then/.finally settle. */
    finish: async (summary: OutboxSweepSummary = OK) => {
      pending.shift()?.(summary)
      // Drain the .then → .catch → .finally microtask chain.
      for (let i = 0; i < 8; i++) await Promise.resolve()
    },
  }
}

describe('outbox sweep tick — single flight (#3864)', () => {
  it('a tick that fires while a sweep is still running starts NO second sweep', async () => {
    const sweep = controllableSweep()
    const logs: string[] = []
    const tick = createOutboxSweepTick({
      getBot: () => ({}),
      backoff: createSweepBackoff(),
      runSweep: sweep.runSweep,
      log: (l) => logs.push(l),
    })

    tick()
    expect(sweep.runs()).toBe(1)
    expect(tick.inFlight()).toBe(true)

    // Two more interval ticks land while the first sweep is still running.
    tick()
    tick()
    expect(sweep.runs()).toBe(1)

    // Once it completes, the next tick sweeps again — the guard defers, it
    // does not disable the sweep.
    await sweep.finish()
    expect(tick.inFlight()).toBe(false)
    tick()
    expect(sweep.runs()).toBe(2)

    // And it says so in the log, once per overlap streak plus a summary.
    expect(logs.some((l) => l.includes('still in flight'))).toBe(true)
    expect(logs.some((l) => l.includes('2 tick(s) were skipped'))).toBe(true)
  })

  it('releases the guard when the sweep REJECTS (a throwing sweep must not wedge it)', async () => {
    let runs = 0
    let reject: ((e: Error) => void) | null = null
    const tick = createOutboxSweepTick({
      getBot: () => ({}),
      backoff: createSweepBackoff(),
      runSweep: () => {
        runs++
        return new Promise<OutboxSweepSummary>((_res, rej) => {
          reject = rej
        })
      },
      log: () => {},
    })

    tick()
    expect(runs).toBe(1)
    reject!(new Error('disk on fire'))
    for (let i = 0; i < 8; i++) await Promise.resolve()

    expect(tick.inFlight()).toBe(false)
    tick()
    expect(runs).toBe(2)
  })

  it('does not sweep at all before the bot exists', () => {
    const sweep = controllableSweep()
    const tick = createOutboxSweepTick({
      getBot: () => undefined,
      backoff: createSweepBackoff(),
      runSweep: sweep.runSweep,
    })
    tick()
    expect(sweep.runs()).toBe(0)
  })

  it('honours the failure backoff independently of the in-flight guard', async () => {
    const sweep = controllableSweep()
    let now = 1_000_000
    const tick = createOutboxSweepTick({
      getBot: () => ({}),
      backoff: createSweepBackoff(),
      runSweep: sweep.runSweep,
      now: () => now,
      log: () => {},
    })

    tick()
    await sweep.finish({ ...OK, sendFailures: 1 })
    expect(sweep.runs()).toBe(1)
    expect(tick.inFlight()).toBe(false)

    // Guard released, but the backoff window is open → still no sweep.
    tick()
    expect(sweep.runs()).toBe(1)

    now += 10 * 60 * 1000
    tick()
    expect(sweep.runs()).toBe(2)
  })
})
