/**
 * Regression: switchroom #3502 — the durable-outbox safety net dropped the 🔊
 * Listen button from a net-delivered final answer.
 *
 * PR #3502 / commit 1a531ebb added the outbox-sweep deliverer, which sent the
 * captured final answer via a RAW `bot.api.sendMessage` with no voice-out
 * resolution — so any answer the net delivered lost the Listen button that the
 * normal `sendReply` path injects. The fix threads a shared `planListenButton`
 * decision into the sweep's chunked send (`createOutboxSend`) so a net-delivered
 * answer is indistinguishable from a normally-delivered one.
 *
 * These tests assert OUTCOMES, not code paths:
 *  - the delivered message actually carries the Listen keyboard when kokoro
 *    on-demand voice-out is enabled;
 *  - it does NOT when the agent supplied its own keyboard, when the TTS text is
 *    empty, or when voice-out is not kokoro-on-demand.
 * A test that only walked the code without asserting `reply_markup` on the sent
 * message would not fail on the pre-fix RAW-send bug, so we assert the exact
 * bytes handed to `sendMessage`.
 */

import { describe, it, expect } from 'vitest'
import { createOutboxSend } from '../gateway/outbox-sweep.js'
import { makeOutboxListenMarkupResolver } from '../gateway/outbox-listen-markup.js'
import {
  planListenButton,
  type ListenButtonVoiceOutPlan,
} from '../voice-ondemand.js'

const kokoroOnDemand: ListenButtonVoiceOutPlan = {
  engine: 'kokoro',
  speed: 1.1,
  replyMode: 'on-demand',
  ttsChunks: ['the spoken answer'],
}

// A passthrough retry that simply invokes the send fn once (no flood/thread
// fallback needed for the unit under test).
const passthroughRetry = <U>(fn: () => Promise<U>): Promise<U> => fn()

function fakeBot() {
  const calls: Array<{ chatId: string; text: string; opts: Record<string, unknown> }> = []
  let n = 100
  return {
    calls,
    api: {
      sendMessage: async (chatId: string, text: string, opts: object) => {
        calls.push({ chatId, text, opts: opts as Record<string, unknown> })
        return { message_id: n++ }
      },
    },
  }
}

describe('planListenButton — shared Listen-button decision', () => {
  it('injects for kokoro on-demand with non-empty TTS and no agent keyboard', () => {
    const plan = planListenButton({ voiceOutPlan: kokoroOnDemand, rawKeyboard: undefined })
    expect(plan).not.toBeNull()
    expect(plan!.replyMarkup.inline_keyboard[0]![0]!.text).toBe('🔊 Listen')
    expect(plan!.replyMarkup.inline_keyboard[0]![0]!.callback_data).toBe(`voice:${plan!.token}`)
    expect(plan!.payload.text).toBe('the spoken answer')
    expect(plan!.payload.speed).toBe(1.1)
  })

  it('does NOT inject when the agent supplied its own keyboard (collision gate)', () => {
    const plan = planListenButton({
      voiceOutPlan: kokoroOnDemand,
      rawKeyboard: [[{ text: 'Approve', callback_data: 'ok' }]],
    })
    expect(plan).toBeNull()
  })

  it('does NOT inject when the TTS text is empty (empty-TTS guard)', () => {
    const plan = planListenButton({
      voiceOutPlan: { ...kokoroOnDemand, ttsChunks: [''] },
      rawKeyboard: undefined,
    })
    expect(plan).toBeNull()
  })

  it('does NOT inject for openai on-demand (taps would dead-end on local sidecar)', () => {
    const plan = planListenButton({
      voiceOutPlan: { ...kokoroOnDemand, engine: 'openai' },
      rawKeyboard: undefined,
    })
    expect(plan).toBeNull()
  })

  it('does NOT inject when reply_mode is not on-demand', () => {
    const plan = planListenButton({
      voiceOutPlan: { ...kokoroOnDemand, replyMode: 'voice+text' },
      rawKeyboard: undefined,
    })
    expect(plan).toBeNull()
  })

  it('returns null when there is no voice-out plan', () => {
    expect(planListenButton({ voiceOutPlan: null, rawKeyboard: undefined })).toBeNull()
  })
})

