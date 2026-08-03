/**
 * Reply-to buffer fallback — REAL history.db integration (1a persistence half).
 *
 * The pure-builder outcomes live in reply-to-buffer-fallback.test.ts (vitest).
 * This file pins the half that needs a real bun:sqlite `history.db`: that the
 * recovered antecedent is actually PERSISTED to the inbound row (reply_to_text
 * non-NULL), not just emitted on the envelope. Envelope-only was the rejected
 * design — it leaves the DB row NULL and starves the next handoff briefing,
 * which reads reply_to_text back out of this store. So this drives the exact
 * production chain: recordOutbound (the bot's own message) → lookup it back →
 * resolveReplyToFromBuffer → recordInbound(reply_to_text) → read the row.
 *
 * Runs under `bun test` (bun:sqlite is a Bun built-in vitest/Node can't
 * resolve); vitest-excluded in vitest.config.ts, covered by the bun `tests/`
 * target in telegram-plugin/scripts/bun-test-ci.sh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordInbound,
  recordOutbound,
  lookupMessageRoleAndText,
  query,
  _resetForTests,
} from '../history.js'
import { resolveReplyToFromBuffer } from '../gateway/inbound-router.js'

const REPLY_TO_TEXT_MAX = 200
const CHAT = '5550001'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'reply-to-buffer-'))
  initHistory(stateDir, 30)
})

afterEach(() => {
  _resetForTests()
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

describe('reply-to buffer fallback persists the recovered antecedent (1a)', () => {
  it('a native reply to the bot own message recovers text+role from history and writes a non-NULL row', () => {
    // 1. The bot sent a message earlier; recordOutbound persisted it (role='assistant').
    const botMsgId = 4242
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [botMsgId],
      texts: ['Added the calendar invite for Friday 3pm.'],
      ts: 1000,
    })

    // 2. Session reset happened (transcript gone). The user native-replies to
    //    that bot message. Telegram gives us the id but NOT the text, so the
    //    live reply text is empty — exactly the incident condition.
    const recovered = resolveReplyToFromBuffer({
      replyToMessageId: botMsgId,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: (id) => lookupMessageRoleAndText(CHAT, id),
    })

    // The buffer recovered both the text and the authorship.
    expect(recovered.replyToText).toBe('Added the calendar invite for Friday 3pm.')
    expect(recovered.replyToRole).toBe('assistant')

    // 3. The gateway records the inbound with the recovered reply_to_text.
    const userMsgId = 4300
    recordInbound({
      chat_id: CHAT,
      thread_id: null,
      message_id: userMsgId,
      user: 'alice',
      user_id: '111',
      ts: 2000,
      text: 'is this added as a calendar invite yet?',
      reply_to_message_id: botMsgId,
      reply_to_text: recovered.replyToText ?? null,
    })

    // 4. THE outcome that would fail on the old bug and the rejected
    //    envelope-only design: the persisted inbound row's reply_to_text is
    //    non-NULL and carries the recovered antecedent.
    const rows = query({ chat_id: CHAT, thread_id: null, limit: 10 })
    const inboundRow = rows.find((r) => r.message_id === userMsgId) as
      | { reply_to_text?: string | null; reply_to_message_id?: number | null }
      | undefined
    expect(inboundRow).toBeDefined()
    expect(inboundRow!.reply_to_message_id).toBe(botMsgId)
    expect(inboundRow!.reply_to_text).not.toBeNull()
    expect(inboundRow!.reply_to_text).toBe('Added the calendar invite for Friday 3pm.')
  })

  it('a reply target absent from history (predates retention) writes a NULL row without throwing — no regression', () => {
    const missingId = 99999
    const recovered = resolveReplyToFromBuffer({
      replyToMessageId: missingId,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: (id) => lookupMessageRoleAndText(CHAT, id),
    })
    expect(recovered.replyToText).toBeUndefined()
    expect(recovered.replyToRole).toBeUndefined()

    const userMsgId = 4301
    recordInbound({
      chat_id: CHAT,
      thread_id: null,
      message_id: userMsgId,
      user: 'alice',
      user_id: '111',
      ts: 2000,
      text: 'what about this one?',
      reply_to_message_id: missingId,
      reply_to_text: recovered.replyToText ?? null,
    })
    const rows = query({ chat_id: CHAT, thread_id: null, limit: 10 })
    const inboundRow = rows.find((r) => r.message_id === userMsgId) as
      | { reply_to_text?: string | null }
      | undefined
    expect(inboundRow).toBeDefined()
    expect(inboundRow!.reply_to_text ?? null).toBeNull()
  })
})
