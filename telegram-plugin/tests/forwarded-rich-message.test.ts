/**
 * Outcome regression: forwarded-message body must reach the agent — never a
 * placeholder (carrie history.db row message_id=944, 2026-07-24 06:03).
 *
 * THE BUG: a forwarded BOT message arrives as Bot API 10.1 `rich_message`
 * content (the gateway sends everything via sendRichMessage) with NO
 * top-level text/caption. Live gateway log (carrie, update_id=417526125):
 *   content_keys=[forward_from,forward_date,rich_message] action=turn
 * It matched no registered `message:*` handler, fell to the terminal
 * catch-all, and the agent received
 *   "(unhandled message content: forward_from)"
 * instead of the forwarded token list. Two defects composed:
 *   1. no `message:rich_message` registration (grammy ^1.44 supports it);
 *   2. legacy `forward_*` wire keys were not in MESSAGE_ENVELOPE_KEYS, so
 *      the placeholder was mislabeled with provenance, not content.
 *
 * These tests drive a REAL grammy 1.44 Bot through the REAL production
 * modules (rich-message-handler + unhandled-message catch-all) in the
 * gateway's registration order and assert the DELIVERED text — the outcome
 * the agent actually receives. The key regression test was verified to FAIL
 * on unfixed main (delivered text was the placeholder) and pass here.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Bot, type Context } from 'grammy'
import type { Update } from 'grammy/types'
import { makeMessageUpdate, resetUpdateCounters } from './update-factory.js'
import { installUnhandledMessageCatchAll } from '../gateway/unhandled-message.js'
import {
  handleRichMessageMessage,
  extractRichMessageText,
  RICH_MESSAGE_EMPTY_TEXT,
} from '../gateway/rich-message-handler.js'
import type { MediaEnvelopeDeps } from '../gateway/media-message-handlers.js'
import { parseForwardOrigin, buildForwardOriginMeta } from '../gateway/forward-origin.js'

const UNHANDLED_PLACEHOLDER_RE = /^\(unhandled message content: /

interface Delivered {
  via: string
  text: string
}

/** Wire a real grammy Bot in the gateway's registration order: message:text,
 * message:rich_message (real production handler), terminal catch-all LAST. */
function buildHarness() {
  const delivered: Delivered[] = []
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

  bot.on('message:text', async ctx => {
    delivered.push({ via: 'text', text: ctx.message.text })
  })
  const richDeps: MediaEnvelopeDeps = {
    handleInbound: async (_ctx, text) => {
      delivered.push({ via: 'rich_message', text })
    },
    handleAckOnly: async () => {},
    handleRefusal: async () => {},
    log: line => logLines.push(line),
  }
  bot.on('message:rich_message', ctx => handleRichMessageMessage(ctx, richDeps))
  installUnhandledMessageCatchAll(
    bot,
    async (_ctx: Context, text: string) => {
      delivered.push({ via: 'catch-all', text })
    },
    line => logLines.push(line),
  )
  return { bot, delivered, logLines }
}

/** The forwarded-bot-message shape observed live (update_id=417526125):
 * forward_origin (modern) + legacy forward_from/forward_date siblings +
 * rich_message content, NO top-level text/caption. */
function makeForwardedRichUpdate(update_id: number, blocks: unknown[]): Update {
  const originUser = { id: 8500000001, is_bot: true, first_name: 'Sidekick', username: 'example_sidekick_bot' }
  return {
    update_id,
    message: {
      message_id: 944,
      chat: { id: -1004444444444, type: 'supergroup', title: 'Example Supergroup', is_forum: true },
      from: { id: 777, is_bot: false, first_name: 'Alice' },
      date: 1784837003,
      forward_origin: { type: 'user', date: 1784830000, sender_user: originUser },
      forward_from: originUser,
      forward_date: 1784830000,
      rich_message: { blocks },
    },
  } as unknown as Update
}

const TOKEN_LIST_BLOCKS = [
  { type: 'paragraph', text: 'Try these tokens' },
  {
    type: 'list',
    items: [
      { label: '-', blocks: [{ type: 'paragraph', text: [{ type: 'code', text: 'tok_alpha_123' }] }] },
      { label: '-', blocks: [{ type: 'paragraph', text: [{ type: 'code', text: 'tok_beta_456' }] }] },
    ],
  },
]

