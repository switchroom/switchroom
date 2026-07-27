/**
 * Outcome pins for the `message:pinned_message` service-message cleanup handler
 * extracted from gateway.ts (switchroom#2996 P6 cluster F). Asserts the
 * chat-scoped ownership guard (only OUR pins get their service message
 * deleted), the reconcile-store race retry, and best-effort logging on a
 * delete failure — against an injected claim registry + a mock deleteServiceMessage.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handlePinnedMessage,
  type PinnedMessageHandlerDeps,
} from '../gateway/pinned-message-handler.js'
import type { StatusPinClaim } from '../gateway/status-pin-retarget.js'

/** One claim, the single record the gateway now keeps per pin key (#3809). */
function claim(messageId: number, chatId: string): StatusPinClaim {
  return { messageId, chatId, pinnedAt: 1000 }
}

function makeDeps(over: Partial<PinnedMessageHandlerDeps> = {}) {
  const deleteServiceMessage = vi.fn(async () => {})
  const log = vi.fn()
  const deps: PinnedMessageHandlerDeps = {
    statusPinClaims: new Map(),
    deleteServiceMessage,
    log,
    ...over,
  }
  return { deps, deleteServiceMessage, log }
}

function ctxWith(chatId: number, pinnedMessageId: number | undefined, serviceMsgId = 999): any {
  return {
    msg: {
      message_id: serviceMsgId,
      pinned_message: pinnedMessageId == null ? undefined : { message_id: pinnedMessageId },
    },
    chat: { id: chatId },
  }
}

describe('handlePinnedMessage — ownership guard', () => {
  it('deletes the service message when the pin is ours in this chat', async () => {
    const { deps, deleteServiceMessage } = makeDeps({
      statusPinClaims: new Map([['fg:a', claim(555, '42')]]),
    })
    await handlePinnedMessage(ctxWith(42, 555, 999), deps)
    expect(deleteServiceMessage).toHaveBeenCalledWith('42', 999)
  })

  it('does NOT delete when the pinned id matches but the tracked chat differs', async () => {
    const { deps, deleteServiceMessage } = makeDeps({
      // tracked in a DIFFERENT chat
      statusPinClaims: new Map([['fg:a', claim(555, '99')]]),
    })
    await handlePinnedMessage(ctxWith(42, 555, 999), deps)
    expect(deleteServiceMessage).not.toHaveBeenCalled()
  })

  it('does nothing when there is no pinned_message id', async () => {
    const { deps, deleteServiceMessage } = makeDeps()
    await handlePinnedMessage(ctxWith(42, undefined), deps)
    expect(deleteServiceMessage).not.toHaveBeenCalled()
  })

  it('does not delete an untracked (operator-manual) pin', async () => {
    const { deps, deleteServiceMessage } = makeDeps()
    await handlePinnedMessage(ctxWith(42, 555, 999), deps)
    expect(deleteServiceMessage).not.toHaveBeenCalled()
  })
})

describe('handlePinnedMessage — reconcile-store race', () => {
  it('re-checks ownership once after the store catches up', async () => {
    // REAL timers on purpose: this suite also runs under `bun test`, whose
    // vitest shim does not support vi.useFakeTimers — fake timers here left
    // the global clock mocked and hung the NEXT test file in CI (the exact
    // #3354 bun-test failure). The handler waits 250ms before its single
    // re-check; populate the store inside that window and await the real
    // delay.
    const claims = new Map<string, StatusPinClaim>()
    const { deps, deleteServiceMessage } = makeDeps({
      statusPinClaims: claims,
    })
    const p = handlePinnedMessage(ctxWith(42, 555, 999), deps)
    // Store catches up during the 250ms race window.
    claims.set('fg:a', claim(555, '42'))
    await p
    expect(deleteServiceMessage).toHaveBeenCalledWith('42', 999)
  })
})

describe('handlePinnedMessage — best-effort delete failure', () => {
  it('logs a concise reason when the delete throws', async () => {
    const { deps, log } = makeDeps({
      statusPinClaims: new Map([['fg:a', claim(555, '42')]]),
      deleteServiceMessage: vi.fn(async () => {
        throw new Error('not enough rights')
      }),
    })
    await handlePinnedMessage(ctxWith(42, 555, 999), deps)
    expect(log).toHaveBeenCalledTimes(1)
    const line = log.mock.calls[0][0] as string
    expect(line).toContain('could not delete pin service message')
    expect(line).toContain('not enough rights')
  })
})
