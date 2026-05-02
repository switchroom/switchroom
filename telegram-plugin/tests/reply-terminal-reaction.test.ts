/**
 * PR #602 follow-up — plain `reply` tool must fire the terminal 👍
 * reaction on real delivery (post-sendMessage), mirroring Bug Z's
 * stream_reply contract.
 *
 * Background. Bug D removed the premature `setDone()` call from the
 * gateway's turn-flush dedup-suppress branch (it was firing 👍 off a
 * 500ms-lagged read of local history rather than from a real Telegram
 * delivery confirmation). Bug Z then wired stream_reply's
 * post-finalize callback to fire `endStatusReaction('done')` on
 * delivery.
 *
 * That left a regression: turns whose only outbound came through the
 * plain `reply` tool (not `stream_reply`) had no remaining 👍 emitter
 * — the dedup branch's setDone was the only thing firing for that
 * path, and removing it meant reply-only turns silently lost their
 * terminal reaction.
 *
 * The follow-up wires `executeReply` to call
 * `endStatusReaction(chat_id, threadId, 'done')` after at least one
 * `bot.api.sendMessage` resolves successfully (i.e. `sentIds.length
 * > 0`). The reply tool has no lane concept (unlike stream_reply, where
 * named lanes like 'progress'/'thinking' are internal driver emits),
 * so no lane gate is needed — every reply is by definition the
 * user-visible answer.
 *
 * The gateway IIFE / executeReply body are too entangled to import
 * directly. Following the same pattern as
 * `turn-flush-dedup-controller.test.ts`, we model the contract as a
 * pure function below and pin the post-fix invariant. If executeReply
 * is ever refactored to extract this branch, the same assertions
 * apply unchanged.
 */
import { describe, it, expect, vi } from 'vitest'

interface ReplyTerminalDeps {
  endStatusReaction: (chatId: string, threadId: number | undefined, outcome: 'done' | 'error') => void
  writeError: (line: string) => void
}

/**
 * Extract of the gateway executeReply post-send block. Mirrors the
 * code at `telegram-plugin/gateway/gateway.ts` (post-fix, in the
 * `if (sentIds.length > 0) { ... }` block after the send loop).
 *
 * Returns true if the terminal 👍 was fired.
 */
function applyReplyTerminalReaction(
  chatId: string,
  threadId: number | undefined,
  sentIdsLength: number,
  deps: ReplyTerminalDeps,
): boolean {
  if (sentIdsLength <= 0) return false
  try {
    deps.endStatusReaction(chatId, threadId, 'done')
    return true
  } catch (err) {
    deps.writeError(`telegram gateway: reply: endStatusReaction hook threw: ${err}\n`)
    return false
  }
}

describe('PR #602 follow-up — plain reply tool terminal 👍', () => {
  it('fires endStatusReaction("done") after at least one chunk lands', () => {
    const endStatusReaction = vi.fn()
    const writeError = vi.fn()

    const fired = applyReplyTerminalReaction('-100', 42, 1, {
      endStatusReaction,
      writeError,
    })

    expect(fired).toBe(true)
    expect(endStatusReaction).toHaveBeenCalledTimes(1)
    expect(endStatusReaction).toHaveBeenCalledWith('-100', 42, 'done')
    expect(writeError).not.toHaveBeenCalled()
  })

  it('passes threadId=undefined through unchanged for non-forum chats', () => {
    // Plain DMs and non-forum supergroups don't carry a thread id —
    // the controller key is `chatId:_`, not `chatId:<thread>`. Pin
    // that the wiring forwards undefined rather than coercing to 0.
    const endStatusReaction = vi.fn()
    const writeError = vi.fn()

    applyReplyTerminalReaction('123', undefined, 3, {
      endStatusReaction,
      writeError,
    })

    expect(endStatusReaction).toHaveBeenCalledWith('123', undefined, 'done')
  })

  it('does NOT fire when sentIds is empty (zero successful sends)', () => {
    // The send loop's catch arm rethrows on persistent failure; we
    // never reach the post-send block in that case. But pin the
    // gating invariant: sentIds.length > 0 is the necessary
    // precondition. A reply that fails before any chunk lands must
    // not claim delivery.
    const endStatusReaction = vi.fn()
    const writeError = vi.fn()

    const fired = applyReplyTerminalReaction('-200', undefined, 0, {
      endStatusReaction,
      writeError,
    })

    expect(fired).toBe(false)
    expect(endStatusReaction).not.toHaveBeenCalled()
  })

  it('swallows endStatusReaction throws and surfaces them via writeError', () => {
    // Defence-in-depth: the controller lookup may race a concurrent
    // purge. The reply path must not surface a status-reaction
    // bookkeeping failure to the agent — the message itself already
    // landed. Pin that the throw is logged, not propagated.
    const endStatusReaction = vi.fn(() => {
      throw new Error('controller missing')
    })
    const writeError = vi.fn()

    const fired = applyReplyTerminalReaction('-300', undefined, 1, {
      endStatusReaction,
      writeError,
    })

    expect(fired).toBe(false)
    expect(endStatusReaction).toHaveBeenCalledTimes(1)
    expect(writeError).toHaveBeenCalledTimes(1)
    expect(writeError.mock.calls[0][0]).toMatch(/endStatusReaction hook threw/)
  })

  it('fires for multi-chunk replies as well as single-chunk', () => {
    // Long replies are split across multiple sendMessage calls. As
    // long as at least one chunk landed, the user saw the answer —
    // the terminal 👍 reflects "delivered", not "delivered in one
    // piece".
    const endStatusReaction = vi.fn()
    const writeError = vi.fn()

    applyReplyTerminalReaction('-400', 7, 5, {
      endStatusReaction,
      writeError,
    })

    expect(endStatusReaction).toHaveBeenCalledWith('-400', 7, 'done')
  })
})
