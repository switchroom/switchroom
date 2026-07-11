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
 *   - shutdownResolutionActions empties the slots and yields, per queued
 *     command, the durable persist the gateway should perform so the choice
 *     still applies across the bounce (#3039) — with a re-issue fallback only
 *     for the unresolvable menu-tag case
 *   - the ack / superseded / restart-superseded text names the target so the
 *     operator always sees their choice was captured, replaced, or deferred —
 *     never dropped.
 */

import { describe, it, expect } from 'vitest'
import {
  createPendingSessionCommandSlots,
  drainCapDecision,
  shutdownResolutionActions,
  resolveForRestart,
  drainTakenCommands,
  type DrainIo,
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

describe('shutdownResolutionActions (#3018 finding 3 + #3039: SIGTERM persists the queued choice)', () => {
  it('empties the slots and yields a persist action per queued command', () => {
    const slots = createPendingSessionCommandSlots()
    slots.set(cmd({ kind: 'model', targetLabel: 'fable', arg: 'fable', ackChatId: '100', ackMessageId: 7 }))
    slots.set(cmd({ kind: 'effort', targetLabel: 'high', arg: 'high', ackChatId: '100', ackMessageId: 9 }))
    const actions = shutdownResolutionActions(slots, ident)
    expect(actions).toHaveLength(2)
    expect(slots.size).toBe(0) // the queue is RESOLVED, not left behind
    const model = actions.find(a => a.cmd.ackMessageId === 7)!
    expect(model.persist).toBe('model')
    expect(model.arg).toBe('fable')
    expect(model.persistedText).toContain('`fable`')
    expect(model.persistedText).toContain('saved')
    // The fallback (persist failed) still names the choice + how to recover.
    expect(model.reissueText).toContain('re-issue')
    const effort = actions.find(a => a.cmd.ackMessageId === 9)!
    expect(effort.persist).toBe('effort')
    expect(effort.arg).toBe('high')
  })

  it('typed /model default → clear-model; typed /effort default → clear-effort', () => {
    expect(resolveForRestart(cmd({ kind: 'model', arg: 'default', targetLabel: 'default' }), ident).persist).toBe('clear-model')
    expect(resolveForRestart(cmd({ kind: 'effort', arg: 'default', targetLabel: 'default' }), ident).persist).toBe('clear-effort')
  })

  it('menu model selection (mdl:s:<tag>) is not offline-resolvable → persist null, re-issue fallback', () => {
    const a = resolveForRestart(cmd({ kind: 'model', origin: 'menu', arg: 'mdl:s:abcd1234', targetLabel: 'the selected model' }), ident)
    expect(a.persist).toBeNull()
    expect(a.reissueText).toContain('re-issue')
  })

  it('menu effort tap (eff:s:<level>) IS resolvable → persist effort with the level', () => {
    const a = resolveForRestart(cmd({ kind: 'effort', origin: 'menu', arg: 'eff:s:xhigh', targetLabel: 'xhigh' }), ident)
    expect(a.persist).toBe('effort')
    expect(a.arg).toBe('xhigh')
  })

  it('returns no actions when nothing is queued', () => {
    expect(shutdownResolutionActions(createPendingSessionCommandSlots(), ident)).toEqual([])
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


// ─── #3042 blocker 1: drain loss-safety across a two-command batch ───────────

describe('drainTakenCommands (#3042 blocker 1: an early stop must not drop the rest of the batch)', () => {
  function makeIo(overrides: Partial<DrainIo> = {}) {
    const events: string[] = []
    const io: DrainIo = {
      restartPending: () => false,
      turnInFlight: () => false,
      apply: async c => { events.push(`apply:${c.kind}`); return `✅ ${c.kind} done` },
      isBusyRefusal: t => t.includes('BUSY'),
      resolveForRestartText: c => `persisted:${c.kind}`,
      editCard: async (c, text) => { events.push(`edit:${c.kind}:${text}`) },
      reEnqueue: c => { events.push(`requeue:${c.kind}`) },
      failureText: (c, err) => `fail:${c.kind}:${(err as Error).message}`,
      ...overrides,
    }
    return { io, events }
  }
  const batch = () => [cmd({ kind: 'model' }), cmd({ kind: 'effort', arg: 'high', targetLabel: 'high' })]

  it('happy path applies and confirms both commands in order', async () => {
    const { io, events } = makeIo()
    await drainTakenCommands(batch(), io)
    expect(events).toEqual(['apply:model', 'edit:model:✅ model done', 'apply:effort', 'edit:effort:✅ effort done'])
  })

  it('turn races in before the FIRST command → BOTH are re-enqueued, none applied or confirmed', async () => {
    const { io, events } = makeIo({ turnInFlight: () => true })
    await drainTakenCommands(batch(), io)
    expect(events).toEqual(['requeue:model', 'requeue:effort'])
  })

  it('turn races in before the SECOND command → first applied, second re-enqueued (not lost)', async () => {
    let calls = 0
    const { io, events } = makeIo({ turnInFlight: () => ++calls > 1 })
    await drainTakenCommands(batch(), io)
    expect(events).toEqual(['apply:model', 'edit:model:✅ model done', 'requeue:effort'])
  })

  it('handler busy-refusal on the FIRST command → the refusal never reaches the ack card and BOTH are re-enqueued', async () => {
    const { io, events } = makeIo({
      apply: async c => (c.kind === 'model' ? 'BUSY — mid-turn' : '✅ effort done'),
    })
    await drainTakenCommands(batch(), io)
    expect(events).toEqual(['requeue:model', 'requeue:effort'])
  })

  it('apply throwing on the first command does NOT stop the second (failure is per-command)', async () => {
    const { io, events } = makeIo({
      apply: async c => {
        if (c.kind === 'model') throw new Error('boom')
        return '✅ effort done'
      },
    })
    await drainTakenCommands(batch(), io)
    expect(events).toEqual(['edit:model:fail:model:boom', 'edit:effort:✅ effort done'])
  })

  it('restart pending → every command is resolved via the carriers, none applied live', async () => {
    const { io, events } = makeIo({ restartPending: () => true })
    await drainTakenCommands(batch(), io)
    expect(events).toEqual(['edit:model:persisted:model', 'edit:effort:persisted:effort'])
  })

  it('#3021: restart-pending is snapshotted at entry → sync loop emptying pendingRestarts mid-drain still defers the SECOND command', async () => {
    // Reproduces the turn-end idle-gate race: the drain is void-dispatched while
    // a synchronous pendingRestarts loop empties the map right after. The first
    // read sees the entry; by the second command the map has been emptied. A
    // naive per-command re-check would let the second command apply live into a
    // session ~100ms from triggerSelfRestart and falsely confirm.
    let restartPresent = true
    const { io, events } = makeIo({
      // takeAll() first read latches true; the sync loop then empties the map,
      // so every subsequent live read returns false.
      restartPending: () => {
        const was = restartPresent
        restartPresent = false // the sync loop deleted the entry after dispatch
        return was
      },
    })
    await drainTakenCommands(batch(), io)
    // BOTH commands must ride the carriers — the second must NOT apply live.
    expect(events).toEqual(['edit:model:persisted:model', 'edit:effort:persisted:effort'])
  })
})
