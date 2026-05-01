import { describe, expect, it } from 'vitest'

import {
  decideShouldPreAlloc,
  PRE_ALLOC_PLACEHOLDER_TEXT,
} from '../pre-alloc-decision.js'

/**
 * Pins the pre-allocate-draft decision contract that drives the
 * `🔵 thinking` placeholder UX. The gateway-side wrapper at
 * gateway.ts (search for `decideShouldPreAlloc`) adds the actual
 * `sendMessageDraft` call; this file pins the decision, the
 * placeholder text, and (most importantly) the post-#479 behaviour
 * that group chats now get the placeholder too.
 */
describe('decideShouldPreAlloc', () => {
  describe('allocate path', () => {
    it('allocates for a private DM (positive chat id)', () => {
      // The original (pre-#479) shape — DM, no thread, draft API up,
      // no prior draft. Pinned here to make sure the post-#479
      // refactor didn't accidentally break the original case.
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: null,
        alreadyHasDraft: false,
      })).toEqual({ allocate: true })
    })

    it('allocates for a group chat (the #479 fix)', () => {
      // The whole point of #479: groups should get the placeholder
      // too. Pre-fix this returned false because of an
      // `isDmChatId(chat_id)` gate that lived in the gateway. The
      // gate is gone; now the only chat-shape gate is the forum
      // topic guard below. The chat id itself doesn't enter the
      // decision at all.
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: null,
        alreadyHasDraft: false,
      })).toEqual({ allocate: true })
    })

    it('allocates regardless of chat-id sign — the helper is chat-id-agnostic', () => {
      // Belt-and-braces: prove the decision doesn't sniff chat id at
      // all. If a future PR re-adds an `isDmChatId(chat_id)` gate
      // here it'll need a new input field, breaking this test.
      // (The chat id isn't even passed in.)
      const result = decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: null,
        alreadyHasDraft: false,
      })
      expect(result.allocate).toBe(true)
    })
  })

  describe('drop branches', () => {
    it('drops when sendMessageDraft API is unavailable', () => {
      // The boot probe at gateway.ts can find sendMessageDraft is
      // missing on some grammy/Bot API combinations. In that case
      // pre-alloc is a no-op — the user gets the legacy "no
      // placeholder" UX rather than a crash.
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: false,
        messageThreadId: null,
        alreadyHasDraft: false,
      })).toEqual({ allocate: false, reason: 'no-draft-api' })
    })

    it('drops for forum topics — sendMessageDraft does not accept message_thread_id', () => {
      // Forum topics are the standard switchroom layout — but
      // sendMessageDraft (the API) doesn't accept
      // message_thread_id, so a draft sent into a forum-topic
      // thread would land in the wrong place (the General topic of
      // the supergroup). Until a thread-aware fallback path lands,
      // we skip and the user falls back to typing-indicator-only.
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: 42,
        alreadyHasDraft: false,
      })).toEqual({ allocate: false, reason: 'forum-topic' })
    })

    it('drops for forum topics with string message_thread_id (some grammy variants pass strings)', () => {
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: '42',
        alreadyHasDraft: false,
      })).toEqual({ allocate: false, reason: 'forum-topic' })
    })

    it('treats empty-string messageThreadId as "no thread" (not forum topic)', () => {
      // Defensive: some upstream paths normalise undefined → ""
      // rather than null. Treat empty as "no thread set".
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: '',
        alreadyHasDraft: false,
      })).toEqual({ allocate: true })
    })

    it('drops when a draft is already pre-allocated for this chat (avoid leaking ids)', () => {
      // The gateway's pre-allocated map carries an entry until the
      // draft is consumed (by reply/stream_reply) or cleared (by
      // turn_end). Re-allocating before that would orphan the prior
      // draft. The decision returns a recognisable reason so the
      // gateway log can be specific.
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: null,
        alreadyHasDraft: true,
      })).toEqual({ allocate: false, reason: 'already-allocated' })
    })
  })

  describe('drop ordering (cascade)', () => {
    it('no-draft-api wins over forum-topic', () => {
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: false,
        messageThreadId: 42,
        alreadyHasDraft: false,
      })).toEqual({ allocate: false, reason: 'no-draft-api' })
    })

    it('forum-topic wins over already-allocated', () => {
      expect(decideShouldPreAlloc({
        sendMessageDraftAvailable: true,
        messageThreadId: 42,
        alreadyHasDraft: true,
      })).toEqual({ allocate: false, reason: 'forum-topic' })
    })
  })
})

describe('PRE_ALLOC_PLACEHOLDER_TEXT', () => {
  it('is the meaningful "🔵 thinking" string (not bare ellipsis)', () => {
    // Pre-#469 the placeholder was `…` — three dots that read as
    // "still loading the message" instead of "agent is working".
    // The post-#469 placeholder text is meaningful prose with the
    // 🔵 emoji as a "I'm working" signal.
    expect(PRE_ALLOC_PLACEHOLDER_TEXT).toBe('🔵 thinking')
  })

  it('does NOT have a trailing ellipsis (PR #496)', () => {
    // The draft transport renders an animated "typing" indicator on
    // the user's Telegram client for the lifetime of the draft. With
    // the animation already signalling "in progress," a `…` after
    // the word stacks redundant visual noise. PR #496 dropped the
    // trailing ellipsis from all three placeholder strings:
    //   - 🔵 thinking            (gateway pre-alloc)
    //   - 📚 recalling memories  (recall.py hook start)
    //   - 💭 thinking            (recall.py post-recall)
    // This pin guards the regression. If a future PR re-adds a `…`
    // to the gateway placeholder, the test fails loudly.
    expect(PRE_ALLOC_PLACEHOLDER_TEXT.endsWith('…')).toBe(false)
    expect(PRE_ALLOC_PLACEHOLDER_TEXT.endsWith('...')).toBe(false)
  })

  it('starts with the 🔵 emoji (the visual cue users have learned)', () => {
    expect(PRE_ALLOC_PLACEHOLDER_TEXT.startsWith('🔵')).toBe(true)
  })
})
