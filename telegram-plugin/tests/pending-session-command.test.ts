/**
 * Contract pins for the mid-turn ack-queue-apply-confirm slots (#3017/#3018)
 * that back `/model` + `/effort` when the agent is busy.
 *
 * The gateway wiring (busy-gate enqueue, idle-gate drain, reaper drain-cap,
 * shutdown resolution) is exercised end-to-end by the UAT harness and pinned
 * structurally in gateway-pending-command-wiring.test.ts; these lock the PURE
 * contract the gateway relies on:
 *
 *   - one slot PER KIND (model, effort): same-kind last-write-wins (a rapid
 *     re-issue queues only the latest and REPORTS the displaced one so it's
 *     never silently lost); cross-kind requests COEXIST (#3018 finding 2)
 *   - take(kind)/takeAll() are the atomic drain reads (empty the slots)
 *   - size mirrors the `pendingRestarts.size` gate shape (0..2)
 *   - the reaper's drainCapDecision DEFERS while a turn is in flight — the
 *     60s cap must never force a mid-turn drain (#3018 finding 1)
 *   - shutdownResolutionEdits empties the slots and yields the ack-card edits
 *     telling the operator to re-issue after boot (#3018 finding 3)
 *   - the ack / superseded / restart-superseded text names the target so the
 *     operator always sees their choice was captured, replaced, or deferred —
 *     never dropped.
 */

