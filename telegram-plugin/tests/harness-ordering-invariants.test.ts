/**
 * Harness ordering invariants — table-driven scenarios.
 *
 * These tests assert cross-cutting properties that hold across a range
 * of turn shapes (Class A/B/C, retry, replay-dup, error-cascade). The
 * scenarios are deterministic and named, not random — see
 * HARNESS_UPGRADE_PLAN.md "scenario fuzzer" decision (skeptic finding 7:
 * property-based fuzzing without shrinking is worse than no fuzzing).
 *
 * Each invariant carries a `// fails when:` comment indicating the
 * production change that would break it. The test author should mentally
 * `git stash` that change and confirm the test fails — see plan
 * "Validation rule for each new test."
 *
 * Invariants:
 *
 *   INV-1 — Terminal reaction (👍) fires AT-OR-AFTER the last user-
 *           visible answer text. NEVER before. The Bug D/Z contract
 *           generalized to all turn shapes.
 *
 *   INV-2 — Exactly one terminal reaction fires per logical turn
 *           (regardless of how many tool emoji ladder steps occurred
 *           in between). Catches a future regression where setDone
 *           fires twice.
 *
 *   INV-3 — Editing a deleted message always errors. Catches a
 *           regression in the fake's delete-vs-edit ordering, which
 *           would let a buggy production module silently miss the
 *           "edit-to-deleted-message" failure mode in tests.
 *
 *   INV-4 — Outbound dedup window holds for the full TTL once the
 *           cache is wired in.
 *
 *   INV-5 — Hold-and-release ordering: an event fired while a
 *           sendMessage/editMessageText is parked at `holdNext`
 *           observes the world as it was BEFORE the held call landed.
 *           This pins the harness's own contract — necessary for
 *           future Bug-D-class tests to be expressible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'
import { createFakeBotApi } from './fake-bot-api.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

interface TurnShape {
  name: string
  /** Drive the harness through one logical turn. Resolves when turn ended. */
  drive: (h: ReturnType<typeof createRealGatewayHarness>) => Promise<void>
}

const turnShapes: TurnShape[] = [
  {
    name: 'class-A reply (sub-2s, no tools)',
    drive: async (h) => {
      h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hi' })
      h.feedSessionEvent({
        kind: 'enqueue',
        chatId: CHAT,
        messageId: '1',
        threadId: null,
        rawContent: 'hi',
      })
      await h.clock.advance(20)
      await h.streamReply({ chat_id: CHAT, text: 'Hello back!', done: true })
      await h.clock.advance(20)
    },
  },
  {
    name: 'class-B with-tools (1 tool, ~3s)',
    drive: async (h) => {
      h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'work' })
      h.feedSessionEvent({
        kind: 'enqueue',
        chatId: CHAT,
        messageId: '1',
        threadId: null,
        rawContent: 'work',
      })
      await h.clock.advance(50)
      h.feedSessionEvent({ kind: 'thinking' })
      await h.clock.advance(500)
      h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read' })
      await h.clock.advance(2500)
      await h.streamReply({ chat_id: CHAT, text: 'Here is the answer.', done: true })
      await h.clock.advance(20)
    },
  },
  {
    name: 'class-C subagent (long, ~10s, sub-agent emit)',
    drive: async (h) => {
      h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'big task' })
      h.feedSessionEvent({
        kind: 'enqueue',
        chatId: CHAT,
        messageId: '1',
        threadId: null,
        rawContent: 'big task',
      })
      await h.clock.advance(50)
      h.feedSessionEvent({ kind: 'thinking' })
      await h.clock.advance(500)
      h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read' })
      await h.clock.advance(2000)
      h.feedSessionEvent({ kind: 'tool_use', toolName: 'Grep' })
      await h.clock.advance(2000)
      h.feedSessionEvent({ kind: 'tool_use', toolName: 'Edit' })
      await h.clock.advance(5000)
      await h.streamReply({ chat_id: CHAT, text: 'Done — see the diff above.', done: true })
      await h.clock.advance(20)
    },
  },
]

describe('INV-1 — terminal reaction fires AT-OR-AFTER last delivery (Bug D/Z generalized)', () => {
  for (const shape of turnShapes) {
    it(`${shape.name}: lastReactionEmojiAt >= lastAnswerTextDeliveredAt`, async () => {
      // fails when: a future refactor moves setDone() from the streamReply
      // post-await branch back to the JSONL turn_end handler — exactly
      // Bug D's failure mode, generalized over turn shapes.
      const h = createRealGatewayHarness({ gapMs: 0 })
      await shape.drive(h)
      const deliveredAt = h.lastAnswerTextDeliveredAt(CHAT)
      const reactionAt = h.lastReactionEmojiAt(CHAT)
      expect(deliveredAt, `no answer text delivered for ${shape.name}`).not.toBeNull()
      expect(reactionAt, `no reaction emitted for ${shape.name}`).not.toBeNull()
      expect(reactionAt!).toBeGreaterThanOrEqual(deliveredAt!)
      h.finalize()
    })
  }
})

