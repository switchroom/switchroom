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
