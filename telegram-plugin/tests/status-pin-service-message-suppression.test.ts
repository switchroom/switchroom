/**
 * Structural test for the `bot.on('message:pinned_message')` handler that
 * suppresses the "pinned a message" service message Telegram inserts when
 * OUR silent status-pin fires.
 *
 * Why structural: like every other gateway handler, this closure is wired
 * inline against the live `bot` instance and is not exported — a functional
 * invocation would require booting the full grammy runtime against a mocked
 * Bot API. The gateway suite settled on file-level grep assertions for
 * exactly this reason (see `inbound-message-types.test.ts`). The regression
 * we care about: a future hand dropping the handler, dropping the ownership
 * guard (which would let us delete manual/operator pins), or swapping the
 * house deletion wrapper for a raw `bot.api.deleteMessage` (allowlist drift).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  pinnedMessageIsOurs,
  type TrackedStatusPin,
} from '../gateway/status-pin-store.js'

const SRC = readFileSync(
  new URL('../gateway/gateway.ts', import.meta.url),
  'utf8',
)

/**
 * Extract the body of the `bot.on('message:pinned_message', …)` handler:
 * from the `bot.on(` line to the matching outer-scope closing brace.
 */
function pinnedMessageHandler(): string {
  const needle = `bot.on('message:pinned_message'`
  const start = SRC.indexOf(needle)
  expect(start, `handler ${needle} not found`).toBeGreaterThan(0)
  const firstBrace = SRC.indexOf('{', start)
  let depth = 0
  for (let i = firstBrace; i < SRC.length; i++) {
    const c = SRC[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error('could not find end of pinned_message handler')
}

describe('status-pin service-message suppression', () => {
  it("registers a bot.on('message:pinned_message') handler", () => {
    expect(SRC).toContain(`bot.on('message:pinned_message'`)
  })

  const body = pinnedMessageHandler()

  it('guards on ownership via the chat-scoped pinnedMessageIsOurs helper', () => {
    // Must consult our tracked pins — never blindly delete a pin service
    // message (which would nuke manual/operator pins too) — AND it must be
    // chat-scoped (pinnedMessageIsOurs requires chatId + messageId), never a
    // messageId-only match.
    expect(body).toContain('statusPinState')
    expect(body).toMatch(/pinned_message\?\.message_id/)
    expect(body).toContain('pinnedMessageIsOurs(')
    // The chatId computed from the update must be fed to the guard.
    expect(body).toMatch(/pinnedMessageIsOurs\(trackedPins\(\), chatId, pinnedId\)/)
    // And the tracked entries must carry their chat association.
    expect(body).toContain('statusPinChatIds.get(pinKey)')
  })

  it('bails out when the pinned message is not one of ours', () => {
    // A `return` guard for the non-owned case must exist.
    expect(body).toMatch(/if \(!isOurs\(\)\) return/)
  })

  it('deletes the service message through the robust wrapper (not a raw api call)', () => {
    expect(body).toContain('robustApiCall(')
    expect(body).toContain('deleteMessage')
    // The message deleted is the service message itself, not the pinned msg.
    expect(body).toContain('serviceMsgId')
    // House verb tag so operators can trace it.
    expect(body).toContain("verb: 'status-pin.delete-service-message'")
  })

  it('tolerates the reconcile-store race with a short retry', () => {
    // The service update can arrive before reconcileStatusPin stores the
    // PinState; a single delayed re-check covers that window.
    expect(body).toContain('setTimeout')
  })
})

/**
 * BEHAVIORAL coverage of the ownership decision (BUG 1). The handler decides
 * whether to delete a `pinned_message` service message by calling the real
 * `pinnedMessageIsOurs(tracked, chatId, pinnedId)`. This models the exact
 * gateway decision and asserts the delete fires ONLY for a same-chat match —
 * the structural grep above would pass even with the messageId-only bug live.
 */
describe('service-message deletion decision (chat-scoped)', () => {
  // Two tracked status pins in DIFFERENT chats. Chat A's pin id (715) collides
  // with an incoming pin update in chat B.
  const tracked: TrackedStatusPin[] = [
    { chatId: '-100AAA', messageId: 715 },
    { chatId: '-100BBB', messageId: 42 },
  ]

  // Mirror the handler: delete iff pinnedMessageIsOurs(...) is true.
  const wouldDelete = (chatId: string, pinnedId: number) =>
    pinnedMessageIsOurs(tracked, chatId, pinnedId)

  it('does NOT delete chat B service message when its pin id collides with chat A', () => {
    // Chat B, pinned id 715 → belongs to chat A, not B. Must NOT delete
    // (this is the operator-manual-pin-notice safety case).
    expect(wouldDelete('-100BBB', 715)).toBe(false)
  })

  it('DOES delete on a genuine same-chat match', () => {
    expect(wouldDelete('-100AAA', 715)).toBe(true)
    expect(wouldDelete('-100BBB', 42)).toBe(true)
  })

  it('does NOT delete a foreign pin id in a tracked chat', () => {
    expect(wouldDelete('-100AAA', 9999)).toBe(false)
  })
})

/**
 * SUPERGROUP / forum-topic coverage. The handler reads only ctx.chat.id +
 * ctx.msg.message_id and deletes by (chat_id, message_id) — topic-agnostic,
 * with no private-chat assumption. In a forum supergroup the pinned status
 * message carries a message_thread_id, but:
 *   - deletion needs no thread arg (chat_id + message_id is sufficient), and
 *   - message_id is unique per chat even across topics, so a single chat-scoped
 *     match is correct regardless of which topic the pin lives in.
 * These tests model a pinned_message update whose chat is a supergroup (and a
 * forum variant carrying message_thread_id) and assert the same chat-scoped
 * decision holds.
 */
describe('service-message deletion in supergroups / forum topics', () => {
  // A status pin tracked in a supergroup chat, plus a collision partner in a
  // different supergroup.
  const tracked: TrackedStatusPin[] = [
    { chatId: '-1001111', messageId: 500 }, // supergroup A
    { chatId: '-1002222', messageId: 500 }, // supergroup B, SAME id as A
  ]

  // Model the handler's identity extraction from a grammy-shaped update. The
  // thread id is present on forum updates but deliberately NOT part of the
  // ownership/delete identity.
  type PinnedUpdate = {
    chat: { id: number; type: 'private' | 'supergroup' }
    message_id: number
    message_thread_id?: number
    pinned_message: { message_id: number }
  }
  const wouldDelete = (u: PinnedUpdate) =>
    pinnedMessageIsOurs(tracked, String(u.chat.id), u.pinned_message.message_id)

  it('deletes on a genuine same-chat match in a plain supergroup', () => {
    const update: PinnedUpdate = {
      chat: { id: -1001111, type: 'supergroup' },
      message_id: 9001, // the service message
      pinned_message: { message_id: 500 },
    }
    expect(wouldDelete(update)).toBe(true)
  })

  it('deletes on a same-chat match in a FORUM topic (message_thread_id set)', () => {
    const update: PinnedUpdate = {
      chat: { id: -1001111, type: 'supergroup' },
      message_id: 9002,
      message_thread_id: 77, // forum topic — irrelevant to the delete identity
      pinned_message: { message_id: 500 },
    }
    expect(wouldDelete(update)).toBe(true)
  })

  it('does NOT delete when the id collides across two supergroups', () => {
    // Supergroup B receives a pin update for id 500, which also happens to be
    // supergroup A's tracked status-pin id. Chat-scoped guard keeps them apart.
    const update: PinnedUpdate = {
      chat: { id: -1002222, type: 'supergroup' },
      message_id: 9003,
      message_thread_id: 12,
      pinned_message: { message_id: 500 },
    }
    // 500 IS tracked for chat -1002222 too in this fixture, so this is a
    // genuine match — assert the positive, then flip to a true cross-chat miss.
    expect(wouldDelete(update)).toBe(true)

    // A supergroup NOT in the tracked set, colliding on id 500 → must NOT fire.
    const foreign: PinnedUpdate = {
      chat: { id: -1009999, type: 'supergroup' },
      message_id: 9004,
      message_thread_id: 5,
      pinned_message: { message_id: 500 },
    }
    expect(wouldDelete(foreign)).toBe(false)
  })

  it('the handler logs a missing-admin-right hint on delete failure (supergroup)', () => {
    // Structural: the catch block names the likely supergroup cause so an
    // operator isn't left with silent nothing.
    const src = readFileSync(
      new URL('../gateway/gateway.ts', import.meta.url),
      'utf8',
    )
    expect(src).toContain('could not delete pin service message')
    expect(src).toContain('missing can_delete_messages')
  })
})
