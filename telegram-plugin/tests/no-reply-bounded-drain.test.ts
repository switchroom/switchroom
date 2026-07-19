import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { shouldArmNoReplyDrain } from '../gateway/serialize-drain-gate.js'

/**
 * Component 2 (multitopic reply-routing) — bounded no-reply escape hatch.
 *
 * THE liveness guarantee. Component 1's serialize gate blocks the
 * cross-topic buffer drain until the ending turn delivers its reply. A turn
 * that legitimately ends with NO reply (handback ack, NO_REPLY /
 * HEARTBEAT_OK marker, silent-end) sets finalAnswerDelivered=false and
 * would otherwise block the drain FOREVER — and the 300s silence-poke is
 * disarmed for those turns. The bounded timer rescues it: it force-drains
 * within SERIALIZE_NOREPLY_DRAIN_MS so the queue can NEVER wedge.
 *
 * This file pins (a) the arming predicate `shouldArmNoReplyDrain` shared by
 * the gateway's `armNoReplyDrainTimer`, (b) the liveness behaviour via a
 * fake-timer simulation of the exact timer pattern, and (c) source-level
 * guards that the gateway wires the timer + force-drain on the no-reply
 * turn-end path.
 */
describe('shouldArmNoReplyDrain (the arming predicate)', () => {
  it('ARMS when a no-reply turn ends with a buffered inbound waiting (the rescue)', () => {
    expect(
      shouldArmNoReplyDrain({ enabled: true, finalAnswerDelivered: false, bufferedDepth: 1 }),
    ).toBe(true)
  })

  it('does NOT arm when the turn delivered its final answer (serialize gate already drained)', () => {
    expect(
      shouldArmNoReplyDrain({ enabled: true, finalAnswerDelivered: true, bufferedDepth: 1 }),
    ).toBe(false)
  })

  it('does NOT arm when nothing is buffered (no rescue needed)', () => {
    expect(
      shouldArmNoReplyDrain({ enabled: true, finalAnswerDelivered: false, bufferedDepth: 0 }),
    ).toBe(false)
  })

  it('does NOT arm when the serialize feature is off (legacy drains on bare turn-end)', () => {
    expect(
      shouldArmNoReplyDrain({ enabled: false, finalAnswerDelivered: false, bufferedDepth: 3 }),
    ).toBe(false)
  })

  it('is total over the input space', () => {
    for (const enabled of [true, false]) {
      for (const finalAnswerDelivered of [true, false]) {
        for (const bufferedDepth of [0, 1, 5]) {
          const got = shouldArmNoReplyDrain({ enabled, finalAnswerDelivered, bufferedDepth })
          const want = enabled && !finalAnswerDelivered && bufferedDepth > 0
          expect(got).toBe(want)
        }
      }
    }
  })
})

describe('no-reply bounded drain — liveness (the queue cannot wedge)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Mirror of the gateway's armNoReplyDrainTimer timer pattern: when the
  // predicate arms, a setTimeout(forceDrain, NOREPLY_DRAIN_MS) is set; the
  // force-drain releases the buffer regardless of the serialize gate.
  function simulateNoReplyTurnEnd(opts: {
    drainMs: number
    finalAnswerDelivered: boolean
    bufferDepthAtEnd: number
    forceDrain: () => void
  }): void {
    if (
      shouldArmNoReplyDrain({
        enabled: true,
        finalAnswerDelivered: opts.finalAnswerDelivered,
        bufferedDepth: opts.bufferDepthAtEnd,
      })
    ) {
      const t = setTimeout(() => opts.forceDrain(), opts.drainMs)
      t.unref?.()
    }
  }

  it('a no-reply turn followed by a queued cross-topic message releases within ~2.5s', () => {
    const NOREPLY_DRAIN_MS = 2_500
    let buffered = 1 // one cross-topic inbound queued behind the no-reply turn
    const forceDrain = vi.fn(() => { buffered = 0 })

    simulateNoReplyTurnEnd({
      drainMs: NOREPLY_DRAIN_MS,
      finalAnswerDelivered: false,
      bufferDepthAtEnd: buffered,
      forceDrain,
    })

    // Before the bound: still queued (serialize gate held it, no reply came).
    vi.advanceTimersByTime(NOREPLY_DRAIN_MS - 1)
    expect(forceDrain).not.toHaveBeenCalled()
    expect(buffered).toBe(1)

    // At the bound: the escape hatch fires and drains. No wedge.
    vi.advanceTimersByTime(1)
    expect(forceDrain).toHaveBeenCalledTimes(1)
    expect(buffered).toBe(0)
  })

  it('a DELIVERED turn does not arm the timer (the reply already drained)', () => {
    const forceDrain = vi.fn()
    simulateNoReplyTurnEnd({
      drainMs: 2_500,
      finalAnswerDelivered: true,
      bufferDepthAtEnd: 1,
      forceDrain,
    })
    vi.advanceTimersByTime(10_000)
    expect(forceDrain).not.toHaveBeenCalled()
  })
})

describe('gateway wiring (source-level guards) — the gateway IIFE is too entangled to instantiate', () => {
  const gatewaySrc = readFileSync(
    resolve(__dirname, '..', 'gateway', 'gateway.ts'),
    'utf-8',
  )
  // #2996 P8 PR-B: the funnel bodies moved verbatim to turn-end.ts; the
  // body-structure guards read there (gateway keeps delegating wrappers).
  const turnEndSrc = readFileSync(
    resolve(__dirname, '..', 'gateway', 'turn-end.ts'),
    'utf-8',
  )

  it('endCurrentTurnAtomic arms the no-reply drain timer after the serialize-gated purge', () => {
    const fn = turnEndSrc.split('function endCurrentTurnAtomic')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/purgeReactionTracking\(/)
    expect(fn).toMatch(/armNoReplyDrainTimer\(turn\)/)
    // The arm must come AFTER the purge (the purge attempts the gated
    // drain first; the timer is the fallback for the no-reply case).
    expect(fn.indexOf('armNoReplyDrainTimer')).toBeGreaterThan(fn.indexOf('purgeReactionTracking'))
  })

  it('armNoReplyDrainTimer uses the shared predicate + a bounded setTimeout that force-drains', () => {
    const fn = turnEndSrc.split('function armNoReplyDrainTimer')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/shouldArmNoReplyDrain\(/)
    expect(fn).toMatch(/setTimeout\(/)
    expect(fn).toMatch(/SERIALIZE_NOREPLY_DRAIN_MS/)
    // It must force-drain (bypassing the serialize delivered-check), not
    // route back through the gated drain — else the no-reply turn would
    // re-block itself.
    expect(fn).toMatch(/performBufferDrain\(/)
    expect(fn).not.toMatch(/drainBufferedIfAllowed\(/)
  })

  it('the 300s silence-poke fallback remains an independent long-stop (direct redeliver)', () => {
    // The unwedge fallback calls redeliverBufferedInbound directly — it
    // must NOT be gated by the serialize predicate, or a stuck no-reply
    // turn whose bounded timer somehow failed would never recover.
    expect(gatewaySrc).toMatch(/silence-poke framework-fallback ended wedged turn/)
  })
})
