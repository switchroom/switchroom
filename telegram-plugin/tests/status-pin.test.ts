import { describe, it, expect } from 'vitest'
import { GrammyError } from 'grammy'
import { decidePinAction, isPinRightsError, isUnpinTerminalError, PinRightsCache } from '../status-pin.js'
import { makeFloodWaitActiveError, GIVE_UP_MESSAGE } from '../retry-api-call.js'
import { executePinLeg, type PinBotApi } from '../status-pin-driver.js'
import type { DesiredPin, PinState, PinRightsCache as _RightsCache } from '../status-pin.js'
import {
  runStatusPinReconcile,
  type StatusPinClaim,
} from '../gateway/status-pin-retarget.js'

/**
 * Drive a whole desired-state reconcile through the REAL unified path — the
 * orchestrator (`runStatusPinReconcile`, which owns the single retarget
 * expansion) composed with the driver (`executePinLeg`), exactly as gateway.ts
 * wires them. `persist: null` mirrors the STATIC / feature-off binding.
 *
 * These cases used to call `reconcilePin(prev, desired)` directly, back when the
 * driver re-decided the action itself and carried its OWN copy of the retarget
 * expansion (#3831). The driver can no longer express a retarget, so exercising
 * the same behaviours now means exercising the composition — which is what
 * production actually runs.
 */
