/**
 * Contract pins for the mid-turn ack-queue-apply-confirm slot (#3017) that
 * backs `/model` + `/effort` when the agent is busy.
 *
 * The gateway wiring (busy-gate enqueue, idle-gate drain, reaper drain-cap) is
 * exercised end-to-end by the UAT harness; these lock the PURE contract the
 * gateway relies on:
 *
 *   - single-valued slot, last-write-wins (a rapid re-issue queues only the
 *     latest and REPORTS the displaced one so it's never silently lost)
 *   - take() is the atomic drain read (empties the slot)
 *   - size mirrors the `pendingRestarts.size` gate shape (0 or 1)
 *   - the ack / superseded / restart-superseded text names the target so the
 *     operator always sees their choice was captured, replaced, or deferred —
 *     never dropped.
 */

import { describe, it, expect } from 'vitest'
import {
  createPendingSessionCommandSlot,
  ackText,
  supersededText,
  restartSupersededText,
  type PendingSessionCommand,
} from '../gateway/pending-session-command.js'

const ident = (s: string) => s

function cmd(overrides: Partial<PendingSessionCommand> = {}): PendingSessionCommand {
  return {
    kind: 'model',
    origin: 'typed',
    arg: 'fable',
    targetLabel: 'fable',
    chatId: '100',
    threadId: undefined,
    ackChatId: '100',
    ackMessageId: 42,
    requestedAt: 1_000,
    ...overrides,
  }
}

describe('pending-session-command slot', () => {
  it('starts empty (size 0, get null, take null)', () => {
    const slot = createPendingSessionCommandSlot()
    expect(slot.size).toBe(0)
    expect(slot.get()).toBeNull()
    expect(slot.take()).toBeNull()
  })

  it('set on an empty slot displaces nothing and becomes gettable', () => {
    const slot = createPendingSessionCommandSlot()
    const a = cmd({ arg: 'opus', targetLabel: 'opus' })
    expect(slot.set(a)).toBeNull()
    expect(slot.size).toBe(1)
    expect(slot.get()).toBe(a)
  })

  it('last-write-wins: a second set returns the displaced command', () => {
    const slot = createPendingSessionCommandSlot()
    const first = cmd({ arg: 'fable', targetLabel: 'fable', ackMessageId: 1 })
    const second = cmd({ arg: 'opus', targetLabel: 'opus', ackMessageId: 2 })
    expect(slot.set(first)).toBeNull()
    const displaced = slot.set(second)
    expect(displaced).toBe(first) // caller edits THIS ack card to "superseded"
    expect(slot.get()).toBe(second) // only the latest is queued
    expect(slot.size).toBe(1)
  })

  it('take() atomically empties the slot (the drain read)', () => {
    const slot = createPendingSessionCommandSlot()
    const a = cmd()
    slot.set(a)
    expect(slot.take()).toBe(a)
    expect(slot.size).toBe(0)
    expect(slot.get()).toBeNull()
    expect(slot.take()).toBeNull() // second drain is a no-op
  })

  it('clear() drops the queued command without returning it', () => {
    const slot = createPendingSessionCommandSlot()
    slot.set(cmd())
    slot.clear()
    expect(slot.size).toBe(0)
    expect(slot.get()).toBeNull()
  })
})

describe('ackText', () => {
  it('names the model target with a mid-turn framing', () => {
    const t = ackText('model', 'fable', ident)
    expect(t).toContain('mid-turn')
    expect(t).toContain('`fable`')
    expect(t).toContain('switch to')
  })

  it('uses the effort verb for effort commands', () => {
    const t = ackText('effort', 'high', ident)
    expect(t).toContain('set effort to')
    expect(t).toContain('`high`')
  })

  it('routes the label through escapeHtml', () => {
    const seen: string[] = []
    ackText('model', 'sr-glm-5', (s) => { seen.push(s); return s })
    expect(seen).toContain('sr-glm-5')
  })
})

describe('supersededText', () => {
  it('names BOTH the replaced and the new target', () => {
    const displaced = cmd({ kind: 'model', targetLabel: 'fable' })
    const next = cmd({ kind: 'model', targetLabel: 'opus' })
    const t = supersededText(displaced, next, ident)
    expect(t).toContain('`opus`')
    expect(t).toContain('`fable`')
    expect(t).toContain('replaced')
  })
})

describe('restartSupersededText', () => {
  it('tells the operator to re-issue after the restart', () => {
    const t = restartSupersededText(cmd({ kind: 'effort', targetLabel: 'max' }), ident)
    expect(t).toContain('restarting')
    expect(t).toContain('/effort max')
    expect(t).toContain('`max`')
  })
})
