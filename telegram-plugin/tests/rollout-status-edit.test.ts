/**
 * #4065 — the rollout card's edit relay must tell hostd the TRUTH about an
 * edit, so a seeded-resume narrator can notice it is editing a card that no
 * longer exists instead of leaving the operator with a frozen card.
 *
 * Outcome under test (gateway half): "message to edit not found" replies
 * `gone:true` (the only class that may trigger a re-post), everything else
 * replies `gone:false`, and "message is not modified" is a SUCCESS — the live
 * card already carries that exact body, so re-posting it would duplicate a
 * perfectly good card.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyRolloutEditError,
  handleRolloutStatusEdit,
  type RolloutStatusEditDeps,
} from '../gateway/rollout-status-edit.js'
import type {
  RolloutStatusEditMessage,
  RolloutStatusEditedEvent,
} from '../gateway/ipc-protocol.js'

const MSG: RolloutStatusEditMessage = {
  type: 'rollout_status_edit',
  requestId: 'ro-1',
  agentName: 'overlord',
  messageId: 4242,
  text: 'rolling…',
}

function harness(
  over: Partial<RolloutStatusEditDeps> = {},
): { deps: RolloutStatusEditDeps; sent: RolloutStatusEditedEvent[]; client: { send(m: RolloutStatusEditedEvent): void } } {
  const sent: RolloutStatusEditedEvent[] = []
  const deps: RolloutStatusEditDeps = {
    selfAgentName: 'overlord',
    operatorChatId: () => 12345,
    editMessage: async () => ({ message_id: 4242 }),
    log: () => {},
    ...over,
  }
  return { deps, sent, client: { send: (m) => sent.push(m) } }
}

/** A grammy-shaped API error (the real thing carries `description`). */
function tgError(description: string): Error & { description: string } {
  const e = new Error(description) as Error & { description: string }
  e.description = description
  return e
}

describe('classifyRolloutEditError', () => {
  it('classifies a deleted / uneditable target as gone', () => {
    expect(
      classifyRolloutEditError(tgError('Bad Request: message to edit not found')),
    ).toBe('gone')
    expect(
      classifyRolloutEditError(tgError("Bad Request: message can't be edited")),
    ).toBe('gone')
    expect(classifyRolloutEditError(tgError('Bad Request: MESSAGE_ID_INVALID'))).toBe(
      'gone',
    )
  })

  it('classifies an unchanged body as not-modified (the card is live)', () => {
    expect(
      classifyRolloutEditError(
        tgError('Bad Request: message is not modified: specified new message content...'),
      ),
    ).toBe('not-modified')
  })

  it('classifies everything else as transient — a re-post would duplicate a live card', () => {
    expect(classifyRolloutEditError(tgError('Too Many Requests: retry after 12'))).toBe(
      'transient',
    )
    expect(classifyRolloutEditError(new Error('socket hang up'))).toBe('transient')
    expect(classifyRolloutEditError(undefined)).toBe('transient')
  })
})

describe('handleRolloutStatusEdit', () => {
  it('replies ok on a successful edit', async () => {
    const h = harness()
    await handleRolloutStatusEdit(h.deps, h.client, MSG)
    expect(h.sent).toEqual([{ type: 'rollout_status_edited', requestId: 'ro-1', ok: true }])
  })

  it('replies gone:true when the card no longer exists (the #4065 signal)', async () => {
    const h = harness({
      editMessage: async () => {
        throw tgError('Bad Request: message to edit not found')
      },
    })
    await handleRolloutStatusEdit(h.deps, h.client, MSG)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ requestId: 'ro-1', ok: false, gone: true })
  })

  it('replies gone:false on a transient failure', async () => {
    const h = harness({
      editMessage: async () => {
        throw tgError('Too Many Requests: retry after 12')
      },
    })
    await handleRolloutStatusEdit(h.deps, h.client, MSG)
    expect(h.sent[0]).toMatchObject({ ok: false, gone: false })
  })

  it('treats "not modified" as success — the live card already says this', async () => {
    const h = harness({
      editMessage: async () => {
        throw tgError('Bad Request: message is not modified')
      },
    })
    await handleRolloutStatusEdit(h.deps, h.client, MSG)
    expect(h.sent).toEqual([{ type: 'rollout_status_edited', requestId: 'ro-1', ok: true }])
  })

  it('rejects an agent mismatch without editing, and never reports gone', async () => {
    let edits = 0
    const h = harness({
      selfAgentName: 'someone-else',
      editMessage: async () => {
        edits++
        return {}
      },
    })
    await handleRolloutStatusEdit(h.deps, h.client, MSG)
    expect(edits).toBe(0)
    expect(h.sent[0]).toMatchObject({ ok: false, gone: false, reason: 'agent mismatch' })
  })

  it('replies (never throws) when there is no operator chat', async () => {
    const h = harness({ operatorChatId: () => undefined })
    await handleRolloutStatusEdit(h.deps, h.client, MSG)
    expect(h.sent[0]).toMatchObject({ ok: false, gone: false, reason: 'no operator chat' })
  })
})
