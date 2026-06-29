/**
 * Integration tests for the stream-controller parse-failure fallback
 * (issue #657, post-#2669 rich-message path).
 *
 * Contract (unchanged dup-message semantics, new rich transport):
 *   - When the FIRST `sendRichMessage({ markdown })` returns
 *     `400 Bad Request: can't parse entities`, recovery is a single fresh
 *     plain `sendMessage` (the raw markdown as a literal string, no parser)
 *     — no edit (there is no message_id to edit yet). Total outbound: ONE
 *     message_id, not two.
 *   - When a subsequent `editMessageText({ markdown })` returns the same
 *     400, recovery is `editMessageText` AGAIN on the same message_id with
 *     a PLAIN string (no rich wrapper). Never a fresh send.
 *
 * The previous behaviour (the bug #657 fixes) was a duplicate plain-text
 * sendMessage on every parse rejection — visible to the user as two
 * messages, one raw and one rendered correctly.
 */

import { describe, it, expect, vi } from 'vitest'
import { createStreamController } from '../stream-controller.js'
import { createFakeBotApi, errors } from './fake-bot-api.js'

describe('stream-controller parse-failure fallback (#657)', () => {
  it('first rich send: parse-entities 400 → ONE plain-text retry, same outbound count', async () => {
    const bot = createFakeBotApi({ startMessageId: 1000 })
    // Inject a parse-entities 400 for the first sendRichMessage. The
    // controller must catch it and retry as a plain sendMessage.
    bot.faults.next(
      'sendRichMessage',
      errors.badRequest("can't parse entities: Unsupported start tag \"frobnicate\""),
    )

    const stream = createStreamController({
      bot: bot as unknown as { api: ReturnType<typeof createFakeBotApi>['api'] },
      chatId: 'c1',
      throttleMs: 0,
    })

    await stream.update('**broken _markdown')
    await stream.finalize()

    // Exactly one message landed.
    expect(bot.state.sent).toHaveLength(1)
    // The recovery send was a plain sendMessage, not a rich one.
    expect(bot.state.sent[0].rich).toBeFalsy()
    // The raw markdown body shipped verbatim as the literal fallback.
    expect(bot.state.sent[0].text).toBe('**broken _markdown')
    // The stream's message id matches the surviving send.
    expect(stream.getMessageId()).toBe(bot.state.sent[0].message_id)
  })

  it('edit on existing message: parse-entities 400 → plain editMessageText on SAME id, never a fresh send', async () => {
    const bot = createFakeBotApi({ startMessageId: 2000 })

    const stream = createStreamController({
      bot: bot as unknown as { api: ReturnType<typeof createFakeBotApi>['api'] },
      chatId: 'c1',
      throttleMs: 0,
    })

    // First update lands cleanly as a rich send.
    await stream.update('**v1**')
    expect(bot.state.sent).toHaveLength(1)
    expect(bot.state.sent[0].rich).toBe(true)
    const firstId = bot.state.sent[0].message_id

    // Second update: inject a parse-entities 400 on editMessageText.
    bot.faults.next(
      'editMessageText',
      errors.badRequest("can't parse entities: Can't find end of the entity"),
    )

    await stream.update('**v2 broken _extra')
    await stream.finalize()

    // Critical assertion: still ONE outbound message_id total — the
    // recovery was an edit on the same id, NOT a fresh send.
    expect(bot.state.sent).toHaveLength(1)
    expect(stream.getMessageId()).toBe(firstId)

    // The recovery editMessageText fired on the same id.
    const editCalls = (bot.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls
    expect(editCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of editCalls) {
      expect(call[1]).toBe(firstId) // same message_id
    }
    // The final edit passed a PLAIN string (the fallback), not { markdown }.
    const finalCall = editCalls[editCalls.length - 1]
    expect(typeof finalCall[2]).toBe('string')
    expect(finalCall[2]).toBe('**v2 broken _extra')
    // The stored text reflects the plain-text fallback body.
    const finalText = bot.state.currentText.get(firstId)
    expect(finalText).toBe('**v2 broken _extra')
  })

  it('non-parse 400 (e.g. message-not-found) is NOT swallowed by the fallback', async () => {
    const bot = createFakeBotApi({ startMessageId: 3000 })

    const stream = createStreamController({
      bot: bot as unknown as { api: ReturnType<typeof createFakeBotApi>['api'] },
      chatId: 'c1',
      throttleMs: 0,
    })

    await stream.update('**v1**')
    const firstId = bot.state.sent[0].message_id

    // Inject message-not-found on the next edit. This is NOT a parse
    // error — the existing not-found recovery in draft-stream.ts should
    // handle it (clear messageId, re-send) and the parse-fallback wrapper
    // must let it propagate.
    bot.faults.next('editMessageText', errors.messageToEditNotFound())

    await stream.update('**v2**')
    await stream.finalize()

    // The not-found recovery path produces a fresh send — that's the
    // pre-existing contract. We're asserting it still fires (i.e. the
    // parse-fallback didn't accidentally catch this error class too).
    // After: 1 original send + 1 re-send = 2 messages.
    expect(bot.state.sent.length).toBeGreaterThanOrEqual(2)
    expect(bot.state.sent[0].message_id).toBe(firstId)
  })
})
