/**
 * Unit tests for handleUpdatePlaceholder — the pure handler that decides
 * whether a hook's `update_placeholder` IPC fires an editMessageDraft or
 * skips. Closes the race-condition class flagged in #472 findings #8 + #9.
 *
 * Three lifecycle states the handler must distinguish:
 *   - apiPending=true: pre-alloc fired sendMessageDraft but it hasn't
 *     resolved yet. Edit MUST proceed — Telegram serializes by draftId.
 *   - consumed=true: executeReply / executeStreamReply has handed the
 *     draft to the agent's reply path. Edit MUST bail.
 *   - neither flag set: normal allocated entry. Edit proceeds.
 */

import { describe, expect, it } from 'bun:test'
import {
  handleUpdatePlaceholder,
  type PreAllocatedDraftEntry,
  type UpdatePlaceholderOutcome,
} from '../update-placeholder-handler.js'

interface DraftCall {
  chatId: string
  draftId: number
  text: string
}

function makeFakeApi(throws = false) {
  const calls: DraftCall[] = []
  const api = (chatId: string, draftId: number, text: string): Promise<unknown> => {
    calls.push({ chatId, draftId, text })
    return throws ? Promise.reject(new Error('boom')) : Promise.resolve()
  }
  return { calls, api }
}

describe('handleUpdatePlaceholder lifecycle (#472 8/9)', () => {
  it('proceeds when the entry is freshly allocated', () => {
    const map = new Map<string, PreAllocatedDraftEntry>([
      ['chat-1', { draftId: 7, allocatedAt: 1 }],
    ])
    const { calls, api } = makeFakeApi()
    const result = handleUpdatePlaceholder({
      msg: { chatId: 'chat-1', text: '📚 recalling' },
      sendMessageDraftFn: api,
      preAllocatedDrafts: map,
    })
    expect(result).toEqual({ kind: 'edited', chatId: 'chat-1', draftId: 7, text: '📚 recalling' })
    expect(calls).toEqual([{ chatId: 'chat-1', draftId: 7, text: '📚 recalling' }])
  })

  it('proceeds even when apiPending=true (#472 finding #8 — closes the .then() race)', () => {
    // The pre-alloc API call hasn't resolved yet — but the entry IS in
    // the map (synchronous seed). Pre-fix this case used to silently no-op
    // because the .then() set the entry only after API resolution.
    const map = new Map<string, PreAllocatedDraftEntry>([
      ['chat-1', { draftId: 7, allocatedAt: 1, apiPending: true }],
    ])
    const { calls, api } = makeFakeApi()
    const result = handleUpdatePlaceholder({
      msg: { chatId: 'chat-1', text: '🟦 thinking' },
      sendMessageDraftFn: api,
      preAllocatedDrafts: map,
    })
    expect(result.kind).toBe('edited')
    // The edit lands at TG's server; if it arrives before the initial
    // post the server queues it on the same draftId (this is the
    // safety property we're relying on by going synchronous).
    expect(calls).toHaveLength(1)
  })

  it('bails when consumed=true (#472 finding #9 — closes the consume/clear race)', () => {
    // executeReply already took the draft. A racing update_placeholder
    // must NOT edit — pre-fix the empty-text clear and the recalling
    // edit raced on TG's server, leaving "📚 recalling" visible after
    // the agent's reply landed.
    const map = new Map<string, PreAllocatedDraftEntry>([
      ['chat-1', { draftId: 7, allocatedAt: 1, consumed: true }],
    ])
    const { calls, api } = makeFakeApi()
    const result = handleUpdatePlaceholder({
      msg: { chatId: 'chat-1', text: '📚 recalling' },
      sendMessageDraftFn: api,
      preAllocatedDrafts: map,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'draft-consumed' })
    expect(calls).toHaveLength(0)
  })

  it('still skips with no-draft-for-chat when the entry is missing', () => {
    const map = new Map<string, PreAllocatedDraftEntry>()
    const { calls, api } = makeFakeApi()
    const result = handleUpdatePlaceholder({
      msg: { chatId: 'chat-1', text: 'hi' },
      sendMessageDraftFn: api,
      preAllocatedDrafts: map,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'no-draft-for-chat' })
    expect(calls).toHaveLength(0)
  })

  it('still skips with no-draft-api when sendMessageDraftFn is null', () => {
    const map = new Map<string, PreAllocatedDraftEntry>([
      ['chat-1', { draftId: 7, allocatedAt: 1 }],
    ])
    const result = handleUpdatePlaceholder({
      msg: { chatId: 'chat-1', text: 'hi' },
      sendMessageDraftFn: null,
      preAllocatedDrafts: map,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'no-draft-api' })
  })

  it('still skips with empty-text when text is empty', () => {
    const map = new Map<string, PreAllocatedDraftEntry>([
      ['chat-1', { draftId: 7, allocatedAt: 1 }],
    ])
    const { calls, api } = makeFakeApi()
    const result = handleUpdatePlaceholder({
      msg: { chatId: 'chat-1', text: '' },
      sendMessageDraftFn: api,
      preAllocatedDrafts: map,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'empty-text' })
    expect(calls).toHaveLength(0)
  })

  it('reports edit-failed via onResult when the API rejects', async () => {
    const map = new Map<string, PreAllocatedDraftEntry>([
      ['chat-1', { draftId: 7, allocatedAt: 1 }],
    ])
    const { api } = makeFakeApi(true)
    const results: UpdatePlaceholderOutcome[] = []
    handleUpdatePlaceholder(
      {
        msg: { chatId: 'chat-1', text: 'hi' },
        sendMessageDraftFn: api,
        preAllocatedDrafts: map,
      },
      (r) => results.push(r),
    )
    // First synchronous emit is `edited`; second async emit is `edit-failed`.
    await new Promise((r) => setImmediate(r))
    expect(results.length).toBe(2)
    expect(results[0].kind).toBe('edited')
    expect(results[1].kind).toBe('edit-failed')
  })
})