describe('forwarded rich (bot) message — the row-944 regression oracle', () => {
  beforeEach(() => resetUpdateCounters())

  it('delivers the REAL forwarded body — not the unhandled placeholder, not empty', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(makeForwardedRichUpdate(417526125, TOKEN_LIST_BLOCKS))

    expect(delivered).toHaveLength(1)
    const turn = delivered[0]
    // Bug-catcher oracle: real content in, real content out.
    expect(turn.text.length).toBeGreaterThan(0)
    expect(turn.text).not.toMatch(UNHANDLED_PLACEHOLDER_RE)
    expect(turn.text).not.toContain('forward_from')
    // The actual forwarded body the agent must receive.
    expect(turn.text).toContain('Try these tokens')
    expect(turn.text).toContain('tok_alpha_123')
    expect(turn.text).toContain('tok_beta_456')
  })

  it('forward-origin metadata CO-ARRIVES on the trusted attr lane (not injected into the body)', async () => {
    const { bot, delivered } = buildHarness()
    const update = makeForwardedRichUpdate(417526126, TOKEN_LIST_BLOCKS)
    await bot.handleUpdate(update)

    // The same server-stamped forward_origin the enqueue path parses
    // (gateway.ts → parseForwardOrigin → buildForwardOriginMeta → meta attrs).
    const origin = parseForwardOrigin(
      (update as unknown as { message: { forward_origin: never } }).message.forward_origin,
    )
    const meta = buildForwardOriginMeta([origin!])
    expect(meta.forwarded_from).toBe('Sidekick (@example_sidekick_bot)')
    expect(meta.forwarded_from_type).toBe('user')
    expect(meta.forwarded_date).toBeDefined()
    // Trusted-lane separation (#3162): the delivered BODY carries no
    // provenance strings — those live only in the channel attrs.
    expect(delivered[0].text).not.toContain('Sidekick')
  })

  it('a rich message with genuinely no extractable text still yields an honest turn', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(
      makeForwardedRichUpdate(417526127, [{ type: 'divider' }, { type: 'anchor', name: 'top' }]),
    )
    expect(delivered).toHaveLength(1)
    // Divider renders as ---; a fully empty tree gets the honest fallback.
    expect(delivered[0].via).toBe('rich_message')
    expect(delivered[0].text).not.toMatch(UNHANDLED_PLACEHOLDER_RE)
  })

  it('a truly empty rich message delivers the named fallback, never the mislabeled placeholder', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(makeForwardedRichUpdate(417526128, []))
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toBe(RICH_MESSAGE_EMPTY_TEXT)
  })

  it('a NON-forwarded rich message (bot-to-bot, rich DM) also delivers its body', async () => {
    const { bot, delivered } = buildHarness()
    const update = {
      update_id: 417526129,
      message: {
        message_id: 950,
        chat: { id: 777, type: 'private' },
        from: { id: 777, is_bot: false, first_name: 'Alice' },
        date: 1784837100,
        rich_message: { blocks: [{ type: 'heading', size: 2, text: 'Release plan' }, { type: 'paragraph', text: 'Ship Friday.' }] },
      },
    } as unknown as Update
    await bot.handleUpdate(update)
    expect(delivered[0].text).toContain('Release plan')
    expect(delivered[0].text).toContain('Ship Friday.')
  })
})

