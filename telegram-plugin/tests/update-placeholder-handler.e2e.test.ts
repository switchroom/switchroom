/**
 * E2E behavioural tests for the `update_placeholder` IPC handler.
 *
 * Pins the contract that drives the user-visible placeholder
 * transitions (`🔵 thinking` → `📚 recalling memories` → `💭 thinking`
 * → final reply). The pure-decision logic for "should we pre-allocate
 * a draft at all" is tested separately in `pre-alloc-decision.test.ts`;
 * this file tests the side-effecting "we have a draft, edit it now"
 * path.
 *
 * Uses a hand-mocked `sendMessageDraftFn` rather than fake-bot-api
 * because `sendMessageDraft` isn't part of grammy's standard API
 * (it's a recent Bot API addition we expose via raw call). The
 * mock matches the function signature the gateway uses in production.
 *
 * See HARNESS.md for general harness usage; this file demonstrates
 * the "test an extracted handler against a mocked external API" pattern.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  handleUpdatePlaceholder,
  PLACEHOLDER_TEXT_MAX_LEN,
  type PreAllocatedDraftEntry,
  type UpdatePlaceholderOutcome,
} from '../update-placeholder-handler.js'

function makeDraftFn() {
  return vi.fn(async (_chatId: string, _draftId: number, _text: string): Promise<unknown> => true)
}

function preAllocMap(entries: Record<string, PreAllocatedDraftEntry> = {}): Map<string, PreAllocatedDraftEntry> {
  return new Map(Object.entries(entries))
}

describe('handleUpdatePlaceholder — happy path', () => {
  it('edits the pre-allocated draft when chatId has one', () => {
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '📚 recalling memories' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })

    expect(result).toEqual({
      kind: 'edited',
      chatId: '12345',
      draftId: 99,
      text: '📚 recalling memories',
    })

    // Confirm the underlying API call landed with the right args.
    // No await — handler returns synchronously and dispatches the
    // promise without blocking.
    expect(sendMessageDraftFn).toHaveBeenCalledTimes(1)
    expect(sendMessageDraftFn).toHaveBeenCalledWith('12345', 99, '📚 recalling memories')
  })

  it('handles the second transition in the recall.py sequence (📚 → 💭)', () => {
    // The real recall.py flow does two updates in succession:
    //   1. update_placeholder(chat, "📚 recalling memories")  [hook start]
    //   2. update_placeholder(chat, "💭 thinking")            [post-recall]
    // Both targets the same draft id. Pin both transitions land.
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })

    handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '📚 recalling memories' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })
    handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '💭 thinking' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })

    expect(sendMessageDraftFn).toHaveBeenCalledTimes(2)
    expect(sendMessageDraftFn.mock.calls[0]).toEqual(['12345', 99, '📚 recalling memories'])
    expect(sendMessageDraftFn.mock.calls[1]).toEqual(['12345', 99, '💭 thinking'])
  })

  it('isolates by chatId — only the matching draft is edited', () => {
    // Multi-chat gateway: the handler must edit ONLY the draft for
    // the chatId in the message, not every draft in the map. Pin
    // chat-isolation against an accidental "edit all drafts" bug.
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '11111': { draftId: 100, allocatedAt: 1000 },
      '22222': { draftId: 200, allocatedAt: 2000 },
      '33333': { draftId: 300, allocatedAt: 3000 },
    })

    handleUpdatePlaceholder({
      msg: { chatId: '22222', text: '💭 thinking' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })

    expect(sendMessageDraftFn).toHaveBeenCalledTimes(1)
    expect(sendMessageDraftFn).toHaveBeenCalledWith('22222', 200, '💭 thinking')
  })
})

describe('handleUpdatePlaceholder — silent skip branches', () => {
  it('skips silently when sendMessageDraftFn is null (API unavailable)', () => {
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '📚 recalling memories' },
      sendMessageDraftFn: null,
      preAllocatedDrafts,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'no-draft-api' })
  })

  it('skips silently when no pre-alloc draft exists for this chat (forum topic, race)', () => {
    // The pre-alloc decision drops forum topics (see
    // pre-alloc-decision.test.ts). When recall.py later sends an
    // update_placeholder for that chat, the handler must silently
    // skip — no spurious API call, no thrown error.
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      // chat 99999 has a draft, but the message targets chat 12345
      '99999': { draftId: 100, allocatedAt: 1000 },
    })
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '💭 thinking' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'no-draft-for-chat' })
    expect(sendMessageDraftFn).not.toHaveBeenCalled()
  })

  it('skips silently when text is empty', () => {
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'empty-text' })
    expect(sendMessageDraftFn).not.toHaveBeenCalled()
  })

  it('skips silently when text is null/undefined coerced to empty string', () => {
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: null as unknown as string },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'empty-text' })
  })
})

describe('handleUpdatePlaceholder — text length cap', () => {
  it(`caps text at ${PLACEHOLDER_TEXT_MAX_LEN} chars`, () => {
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    const longText = 'x'.repeat(PLACEHOLDER_TEXT_MAX_LEN + 100)
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: longText },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })

    if (result.kind !== 'edited') throw new Error(`expected edited, got ${result.kind}`)
    expect(result.text.length).toBe(PLACEHOLDER_TEXT_MAX_LEN)
    expect(sendMessageDraftFn).toHaveBeenCalledWith('12345', 99, 'x'.repeat(PLACEHOLDER_TEXT_MAX_LEN))
  })

  it('passes through text shorter than the cap unchanged', () => {
    const sendMessageDraftFn = makeDraftFn()
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '💭 thinking' },
      sendMessageDraftFn,
      preAllocatedDrafts,
    })
    expect(sendMessageDraftFn).toHaveBeenCalledWith('12345', 99, '💭 thinking')
  })
})

describe('handleUpdatePlaceholder — error handling', () => {
  it('reports edit-failed via onResult callback when the API throws', async () => {
    const failingDraftFn = vi.fn(async () => {
      throw new Error('Bad Request: message to edit not found')
    })
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })
    const outcomes: UpdatePlaceholderOutcome[] = []

    const result = handleUpdatePlaceholder(
      {
        msg: { chatId: '12345', text: '💭 thinking' },
        sendMessageDraftFn: failingDraftFn,
        preAllocatedDrafts,
      },
      (r) => outcomes.push(r),
    )

    // Synchronous outcome reports the intent.
    expect(result.kind).toBe('edited')

    // Drain microtasks so the .catch fires.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // onResult fired twice — once with intent, once with the
    // settled failure. Tests + gateway both rely on this shape:
    // gateway logs only on `edit-failed`.
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]!.kind).toBe('edited')
    expect(outcomes[1]!.kind).toBe('edit-failed')
    if (outcomes[1]!.kind === 'edit-failed') {
      expect(outcomes[1]!.error.message).toMatch(/message to edit not found/)
      expect(outcomes[1]!.chatId).toBe('12345')
      expect(outcomes[1]!.draftId).toBe(99)
    }
  })

  it('does NOT throw synchronously on API error (callers do not need try/catch)', () => {
    const failingDraftFn = vi.fn(async () => {
      throw new Error('Bad Request: message to edit not found')
    })
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })

    // Bare invocation must not throw — the gateway's IPC dispatch
    // loop calls this synchronously and a sync throw would crash
    // the loop.
    expect(() => handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '💭 thinking' },
      sendMessageDraftFn: failingDraftFn,
      preAllocatedDrafts,
    })).not.toThrow()
  })

  it('returns synchronously without awaiting the API call', () => {
    // Pin the fire-and-forget contract: even with an
    // infinitely-pending API call, the handler returns immediately.
    const stuckDraftFn = vi.fn(() => new Promise(() => {})) // never resolves
    const preAllocatedDrafts = preAllocMap({
      '12345': { draftId: 99, allocatedAt: 1000 },
    })

    const start = Date.now()
    const result = handleUpdatePlaceholder({
      msg: { chatId: '12345', text: '💭 thinking' },
      sendMessageDraftFn: stuckDraftFn,
      preAllocatedDrafts,
    })
    const elapsed = Date.now() - start

    expect(result.kind).toBe('edited')
    expect(elapsed).toBeLessThan(50) // would be ~∞ if we awaited
  })
})
