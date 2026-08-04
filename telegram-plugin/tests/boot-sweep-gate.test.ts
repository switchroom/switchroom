/**
 * boot-sweep-gate — the deterministic ordering fence for #3664 Defect A.
 *
 * The regression these assertions exist to catch: the boot orphan sweep was
 * dispatched the moment the gateway won the startup mutex, which happens at
 * module-eval time — thousands of lines before `initGatewayBot()` assigns
 * `lockedBot`. Every boot-cleanup unpin therefore threw
 * `undefined is not an object (evaluating 'lockedBot.api')` before reaching
 * Telegram (14/14 fleet-wide failures since #3310, zero clean successes).
 *
 * The behavioural assertion is "arming ALONE must not dispatch the sweep" —
 * a test that would have failed on the original bug shape.
 */
import { describe, it, expect } from 'vitest'
import {
  createBootSweepGate,
  runBootPinSweepSteps,
  type BootPinSweepSteps,
} from '../gateway/boot-sweep-gate.js'

/** A fake sweep that records whether it ran and what the bot handle looked
 *  like at that moment — the thing the original bug got wrong. */
function fakeSweep() {
  const observed: (string | undefined)[] = []
  let bot: string | undefined
  return {
    run: async () => {
      observed.push(bot)
    },
    setBot: (b: string) => {
      bot = b
    },
    get observed() {
      return observed
    },
  }
}

