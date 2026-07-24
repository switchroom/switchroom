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
  type RichMessageHandlerDeps,
} from '../gateway/rich-message-handler.js'
import { createInboundCoalescer, inboundCoalesceKey } from '../gateway/inbound-coalesce.js'
import {
  parseForwardOrigin,
  dedupeForwardOrigins,
  buildForwardOriginMeta,
  type ForwardOriginInfo,
} from '../gateway/forward-origin.js'

const UNHANDLED_PLACEHOLDER_RE = /^\(unhandled message content: /

interface Delivered {
  via: string
  text: string
  /** Deduped forward origins of the (possibly coalesced) turn — mirrors the
   * production merge (gateway.ts CoalescePayload.forwardOrigins). */
  origins: ForwardOriginInfo[]
}

const COALESCE_GAP_MS = 10

/** Wait past the coalesce window so any buffered burst flushes. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, COALESCE_GAP_MS * 4))
}

/** Wire a real grammy Bot in the gateway's registration order: message:text,
 * message:rich_message (real production handler), terminal catch-all LAST.
 * ALL body-content lanes dispatch through a REAL inbound coalescer wired the
 * same way gateway.ts wires production (per-entry forward-origin parsed at
 * enqueue, texts joined by '\n', origins deduped in merge) — so the tests
 * assert the DELIVERED turn(s), coalescing included. */
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

  type Entry = { via: string; text: string; forwardOrigin?: ForwardOriginInfo }
  const coalescer = createInboundCoalescer<Entry & { origins?: ForwardOriginInfo[] }>({
    gapMs: COALESCE_GAP_MS,
    merge: entries => ({
      via: entries[entries.length - 1].via,
      text: entries.map(e => e.text).filter(t => t.length > 0).join('\n'),
      origins: dedupeForwardOrigins(entries.map(e => e.forwardOrigin)),
    }),
    onFlush: (_key, merged) => {
      delivered.push({ via: merged.via, text: merged.text, origins: merged.origins ?? [] })
    },
  })
  // Mirrors gateway.ts handleInboundCoalesced enqueue: key on
  // (chat, thread, user); parse THIS entry's forward_origin at enqueue time.
  const dispatchCoalesced = async (via: string, ctx: Context, text: string): Promise<void> => {
    const key = inboundCoalesceKey(
      String(ctx.chat!.id),
      ctx.message?.message_thread_id,
      String(ctx.from!.id),
    )
    coalescer.enqueue(key, {
      via,
      text,
      forwardOrigin: parseForwardOrigin(ctx.message?.forward_origin),
    })
  }

  bot.on('message:text', async ctx => {
    await dispatchCoalesced('text', ctx, ctx.message.text)
  })
  const richDeps: RichMessageHandlerDeps = {
    dispatchInbound: (ctx, text) => dispatchCoalesced('rich_message', ctx, text),
    log: line => logLines.push(line),
  }
  bot.on('message:rich_message', ctx => handleRichMessageMessage(ctx, richDeps))
  installUnhandledMessageCatchAll(
    bot,
    (ctx: Context, text: string) => dispatchCoalesced('catch-all', ctx, text),
    line => logLines.push(line),
  )
  return { bot, delivered, logLines }
}

/** The forwarded-bot-message shape observed live (update_id=417526125):
 * forward_origin (modern) + legacy forward_from/forward_date siblings +
 * rich_message content, NO top-level text/caption. */