describe('INV-2 — terminal 👍 fires exactly once per turn (Bug Z generalized)', () => {
  for (const shape of turnShapes) {
    it(`${shape.name}: 👍 appears exactly once across the full reaction sequence`, async () => {
      // fails when: a future change fires setDone() more than once
      // for the same turn (e.g. both the streamReply post-await branch
      // AND the turn_end JSONL handler call it). Specifically asserting
      // the COUNT of 👍 in the full sequence — not just "the last
      // emoji is unique" (which would be a tautology).
      const h = createRealGatewayHarness({ gapMs: 0 })
      await shape.drive(h)
      const seq = h.recorder.reactionSequence()
      expect(seq.length, `no reactions for ${shape.name}`).toBeGreaterThan(0)
      const thumbsUpCount = seq.filter((e) => e === '👍').length
      expect(thumbsUpCount).toBe(1)
      // And the 👍 is the LAST reaction — terminal contract.
      expect(seq[seq.length - 1]).toBe('👍')
      h.finalize()
    })
  }
})

describe('INV-3 — editing a deleted message always errors', () => {
  it('fake throws messageToEditNotFound after the message is deleted', async () => {
    // fails when: someone changes fake-bot-api's editMessageText to
    // silently succeed for deleted messages — production modules
    // would then look correct in tests but error in real Telegram.
    const bot = createFakeBotApi()
    const r = (await bot.api.sendMessage('c1', 'long enough text content here ok', {})) as {
      message_id: number
    }
    await bot.api.deleteMessage('c1', r.message_id)
    await expect(
      bot.api.editMessageText('c1', r.message_id, 'updated text content here ok', {}),
    ).rejects.toMatchObject({ error_code: 400 })
  })
})

describe('INV-4 — outbound dedup window holds for the full TTL', () => {
  // Span of "now" offsets within the TTL that should all be deduped.
  const inWindowOffsets = [0, 1000, 30_000, 59_000]
  // Span outside the TTL that should NOT be deduped.
  const outOfWindowOffsets = [60_001, 120_000]

  for (const ms of inWindowOffsets) {
    it(`same content at +${ms}ms is suppressed (within TTL=60s)`, async () => {
      // fails when: TTL is silently shortened, or the cache's eviction
      // sweep evicts entries before their TTL expires.
      const h = createRealGatewayHarness({ gapMs: 0, withDedup: true })
      const text = 'A long enough message to clear the 24-char dedup floor by a wide margin.'
      await h.send({ chat_id: CHAT, text })
      await h.clock.advance(ms)
      const id2 = await h.send({ chat_id: CHAT, text })
      expect(id2).toBeNull()
      h.finalize()
    })
  }

  for (const ms of outOfWindowOffsets) {
    it(`same content at +${ms}ms is allowed (outside TTL)`, async () => {
      // fails when: TTL eviction breaks (entries linger past their TTL).
      const h = createRealGatewayHarness({ gapMs: 0, withDedup: true })
      const text = 'A long enough message to clear the 24-char dedup floor by a wide margin.'
      await h.send({ chat_id: CHAT, text })
      await h.clock.advance(ms)
      const id2 = await h.send({ chat_id: CHAT, text })
      expect(id2).not.toBeNull()
      h.finalize()
    })
  }
})

describe('INV-5 — holdNext: events fired during a held call observe pre-held state', () => {
  it('a setMessageReaction parked at holdNext lets unrelated state mutate before its release', async () => {
    // fails when: a future fake-bot refactor makes holdNext block
    // mutations on OTHER methods, or makes release() synchronous when
    // it should be async.
    //
    // This is the foundational seam that makes Bug-D-class tests
    // expressible: "while editMessageText is pending, fire the 👍" —
    // the harness must let the 👍 land while the edit is parked.
    const bot = createFakeBotApi()
    const r = (await bot.api.sendMessage('c1', 'long enough text content here ok', {})) as {
      message_id: number
    }
    const hold = bot.holdNext('editMessageText', 'c1')
    // Start the edit; it parks at the gate.
    const editPromise = bot.api.editMessageText('c1', r.message_id, 'edited content here ok', {})
    // Yield a microtask so the held call enters its await.
    await Promise.resolve()
    expect(hold.triggered()).toBe(true)
    // Fire something else — setMessageReaction — and confirm it lands
    // independently while the edit is still parked.
    await bot.api.setMessageReaction('c1', r.message_id, [{ type: 'emoji', emoji: '👍' }])
    expect(bot.state.reactions.length).toBe(1)
    // The edit's text hasn't landed yet — the message is still original.
    expect(bot.textOf(r.message_id)).toBe('long enough text content here ok')
    // Release the edit — now the text updates.
    hold.release()
    await editPromise
    expect(bot.textOf(r.message_id)).toBe('edited content here ok')
  })
})
