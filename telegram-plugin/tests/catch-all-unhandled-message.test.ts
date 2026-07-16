/**
 * Regression tests for the terminal catch-all message handler (#3300).
 *
 * THE BUG (root cause of the 2026-07-16 dropped-forward incident): the
 * gateway registered ONLY content-specific handlers — `bot.on('message:text')`,
 * `:photo`, `:document`, … `:paid_media`. grammy ^1.44 routes `bot.on` as
 * filtering middleware (`on → filter(pred, handler) → branch(pred, handler,
 * pass)`); when NO registered filter matches an inbound `message`, grammy
 * SILENTLY drops it — no log, no ack, no history row. A forwarded message
 * whose content matched none of the registered filters vanished with zero
 * trace.
 *
 * THE FIX: a terminal `bot.on('message', …)` registered LAST. Because a
 * matched specific handler is a leaf that never calls `next()`, the chain
 * stops on a specific match (specific handler wins), and the catch-all only
 * fires for messages no specific handler consumed — routing every inbound
 * into the pipeline so nothing is dropped at this layer.
 *
 * These tests exercise the REAL grammy 1.44 middleware engine via
 * `bot.handleUpdate`, asserting OUTCOMES:
 *   (b) an unregistered content type reaches the catch-all, is logged, and
 *       yields a placeholder text naming the content type;
 *   (c) a plain-text message is consumed by the specific handler and does
 *       NOT double-handle in the catch-all;
 *   plus: the diagnostic tap observes EVERY update (pass-through, never
 *   consumes), and a structural guard that gateway.ts keeps the catch-all
 *   registered LAST with the tap in place.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { makeMessageUpdate, resetUpdateCounters } from './update-factory.js'

// Envelope keys mirror gateway.ts MESSAGE_ENVELOPE_KEYS — the fields filtered
// out when surfacing the CONTENT keys of a message.
const MESSAGE_ENVELOPE_KEYS = new Set<string>([
  'message_id', 'message_thread_id', 'date', 'chat', 'from', 'sender_chat',
  'forward_origin', 'reply_to_message', 'external_reply', 'quote',
  'reply_to_story', 'edit_date', 'media_group_id', 'author_signature',
  'is_topic_message', 'is_automatic_forward', 'via_bot', 'sender_boost_count',
  'business_connection_id', 'effect_id', 'has_protected_content',
  'is_from_offline', 'link_preview_options', 'show_caption_above_media',
  'entities', 'caption_entities',
])

interface DeliveredTurn {
  via: 'text' | 'catch-all'
  text: string
  update_id: number
}

/**
 * Build a Bot whose handler registration ORDER mirrors gateway.ts:
 * specific `message:text` first, terminal `bot.on('message')` LAST, with the
 * diagnostic tap as the first middleware. Handlers record outcomes instead of
 * touching the network, and we set `botInfo` so `handleUpdate` never calls
 * getMe.
 */
function buildHarness() {
  const delivered: DeliveredTurn[] = []
  const tapLog: Array<{ update_id: number; type: string }> = []
  const catchAllLog: Array<{ update_id: number; content_keys: string[] }> = []

  const bot = new Bot('12345:TEST_TOKEN_NOT_REAL')
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  }

  // Diagnostic tap — pass-through, sees EVERY update, never consumes.
  bot.use(async (ctx, next) => {
    const upd = ctx.update as unknown as Record<string, unknown>
    const type = Object.keys(upd).find(k => k !== 'update_id') ?? 'unknown'
    tapLog.push({ update_id: ctx.update.update_id, type })
    await next()
  })

  // Specific handler (representative of the real message:text / :photo / …).
  bot.on('message:text', async ctx => {
    delivered.push({ via: 'text', text: ctx.message.text, update_id: ctx.update.update_id })
  })

  // Terminal catch-all — MUST be registered LAST. Mirrors gateway.ts logic.
  bot.on('message', async ctx => {
    const msg = ctx.message as unknown as Record<string, unknown> | undefined
    const contentKeys = msg
      ? Object.keys(msg).filter(k => !MESSAGE_ENVELOPE_KEYS.has(k))
      : []
    catchAllLog.push({ update_id: ctx.update.update_id, content_keys: contentKeys })
    const contentType = contentKeys[0] ?? 'unknown'
    const text =
      (msg?.text as string | undefined) ??
      (msg?.caption as string | undefined) ??
      `(unhandled message content: ${contentType})`
    delivered.push({ via: 'catch-all', text, update_id: ctx.update.update_id })
  })

  return { bot, delivered, tapLog, catchAllLog }
}

