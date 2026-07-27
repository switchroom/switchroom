/**
 * status-pin-api — the two invariants the extracted pin API enforces (#3664).
 *
 * Both are about the same failure shape: the pin state machine reads "the call
 * did not throw" as "the pin/unpin LANDED". Anything that resolves
 * success-shaped without reaching Telegram therefore corrupts pin state — a
 * claimed-but-never-painted pin, or (worse, Defect B's shape) a dropped claim
 * plus a deleted durable row for a message that is still pinned.
 *
 * The assertions below are OUTCOMES read off `executePinLeg`'s returned state
 * (does the gateway still hold a record of the pinned message?), not "was some
 * function called".
 */
import { describe, it, expect } from 'vitest'
import {
  createStatusPinApi,
  assertLanded,
  BotNotReadyError,
  SendGateShedError,
  type PinCapableBot,
} from '../gateway/status-pin-api.js'
import { SEND_GATE_SHED } from '../send-gate.js'
import { executePinLeg } from '../status-pin-driver.js'

/** A bot whose API always succeeds — so any failure below comes from the gate
 *  seam, never from Telegram. */
const liveBot = (): PinCapableBot => ({
  api: {
    pinChatMessage: async () => true,
    unpinChatMessage: async () => true,
  },
})

/** `robustApiCall` stand-in that behaves as the send gate does on a SHED:
 *  it RESOLVES the sentinel instead of throwing (send-gate.ts:140). */
const shedRobust = async () => SEND_GATE_SHED as unknown

describe('assertLanded — a shed send must not look like a landed one (#3664)', () => {
  it('a shed unpin does NOT drop the claim — the message is still pinned', async () => {
    const api = createStatusPinApi(liveBot, shedRobust)
    const next = await executePinLeg({
      api,
      chatId: '-100123',
      prevState: { messageId: 715 },
      action: { kind: 'unpin', messageId: 715 },
      onError: () => {},
    })
    // Without assertLanded the shed resolves success-shaped, executePinLeg
    // returns null, and reconcileAndPersistStatusPin then DELETES the durable
    // row for a message that is provably still pinned — Defect B, reopened.
    expect(next).toEqual({ messageId: 715 })
  })

  it('a shed pin does not claim the message', async () => {
    const api = createStatusPinApi(liveBot, shedRobust)
    const next = await executePinLeg({
      api,
      chatId: '-100123',
      prevState: null,
      action: { kind: 'pin', messageId: 715 },
      onError: () => {},
    })
    // Claiming it would leave the gateway believing a pin exists that never
    // painted, and `decidePinAction` would return `noop` forever.
    expect(next).toBeNull()
  })

  it('a landed call is passed through untouched', async () => {
    const seen: unknown[] = []
    const api = createStatusPinApi(liveBot, async (fn) => {
      const r = await fn()
      seen.push(r)
      return r
    })
    await expect(api.unpinChatMessage('-100123', 715)).resolves.toBe(true)
    expect(seen).toEqual([true])
  })

  it('does NOT treat a benign undefined as a shed', async () => {
    // The gate resolves `undefined` for a no-op drop and the retry policy for a
    // swallowed benign 400. Conflating either with a shed is the ambiguity
    // SEND_GATE_SHED exists to remove — and would make every benign unpin
    // retain a claim forever.
    const api = createStatusPinApi(liveBot, async () => undefined)
    await expect(api.unpinChatMessage('-100123', 715)).resolves.toBeUndefined()

    const next = await executePinLeg({
      api,
      chatId: '-100123',
      prevState: { messageId: 715 },
      action: { kind: 'unpin', messageId: 715 },
      onError: () => {},
    })
    expect(next).toBeNull()
  })

  it('throws a named SendGateShedError, and only on the sentinel', () => {
    expect(() => assertLanded(SEND_GATE_SHED, 'status-pin.unpin')).toThrow(SendGateShedError)
    expect(() => assertLanded(SEND_GATE_SHED, 'status-pin.unpin')).toThrow('STATUS_PIN_SEND_SHED')
    expect(assertLanded(undefined, 'status-pin.unpin')).toBeUndefined()
    expect(assertLanded(null, 'status-pin.unpin')).toBeNull()
    expect(assertLanded(false, 'status-pin.unpin')).toBe(false)
    expect(assertLanded(Symbol('other'), 'status-pin.unpin')).toBeTypeOf('symbol')
  })
})

describe('assertBotReady — named backstop for a pre-ready caller (#3664)', () => {
  const passthrough = async (fn: () => Promise<unknown>) => fn()

  it('throws STATUS_PIN_BOT_NOT_READY instead of dereferencing undefined', async () => {
    const api = createStatusPinApi(() => undefined, passthrough)
    // The month-long symptom was `undefined is not an object (evaluating
    // 'lockedBot.api')`, which read like a Telegram fault.
    await expect(api.unpinChatMessage('-100123', 715)).rejects.toThrow(BotNotReadyError)
    await expect(api.pinChatMessage('-100123', 715)).rejects.toThrow(
      /STATUS_PIN_BOT_NOT_READY: status-pin\.pin/,
    )
  })

  it('reads the bot LAZILY, so a late assignment works', async () => {
    let bot: PinCapableBot | undefined
    const api = createStatusPinApi(() => bot, passthrough)
    await expect(api.unpinChatMessage('-100123', 715)).rejects.toThrow(BotNotReadyError)
    bot = liveBot()
    await expect(api.unpinChatMessage('-100123', 715)).resolves.toBe(true)
  })

  it('a pre-ready unpin failure RETAINS the claim (it never reached Telegram)', async () => {
    const api = createStatusPinApi(() => undefined, passthrough)
    const next = await executePinLeg({
      api,
      chatId: '-100123',
      prevState: { messageId: 715 },
      action: { kind: 'unpin', messageId: 715 },
      onError: () => {},
    })
    expect(next).toEqual({ messageId: 715 })
  })
})

describe('createStatusPinApi — call shape is preserved by the extraction', () => {
  it('tags each call with the chat id and verb the retry policy expects', async () => {
    const opts: Record<string, unknown>[] = []
    const api = createStatusPinApi(liveBot, async (fn, o) => {
      opts.push(o)
      return fn()
    })
    await api.pinChatMessage(-100123, 715, { disable_notification: true })
    await api.unpinChatMessage(-100123, 715)
    expect(opts).toEqual([
      { chat_id: '-100123', verb: 'status-pin.pin' },
      { chat_id: '-100123', verb: 'status-pin.unpin' },
    ])
  })

  it('forwards the pin opts through to the Bot API', async () => {
    const calls: unknown[][] = []
    const bot: PinCapableBot = {
      api: {
        pinChatMessage: async (...args) => {
          calls.push(args)
          return true
        },
        unpinChatMessage: async (...args) => {
          calls.push(args)
          return true
        },
      },
    }
    const api = createStatusPinApi(() => bot, async (fn) => fn())
    await api.pinChatMessage('-100123', 715, { disable_notification: true })
    await api.unpinChatMessage('-100123', 715)
    expect(calls).toEqual([
      ['-100123', 715, { disable_notification: true }],
      ['-100123', 715],
    ])
  })
})
