import { describe, it, expect } from 'vitest'
import { GrammyError } from 'grammy'
import { decidePinAction } from '../status-pin.js'
import { reconcilePin, type PinBotApi } from '../status-pin-driver.js'
import type { PinState } from '../status-pin.js'

/** A real GrammyError with the given code + description, mirroring the wire
 *  shape Telegram returns for the pin-rights failure that crashed marko. */
function grammyError(error_code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to 'pinChatMessage' failed!`,
    { ok: false, error_code, description },
    'pinChatMessage',
    {} as never,
  )
}

describe('decidePinAction (pure)', () => {
  it('pins an existing message when work goes in-flight (nothing pinned yet)', () => {
    const action = decidePinAction(null, { pinned: true, messageId: 42 })
    expect(action).toEqual({ kind: 'pin', messageId: 42 })
  })

  it('unpins when work completes (something pinned)', () => {
    const action = decidePinAction({ messageId: 42 }, { pinned: false })
    expect(action).toEqual({ kind: 'unpin', messageId: 42 })
  })

  it('noops when nothing is pinned and nothing is wanted', () => {
    const action = decidePinAction(null, { pinned: false })
    expect(action.kind).toBe('noop')
  })

  it('noops when the wanted message is already pinned', () => {
    const action = decidePinAction({ messageId: 42 }, { pinned: true, messageId: 42 })
    expect(action.kind).toBe('noop')
  })

  it('unpins the stale claim when the wanted message id changed (feed re-posted)', () => {
    const action = decidePinAction({ messageId: 42 }, { pinned: true, messageId: 99 })
    expect(action).toEqual({ kind: 'unpin', messageId: 42 })
  })
})

/** A fake Bot API recording calls, with per-method throw toggles. */
function fakeApi(opts: { pinThrows?: boolean; unpinThrows?: boolean } = {}) {
  const calls: { verb: string; messageId: number; opts?: unknown }[] = []
  const api: PinBotApi = {
    pinChatMessage: async (_chat, message_id, o) => {
      calls.push({ verb: 'pin', messageId: message_id, opts: o })
      if (opts.pinThrows) throw new Error('pin failed')
    },
    unpinChatMessage: async (_chat, message_id) => {
      calls.push({ verb: 'unpin', messageId: message_id })
      if (opts.unpinThrows) throw new Error('unpin failed')
    },
  }
  return { api, calls }
}

describe('reconcilePin (driver)', () => {
  it('pin on in-progress: pins the EXISTING message SILENTLY and claims it', async () => {
    const { api, calls } = fakeApi()
    const next = await reconcilePin({
      api,
      chatId: '123',
      prevState: null,
      desired: { pinned: true, messageId: 42 },
    })
    expect(next).toEqual({ messageId: 42 })
    expect(calls).toHaveLength(1)
    expect(calls[0].verb).toBe('pin')
    expect(calls[0].messageId).toBe(42)
    // Silent — must never buzz the device.
    expect((calls[0].opts as Record<string, unknown>).disable_notification).toBe(true)
  })

  it('unpin on finalize: unpins and drops the claim', async () => {
    const { api, calls } = fakeApi()
    const prev: PinState = { messageId: 42 }
    const next = await reconcilePin({
      api,
      chatId: '123',
      prevState: prev,
      desired: { pinned: false },
    })
    expect(next).toBeNull()
    expect(calls).toEqual([{ verb: 'unpin', messageId: 42 }])
  })

  it('CRITICAL: drops the claim even when unpinChatMessage throws', async () => {
    const errors: string[] = []
    const { api, calls } = fakeApi({ unpinThrows: true })
    const next = await reconcilePin({
      api,
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: false },
      onError: (phase) => errors.push(phase),
    })
    // State MUST be cleared even though the API threw — never stay stuck pinned.
    expect(next).toBeNull()
    expect(calls).toEqual([{ verb: 'unpin', messageId: 42 }])
    expect(errors).toEqual(['unpin'])
  })

  it('does NOT claim a message whose pin failed (retries next reconcile)', async () => {
    const errors: string[] = []
    const { api } = fakeApi({ pinThrows: true })
    const next = await reconcilePin({
      api,
      chatId: '123',
      prevState: null,
      desired: { pinned: true, messageId: 42 },
      onError: (phase) => errors.push(phase),
    })
    // No claim taken — prevState (null) is returned so the next reconcile retries.
    expect(next).toBeNull()
    expect(errors).toEqual(['pin'])
  })

  it('never sends a new message — only pin/unpin the existing id', async () => {
    // The fake has no sendMessage; a driver that tried to send would throw.
    const { api } = fakeApi()
    await reconcilePin({ api, chatId: '1', prevState: null, desired: { pinned: true, messageId: 7 } })
    await reconcilePin({ api, chatId: '1', prevState: { messageId: 7 }, desired: { pinned: false } })
    expect(Object.keys(api)).toEqual(['pinChatMessage', 'unpinChatMessage'])
  })
})

// ── Regression: the marko 2026-07-01 gateway crash ─────────────────────────
// A pinChatMessage 400 "not enough rights to manage pinned messages" (the bot
// is not an admin in a supergroup) escaped as an unhandledRejection and shut
// the whole gateway down. Auto status-pin is best-effort/cosmetic — a
// pin-rights failure must be absorbed, never fatal, and never reach the
// process-level unhandledRejection handler.
describe('reconcilePin — pin-rights 400 must never crash (marko 2026-07-01)', () => {
  it('absorbs the "not enough rights" 400 via onError and never rejects', async () => {
    const rightsErr = grammyError(
      400,
      'Bad Request: not enough rights to manage pinned messages in the chat',
    )
    const captured: { phase: string; code?: number }[] = []
    const api: PinBotApi = {
      pinChatMessage: async () => {
        throw rightsErr
      },
      unpinChatMessage: async () => {},
    }

    // reconcilePin resolves (never rejects) even when the pin API throws a
    // real GrammyError — this is the contract the fire-and-forget
    // `void reconcileStatusPin(...)` callsites depend on to not leak a
    // rejection to the process.
    const next = await reconcilePin({
      api,
      chatId: '-1003831053471',
      prevState: null,
      desired: { pinned: true, messageId: 4 },
      onError: (phase, err) =>
        captured.push({
          phase,
          code: err instanceof GrammyError ? err.error_code : undefined,
        }),
    })

    // No claim taken (pin failed), error routed through onError, promise
    // resolved cleanly.
    expect(next).toBeNull()
    expect(captured).toEqual([{ phase: 'pin', code: 400 }])
  })

  it('a fire-and-forget reconcilePin does NOT emit an unhandledRejection', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      const api: PinBotApi = {
        pinChatMessage: async () => {
          throw grammyError(
            400,
            'Bad Request: not enough rights to manage pinned messages in the chat',
          )
        },
        unpinChatMessage: async () => {},
      }
      // Fire-and-forget, exactly as the gateway's auto-pin callsites do.
      void reconcilePin({
        api,
        chatId: '-1003831053471',
        prevState: null,
        desired: { pinned: true, messageId: 4 },
        onError: () => {},
      })
      // Let microtasks + a macrotask flush so any leaked rejection would fire.
      await new Promise((r) => setTimeout(r, 20))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
