import { describe, expect, it } from 'vitest'

import {
  ackDelivery,
  createDeliveryQueue,
  forgetDelivery,
  sweep,
  trackDelivery,
  type DeliveryQueue,
} from '../gateway/inbound-delivery-confirm.js'

/**
 * Regression coverage for the marko drop-wedge.
 *
 * An inbound delivered to claude's TUI composer strands unsubmitted when the
 * auto-submit races turn-completion. claude never emits `enqueue`, so the
 * gateway used to sit "typing…" for 300s then DROP the message.
 *
 * The queue's contract: a delivered inbound is acked ONLY by `enqueue`; until
 * then it is re-delivered every `timeoutMs`, forever, never dropped — and an
 * acked delivery never re-fires (no duplicate turns).
 */
type Msg = { text: string }
const TIMEOUT = 15_000

function fresh(): DeliveryQueue<Msg> {
  return createDeliveryQueue<Msg>()
}

describe('inbound-delivery-confirm (reliable deliver-until-acked queue)', () => {
  it('an acked delivery is never re-delivered (happy path — no duplicate turns)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'hi' }, 1_000)
    expect(ackDelivery(q, 'chat:_')).toBe(true) // enqueue arrived
    expect(sweep(q, 1_000 + 999_999, TIMEOUT)).toHaveLength(0)
    expect(q.pending.size).toBe(0)
  })

  it('within the timeout, an un-acked delivery is left alone (claude may still be picking it up)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'hi' }, 1_000)
    expect(sweep(q, 1_000 + 14_999, TIMEOUT)).toHaveLength(0)
    expect(q.pending.size).toBe(1)
  })

  it('a strand (no ack) is re-delivered after the timeout, and the clock resets', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'draft nurture email' }, 1_000)
    const r = sweep(q, 1_000 + 15_000, TIMEOUT)
    expect(r).toHaveLength(1)
    expect(r[0]!.inbound.text).toBe('draft nurture email')
    expect(r[0]!.lastAttemptAt).toBe(1_000 + 15_000) // clock reset
    // not re-swept until another full timeout elapses
    expect(sweep(q, 1_000 + 15_000 + 14_999, TIMEOUT)).toHaveLength(0)
  })

  it('keeps re-delivering forever until acked — never drops (the reliability invariant)', () => {
    const q = fresh()
    let t = 0
    trackDelivery(q, 'chat:_', { text: 'x' }, t)
    for (let i = 0; i < 50; i++) {
      t += 15_000
      expect(sweep(q, t, TIMEOUT)).toHaveLength(1) // still trying after 50 strands
    }
    expect(q.pending.size).toBe(1) // never dropped
    // claude finally picks it up → acked → stops.
    expect(ackDelivery(q, 'chat:_')).toBe(true)
    expect(sweep(q, t + 999_999, TIMEOUT)).toHaveLength(0)
  })

  it('an ack that lands right after a re-delivery stops further re-delivery (no duplicate turns)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'x' }, 0)
    sweep(q, 15_000, TIMEOUT) // strand → re-delivered
    expect(ackDelivery(q, 'chat:_')).toBe(true) // the re-delivered copy landed
    expect(sweep(q, 999_999, TIMEOUT)).toHaveLength(0)
    expect(q.pending.size).toBe(0)
  })

  it('keys are independent — a strand on one topic does not affect another (DM + supergroup topics)', () => {
    const q = fresh()
    trackDelivery(q, '-100:4', { text: 'crm topic msg' }, 0) // supergroup CRM topic
    trackDelivery(q, '555:_', { text: 'dm msg' }, 0) // a DM
    ackDelivery(q, '555:_') // the DM submits fine
    const r = sweep(q, 15_000, TIMEOUT)
    expect(r).toHaveLength(1)
    expect(r[0]!.key).toBe('-100:4') // only the stranded topic re-delivers
  })

  it('tracking the same key twice keeps only the latest inbound (gate serialises per key)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'first' }, 0)
    trackDelivery(q, 'chat:_', { text: 'second' }, 100)
    expect(q.pending.size).toBe(1)
    expect(sweep(q, 100 + 15_000, TIMEOUT)[0]!.inbound.text).toBe('second')
  })

  it('ack on an unknown key is a harmless no-op', () => {
    expect(ackDelivery(fresh(), 'never-tracked')).toBe(false)
  })

  it('forgetDelivery clears without acking or re-delivering (bridge went offline)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'x' }, 0)
    forgetDelivery(q, 'chat:_')
    expect(q.pending.size).toBe(0)
    expect(sweep(q, 999_999, TIMEOUT)).toHaveLength(0)
  })
})