describe('createBootSweepGate (#3664 Defect A)', () => {
  it('does NOT dispatch on arm() alone — the bot handle does not exist yet', async () => {
    const sweep = fakeSweep()
    const gate = createBootSweepGate({ run: sweep.run })

    gate.arm()
    await Promise.resolve()

    expect(gate.hasRun()).toBe(false)
    expect(sweep.observed).toEqual([])
  })

  it('does NOT dispatch on botReady() alone — this boot may not own the pin state', async () => {
    const sweep = fakeSweep()
    const gate = createBootSweepGate({ run: sweep.run })

    gate.botReady()
    await Promise.resolve()

    expect(gate.hasRun()).toBe(false)
    expect(sweep.observed).toEqual([])
  })

  it('dispatches once BOTH signals arrive, and the bot handle is live when it does', async () => {
    const sweep = fakeSweep()
    const gate = createBootSweepGate({ run: sweep.run })

    gate.arm() // startup mutex won (module-eval time)
    await Promise.resolve()
    expect(sweep.observed).toEqual([])

    sweep.setBot('lockedBot') // initGatewayBot() assigns lockedBot …
    gate.botReady() // … and signals the gate
    await Promise.resolve()

    // The sweep ran, and it saw a live bot handle — never `undefined`.
    expect(sweep.observed).toEqual(['lockedBot'])
    expect(gate.hasRun()).toBe(true)
  })

  it('is order-independent: botReady() before arm() still dispatches exactly once', async () => {
    const sweep = fakeSweep()
    const gate = createBootSweepGate({ run: sweep.run })

    sweep.setBot('lockedBot')
    gate.botReady()
    await Promise.resolve()
    expect(sweep.observed).toEqual([])

    gate.arm()
    await Promise.resolve()
    expect(sweep.observed).toEqual(['lockedBot'])
  })

  it('dispatches at most once however many times the signals repeat', async () => {
    const sweep = fakeSweep()
    const gate = createBootSweepGate({ run: sweep.run })

    sweep.setBot('lockedBot')
    gate.arm()
    gate.botReady()
    gate.arm() // e.g. the mutex path AND the mutex-fallback path
    gate.botReady()
    await Promise.resolve()

    expect(sweep.observed).toEqual(['lockedBot'])
  })

  it('routes a rejecting sweep to onError instead of leaking an unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      const errs: unknown[] = []
      const gate = createBootSweepGate({
        run: async () => {
          throw new Error('boom')
        },
        onError: (err) => errs.push(err),
      })

      gate.arm()
      gate.botReady()
      await new Promise((r) => setTimeout(r, 10))

      expect((errs[0] as Error).message).toBe('boom')
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

/**
 * Per-step isolation (#3664 salvage S2).
 *
 * The steps used to be a bare sequential `await` chain in gateway.ts. A throw
 * from either card reaper skipped `stalePinSweepEligible = true`, which
 * authorises the stale-pin drain for the WHOLE SESSION — so one throwing reaper
 * silently disabled stale-pin cleanup, including every later lazy first-inbound
 * sweep. That became newly reachable the moment #3664 made the sweep actually
 * run for the first time.
 *
 * The outcome asserted is "was the drain enabled and were the recorded
 * (chat, thread) targets swept", not "was a wrapper called".
 */
describe('runBootPinSweepSteps (#3664 salvage S2)', () => {
  function deps(over: Partial<BootPinSweepSteps> = {}) {
    const order: string[] = []
    const logs: string[] = []
    const base: BootPinSweepSteps = {
      scanSweepTargets: () => {
        order.push('scan')
        return [{ chatId: '900000001' }]
      },
      statusPinCleanup: async () => {
        order.push('status-pins')
      },
      activityCardReaper: async () => {
        order.push('activity-cards')
      },
      queuedCardReaper: async () => {
        order.push('queued-cards')
      },
      enableSweep: () => order.push('enable-sweep'),
      seedPruneSweepCursors: () => order.push('seed-prune'),
      sweepTarget: async (t) => {
        order.push(`sweep:${t.chatId}:${t.threadId ?? '-'}`)
      },
      log: (l) => logs.push(l),
    }
    return { order, logs, deps: { ...base, ...over } }
  }

  it('runs the store scan first, then the reapers, then enables + runs the DM sweep', async () => {
    const d = deps()
    await runBootPinSweepSteps(d.deps)
    expect(d.order).toEqual([
      'scan',
      'status-pins',
      'activity-cards',
      'queued-cards',
      'seed-prune',
      'enable-sweep',
      'sweep:900000001:-',
    ])
  })

  it('a throwing reaper does not strand the steps behind it', async () => {
    const d = deps({
      activityCardReaper: async () => {
        throw new Error('boom')
      },
    })
    await runBootPinSweepSteps(d.deps)
    // The DM path is still enabled and the recorded DM chat is still swept.
    expect(d.order).toEqual([
      'scan',
      'status-pins',
      'queued-cards',
      'seed-prune',
      'enable-sweep',
      'sweep:900000001:-',
    ])
    expect(d.logs.join('')).toContain("step 'activity-card-reaper' failed: boom")
  })

  it('enables the DM sweep even when EVERY earlier step throws', async () => {
    const boom = async () => {
      throw new Error('boom')
    }
    const d = deps({
      statusPinCleanup: boom,
      activityCardReaper: boom,
      queuedCardReaper: boom,
    })
    await runBootPinSweepSteps(d.deps)
    expect(d.order).toEqual(['scan', 'seed-prune', 'enable-sweep', 'sweep:900000001:-'])
  })

  it('a failing store scan still lets the reapers and the DM enable run', async () => {
    const d = deps({
      scanSweepTargets: () => {
        throw new Error('ENOENT')
      },
    })
    await runBootPinSweepSteps(d.deps)
    // No targets to sweep, but nothing behind the scan is stranded.
    expect(d.order).toEqual([
      'status-pins',
      'activity-cards',
      'queued-cards',
      'seed-prune',
      'enable-sweep',
    ])
    expect(d.logs.join('')).toContain("step 'sweep-target-scan' failed: ENOENT")
  })

  it('one failing target does not block the next one, and topics stay distinct', async () => {
    const swept: string[] = []
    const d = deps({
      scanSweepTargets: () => [
        { chatId: '-1009000000001', threadId: 5 },
        { chatId: '-1009000000001', threadId: 9 },
      ],
      sweepTarget: async (t) => {
        if (t.threadId === 5) throw new Error('kicked')
        swept.push(`${t.chatId}:${t.threadId}`)
      },
    })
    await runBootPinSweepSteps(d.deps)
    expect(swept).toEqual(['-1009000000001:9'])
    // Each target gets its own named step, keyed by (chat, thread).
    expect(d.logs.join('')).toContain("step 'stale-pin-sweep:-1009000000001:5' failed: kicked")
  })

  it('logs a non-Error throw honestly instead of "undefined"', async () => {
    const d = deps({
      queuedCardReaper: async () => {
        // A non-Error throw: `(err as Error).message` would log "undefined".
        throw 'not an Error'
      },
    })
    await runBootPinSweepSteps(d.deps)
    expect(d.logs.join('')).toContain("step 'queued-card-reaper' failed: not an Error")
    expect(d.logs.join('')).not.toContain('failed: undefined')
  })

  it('survives a log sink that itself throws', async () => {
    // stderr can be gone on a dying process; the one function whose job is
    // "a step must not take the sweep down" must not take the sweep down.
    const order: string[] = []
    await expect(
      runBootPinSweepSteps({
        scanSweepTargets: () => [],
        statusPinCleanup: async () => {
          throw new Error('boom')
        },
        activityCardReaper: async () => {
          order.push('activity-cards')
        },
        queuedCardReaper: async () => {
          order.push('queued-cards')
        },
        enableSweep: () => order.push('enable-sweep'),
        seedPruneSweepCursors: () => {},
        sweepTarget: async () => {},
        log: () => {
          throw new Error('EPIPE')
        },
      }),
    ).resolves.toBeUndefined()
    expect(order).toEqual(['activity-cards', 'queued-cards', 'enable-sweep'])
  })

  it('never rejects — the caller fire-and-forgets it', async () => {
    const boom = async () => {
      throw new Error('boom')
    }
    await expect(
      runBootPinSweepSteps({
        scanSweepTargets: () => {
          throw new Error('boom')
        },
        statusPinCleanup: boom,
        activityCardReaper: boom,
        queuedCardReaper: boom,
        enableSweep: () => {
          throw new Error('boom')
        },
        seedPruneSweepCursors: () => {
          throw new Error('boom')
        },
        sweepTarget: boom,
        log: () => {},
      }),
    ).resolves.toBeUndefined()
  })
})