function makeForwardedRichUpdate(
  update_id: number,
  blocks: unknown[],
  opts?: { message_id?: number; originUser?: { id: number; is_bot: boolean; first_name: string; username?: string } },
): Update {
  const originUser = opts?.originUser
    ?? { id: 8500000001, is_bot: true, first_name: 'Klanker', username: 'meken_klanker_bot' }
  return {
    update_id,
    message: {
      message_id: opts?.message_id ?? 944,
      chat: { id: -1004223464247, type: 'supergroup', title: 'ProductOS', is_forum: true },
      from: { id: 777, is_bot: false, first_name: 'Ken' },
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
    await settle()

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
    await settle()

    // The same server-stamped forward_origin the enqueue path parses
    // (gateway.ts → parseForwardOrigin → buildForwardOriginMeta → meta attrs).
    const origin = parseForwardOrigin(
      (update as unknown as { message: { forward_origin: never } }).message.forward_origin,
    )
    const meta = buildForwardOriginMeta([origin!])
    expect(meta.forwarded_from).toBe('Klanker (@meken_klanker_bot)')
    expect(meta.forwarded_from_type).toBe('user')
    expect(meta.forwarded_date).toBeDefined()
    // Trusted-lane separation (#3162): the delivered BODY carries no
    // provenance strings — those live only in the channel attrs.
    expect(delivered[0].text).not.toContain('Klanker')
  })

  it('a rich message with genuinely no extractable text still yields an honest turn', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(
      makeForwardedRichUpdate(417526127, [{ type: 'divider' }, { type: 'anchor', name: 'top' }]),
    )
    await settle()
    expect(delivered).toHaveLength(1)
    // A divider/anchor-only tree has no readable content — the NAMED empty
    // fallback, not a bare `---` body and not the mislabeled placeholder.
    expect(delivered[0].via).toBe('rich_message')
    expect(delivered[0].text).toBe(RICH_MESSAGE_EMPTY_TEXT)
    expect(delivered[0].text).not.toMatch(UNHANDLED_PLACEHOLDER_RE)
  })

  it('a truly empty rich message delivers the named fallback, never the mislabeled placeholder', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(makeForwardedRichUpdate(417526128, []))
    await settle()
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
        from: { id: 777, is_bot: false, first_name: 'Ken' },
        date: 1784837100,
        rich_message: { blocks: [{ type: 'heading', size: 2, text: 'Release plan' }, { type: 'paragraph', text: 'Ship Friday.' }] },
      },
    } as unknown as Update
    await bot.handleUpdate(update)
    await settle()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('Release plan')
    expect(delivered[0].text).toContain('Ship Friday.')
  })

  it('a BURST of forwarded bot messages coalesces into ONE turn with all bodies + per-message origins', async () => {
    // The primary fixed use case: the user forwards SEVERAL bot messages at
    // once. Pre-N1 the rich handler dispatched each update as its own turn;
    // through the coalesced lane the burst folds into ONE delivered turn.
    const { bot, delivered } = buildHarness()
    const otherBot = { id: 8500000002, is_bot: true, first_name: 'Carrie', username: 'carrie_bot' }
    await bot.handleUpdate(makeForwardedRichUpdate(417526130, [{ type: 'paragraph', text: 'first forwarded body' }], { message_id: 960 }))
    await bot.handleUpdate(makeForwardedRichUpdate(417526131, [{ type: 'paragraph', text: 'second forwarded body' }], { message_id: 961 }))
    await bot.handleUpdate(makeForwardedRichUpdate(417526132, [{ type: 'paragraph', text: 'third forwarded body' }], { message_id: 962, originUser: otherBot }))
    await settle()

    // ONE coalesced turn — not three.
    expect(delivered).toHaveLength(1)
    const turn = delivered[0]
    // All three bodies, arrival order.
    expect(turn.text).toBe('first forwarded body\nsecond forwarded body\nthird forwarded body')
    expect(turn.text).not.toMatch(UNHANDLED_PLACEHOLDER_RE)
    // Per-message origins survive, deduped: two messages from Klanker
    // collapse to one origin entry; Carrie keeps her own sibling.
    const meta = buildForwardOriginMeta(turn.origins)
    expect(meta.forwarded_from).toBe('Klanker (@meken_klanker_bot)')
    expect(meta.forwarded_from_2).toBe('Carrie (@carrie_bot)')
    expect(meta.forwarded_from_3).toBeUndefined()
  })

  it('a mixed burst (forwarded rich + plain text) also coalesces into one turn', async () => {
    const { bot, delivered } = buildHarness()
    await bot.handleUpdate(makeForwardedRichUpdate(417526133, [{ type: 'paragraph', text: 'the forwarded plan' }], { message_id: 970 }))
    // Same (chat, user) as the forwarded update so the coalesce keys match.
    const textUpdate = makeMessageUpdate({
      text: 'thoughts on this?',
      update_id: 417526134,
      chat: { id: -1004223464247, type: 'supergroup', title: 'ProductOS' },
      from: { id: 777, is_bot: false, first_name: 'Ken' },
    })
    await bot.handleUpdate(textUpdate)
    await settle()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toBe('the forwarded plan\nthoughts on this?')
  })

  it('a dispatch failure PROPAGATES to the gateway error funnel — never a silent local swallow', async () => {
    // N2: the handler must not eat a dispatch throw with only a local log
    // line. Same contract as message:text (no local catch): the error
    // reaches grammy's bot.catch, the gateway's single handler-error funnel.
    const bot = new Bot('12345:TEST_TOKEN_NOT_REAL')
    bot.botInfo = {
      id: 999, is_bot: true, first_name: 'TestBot', username: 'test_bot',
      can_join_groups: true, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false,
    }
    const richDeps: RichMessageHandlerDeps = {
      dispatchInbound: async () => { throw new Error('dispatch pipeline down') },
      log: () => {},
    }
    bot.on('message:rich_message', ctx => handleRichMessageMessage(ctx, richDeps))
    // grammy wraps a middleware throw in BotError and (under polling) routes
    // it to bot.catch — the gateway's single handler-error funnel. From
    // handleUpdate the same BotError surfaces as a rejection: assert the
    // original error rides it out instead of dying in a local catch.
    let caught: unknown
    try {
      await bot.handleUpdate(makeForwardedRichUpdate(417526135, TOKEN_LIST_BLOCKS))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { error: Error }).error.message).toBe('dispatch pipeline down')
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
      sender_user: { id: 424242, is_bot: false, first_name: 'Ken', last_name: 'Thompson' },
    }
    await bot.handleUpdate(update)
    await settle()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ via: 'text', text: 'here is the brief I forwarded' })
    const meta = buildForwardOriginMeta([parseForwardOrigin(msg.forward_origin as never)!])
    expect(meta.forwarded_from).toBe('Ken Thompson')
    expect(meta.forwarded_date).toBeDefined()
  })

  it('hidden_user forward: full body, type=hidden_user, NO forwarded_from_id', async () => {
    const { bot, delivered } = buildHarness()
    const update = makeMessageUpdate({ text: 'anon tip: check the logs', update_id: 7002 })
    const msg = (update as unknown as { message: Record<string, unknown> }).message
    msg.forward_origin = { type: 'hidden_user', date: 1_700_000_000, sender_user_name: 'Mystery Sender' }
    await bot.handleUpdate(update)
    await settle()

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
        { type: 'table', cells: [[{ text: 'A', align: 'left', valign: 'top' }, { text: 'B', align: 'left', valign: 'top' }]], caption: { text: 'quarterly numbers', credit: 'finance team' } },
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
    // N3: table caption goes through the caption renderer — credit survives.
    expect(text).toContain('quarterly numbers — finance team')
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