/** A message update carrying a content type that no specific handler covers. */
function makeUnregisteredContentUpdate(update_id: number): Update {
  return {
    update_id,
    message: {
      message_id: 5000,
      chat: { id: 777, type: 'private' },
      from: { id: 777, is_bot: false, first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
      // A content field none of the gateway's `message:*` filters register.
      unknown_future_type: { some: 'payload' },
    },
  } as unknown as Update
}

describe('terminal catch-all — unhandled message content types (#3300)', () => {
  beforeEach(() => resetUpdateCounters())

  it('(c) a plain-text message is consumed by message:text and does NOT reach the catch-all', async () => {
    const { bot, delivered, catchAllLog } = buildHarness()
    await bot.handleUpdate(makeMessageUpdate({ text: 'hello brief', update_id: 42 }))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ via: 'text', text: 'hello brief' })
    // The catch-all never fired — specific handler won (no double-handling).
    expect(catchAllLog).toHaveLength(0)
  })

  it('(b) an unregistered content type reaches the catch-all, is logged, and yields a placeholder turn', async () => {
    const { bot, delivered, catchAllLog } = buildHarness()
    await bot.handleUpdate(makeUnregisteredContentUpdate(99))

    // Reached the catch-all (not silently dropped) and was logged.
    expect(catchAllLog).toHaveLength(1)
    expect(catchAllLog[0].update_id).toBe(99)
    expect(catchAllLog[0].content_keys).toEqual(['unknown_future_type'])

    // Produced a delivered turn with placeholder text naming the content type.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      via: 'catch-all',
      text: '(unhandled message content: unknown_future_type)',
    })
  })

  it('the diagnostic tap observes EVERY update (pass-through, both routed and caught)', async () => {
    const { bot, tapLog } = buildHarness()
    await bot.handleUpdate(makeMessageUpdate({ text: 'routed', update_id: 1 }))
    await bot.handleUpdate(makeUnregisteredContentUpdate(2))

    expect(tapLog).toEqual([
      { update_id: 1, type: 'message' },
      { update_id: 2, type: 'message' },
    ])
  })
})

// ─── Structural guard on the real gateway.ts wiring ────────────────────────
// The functional harness above proves the grammy contract; this guards that
// gateway.ts actually keeps the catch-all registered LAST and the tap present.
describe('gateway.ts catch-all registration invariant', () => {
  const SRC = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')

  it('registers a terminal bot.on(\'message\') catch-all', () => {
    expect(SRC).toMatch(/bot\.on\('message',\s*async ctx =>/)
  })

  it('the catch-all is registered AFTER every specific message:* handler', () => {
    const catchAllIdx = SRC.indexOf("bot.on('message', async ctx =>")
    expect(catchAllIdx).toBeGreaterThan(0)
    // No `bot.on('message:<type>'` may appear after the catch-all — otherwise
    // grammy would route that later specific handler into the pass chain and
    // the ordering guarantee (specific wins, catch-all is terminal) breaks.
    const after = SRC.slice(catchAllIdx + 1)
    expect(after).not.toMatch(/bot\.on\('message:/)
  })

  it('routes the catch-all through handleInboundCoalesced (same gating + forward-origin path)', () => {
    const catchAllIdx = SRC.indexOf("bot.on('message', async ctx =>")
    const body = SRC.slice(catchAllIdx, catchAllIdx + 1500)
    expect(body).toMatch(/handleInboundCoalesced\(ctx, text, undefined\)/)
    expect(body).toMatch(/unhandled message content:/)
  })

  it('installs the diagnostic update tap (bot.use logging rx update_id)', () => {
    expect(SRC).toMatch(/rx update_id=\$\{upd\.update_id\} type=\$\{updateType\}/)
  })
})