import { describe, it, expect } from 'vitest'
import {
  createPendingSessionCommandSlots,
  drainCapDecision,
  shutdownResolutionEdits,
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

describe('pending-session-command slots', () => {
  it('start empty (size 0, get null, take null, takeAll empty)', () => {
    const slots = createPendingSessionCommandSlots()
    expect(slots.size).toBe(0)
    expect(slots.get('model')).toBeNull()
    expect(slots.get('effort')).toBeNull()
    expect(slots.take('model')).toBeNull()
    expect(slots.takeAll()).toEqual([])
    expect(slots.list()).toEqual([])
  })

  it('set on an empty slot displaces nothing and becomes gettable', () => {
    const slots = createPendingSessionCommandSlots()
    const a = cmd({ arg: 'opus', targetLabel: 'opus' })
    expect(slots.set(a)).toBeNull()
    expect(slots.size).toBe(1)
    expect(slots.get('model')).toBe(a)
  })

  it('SAME-KIND last-write-wins: a second set returns the displaced command', () => {
    const slots = createPendingSessionCommandSlots()
    const first = cmd({ arg: 'fable', targetLabel: 'fable', ackMessageId: 1 })
    const second = cmd({ arg: 'opus', targetLabel: 'opus', ackMessageId: 2 })
    expect(slots.set(first)).toBeNull()
    const displaced = slots.set(second)
    expect(displaced).toBe(first) // caller edits THIS ack card to "superseded"
    expect(slots.get('model')).toBe(second) // only the latest is queued
    expect(slots.size).toBe(1)
  })

  it('CROSS-KIND commands coexist: /effort never displaces a queued /model (#3018 finding 2)', () => {
    const slots = createPendingSessionCommandSlots()
    const model = cmd({ kind: 'model', arg: 'fable', targetLabel: 'fable', ackMessageId: 1 })
    const effort = cmd({ kind: 'effort', arg: 'high', targetLabel: 'high', ackMessageId: 2 })
    expect(slots.set(model)).toBeNull()
    expect(slots.set(effort)).toBeNull() // NOT a displacement
    expect(slots.size).toBe(2)
    expect(slots.get('model')).toBe(model)
    expect(slots.get('effort')).toBe(effort)
    // …and vice versa: a later model re-issue displaces only the model slot.
    const model2 = cmd({ kind: 'model', arg: 'opus', targetLabel: 'opus', ackMessageId: 3 })
    expect(slots.set(model2)).toBe(model)
    expect(slots.get('effort')).toBe(effort)
    expect(slots.size).toBe(2)
  })

  it('take(kind) atomically empties only that slot (the per-kind drain read)', () => {
    const slots = createPendingSessionCommandSlots()
    const model = cmd({ kind: 'model' })
    const effort = cmd({ kind: 'effort', arg: 'high', targetLabel: 'high' })
    slots.set(model)
    slots.set(effort)
    expect(slots.take('model')).toBe(model)
    expect(slots.size).toBe(1)
    expect(slots.get('model')).toBeNull()
    expect(slots.get('effort')).toBe(effort)
    expect(slots.take('model')).toBeNull() // second drain is a no-op
  })

  it('takeAll() empties everything in enqueue order; a same-kind re-enqueue moves to the back', () => {
    const slots = createPendingSessionCommandSlots()
    const model1 = cmd({ kind: 'model', targetLabel: 'fable', ackMessageId: 1 })
    const effort = cmd({ kind: 'effort', arg: 'high', targetLabel: 'high', ackMessageId: 2 })
    const model2 = cmd({ kind: 'model', targetLabel: 'opus', ackMessageId: 3 })
    slots.set(model1)
    slots.set(effort)
    slots.set(model2) // displaces model1 AND moves the model slot behind effort
    const all = slots.takeAll()
    expect(all).toEqual([effort, model2])
    expect(slots.size).toBe(0)
    expect(slots.takeAll()).toEqual([])
  })

  it('clear() drops every queued command without returning them', () => {
    const slots = createPendingSessionCommandSlots()
    slots.set(cmd({ kind: 'model' }))
    slots.set(cmd({ kind: 'effort', arg: 'high', targetLabel: 'high' }))
    slots.clear()
    expect(slots.size).toBe(0)
    expect(slots.get('model')).toBeNull()
    expect(slots.get('effort')).toBeNull()
  })
})

describe('drainCapDecision (#3018 finding 1: the cap must never force mid-turn)', () => {
  const CAP = 60_000

  it('waits when nothing is queued', () => {
    expect(drainCapDecision([], 1_000_000, CAP, false)).toBe('wait')
    expect(drainCapDecision([], 1_000_000, CAP, true)).toBe('wait')
  })

  it('waits while the queued command is younger than the cap', () => {
    const q = [cmd({ requestedAt: 100_000 })]
    expect(drainCapDecision(q, 100_000 + CAP, CAP, false)).toBe('wait')
  })

  it('forces once overdue AND the session is idle (missed idle gate)', () => {
    const q = [cmd({ requestedAt: 100_000 })]
    expect(drainCapDecision(q, 100_000 + CAP + 1, CAP, false)).toBe('force')
  })

  it('DEFERS (keeps waiting) when overdue but a turn is in flight — a forced mid-turn drain would destroy the queued command', () => {
    const q = [cmd({ requestedAt: 100_000 })]
    expect(drainCapDecision(q, 100_000 + CAP + 1, CAP, true)).toBe('defer-turn-in-flight')
    // …even hours overdue: the idle gate at turn end is the drain point.
    expect(drainCapDecision(q, 100_000 + 100 * CAP, CAP, true)).toBe('defer-turn-in-flight')
  })

  it('any one overdue command trips the cap (mixed ages)', () => {
    const q = [
      cmd({ kind: 'model', requestedAt: 100_000 }),
      cmd({ kind: 'effort', requestedAt: 100_000 + CAP }),
    ]
    expect(drainCapDecision(q, 100_000 + CAP + 1, CAP, false)).toBe('force')
  })
})

describe('shutdownResolutionEdits (#3018 finding 3: SIGTERM must not dangle the ack card)', () => {
  it('empties the slots and yields one restart-superseded edit per queued command', () => {
    const slots = createPendingSessionCommandSlots()
    slots.set(cmd({ kind: 'model', targetLabel: 'fable', ackChatId: '100', ackMessageId: 7 }))
    slots.set(cmd({ kind: 'effort', targetLabel: 'high', ackChatId: '100', ackMessageId: 9 }))
    const edits = shutdownResolutionEdits(slots, ident)
    expect(edits).toHaveLength(2)
    expect(slots.size).toBe(0) // the queue is RESOLVED, not left behind
    const model = edits.find(e => e.messageId === 7)!
    expect(model.chatId).toBe('100')
    expect(model.text).toContain('`fable`')
    expect(model.text).toContain('re-issue')
    const effort = edits.find(e => e.messageId === 9)!
    expect(effort.text).toContain('/effort high')
  })

  it('returns no edits when nothing is queued', () => {
    expect(shutdownResolutionEdits(createPendingSessionCommandSlots(), ident)).toEqual([])
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
