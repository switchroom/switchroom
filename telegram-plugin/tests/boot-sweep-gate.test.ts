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
import { createBootSweepGate } from '../gateway/boot-sweep-gate.js'

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
