import { describe, expect, it } from 'vitest'

import {
  decideInboundDelivery,
  reserveInboundDelivery,
} from '../gateway/inbound-delivery-gate.js'

/**
 * #2917 — rapid-fire DM: replies emitted late & out of order.
 *
 * Root cause: the #1556 delivery gate is documented as a LIVE read
 * ("evaluated at delivery time — not a receipt-time snapshot"), but on the
 * concurrent `handleInbound` path the gate decision and the busy-mark that
 * records "a turn is in flight for this chat" were separated by an `await`
 * (attachment download, composer-clear). Two same-chat inbounds each read
 * "idle" during the other's async lead-in, both passed the gate, and both
 * were delivered to the bridge — so the replies came back reordered.
 *
 * The fix couples the deliver decision with a synchronous RESERVE
 * (`reserveInboundDelivery`): a fresh-turn deliver reserves the chat's busy
 * key BEFORE any await, so a concurrent same-chat inbound observes the
 * reservation on the live gate and buffers behind it — restoring per-chat
 * FIFO without dropping anything (a buffered inbound drains on turn-complete
 * / idle exactly as before).
 */
describe('reserveInboundDelivery — fresh-turn reservation flag', () => {
  it('reserves a fresh-turn deliver (idle, non-steering, non-interrupt)', () => {
    const r = reserveInboundDelivery({ turnInFlight: false, isSteering: false, isInterrupt: false })
    expect(r.decision).toBe('deliver')
    expect(r.reserve).toBe(true)
  })

  it('does NOT reserve a buffered (mid-turn) inbound', () => {
    const r = reserveInboundDelivery({ turnInFlight: true, isSteering: false, isInterrupt: false })
    expect(r.decision).toBe('buffer-until-idle')
    expect(r.reserve).toBe(false)
  })

  it('does NOT reserve a steering deliver (amends the running turn)', () => {
    const r = reserveInboundDelivery({ turnInFlight: true, isSteering: true, isInterrupt: false })
    expect(r.decision).toBe('deliver')
    expect(r.reserve).toBe(false)
  })

  it('does NOT reserve an interrupt deliver (amends the running turn)', () => {
    const r = reserveInboundDelivery({ turnInFlight: true, isSteering: false, isInterrupt: true })
    expect(r.decision).toBe('deliver')
    expect(r.reserve).toBe(false)
  })

  it('decision stays byte-identical to decideInboundDelivery across the matrix', () => {
    for (const turnInFlight of [false, true]) {
      for (const isSteering of [false, true]) {
        for (const isInterrupt of [false, true]) {
          const input = { turnInFlight, isSteering, isInterrupt }
          expect(reserveInboundDelivery(input).decision).toBe(decideInboundDelivery(input))
        }
      }
    }
  })
})

/**
 * A minimal model of the gateway's concurrent same-chat delivery path. Each
 * inbound handler:
 *   1. reads the LIVE gate off the shared busy set,
 *   2. yields at an `await` (the composer-clear / attachment lead-in),
 *   3. on a reserving deliver, marks the chat busy and appends to the wire.
 *
 * This reproduces the ordering race deterministically: two same-chat handlers
 * whose async lead-ins overlap. The `syncReserve` flag toggles the fix — when
 * off (legacy: mark busy only AFTER the await), both handlers deliver and the
 * wire order is decided by the await race; when on (#2917: reserve BEFORE the
 * await), the second handler sees the reservation and buffers, preserving FIFO.
 */
interface WireResult {
  delivered: string[]
  buffered: string[]
}

async function runTwoConcurrentInbounds(opts: {
  syncReserve: boolean
  /** ms the first handler's lead-in await takes vs the second's. First is
   *  SLOWER so, without the fix, the second overtakes it on the wire. */
  firstLeadInMs: number
  secondLeadInMs: number
}): Promise<WireResult> {
  const busy = new Set<string>()
  const key = 'chatDM:_'
  const delivered: string[] = []
  const buffered: string[] = []

  const handle = async (id: string, leadInMs: number): Promise<void> => {
    // Step 1 — live gate read.
    const gate = reserveInboundDelivery({
      turnInFlight: busy.size > 0,
      isSteering: false,
      isInterrupt: false,
    })
    if (gate.decision === 'buffer-until-idle') {
      buffered.push(id)
      return
    }
    // Step 2 — the fix reserves synchronously BEFORE the await.
    let reserved = false
    if (opts.syncReserve && gate.reserve) {
      busy.add(key)
      reserved = true
    }
    // Step 3 — the async lead-in (composer-clear / attachment download).
    await new Promise((r) => setTimeout(r, leadInMs))
    // Step 4 — legacy marks busy only now, after the await.
    if (!reserved) busy.add(key)
    delivered.push(id)
  }

  await Promise.all([
    handle('msg1', opts.firstLeadInMs),
    handle('msg2', opts.secondLeadInMs),
  ])
  return { delivered, buffered }
}

describe('rapid-fire same-chat delivery ordering (#2917)', () => {
  it('LEGACY (mark-after-await): the faster second inbound overtakes the first — reorder', async () => {
    // msg1's lead-in is slower, so with the busy-mark deferred until after the
    // await BOTH pass the idle gate and BOTH deliver, with msg2 landing first.
    const { delivered, buffered } = await runTwoConcurrentInbounds({
      syncReserve: false,
      firstLeadInMs: 20,
      secondLeadInMs: 1,
    })
    expect(buffered).toEqual([]) // nothing buffered — the bug
    expect(delivered).toEqual(['msg2', 'msg1']) // out of order
  })

  it('FIX (sync reserve): the second inbound sees the reservation and buffers — FIFO preserved', async () => {
    const { delivered, buffered } = await runTwoConcurrentInbounds({
      syncReserve: true,
      firstLeadInMs: 20,
      secondLeadInMs: 1,
    })
    // msg1 reserved synchronously; msg2's live gate sees busy → buffers.
    expect(delivered).toEqual(['msg1'])
    expect(buffered).toEqual(['msg2'])
    // msg2 is not lost — it is held for the turn-complete / idle drain, which
    // re-delivers it in order after msg1's turn ends.
  })
})
