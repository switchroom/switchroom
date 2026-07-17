/**
 * Regression tests for the terminal catch-all message handler + diagnostic
 * update tap (#3300).
 *
 * THE CLASS OF BUG: the gateway registered ONLY content-specific handlers —
 * `bot.on('message:text')`, `:photo`, `:document`, … `:paid_media`. grammy
 * ^1.44 routes `bot.on` as filtering middleware (`on → filter(pred, handler)
 * → branch(pred, handler, pass)`, verified in grammy/out/composer.js); when
 * NO registered filter matches an inbound `message`, grammy SILENTLY drops
 * it — no log, no ack, no history row. Live signature (2026-07-16, klanker
 * DM): message_id 19090 was allocated between an outbound reply and the next
 * inbound with ZERO gateway trace while polling stayed healthy.
 *
 * THE FIX under test is the REAL production module
 * (`gateway/unhandled-message.ts`) — the same `installUpdateTap` /
 * `installUnhandledMessageCatchAll` gateway.ts wires — driven through a real
 * grammy 1.44 Bot via `bot.handleUpdate`, with a real `bot.on('message:text')`
 * registered BEFORE the catch-all exactly like the gateway's registration
 * order. (gateway.ts itself is a side-effecting module that cannot be
 * imported into a unit test — the extraction into unhandled-message.ts exists
 * precisely so the registered composer path is testable; a structural suite
 * below guards that gateway.ts actually wires it in that order.)
 *
 * Outcomes asserted:
 *   (b) an unregistered content type reaches the catch-all, is logged, and
 *       yields a turn with the placeholder text naming the content type;
 *   (c) a plain text message is consumed by the specific handler and does
 *       NOT double-handle in the catch-all;
 *   service-noise messages (forum topic lifecycle etc.) are logged but do
 *       NOT become turns;
 *   the tap observes every update and rate-limits with a suppression summary.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { Bot, type Context } from 'grammy'
import type { Update } from 'grammy/types'
import { makeMessageUpdate, resetUpdateCounters } from './update-factory.js'
import {
  installUpdateTap,
  installUnhandledMessageCatchAll,
  planUnhandledMessage,
  SERVICE_NOISE_KEYS,
  TAP_MAX_LINES_PER_MINUTE,
} from '../gateway/unhandled-message.js'

interface DeliveredTurn {
  via: 'text' | 'catch-all'
  text: string
  update_id: number
}

/**
 * Wire a real grammy Bot in the gateway's registration order using the REAL
 * production install functions: tap first, specific `message:text` handler,
 * terminal catch-all LAST. `onInbound` records what would flow into
 * handleInboundCoalesced.
 */
function buildHarness() {
  const delivered: DeliveredTurn[] = []
  const logLines: string[] = []

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

  // REAL production tap (same call gateway.ts makes).
  installUpdateTap(bot, line => logLines.push(line))

  // Specific handler — representative of the gateway's message:text
  // registration, placed BEFORE the catch-all exactly as in gateway.ts.
  bot.on('message:text', async ctx => {
    delivered.push({ via: 'text', text: ctx.message.text, update_id: ctx.update.update_id })
  })

  // REAL production catch-all, registered LAST (same call gateway.ts makes).
  installUnhandledMessageCatchAll(
    bot,
    async (ctx: Context, text: string) => {
      delivered.push({ via: 'catch-all', text, update_id: ctx.update.update_id })
    },
    line => logLines.push(line),
  )

  return { bot, delivered, logLines }
}

/** A message update carrying content that no `message:*` filter covers. */
function makeContentUpdate(update_id: number, content: Record<string, unknown>): Update {
  return {
    update_id,
    message: {
      message_id: 5000 + update_id,
      chat: { id: 777, type: 'private' },
      from: { id: 777, is_bot: false, first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
      ...content,
    },
  } as unknown as Update
}

describe('terminal catch-all — real module on a real grammy 1.44 composer (#3300)', () => {
  beforeEach(() => resetUpdateCounters())

  it('(c) a plain-text message is consumed by message:text and does NOT reach the catch-all', async () => {
    const { bot, delivered, logLines } = buildHarness()
    await bot.handleUpdate(makeMessageUpdate({ text: 'hello brief', update_id: 42 }))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ via: 'text', text: 'hello brief' })
    // No catch-all log line — specific handler won (no double-handling).
    expect(logLines.filter(l => l.includes('catch-all inbound'))).toHaveLength(0)
  })

  it('(b) an unregistered content type reaches the catch-all, is logged, and yields a placeholder turn', async () => {
    const { bot, delivered, logLines } = buildHarness()
    await bot.handleUpdate(makeContentUpdate(99, { unknown_future_type: { some: 'payload' } }))

    // Logged with content KEYS + ids only (never the payload body).
    const catchAllLines = logLines.filter(l => l.includes('catch-all inbound'))
    expect(catchAllLines).toHaveLength(1)
    expect(catchAllLines[0]).toContain('update_id=99')
    expect(catchAllLines[0]).toContain('content_keys=[unknown_future_type]')
    expect(catchAllLines[0]).not.toContain('payload')

    // Produced a delivered turn with placeholder text naming the content type.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      via: 'catch-all',
      text: '(unhandled message content: unknown_future_type)',
    })
  })

  it('a caption on an unhandled content type is used as the turn text (best-effort)', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(
      makeContentUpdate(120, { some_new_media: { id: 'x' }, caption: 'read this brief' }),
    )
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ via: 'catch-all', text: 'read this brief' })
  })

  it('known-noise service messages are LOGGED but produce NO agent turn', async () => {
    const { bot, delivered, logLines } = buildHarness()
    await bot.handleUpdate(
      makeContentUpdate(130, { forum_topic_created: { name: 'spam topic', icon_color: 1 } }),
    )
    await bot.handleUpdate(
      makeContentUpdate(131, { new_chat_members: [{ id: 5, is_bot: false, first_name: 'X' }] }),
    )

    // No turns delivered — service noise never reaches the agent.
    expect(delivered).toHaveLength(0)
    // But both were explicitly logged (never silently dropped).
    const noiseLines = logLines.filter(l => l.includes('action=log-only'))
    expect(noiseLines).toHaveLength(2)
    expect(noiseLines[0]).toContain('content_keys=[forum_topic_created]')
    expect(noiseLines[1]).toContain('content_keys=[new_chat_members]')
  })

  it('the diagnostic tap observes EVERY update (pass-through, both routed and caught)', async () => {
    const { bot, logLines } = buildHarness()
    await bot.handleUpdate(makeMessageUpdate({ text: 'routed', update_id: 1 }))
    await bot.handleUpdate(makeContentUpdate(2, { unknown_future_type: {} }))

    const rx = logLines.filter(l => l.includes('rx update_id='))
    expect(rx).toHaveLength(2)
    expect(rx[0]).toContain('rx update_id=1 type=message')
    expect(rx[1]).toContain('rx update_id=2 type=message')
  })
})

