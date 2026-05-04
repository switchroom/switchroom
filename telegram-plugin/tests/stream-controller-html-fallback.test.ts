/**
 * Integration tests for stream-controller HTML parse-failure fallback
 * (issue #657).
 *
 * Contract:
 *   - When the FIRST sendMessage with parse_mode=HTML returns
 *     `400 Bad Request: can't parse entities`, the recovery is a single
 *     fresh sendMessage with parse_mode stripped — no edit (there is no
 *     message_id to edit yet). Total outbound: ONE message_id, not two.
 *   - When a subsequent editMessageText with parse_mode=HTML returns the
 *     same 400, the recovery is editMessageText AGAIN on the same
 *     message_id (with parse_mode stripped). Never sendMessage.
 *
 * The previous behaviour (the bug #657 fixes) was a duplicate plain-text
 * sendMessage on every HTML parse rejection — visible to the user as two
 * messages, one with raw `<b>` tags and one rendered correctly.
 */

import { describe, it, expect, vi } from 'vitest'
import { createStreamController } from '../stream-controller.js'
import { createFakeBotApi, errors } from './fake-bot-api.js'

describe('stream-controller HTML parse-failure fallback (#657)', () => {
  it('first send: parse-entities 400 → ONE retry without parse_mode, same outbound count', async () => {
    const bot = createFakeBotApi({ startMessageId: 1000 })
    // Inject a parse-entities 400 for the first sendMessage. The
    // controller must catch it and retry with parse_mode stripped.
    bot.faults.next(
      'sendMessage',
      errors.badRequest("can't parse entities: Unsupported start tag \"frobnicate\""),
    )

    const stream = createStreamController({
      bot: bot as unknown as { api: ReturnType<typeof createFakeBotApi>['api'] },
      chatId: 'c1',
      parseMode: 'HTML',
      throttleMs: 0,
    })

    await stream.update('<frobnicate>hello</frobnicate>')
    await stream.finalize()

    // Exactly one message landed.
    expect(bot.state.sent).toHaveLength(1)
    // The recovery send had no parse_mode.
    expect(bot.state.sent[0].parse_mode).toBeUndefined()
    // The body was rendered as plain text (tags stripped).
    expect(bot.state.sent[0].text).toContain('hello')
    expect(bot.state.sent[0].text).not.toContain('<frobnicate>')
    // The stream's message id matches the surviving send.
    expect(stream.getMessageId()).toBe(bot.state.sent[0].message_id)
  })

  it('edit on existing message: parse-entities 400 → editMessageText retry on SAME id, never sendMessage', async () => {
    const bot = createFakeBotApi({ startMessageId: 2000 })

    const stream = createStreamController({
      bot: bot as unknown as { api: ReturnType<typeof createFakeBotApi>['api'] },
      chatId: 'c1',
      parseMode: 'HTML',
      throttleMs: 0,
    })

    // First update lands cleanly as a sendMessage.
    await stream.update('<b>v1</b>')
    expect(bot.state.sent).toHaveLength(1)
    const firstId = bot.state.sent[0].message_id

    // Second update: inject a parse-entities 400 on editMessageText.
    bot.faults.next(
      'editMessageText',
      errors.badRequest("can't parse entities: Unmatched end tag at byte offset 12"),
    )

    await stream.update('<b>v2 broken</b><i>extra')
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
    // The final edit had parse_mode stripped (key absent).
    const finalCall = editCalls[editCalls.length - 1]
    expect(finalCall[3].parse_mode).toBeUndefined()
    // The stored text reflects the plain-text fallback.
    const finalText = bot.state.currentText.get(firstId)
    expect(finalText).toBeDefined()
    expect(finalText).not.toContain('<b>')
  })

  it('non-parse 400 (e.g. message-not-found) is NOT swallowed by the fallback', async () => {
    const bot = createFakeBotApi({ startMessageId: 3000 })

    const stream = createStreamController({
      bot: bot as unknown as { api: ReturnType<typeof createFakeBotApi>['api'] },
      chatId: 'c1',
      parseMode: 'HTML',
      throttleMs: 0,
    })

    await stream.update('<b>v1</b>')
    const firstId = bot.state.sent[0].message_id

    // Inject message-not-found on the next edit. This is NOT a parse
    // error — the existing not-found recovery in draft-stream.ts should
    // handle it (clear messageId, re-send) and our parse-fallback
    // wrapper must let it propagate.
    bot.faults.next('editMessageText', errors.messageToEditNotFound())

    await stream.update('<b>v2</b>')
    await stream.finalize()

    // The not-found recovery path produces a fresh send — that's the
    // pre-existing contract. We're asserting it still fires after our
    // changes (i.e. we didn't accidentally catch this error class too).
    // After: 1 original send + 1 re-send = 2 messages.
    expect(bot.state.sent.length).toBeGreaterThanOrEqual(2)
    expect(bot.state.sent[0].message_id).toBe(firstId)
  })
})