async function reconcilePin(args: {
  api: PinBotApi
  chatId: string
  prevState: PinState | null
  desired: DesiredPin
  rightsCache?: _RightsCache
  onError?: (phase: 'pin' | 'unpin', err: unknown) => void
  onPinRightsDisabled?: (chatId: string) => void
}): Promise<PinState | null> {
  const claims = new Map<string, StatusPinClaim>()
  if (args.prevState != null) {
    claims.set('k', { messageId: args.prevState.messageId, chatId: args.chatId, pinnedAt: 1 })
  }
  await runStatusPinReconcile({
    pinKey: 'k',
    chatId: args.chatId,
    prev: args.prevState,
    desired: args.desired,
    persist: null,
    runPin: (action, from) =>
      executePinLeg({
        api: args.api,
        chatId: args.chatId,
        prevState: from,
        action,
        rightsCache: args.rightsCache,
        onError: args.onError,
        onPinRightsDisabled: args.onPinRightsDisabled,
      }),
    claims,
  })
  const claim = claims.get('k')
  return claim == null ? null : { messageId: claim.messageId }
}

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

  it('RETARGETS (unpin old + pin new) when the wanted message id changed (surface re-posted)', () => {
    // Regression: this used to report a bare `unpin`, on the assumption that a
    // later reconcile would pin the new message. Single-shot callers (the
    // foreground activity card, which reconciles only when a card OPENs) have
    // no later reconcile, so the new card was left unpinned for the rest of
    // the turn. The decision must carry BOTH message ids.
    const action = decidePinAction({ messageId: 42 }, { pinned: true, messageId: 99 })
    expect(action).toEqual({ kind: 'repin', unpinMessageId: 42, pinMessageId: 99 })
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

describe('unified reconcile path (orchestrator + driver)', () => {
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

  it('CRITICAL: drops the claim on a TERMINAL unpin failure — never stays stuck pinned', async () => {
    // A 400 means the call REACHED Telegram and was rejected for a reason that
    // cannot change on retry (message gone / rights). Dropping is correct.
    const errors: string[] = []
    const calls: { verb: string; messageId: number }[] = []
    const api: PinBotApi = {
      pinChatMessage: async () => {},
      unpinChatMessage: async (_chat, message_id) => {
        calls.push({ verb: 'unpin', messageId: message_id })
        throw grammyError(400, 'Bad Request: message to unpin not found')
      },
    }
    const next = await reconcilePin({
      api,
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: false },
      onError: (phase) => errors.push(phase),
    })
    expect(next).toBeNull()
    expect(calls).toEqual([{ verb: 'unpin', messageId: 42 }])
    expect(errors).toEqual(['unpin'])
  })

  it('#3664 Defect B: a FLOOD_WAIT_ACTIVE unpin failure RETAINS the claim (no API call was made)', async () => {
    // FLOOD_WAIT_ACTIVE is a purely LOCAL fail-fast: the send gate refused to
    // issue the call, so the message is provably STILL PINNED. Dropping the
    // claim here erased the in-memory claim AND the durable store row, leaving
    // an orphan nothing could ever find again.
    const errors: string[] = []
    const prev: PinState = { messageId: 42 }
    const next = await reconcilePin({
      api: {
        pinChatMessage: async () => {},
        unpinChatMessage: async () => {
          throw makeFloodWaitActiveError(16739, Date.now() + 16739_000, null)
        },
      },
      chatId: '123',
      prevState: prev,
      desired: { pinned: false },
      onError: (phase) => errors.push(phase),
    })
    // The claim SURVIVES so the next reconcile / reaper / boot sweep retries.
    expect(next).toEqual({ messageId: 42 })
    expect(errors).toEqual(['unpin'])
  })

  it('#3664 Defect B: retains the claim on a never-confirmed transport failure (retries exhausted / network / 5xx)', async () => {
    for (const err of [
      new Error(GIVE_UP_MESSAGE),
      new Error('fetch failed'),
      grammyError(500, 'Internal Server Error'),
    ]) {
      const next = await reconcilePin({
        api: {
          pinChatMessage: async () => {},
          unpinChatMessage: async () => {
            throw err
          },
        },
        chatId: '123',
        prevState: { messageId: 42 },
        desired: { pinned: false },
      })
      expect(next).toEqual({ messageId: 42 })
    }
  })

  it('#3664 Defect B: a retained claim retries the unpin and clears once it lands', async () => {
    let attempts = 0
    const api: PinBotApi = {
      pinChatMessage: async () => {},
      unpinChatMessage: async () => {
        attempts += 1
        if (attempts === 1) throw makeFloodWaitActiveError(300, Date.now() + 300_000, null)
      },
    }
    const common = { api, chatId: '123', desired: { pinned: false } as const }

    const first = await reconcilePin({ ...common, prevState: { messageId: 42 } })
    expect(first).toEqual({ messageId: 42 }) // retained

    const second = await reconcilePin({ ...common, prevState: first })
    expect(second).toBeNull() // flood window closed; unpin landed; claim cleared
    expect(attempts).toBe(2)
  })

  // ── Retarget (`repin`) — the single-shot-caller leak ──────────────────────
  // The foreground activity card reconciles its `fg:` pin EXACTLY ONCE, when a
  // card OPENs (narrative-lane.ts; the edit branch never touches the pin). When
  // the ack-first reopen path (feed-reopen-gate.ts) nulls `activityMessageId`
  // and a FRESH card opens mid-turn, that single reconcile must leave the NEW
  // card pinned. Previously it emitted only an unpin and the turn ran on with
  // nothing pinned.
  it('RETARGET: one reconcile unpins the stale message AND pins the new one', async () => {
    const { api, calls } = fakeApi()
    const next = await reconcilePin({
      api,
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: true, messageId: 99 },
    })
    expect(next).toEqual({ messageId: 99 })
    expect(calls.map((c) => [c.verb, c.messageId])).toEqual([
      ['unpin', 42],
      ['pin', 99],
    ])
    // The new pin must still be silent.
    expect((calls[1].opts as Record<string, unknown>).disable_notification).toBe(true)
  })

  it('RETARGET: a TERMINAL unpin failure still pins the new message', async () => {
    // "message to unpin not found" means the old surface is already gone — the
    // retarget must complete, not abort.
    const calls: { verb: string; messageId: number }[] = []
    const next = await reconcilePin({
      api: {
        pinChatMessage: async (_c, message_id) => {
          calls.push({ verb: 'pin', messageId: message_id })
        },
        unpinChatMessage: async (_c, message_id) => {
          calls.push({ verb: 'unpin', messageId: message_id })
          throw grammyError(400, 'Bad Request: message to unpin not found')
        },
      },
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: true, messageId: 99 },
    })
    expect(next).toEqual({ messageId: 99 })
    expect(calls).toEqual([
      { verb: 'unpin', messageId: 42 },
      { verb: 'pin', messageId: 99 },
    ])
  })

  it('RETARGET: a NEVER-CONFIRMED unpin retains the OLD claim and does NOT pin the new one', async () => {
    // The old message is provably still pinned (#3664 Defect B). Pinning the
    // new one now would leave two pins in the chat with a durable record of
    // only one — the exact orphan class the retain rule exists to prevent.
    const calls: { verb: string; messageId: number }[] = []
    const next = await reconcilePin({
      api: {
        pinChatMessage: async (_c, message_id) => {
          calls.push({ verb: 'pin', messageId: message_id })
        },
        unpinChatMessage: async (_c, message_id) => {
          calls.push({ verb: 'unpin', messageId: message_id })
          throw makeFloodWaitActiveError(300, Date.now() + 300_000, null)
        },
      },
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: true, messageId: 99 },
    })
    expect(next).toEqual({ messageId: 42 })
    expect(calls).toEqual([{ verb: 'unpin', messageId: 42 }])
  })

  it('RETARGET: a failed pin leg drops the claim (nothing is pinned, nothing is tracked)', async () => {
    const calls: { verb: string; messageId: number }[] = []
    const next = await reconcilePin({
      api: {
        pinChatMessage: async (_c, message_id) => {
          calls.push({ verb: 'pin', messageId: message_id })
          throw new Error('fetch failed')
        },
        unpinChatMessage: async (_c, message_id) => {
          calls.push({ verb: 'unpin', messageId: message_id })
        },
      },
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: true, messageId: 99 },
    })
    // prevState for the pin leg is null (the unpin landed), so a failed pin
    // returns null — no phantom claim on a message we never pinned.
    expect(next).toBeNull()
    expect(calls).toEqual([
      { verb: 'unpin', messageId: 42 },
      { verb: 'pin', messageId: 99 },
    ])
  })

  it('RETARGET: a pin-rights-blocked chat makes NO API calls and drops the claim', async () => {
    const calls: string[] = []
    const cache = new PinRightsCache()
    cache.block('123')
    const next = await reconcilePin({
      api: {
        pinChatMessage: async () => {
          calls.push('pin')
        },
        unpinChatMessage: async () => {
          calls.push('unpin')
        },
      },
      chatId: '123',
      prevState: { messageId: 42 },
      desired: { pinned: true, messageId: 99 },
      rightsCache: cache,
    })
    expect(calls).toEqual([])
    // unpin leg returns null (claim dropped, nothing worth tracking); the pin
    // leg is skipped from a null prev and returns null too.
    expect(next).toBeNull()
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
describe('unified reconcile path — pin-rights 400 must never crash (marko 2026-07-01)', () => {
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
      chatId: '-1001234567890',
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
        chatId: '-1001234567890',
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

// ── #3024: rights-aware negative cache ─────────────────────────────────────
// marko logged 41 identical `pinChatMessage` "not enough rights" rejections in
// 48h — one per auto status-pin attempt in a group where the bot isn't a pin
// admin. The permanent-rights class is now cached per-chat so the SECOND and
// later attempts skip the API call entirely and stop spamming the log. Synthetic
// chat IDs only (the real ones in the issue are operator PII).
describe('isPinRightsError (pure classifier)', () => {
  it('matches the permanent pin-rights 400 (grammy .description)', () => {
    expect(
      isPinRightsError(
        grammyError(400, 'Bad Request: not enough rights to manage pinned messages in the chat'),
      ),
    ).toBe(true)
  })

  it('matches a plain Error carrying the rights text', () => {
    expect(isPinRightsError(new Error('not enough rights to manage pinned messages'))).toBe(true)
  })

  it('does NOT match transient classes (429 flood-wait, network)', () => {
    expect(isPinRightsError(grammyError(429, 'Too Many Requests: retry after 5'))).toBe(false)
    expect(isPinRightsError(new Error('fetch failed'))).toBe(false)
    expect(isPinRightsError(grammyError(400, 'Bad Request: message to edit not found'))).toBe(false)
  })
})

describe('PinRightsCache (pure)', () => {
  it('block() returns true only the first time a chat is added (log-once)', () => {
    const cache = new PinRightsCache()
    expect(cache.isBlocked('-1009000000001')).toBe(false)
    expect(cache.block('-1009000000001')).toBe(true)
    expect(cache.block('-1009000000001')).toBe(false)
    expect(cache.isBlocked('-1009000000001')).toBe(true)
  })

  it('clear() forgets a chat (rights re-granted)', () => {
    const cache = new PinRightsCache()
    cache.block('-1009000000001')
    expect(cache.clear('-1009000000001')).toBe(true)
    expect(cache.isBlocked('-1009000000001')).toBe(false)
    expect(cache.clear('-1009000000001')).toBe(false)
  })
})

/** A fake Bot API counting pin calls, throwing a chosen error on pin. */
function countingApi(pinError?: unknown) {
  let pinCalls = 0
  let unpinCalls = 0
  const api: PinBotApi = {
    pinChatMessage: async () => {
      pinCalls += 1
      if (pinError) throw pinError
    },
    unpinChatMessage: async () => {
      unpinCalls += 1
    },
  }
  return {
    api,
    get pinCalls() {
      return pinCalls
    },
    get unpinCalls() {
      return unpinCalls
    },
  }
}

describe('unified reconcile path — rights-aware negative cache (#3024)', () => {
  const rightsErr = () =>
    grammyError(400, 'Bad Request: not enough rights to manage pinned messages in the chat')

  it('first rights failure: attempts once, logs once, records the chat', async () => {
    const cache = new PinRightsCache()
    const disabled: string[] = []
    const pinFails: string[] = []
    const t = countingApi(rightsErr())

    const next = await reconcilePin({
      api: t.api,
      chatId: '-1009000000001',
      prevState: null,
      desired: { pinned: true, messageId: 4 },
      rightsCache: cache,
      onPinRightsDisabled: (chat) => disabled.push(chat),
      onError: (phase) => pinFails.push(phase),
    })

    expect(t.pinCalls).toBe(1) // it did try
    expect(next).toBeNull() // no claim taken
    expect(disabled).toEqual(['-1009000000001']) // logged once
    expect(pinFails).toEqual([]) // NOT routed through the per-attempt onError
    expect(cache.isBlocked('-1009000000001')).toBe(true)
  })

  it('second attempt in the same chat makes NO api call and logs nothing', async () => {
    const cache = new PinRightsCache()
    const disabled: string[] = []
    const pinFails: string[] = []
    const t = countingApi(rightsErr())

    const common = {
      chatId: '-1009000000001',
      prevState: null,
      desired: { pinned: true, messageId: 4 } as const,
      rightsCache: cache,
      onPinRightsDisabled: (chat: string) => disabled.push(chat),
      onError: (phase: 'pin' | 'unpin') => pinFails.push(phase),
    }

    await reconcilePin({ api: t.api, ...common })
    await reconcilePin({ api: t.api, ...common })

    expect(t.pinCalls).toBe(1) // second attempt short-circuited before the API
    expect(disabled).toEqual(['-1009000000001']) // still logged exactly once
    expect(pinFails).toEqual([])
  })

  it('a DIFFERENT chat is unaffected by another chat being blocked', async () => {
    const cache = new PinRightsCache()
    cache.block('-1009000000001')
    const t = countingApi() // pin succeeds here

    const next = await reconcilePin({
      api: t.api,
      chatId: '-1009000000002',
      prevState: null,
      desired: { pinned: true, messageId: 7 },
      rightsCache: cache,
      onPinRightsDisabled: () => {
        throw new Error('should not disable a healthy chat')
      },
    })

    expect(t.pinCalls).toBe(1)
    expect(next).toEqual({ messageId: 7 })
    expect(cache.isBlocked('-1009000000002')).toBe(false)
  })

  it('a 429 (transient) does NOT enter the cache — retry behaviour preserved', async () => {
    const cache = new PinRightsCache()
    const disabled: string[] = []
    const pinFails: string[] = []
    const t = countingApi(grammyError(429, 'Too Many Requests: retry after 5'))

    await reconcilePin({
      api: t.api,
      chatId: '-1009000000003',
      prevState: null,
      desired: { pinned: true, messageId: 9 },
      rightsCache: cache,
      onPinRightsDisabled: (chat) => disabled.push(chat),
      onError: (phase) => pinFails.push(phase),
    })

    expect(cache.isBlocked('-1009000000003')).toBe(false) // NOT cached
    expect(disabled).toEqual([]) // no rights-disable log
    expect(pinFails).toEqual(['pin']) // routed through onError → normal retry path

    // A follow-up attempt still hits the API (no negative cache in the way).
    await reconcilePin({
      api: t.api,
      chatId: '-1009000000003',
      prevState: null,
      desired: { pinned: true, messageId: 9 },
      rightsCache: cache,
      onError: (phase) => pinFails.push(phase),
    })
    expect(t.pinCalls).toBe(2)
  })

  it('a later successful pin clears a previously-blocked chat', async () => {
    const cache = new PinRightsCache()
    cache.block('-1009000000004')
    const t = countingApi() // succeeds

    // While blocked, the pin is skipped (no claim, no API call).
    const skipped = await reconcilePin({
      api: t.api,
      chatId: '-1009000000004',
      prevState: null,
      desired: { pinned: true, messageId: 3 },
      rightsCache: cache,
    })
    expect(skipped).toBeNull()
    expect(t.pinCalls).toBe(0)

    // Simulate rights granted: unblock, then a pin succeeds and stays clear.
    cache.clear('-1009000000004')
    const next = await reconcilePin({
      api: t.api,
      chatId: '-1009000000004',
      prevState: null,
      desired: { pinned: true, messageId: 3 },
      rightsCache: cache,
    })
    expect(next).toEqual({ messageId: 3 })
    expect(cache.isBlocked('-1009000000004')).toBe(false)
  })

  it('UNPIN rights-failure (rights revoked mid-session) blocks the chat, logs once, second unpin makes no API call', async () => {
    const cache = new PinRightsCache()
    const disabled: string[] = []
    const unpinFails: string[] = []
    let unpinCalls = 0
    const api: PinBotApi = {
      pinChatMessage: async () => {},
      unpinChatMessage: async () => {
        unpinCalls += 1
        throw rightsErr()
      },
    }
    const common = {
      api,
      chatId: '-1009000000007',
      desired: { pinned: false } as const,
      rightsCache: cache,
      onPinRightsDisabled: (chat: string) => disabled.push(chat),
      onError: (phase: 'pin' | 'unpin') => unpinFails.push(phase),
    }

    const first = await reconcilePin({ ...common, prevState: { messageId: 21 } })
    expect(first).toBeNull() // rights 400 is TERMINAL — claim dropped (#3664)
    expect(unpinCalls).toBe(1) // it did try once
    expect(disabled).toEqual(['-1009000000007']) // logged exactly once
    expect(unpinFails).toEqual([]) // NOT routed through per-attempt onError
    expect(cache.isBlocked('-1009000000007')).toBe(true)

    const second = await reconcilePin({ ...common, prevState: { messageId: 22 } })
    expect(second).toBeNull() // claim still dropped
    expect(unpinCalls).toBe(1) // second attempt short-circuited before the API
    expect(disabled).toEqual(['-1009000000007']) // no second log
  })

  it('a blocked chat skips the UNPIN api call too (drops the claim silently)', async () => {
    const cache = new PinRightsCache()
    cache.block('-1009000000005')
    const t = countingApi()

    const next = await reconcilePin({
      api: t.api,
      chatId: '-1009000000005',
      prevState: { messageId: 12 },
      desired: { pinned: false },
      rightsCache: cache,
    })

    expect(next).toBeNull() // claim dropped
    expect(t.unpinCalls).toBe(0) // but no wasted API call
  })

  it('fire-and-forget with the cache leaks NO unhandledRejection', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      const cache = new PinRightsCache()
      const t = countingApi(rightsErr())
      void reconcilePin({
        api: t.api,
        chatId: '-1009000000006',
        prevState: null,
        desired: { pinned: true, messageId: 4 },
        rightsCache: cache,
        onPinRightsDisabled: () => {},
      })
      await new Promise((r) => setTimeout(r, 20))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('isUnpinTerminalError (#3664 Defect B classifier)', () => {
  it('treats a stable 4xx as terminal — Telegram answered, retrying cannot help', () => {
    expect(isUnpinTerminalError(grammyError(400, 'Bad Request: message to unpin not found'))).toBe(true)
    expect(isUnpinTerminalError(grammyError(400, 'Bad Request: chat not found'))).toBe(true)
    expect(isUnpinTerminalError(grammyError(403, 'Forbidden: bot was kicked'))).toBe(true)
    expect(
      isUnpinTerminalError(
        grammyError(400, 'Bad Request: not enough rights to manage pinned messages in the chat'),
      ),
    ).toBe(true)
  })

  it('treats FLOOD_WAIT_ACTIVE as NON-terminal even though it carries the 429 duck-type shape', () => {
    const err = makeFloodWaitActiveError(16739, Date.now() + 16739_000, null)
    expect(err.error_code).toBe(429) // the shape other cooldown gates duck-type on
    expect(isUnpinTerminalError(err)).toBe(false)
  })

  it('treats transport failures as NON-terminal (the unpin may never have landed)', () => {
    expect(isUnpinTerminalError(new Error(GIVE_UP_MESSAGE))).toBe(false)
    expect(isUnpinTerminalError(new Error('fetch failed'))).toBe(false)
    expect(isUnpinTerminalError(grammyError(500, 'Internal Server Error'))).toBe(false)
    expect(isUnpinTerminalError(grammyError(429, 'Too Many Requests'))).toBe(false)
    expect(isUnpinTerminalError(undefined)).toBe(false)
    expect(isUnpinTerminalError('boom')).toBe(false)
  })
})