describe('createOutboxSend — net-delivered answer carries the Listen button (#3502)', () => {
  it('attaches the Listen keyboard as reply_markup when voice-out on-demand is enabled', async () => {
    const bot = fakeBot()
    const send = createOutboxSend({
      getBot: () => bot,
      retry: passthroughRetry,
      resolveReplyMarkup: () => planListenButton({ voiceOutPlan: kokoroOnDemand, rawKeyboard: undefined })!.replyMarkup,
    })

    await send('123', null, 'the final answer')

    expect(bot.calls).toHaveLength(1)
    const markup = bot.calls[0]!.opts.reply_markup as
      | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
      | undefined
    expect(markup).toBeDefined()
    expect(markup!.inline_keyboard[0]![0]!.text).toBe('🔊 Listen')
    // Guards against the pre-fix RAW send: no button would have been attached.
  })

  it('attaches the keyboard to the LAST chunk only (final visible message)', async () => {
    const bot = fakeBot()
    const markup = { inline_keyboard: [[{ text: '🔊 Listen', callback_data: 'voice:abcd1234' }]] }
    const send = createOutboxSend({
      getBot: () => bot,
      retry: passthroughRetry,
      resolveReplyMarkup: () => markup,
    })

    // > 4000 chars → two chunks.
    await send('123', null, 'x'.repeat(4500))

    expect(bot.calls).toHaveLength(2)
    expect(bot.calls[0]!.opts.reply_markup).toBeUndefined()
    expect(bot.calls[1]!.opts.reply_markup).toEqual(markup)
  })

  it('delivers plain (no reply_markup) when the resolver returns undefined', async () => {
    const bot = fakeBot()
    const send = createOutboxSend({
      getBot: () => bot,
      retry: passthroughRetry,
      resolveReplyMarkup: () => undefined,
    })

    await send('123', 42, 'plain answer')

    expect(bot.calls).toHaveLength(1)
    expect(bot.calls[0]!.opts.reply_markup).toBeUndefined()
    // thread id still threaded through
    expect(bot.calls[0]!.opts.message_thread_id).toBe(42)
  })

  it('delivers plain when no resolver is wired at all (legacy behaviour preserved)', async () => {
    const bot = fakeBot()
    const send = createOutboxSend({ getBot: () => bot, retry: passthroughRetry })

    await send('123', null, 'legacy answer')

    expect(bot.calls).toHaveLength(1)
    expect(bot.calls[0]!.opts.reply_markup).toBeUndefined()
  })

  it('empty text sends NOTHING and returns undefined (no empty-message retry wedge)', async () => {
    // Telegram rejects an empty message body; a stray '' chunk would throw
    // every sweep tick and wedge the record in a permanent retry. The send
    // must short-circuit instead of calling sendMessage.
    const bot = fakeBot()
    const resolverCalls: string[] = []
    const send = createOutboxSend({
      getBot: () => bot,
      retry: passthroughRetry,
      resolveReplyMarkup: (_c, _t, text) => {
        resolverCalls.push(text)
        return undefined
      },
    })

    const result = await send('123', null, '')

    expect(result).toBeUndefined()
    expect(bot.calls).toHaveLength(0)
    // No point resolving a Listen button for a body we never send.
    expect(resolverCalls).toEqual([])
  })
})

describe('gateway wiring — makeOutboxListenMarkupResolver end-to-end (#3502)', () => {
  // Pins the ACTUAL gateway resolver: the sweep must obtain the Listen keyboard
  // AND persist the tap token when kokoro on-demand voice-out is enabled. If a
  // future change re-severs the sweep delivery from voice-out resolution (the
  // PR #3502 / commit 1a531ebb raw-sendMessage regression), the delivered
  // message loses its button and these assertions go red.
  it('a net-delivered answer carries the button and the tap token is cached', async () => {
    const cached: Array<{ token: string; text: string }> = []
    const enqueued: string[] = []
    const resolve = makeOutboxListenMarkupResolver({
      resolveVoiceOutPlan: () => kokoroOnDemand,
      cachePut: (token, payload) => cached.push({ token, text: payload.text }),
      eagerVoiceEnabled: () => true,
      enqueuePreSynth: (j) => enqueued.push(j.token),
    })

    const bot = fakeBot()
    const send = createOutboxSend({ getBot: () => bot, retry: passthroughRetry, resolveReplyMarkup: resolve })
    await send('123', null, 'the final answer the net is delivering')

    const markup = bot.calls[0]!.opts.reply_markup as
      | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
      | undefined
    expect(markup).toBeDefined()
    const btn = markup!.inline_keyboard[0]![0]!
    expect(btn.text).toBe('🔊 Listen')
    // The token on the button must be the one cached + eagerly pre-synthesized,
    // so the tap resolves to real audio (not a dead token).
    const token = btn.callback_data.replace('voice:', '')
    expect(cached).toEqual([{ token, text: 'the spoken answer' }])
    expect(enqueued).toEqual([token])
  })

  it('resolves to no button (and caches nothing) when voice-out is off', async () => {
    const cached: string[] = []
    const resolve = makeOutboxListenMarkupResolver({
      resolveVoiceOutPlan: () => null,
      cachePut: (token) => cached.push(token),
      eagerVoiceEnabled: () => true,
      enqueuePreSynth: () => {},
    })
    const bot = fakeBot()
    const send = createOutboxSend({ getBot: () => bot, retry: passthroughRetry, resolveReplyMarkup: resolve })
    await send('123', null, 'plain answer, voice-out disabled')

    expect(bot.calls[0]!.opts.reply_markup).toBeUndefined()
    expect(cached).toEqual([])
  })

  it('skips eager pre-synth when the kill switch is off but still shows the button', async () => {
    const enqueued: string[] = []
    const resolve = makeOutboxListenMarkupResolver({
      resolveVoiceOutPlan: () => kokoroOnDemand,
      cachePut: () => {},
      eagerVoiceEnabled: () => false,
      enqueuePreSynth: (j) => enqueued.push(j.token),
    })
    const bot = fakeBot()
    const send = createOutboxSend({ getBot: () => bot, retry: passthroughRetry, resolveReplyMarkup: resolve })
    await send('123', null, 'answer')

    expect(bot.calls[0]!.opts.reply_markup).toBeDefined()
    expect(enqueued).toEqual([])
  })
})
