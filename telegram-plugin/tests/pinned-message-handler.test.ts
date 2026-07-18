/**
 * Outcome pins for the `message:pinned_message` service-message cleanup handler
 * extracted from gateway.ts (switchroom#2996 P6 cluster F). Asserts the
 * chat-scoped ownership guard (only OUR pins get their service message
 * deleted), the reconcile-store race retry, and best-effort logging on a
 * delete failure — against injected pin-state maps + a mock deleteServiceMessage.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handlePinnedMessage,
  type PinnedMessageHandlerDeps,
} from '../gateway/pinned-message-handler.js'

function makeDeps(over: Partial<PinnedMessageHandlerDeps> = {}) {
  const deleteServiceMessage = vi.fn(async () => {})
  const log = vi.fn()
  const deps: PinnedMessageHandlerDeps = {
    statusPinState: new Map(),
    statusPinChatIds: new Map(),
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
      statusPinState: new Map([['fg:a', { messageId: 555 }]]),
      statusPinChatIds: new Map([['fg:a', '42']]),
    })
    await handlePinnedMessage(ctxWith(42, 555, 999), deps)
    expect(deleteServiceMessage).toHaveBeenCalledWith('42', 999)
  })

  it('does NOT delete when the pinned id matches but the tracked chat differs', async () => {
    const { deps, deleteServiceMessage } = makeDeps({
      statusPinState: new Map([['fg:a', { messageId: 555 }]]),
      statusPinChatIds: new Map([['fg:a', '99']]), // tracked in a DIFFERENT chat
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
    vi.useFakeTimers()
    const state = new Map<string, { messageId: number }>()
    const chatIds = new Map<string, string>()
    const { deps, deleteServiceMessage } = makeDeps({
      statusPinState: state,
      statusPinChatIds: chatIds,
    })
    const p = handlePinnedMessage(ctxWith(42, 555, 999), deps)
    // Store catches up during the 250ms race window.
    state.set('fg:a', { messageId: 555 })
    chatIds.set('fg:a', '42')
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(deleteServiceMessage).toHaveBeenCalledWith('42', 999)
    vi.useRealTimers()
  })
})

describe('handlePinnedMessage — best-effort delete failure', () => {
  it('logs a concise reason when the delete throws', async () => {
    const { deps, log } = makeDeps({
      statusPinState: new Map([['fg:a', { messageId: 555 }]]),
      statusPinChatIds: new Map([['fg:a', '42']]),
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
