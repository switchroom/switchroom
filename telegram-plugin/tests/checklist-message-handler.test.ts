/**
 * Outcome pins for the checklist service-message handler extracted from
 * gateway.ts (switchroom#2996 P6). Asserts the fail-closed allowlist gate
 * (#472 finding #13), the exact per-task InboundMessage envelope broadcast to
 * bridges (kind="checklist_task_changed"), the done/undone/added state
 * derivation, and swallow-with-log error containment.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleChecklistUpdate,
  type ChecklistHandlerDeps,
} from '../gateway/checklist-message-handler.js'

function makeDeps(over: Partial<ChecklistHandlerDeps> = {}) {
  const broadcast = vi.fn()
  const log = vi.fn()
  const deps: ChecklistHandlerDeps = {
    loadAccess: () => ({ allowFrom: ['42'] }),
    broadcast,
    log,
    ...over,
  }
  return { deps, broadcast, log }
}

function ctxWith(message: Record<string, unknown> | undefined, chatId: number | undefined = 42): any {
  return {
    message,
    chat: chatId == null ? undefined : { id: chatId },
  }
}

describe('handleChecklistUpdate — allowlist gate (fail-closed)', () => {
  it('drops updates from non-allowlisted chats', () => {
    const { deps, broadcast } = makeDeps({ loadAccess: () => ({ allowFrom: ['99'] }) })
    handleChecklistUpdate(
      ctxWith({ message_id: 7, date: 1000, checklist_tasks_done: [{ id: 1 }] }),
      'checklist_tasks_done',
      deps,
    )
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('drops EVERYTHING when the allowlist is empty (the #472 fail-open bug)', () => {
    const { deps, broadcast } = makeDeps({ loadAccess: () => ({ allowFrom: [] }) })
    handleChecklistUpdate(
      ctxWith({ message_id: 7, date: 1000, checklist_tasks_done: [{ id: 1 }] }),
      'checklist_tasks_done',
      deps,
    )
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('does nothing without a message or chat', () => {
    const { deps, broadcast } = makeDeps()
    handleChecklistUpdate(ctxWith(undefined), 'checklist_tasks_done', deps)
    handleChecklistUpdate(ctxWith({ message_id: 7 }, undefined), 'checklist_tasks_done', deps)
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('handleChecklistUpdate — envelope', () => {
  it('broadcasts one checklist_task_changed event per done task with the exact envelope', () => {
    const { deps, broadcast, log } = makeDeps()
    handleChecklistUpdate(
      ctxWith({
        message_id: 7,
        date: 1_700_000_000,
        checklist_tasks_done: [
          { id: 3, user: { id: 11, username: 'ken' } },
          { id: 4, user: { id: 12 }, done: false },
        ],
      }),
      'checklist_tasks_done',
      deps,
    )
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast.mock.calls[0][0]).toEqual({
      type: 'inbound',
      chatId: '42',
      messageId: 7,
      user: 'ken',
      userId: 11,
      ts: 1_700_000_000,
      text: '(checklist task done: id=3)',
      meta: {
        chat_id: '42',
        message_id: '7',
        kind: 'checklist_task_changed',
        task_id: '3',
        state: 'done',
        user: 'ken',
        user_id: '11',
        ts: new Date(1_700_000_000 * 1000).toISOString(),
      },
    })
    // done === false → 'undone'; username absent → numeric id string.
    const second = broadcast.mock.calls[1][0]
    expect(second.meta.state).toBe('undone')
    expect(second.user).toBe('12')
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0][0]).toContain('checklist checklist_tasks_done')
  })

  it('broadcasts added tasks with state=added', () => {
    const { deps, broadcast } = makeDeps()
    handleChecklistUpdate(
      ctxWith({
        message_id: 8,
        date: 1000,
        checklist_tasks_added: [{ id: 9, text: 'new task' }],
      }),
      'checklist_tasks_added',
      deps,
    )
    expect(broadcast).toHaveBeenCalledTimes(1)
    const evt = broadcast.mock.calls[0][0]
    expect(evt.meta.state).toBe('added')
    expect(evt.meta.task_id).toBe('9')
    expect(evt.user).toBe('unknown')
    expect(evt.userId).toBe(0)
  })

  it('reads only the field matching the kind argument', () => {
    const { deps, broadcast } = makeDeps()
    handleChecklistUpdate(
      ctxWith({
        message_id: 8,
        date: 1000,
        checklist_tasks_done: [{ id: 1 }],
        checklist_tasks_added: [{ id: 2 }, { id: 3 }],
      }),
      'checklist_tasks_added',
      deps,
    )
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast.mock.calls.map(c => c[0].meta.task_id)).toEqual(['2', '3'])
  })
})

describe('handleChecklistUpdate — error containment', () => {
  it('swallows a throwing broadcast and logs the handler error', () => {
    const { deps, log } = makeDeps({
      broadcast: vi.fn(() => {
        throw new Error('ipc down')
      }),
    })
    expect(() =>
      handleChecklistUpdate(
        ctxWith({ message_id: 7, date: 1000, checklist_tasks_done: [{ id: 1 }] }),
        'checklist_tasks_done',
        deps,
      ),
    ).not.toThrow()
    const line = log.mock.calls.at(-1)?.[0] as string
    expect(line).toContain('checklist handler error (checklist_tasks_done)')
    expect(line).toContain('ipc down')
  })
})