describe('working shapes stay unchanged (no regression on existing forwards)', () => {
  beforeEach(() => resetUpdateCounters())

  it('plain user-text forward: full body via message:text + co-arriving origin meta', async () => {
    const { bot, delivered } = buildHarness()
    const update = makeMessageUpdate({ text: 'here is the brief I forwarded', update_id: 7001 })
    const msg = (update as unknown as { message: Record<string, unknown> }).message
    msg.forward_origin = {
      type: 'user',
      date: 1_700_000_000,
      sender_user: { id: 424242, is_bot: false, first_name: 'Alice', last_name: 'Example' },
    }
    await bot.handleUpdate(update)

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ via: 'text', text: 'here is the brief I forwarded' })
    const meta = buildForwardOriginMeta([parseForwardOrigin(msg.forward_origin as never)!])
    expect(meta.forwarded_from).toBe('Alice Example')
    expect(meta.forwarded_date).toBeDefined()
  })

  it('hidden_user forward: full body, type=hidden_user, NO forwarded_from_id', async () => {
    const { bot, delivered } = buildHarness()
    const update = makeMessageUpdate({ text: 'anon tip: check the logs', update_id: 7002 })
    const msg = (update as unknown as { message: Record<string, unknown> }).message
    msg.forward_origin = { type: 'hidden_user', date: 1_700_000_000, sender_user_name: 'Mystery Sender' }
    await bot.handleUpdate(update)

    expect(delivered[0].text).toBe('anon tip: check the logs')
    const meta = buildForwardOriginMeta([parseForwardOrigin(msg.forward_origin as never)!])
    expect(meta.forwarded_from).toBe('Mystery Sender')
    expect(meta.forwarded_from_type).toBe('hidden_user')
    expect(meta.forwarded_from_id).toBeUndefined()
  })

  it('channel caption/media forward: caption is the body and forwarded_message_id deep-links the post (G2)', () => {
    // The photo handler's body contract is `caption ?? '(photo)'`
    // (photo-message-handler.ts) — assert the origin-meta side here.
    const origin = parseForwardOrigin({
      type: 'channel',
      date: 1_700_000_000,
      message_id: 555,
      chat: { id: -100400500, type: 'channel', title: 'Release Notes', username: 'relnotes' } as never,
    })
    const meta = buildForwardOriginMeta([origin!])
    expect(meta.forwarded_from).toBe('Release Notes (@relnotes)')
    expect(meta.forwarded_from_type).toBe('channel')
    expect(meta.forwarded_message_id).toBe('555')
  })
})

describe('rich block rendering — deterministic text extraction', () => {
  it('renders headings, lists with checkboxes, pre blocks, quotes, and tables', () => {
    const text = extractRichMessageText({
      blocks: [
        { type: 'heading', size: 1, text: 'Plan' },
        {
          type: 'list',
          items: [
            { label: '1.', blocks: [{ type: 'paragraph', text: 'first' }], has_checkbox: true, is_checked: true },
            { label: '2.', blocks: [{ type: 'paragraph', text: 'second' }], has_checkbox: true },
          ],
        },
        { type: 'pre', language: 'python', text: 'print(1)' },
        { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'quoted line' }], credit: 'someone' },
        { type: 'table', cells: [[{ text: 'A', align: 'left', valign: 'top' }, { text: 'B', align: 'left', valign: 'top' }]] },
        { type: 'photo', photo: [], caption: { text: 'the screenshot' } },
      ],
    })
    expect(text).toContain('Plan')
    expect(text).toContain('1. [x] first')
    expect(text).toContain('2. [ ] second')
    expect(text).toContain('```python\nprint(1)\n```')
    expect(text).toContain('> quoted line')
    expect(text).toContain('> — someone')
    expect(text).toContain('A | B')
    expect(text).toContain('[photo] the screenshot')
  })

  it('flattens nested inline rich text (bold/url/custom emoji/math) to content', () => {
    const text = extractRichMessageText({
      blocks: [{
        type: 'paragraph',
        text: [
          'see ',
          { type: 'bold', text: [{ type: 'url', text: 'the docs', url: 'https://x' }] },
          ' ',
          { type: 'custom_emoji', custom_emoji_id: '1', alternative_text: '👍' },
          ' ',
          { type: 'mathematical_expression', expression: 'E=mc^2' },
        ],
      }],
    })
    expect(text).toBe('see the docs 👍 E=mc^2')
  })

  it('an unknown future block type surfaces its text instead of vanishing', () => {
    expect(extractRichMessageText({ blocks: [{ type: 'hologram', text: 'future words' }] }))
      .toBe('future words')
  })

  it('malformed / hostile payloads return undefined instead of throwing', () => {
    expect(extractRichMessageText(undefined)).toBeUndefined()
    expect(extractRichMessageText('nope')).toBeUndefined()
    expect(extractRichMessageText({ blocks: 'nope' })).toBeUndefined()
    // Deep self-nesting stops at the recursion cap, no stack overflow.
    const deep: { type: string; blocks: unknown[] } = { type: 'blockquote', blocks: [] }
    let cur = deep
    for (let i = 0; i < 200; i++) {
      const next = { type: 'blockquote', blocks: [] as unknown[] }
      cur.blocks.push(next)
      cur = next
    }
    cur.blocks.push({ type: 'paragraph', text: 'buried' })
    expect(() => extractRichMessageText({ blocks: [deep] })).not.toThrow()
  })
})
