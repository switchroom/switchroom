/**
 * #2995 — mid-flight busy ack: pure decision module.
 *
 * Pins the deterministic policy (`shouldPostBusyAck`) and the rendered
 * card text (`formatBusyAckText`) — the model-free ack a buffered/steered
 * mid-turn inbound gets while the running turn sits inside one long tool
 * step. Behavioral assertions on the RENDERED text (wording contract:
 * "Queued" for the buffered path per the steer-or-queue classification-
 * visibility invariant; never "Queued" for a steer).
 */

import { describe, it, expect } from 'vitest'
import {
  BUSY_ACK_STEP_AGE_THRESHOLD_MS,
  shouldPostBusyAck,
  formatBusyAckText,
} from '../gateway/busy-ack.js'

const base = {
  gateDecision: 'buffer-until-idle' as const,
  midToolCall: true,
  stepAgeMs: BUSY_ACK_STEP_AGE_THRESHOLD_MS + 1,
  alreadyAcked: false,
}

describe('shouldPostBusyAck', () => {
  it('fires for a buffered inbound behind an old tool step', () => {
    expect(shouldPostBusyAck(base)).toBe(true)
  })

  it('fires for a steer behind an old tool step', () => {
    expect(shouldPostBusyAck({ ...base, gateDecision: 'steer' })).toBe(true)
  })

  it('never fires for a plain fresh-turn deliver', () => {
    expect(shouldPostBusyAck({ ...base, gateDecision: 'deliver' })).toBe(false)
  })

  it('never fires when not mid-tool-call (turn thinking between tools)', () => {
    expect(shouldPostBusyAck({ ...base, midToolCall: false })).toBe(false)
  })

  it('never fires below the step-age threshold (agent seconds from answering)', () => {
    expect(
      shouldPostBusyAck({ ...base, stepAgeMs: BUSY_ACK_STEP_AGE_THRESHOLD_MS - 1 }),
    ).toBe(false)
    // exactly at the threshold → fires (>= semantics)
    expect(
      shouldPostBusyAck({ ...base, stepAgeMs: BUSY_ACK_STEP_AGE_THRESHOLD_MS }),
    ).toBe(true)
  })

  it('never fires with no tracked step age', () => {
    expect(shouldPostBusyAck({ ...base, stepAgeMs: null })).toBe(false)
  })

  it('fires at most once per key — a second ping gets no second card', () => {
    // The gateway feeds `alreadyAcked` from its per-turn key set + the live
    // card map; the policy must refuse when either says "already acked".
    expect(shouldPostBusyAck({ ...base, alreadyAcked: true })).toBe(false)
  })

  it('threshold constant sits between the fast-tool envelope and the ignored horizon', () => {
    expect(BUSY_ACK_STEP_AGE_THRESHOLD_MS).toBeGreaterThanOrEqual(5_000)
    expect(BUSY_ACK_STEP_AGE_THRESHOLD_MS).toBeLessThanOrEqual(30_000)
  })
})

describe('formatBusyAckText — rendered card text', () => {
  it('buffered path says "Queued", names the blocking activity, and promises the answer', () => {
    const text = formatBusyAckText({
      gateDecision: 'buffer-until-idle',
      toolName: 'Bash',
      toolLabel: 'gh pr checks --watch',
    })
    expect(text).toContain('Queued')
    expect(text).toContain('`Bash: gh pr checks --watch`')
    expect(text).toMatch(/I'll answer when this step finishes/)
  })

  it('carries no point-in-time elapsed figure (a static card must not decay)', () => {
    // The card is posted once and never re-rendered while the blocking
    // step runs — any "(Nm elapsed)" would silently go stale on screen.
    const text = formatBusyAckText({
      gateDecision: 'buffer-until-idle',
      toolName: 'Bash',
      toolLabel: 'sleep 90',
    })
    expect(text).not.toMatch(/elapsed|\b\d+[sm]\b/)
  })

  it('steer path never says "Queued" (classification-visibility invariant)', () => {
    const text = formatBusyAckText({
      gateDecision: 'steer',
      toolName: 'Bash',
      toolLabel: 'sleep 90',
    })
    expect(text).not.toContain('Queued')
    expect(text).toContain('Steer noted')
    expect(text).toContain('`Bash: sleep 90`')
  })

  it('degrades honestly when the tool label is unknown', () => {
    const text = formatBusyAckText({
      gateDecision: 'buffer-until-idle',
      toolName: null,
      toolLabel: null,
    })
    expect(text).toContain('Queued')
    expect(text).toContain('a long-running step')
  })

  it('uses the bare tool name when no label was derived', () => {
    const text = formatBusyAckText({
      gateDecision: 'buffer-until-idle',
      toolName: 'Bash',
      toolLabel: null,
    })
    expect(text).toContain('`Bash`')
  })
})
