/**
 * Unit tests for forum-topic-placeholder.ts (issue #479).
 *
 * The forum-topic placeholder is the substitute for sendMessageDraft
 * (which can't target message_thread_id). We send a regular message
 * with thread_id on inbound, track it, then delete on turn_end.
 *
 * These tests focus on the lifecycle contract: send + track, dedupe
 * within a (chat, thread), clear by deleting and dropping the entry,
 * and graceful degradation when the API errors.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  sendForumTopicPlaceholder,
  clearForumTopicPlaceholder,
  forumTopicPlaceholderKey,
  getForumTopicPlaceholderState,
  _resetForumTopicPlaceholdersForTest,
  type ForumTopicPlaceholderApi,
} from '../forum-topic-placeholder.js'

beforeEach(() => {
  _resetForumTopicPlaceholdersForTest()
})

function makeApi(opts: {
  sendShouldThrow?: boolean
  deleteShouldThrow?: boolean
} = {}): { api: ForumTopicPlaceholderApi; calls: { sent: unknown[]; deleted: unknown[] } } {
  const calls = { sent: [] as unknown[], deleted: [] as unknown[] }
  let nextMessageId = 100
  const api: ForumTopicPlaceholderApi = {
    sendMessage: async (chatId, text, msgOpts) => {
      calls.sent.push({ chatId, text, msgOpts })
      if (opts.sendShouldThrow) throw new Error('boom')
      return { message_id: nextMessageId++ }
    },
    deleteMessage: async (chatId, messageId) => {
      calls.deleted.push({ chatId, messageId })
      if (opts.deleteShouldThrow) throw new Error('boom')
      return undefined
    },
  }
  return { api, calls }
}

describe('forumTopicPlaceholderKey', () => {
  it('namespaces (chat, thread) so different topics in the same chat are independent', () => {
    const k1 = forumTopicPlaceholderKey('chat-A', 1)
    const k2 = forumTopicPlaceholderKey('chat-A', 2)
    const k3 = forumTopicPlaceholderKey('chat-B', 1)
    expect(k1).not.toBe(k2)
    expect(k1).not.toBe(k3)
    expect(k2).not.toBe(k3)
  })

  it('handles numeric and string ids consistently', () => {
    expect(forumTopicPlaceholderKey(123, 456)).toBe('123::456')
    expect(forumTopicPlaceholderKey('123', '456')).toBe('123::456')
  })
})

describe('sendForumTopicPlaceholder', () => {
  it('sends with message_thread_id and tracks the resulting messageId', async () => {
    const { api, calls } = makeApi()
    const mid = await sendForumTopicPlaceholder(api, 'chat-1', 42)
    expect(mid).toBe(100)
    expect(calls.sent).toHaveLength(1)
    expect(calls.sent[0]).toEqual({
      chatId: 'chat-1',
      text: '🔵 thinking',
      msgOpts: { message_thread_id: 42 },
    })
    const state = getForumTopicPlaceholderState()
    expect(state.size).toBe(1)
    expect(state.get(forumTopicPlaceholderKey('chat-1', 42))?.messageId).toBe(100)
  })

  it('returns null and skips a second send for the same (chat, thread)', async () => {
    const { api, calls } = makeApi()
    const first = await sendForumTopicPlaceholder(api, 'chat-1', 42)
    expect(first).toBe(100)
    const second = await sendForumTopicPlaceholder(api, 'chat-1', 42)
    expect(second).toBeNull()
    expect(calls.sent).toHaveLength(1)
  })

  it('allows independent placeholders in different topics of the same chat', async () => {
    const { api } = makeApi()
    await sendForumTopicPlaceholder(api, 'chat-1', 1)
    await sendForumTopicPlaceholder(api, 'chat-1', 2)
    const state = getForumTopicPlaceholderState()
    expect(state.size).toBe(2)
  })

  it('returns null and tracks nothing when the API throws (best-effort)', async () => {
    const { api } = makeApi({ sendShouldThrow: true })
    const mid = await sendForumTopicPlaceholder(api, 'chat-1', 42)
    expect(mid).toBeNull()
    expect(getForumTopicPlaceholderState().size).toBe(0)
  })

  it('respects a custom placeholderText override', async () => {
    const { api, calls } = makeApi()
    await sendForumTopicPlaceholder(api, 'c', 1, { placeholderText: '⏳ working' })
    expect((calls.sent[0] as { text: string }).text).toBe('⏳ working')
  })
})

describe('clearForumTopicPlaceholder', () => {
  it('deletes the tracked message and drops the map entry', async () => {
    const { api, calls } = makeApi()
    await sendForumTopicPlaceholder(api, 'chat-1', 42)
    expect(getForumTopicPlaceholderState().size).toBe(1)
    await clearForumTopicPlaceholder(api, 'chat-1', 42)
    expect(calls.deleted).toEqual([{ chatId: 'chat-1', messageId: 100 }])
    expect(getForumTopicPlaceholderState().size).toBe(0)
  })

  it('is a no-op when no placeholder is tracked for the (chat, thread)', async () => {
    const { api, calls } = makeApi()
    await clearForumTopicPlaceholder(api, 'chat-untracked', 99)
    expect(calls.deleted).toHaveLength(0)
  })

  it('drops the map entry even when deleteMessage throws', async () => {
    // Network flakes happen — the map must self-heal so a stuck entry
    // doesn't block the next inbound's placeholder dedupe forever.
    const { api } = makeApi({ deleteShouldThrow: true })
    await sendForumTopicPlaceholder(api, 'chat-1', 42)
    await clearForumTopicPlaceholder(api, 'chat-1', 42)
    expect(getForumTopicPlaceholderState().size).toBe(0)
  })

  it('only clears the targeted (chat, thread) — sibling topics in the same chat are untouched', async () => {
    const { api } = makeApi()
    await sendForumTopicPlaceholder(api, 'chat-1', 1)
    await sendForumTopicPlaceholder(api, 'chat-1', 2)
    await clearForumTopicPlaceholder(api, 'chat-1', 1)
    const state = getForumTopicPlaceholderState()
    expect(state.size).toBe(1)
    expect(state.has(forumTopicPlaceholderKey('chat-1', 2))).toBe(true)
  })
})