describe('planUnhandledMessage — service-noise classification', () => {
  it('every SERVICE_NOISE_KEYS entry classifies log-only', () => {
    for (const key of SERVICE_NOISE_KEYS) {
      const plan = planUnhandledMessage({ message_id: 1, chat: {}, date: 0, [key]: {} })
      expect(plan.action, `key ${key} should be log-only`).toBe('log-only')
    }
  })

  it('an unknown content type classifies as a turn (fail-toward-delivery)', () => {
    const plan = planUnhandledMessage({ message_id: 1, chat: {}, date: 0, mystery_type: {} })
    expect(plan).toMatchObject({
      action: 'turn',
      text: '(unhandled message content: mystery_type)',
    })
  })

  it('a message mixing noise with real content still becomes a turn', () => {
    const plan = planUnhandledMessage({
      message_id: 1, chat: {}, date: 0,
      boost_added: {}, mystery_media: {}, caption: 'look',
    })
    expect(plan).toMatchObject({ action: 'turn', text: 'look' })
  })
})

describe('installUpdateTap — rate limit', () => {
  it('caps lines per minute and emits ONE suppression summary on window rollover', async () => {
    const logLines: string[] = []
    let now = 1_000_000
    const mw: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>> = []
    const fakeBot = { use: (fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) => { mw.push(fn) } }
    installUpdateTap(fakeBot as never, l => logLines.push(l), () => now)

    const fire = (update_id: number) =>
      mw[0]({ update: { update_id }, message: undefined } as never, async () => {})

    for (let i = 0; i < TAP_MAX_LINES_PER_MINUTE + 50; i++) await fire(i)
    expect(logLines.filter(l => l.includes('rx update_id='))).toHaveLength(TAP_MAX_LINES_PER_MINUTE)

    // Roll the window: the 50 suppressed lines surface as ONE summary.
    now += 61_000
    await fire(9999)
    const summaries = logLines.filter(l => l.includes('suppressed 50 update lines'))
    expect(summaries).toHaveLength(1)
    // And logging resumes in the fresh window.
    expect(logLines.filter(l => l.includes('rx update_id=9999'))).toHaveLength(1)
  })
})

// ─── Structural guard on the real gateway.ts wiring ────────────────────────
// The functional harness above proves the composer contract using the REAL
// production install functions; this guards that gateway.ts wires those same
// functions in the required order. Hardened beyond a naive regex: it fails
// if the install call disappears (e.g. refactored away) OR if ANY
// `bot.on('message…')` registration appears after the catch-all install.
describe('gateway.ts catch-all registration invariant', () => {
  const SRC = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')

  it('imports and installs the real catch-all + tap from unhandled-message.ts', () => {
    expect(SRC).toContain("from './unhandled-message.js'")
    expect(SRC).toContain('installUpdateTap(bot,')
    expect(SRC).toContain('installUnhandledMessageCatchAll(')
  })

  it('the catch-all install is AFTER every message handler registration', () => {
    const installIdx = SRC.indexOf('installUnhandledMessageCatchAll(')
    expect(installIdx).toBeGreaterThan(0)
    const after = SRC.slice(installIdx)
    // No message-filter registration of any spelling may follow the terminal
    // catch-all — grammy ordering is the no-double-handling guarantee.
    // (`message_reaction` etc. are DIFFERENT update types, not `message`
    // filters — the pattern requires `message` exactly or `message:<sub>`.)
    expect(after).not.toMatch(/bot\.on\(\s*['"`]message(:|['"`])/)
    // And there must be exactly one catch-all install (no duplicate turns).
    expect(SRC.indexOf('installUnhandledMessageCatchAll(', installIdx + 1)).toBe(-1)
  })

  it('routes the catch-all through handleInboundCoalesced (same gating + forward-origin path)', () => {
    const installIdx = SRC.indexOf('installUnhandledMessageCatchAll(')
    const body = SRC.slice(installIdx, installIdx + 400)
    expect(body).toMatch(/handleInboundCoalesced\(ctx, text, undefined\)/)
  })
})
