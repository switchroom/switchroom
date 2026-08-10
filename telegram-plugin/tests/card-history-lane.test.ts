/**
 * Card history lane — REAL history.db end-to-end (#4571).
 *
 * The bug: the gateway posts activity cards, status pins, approval / boot /
 * issues cards and progress lines as real Telegram messages that consume real
 * message ids, but ONLY the `reply` family (which calls `recordOutbound`) ever
 * wrote a row. Measured on a live agent's buffer: 116 rows across a 266-id
 * span. The operator quote-replies to the activity card — the most recent
 * message on their screen for most of a turn — Telegram delivers
 * `reply_to_message_id` pointing at it, the buffer has nothing, and the agent
 * answers "I can't see the message you replied to".
 *
 * This drives the WHOLE chain against a real bun:sqlite DB, because a stored
 * row nobody can look up is not a fix:
 *
 *     robustApiCall resolves → observer → recordSystemOutbound
 *       → lookupMessageRoleAndText({ includeSystem: true })
 *       → resolveReplyToFromBuffer → buildInboundEnvelope
 *       → meta.reply_to_role='system' + meta.reply_to_kind + reply_to_text
 *
 * plus the three regressions the lane must not cause: card rows must not be
 * LISTED by `query()` (get_recent_messages), a real reply must always beat the
 * provisional card row for the same id, and the schema migration must be
 * idempotent against a live pre-#4571 DB without losing a row.
 *
 * Runs under `bun test` (bun:sqlite is a Bun built-in vitest can't resolve);
 * vitest-excluded in vitest.config.ts, covered by the bun `tests/` target in
 * telegram-plugin/scripts/bun-test-ci.sh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordInbound,
  recordOutbound,
  recordSystemOutbound,
  updateSystemOutboundText,
  lookupMessageRoleAndText,
  query,
  _resetForTests,
} from '../history.js'
import {
  resolveReplyToFromBuffer,
  buildInboundEnvelope,
  type EnvelopeBuildParams,
} from '../gateway/inbound-router.js'
import { makeSystemMessageObserver } from '../gateway/system-message-observer.js'
import { Bot, Context } from 'grammy'
import {
  installRichMarkdownGuard,
  installSystemMessageObserver,
  makeSwitchroomReply,
  withTgSendContext,
} from '../shared/bot-runtime.js'
import { installSentTextCapture } from '../shared/sent-text-capture.js'
import { richMessage } from '../rich-send.js'

const CHAT = '5550001'
const REPLY_TO_TEXT_MAX = 200

/** The gateway's own wiring, verbatim: history writers behind the observer. */
function makeObserver(now?: () => number) {
  return makeSystemMessageObserver({
    insert: recordSystemOutbound,
    updateText: updateSystemOutboundText,
    ...(now != null ? { now } : {}),
  })
}

/**
 * A Telegram Message response, as `robustApiCall` resolves with.
 *
 * NOTE (#4576): this PLAIN shape is what `sendMessage` returns. No CARD send
 * uses it — cards go out via `sendRichMessage`, whose response carries no
 * `text` at all. Tests that assert the card BODY must use `sentRichCard()`
 * below; a hand-built `{ text }` fixture cannot fail on the empty-body bug.
 */
function sentMessage(messageId: number, text: string) {
  return { message_id: messageId, chat: { id: Number(CHAT) }, text }
}

/**
 * The result of a REAL `sendRichMessage` through the production transformer
 * stack (fmt guard + `installSentTextCapture`), transport stubbed to answer
 * with the true `Message.RichMessageMessage` shape: `rich_message` blocks, and
 * NO `text` / `caption`.
 *
 * This is the fixture the #4576 defect demanded: every `role='system'` row on
 * every agent in the fleet had `length(text)=0`, because the lane's tests fed
 * the observer a response shape production never produces.
 */
async function sentRichCard(messageId: number, body: string): Promise<unknown> {
  const fakeFetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: messageId,
          date: 0,
          chat: { id: Number(CHAT), type: 'private' },
          rich_message: { blocks: [{ type: 'paragraph', text: { text: body } }] },
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch

  const bot = new Bot('123456:TEST_TOKEN', {
    botInfo: {
      id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot',
      can_join_groups: false, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false,
    },
    client: { fetch: fakeFetch },
  })
  installRichMarkdownGuard(bot)
  installSentTextCapture(bot)
  return bot.api.sendRichMessage(Number(CHAT), richMessage(body))
}

/** The reply-antecedent lookup as gateway.ts binds it (#4571: includeSystem). */
function boundLookup(messageId: number) {
  return lookupMessageRoleAndText(CHAT, messageId, { includeSystem: true })
}

function makeEnvelopeParams(overrides: Partial<EnvelopeBuildParams>): EnvelopeBuildParams {
  return {
    ctx: { message: { date: 1_700_000_000 } } as unknown as EnvelopeBuildParams['ctx'],
    chat_id: CHAT,
    messageThreadId: undefined,
    msgId: 20268,
    effectiveText: 'stop what you are doing and check the other repo',
    imagePath: undefined,
    attachment: undefined,
    attachmentCount: 0,
    extraMeta: {},
    from: { id: 111, username: 'alice' },
    access: { groups: {} },
    isSteering: false,
    isQueuedPrefix: false,
    isQueuedMidTurn: false,
    priorTurnInProgress: false,
    secondsSinceTurnStart: undefined,
    priorAssistantPreview: undefined,
    replyToMessageId: undefined,
    replyToTextEscaped: undefined,
    replyToRole: undefined,
    forwardOriginMeta: {},
    topicFramingEnabled: false,
    personDirectory: { byTelegramKey: {} },
    isDmChatId: () => true,
    ...overrides,
  } as EnvelopeBuildParams
}

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'card-history-lane-'))
  initHistory(stateDir, 30)
})

afterEach(() => {
  _resetForTests()
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

describe('a quote-reply to the live activity card is UNDERSTOOD, end to end', () => {
  it('card posted → id resolvable → the reply carries role=system, the card kind, and its body', () => {
    const observe = makeObserver()
    const CARD_ID = 20267

    // 1. The gateway opens the activity card. No `recordOutbound` anywhere —
    //    this is the exact path that used to leave NO row at all.
    observe(sentMessage(CARD_ID, '⚙️ Working — reading history.ts, 3 tools'), {
      chat_id: CHAT,
      verb: 'activity-summary.send',
    })

    // 2. The operator quote-replies to it. Telegram gives the id but NOT the
    //    text (the bot authored it), so the live reply text is empty.
    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: CARD_ID,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: boundLookup,
    })

    // 3. The antecedent resolves — this is the assertion the bug fails.
    expect(resolved.replyToRole).toBe('system')
    expect(resolved.replyToKind).toBe('activity-summary')
    expect(resolved.replyToText).toBe('⚙️ Working — reading history.ts, 3 tools')

    // 4. …and reaches the agent on the inbound envelope, so it can read the
    //    card body instead of reporting amnesia.
    const msg = buildInboundEnvelope(
      makeEnvelopeParams({
        replyToMessageId: CARD_ID,
        replyToTextEscaped: resolved.replyToTextEscaped,
        replyToRole: resolved.replyToRole,
        replyToKind: resolved.replyToKind,
      }),
    )
    expect(msg.meta?.reply_to_message_id).toBe(String(CARD_ID))
    expect(msg.meta?.reply_to_role).toBe('system')
    expect(msg.meta?.reply_to_kind).toBe('activity-summary')
    expect(msg.meta?.reply_to_text).toBe('⚙️ Working — reading history.ts, 3 tools')
  })

  it('WITHOUT the observer the same reply resolves to nothing (the bug, pinned)', () => {
    // No observe() call — i.e. pre-#4571 behaviour for a card send.
    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: 20267,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: boundLookup,
    })
    expect(resolved.replyToRole).toBeUndefined()
    expect(resolved.replyToText).toBeUndefined()
  })

  it('surfaces the LATEST card body, not the text it was opened with', () => {
    let t = 1_000
    const observe = makeObserver(() => t)
    observe(sentMessage(20267, '⚙️ Working — starting'), {
      chat_id: CHAT,
      verb: 'activity-summary.send',
    })
    t += 60_000
    observe(sentMessage(20267, '⚙️ Working — 11 tools, editing gateway.ts'), {
      chat_id: CHAT,
      verb: 'activity-summary.edit',
    })

    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: 20267,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: boundLookup,
    })
    expect(resolved.replyToText).toBe('⚙️ Working — 11 tools, editing gateway.ts')
  })
})

describe('#4576: the stored card body is NOT empty — real sendRichMessage response', () => {
  it('a rich card write leaves a non-empty row, and the quote-reply carries the body', async () => {
    const observe = makeObserver()
    const CARD_ID = 20395
    const BODY = '⚙️ Working — reading history.ts, 3 tools'

    // The exact production path: sendRichMessage → transformer stack → observer.
    // Its response has NO `text` field, which is what made every fleet row empty.
    const result = await sentRichCard(CARD_ID, BODY)
    expect((result as { text?: unknown }).text).toBeUndefined()
    observe(result, { chat_id: CHAT, verb: 'activity-summary.send' })

    const row = lookupMessageRoleAndText(CHAT, CARD_ID, { includeSystem: true })
    expect(row?.role).toBe('system')
    expect(row?.kind).toBe('activity-summary')
    // The assertion the shipped bug fails: a stored body, not ''.
    expect(row?.text.length).toBeGreaterThan(0)
    expect(row?.text).toBe(BODY)

    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: CARD_ID,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: boundLookup,
    })
    expect(resolved.replyToText).toBe(BODY)

    const msg = buildInboundEnvelope(
      makeEnvelopeParams({
        replyToMessageId: CARD_ID,
        replyToTextEscaped: resolved.replyToTextEscaped,
        replyToRole: resolved.replyToRole,
        replyToKind: resolved.replyToKind,
      }),
    )
    expect(msg.meta?.reply_to_text).toBe(BODY)
  })

  it('holds for every card verb observed on the live fleet, not just the activity card', async () => {
    const observe = makeObserver()
    // The `kind` values measured on live agents' history.db after v0.21.0.
    const verbs: [string, number, string][] = [
      ['boot-card', 5082, '🟢 **overlord** is up — sonnet, 3 skills'],
      ['worker-feed', 20404, '🛠 Worker — scoping the card-persistence defect'],
      ['issues-card', 20405, '**3 open issues** — #4571, #4576, #4580'],
      ['rollout-status-post', 20402, 'Rolling v0.21.0 — 4/12 agents done'],
      ['quota-watch.fleet-roll', 20407, 'Quota 61% — resets 09:00'],
      ['permission_request', 20406, '**Approve** `docker restart switchroom-clerk`?'],
    ]
    for (const [verb, id, body] of verbs) {
      observe(await sentRichCard(id, body), { chat_id: CHAT, verb })
    }
    for (const [verb, id, body] of verbs) {
      const row = lookupMessageRoleAndText(CHAT, id, { includeSystem: true })
      expect(`${verb}:${row?.text.length ?? 0}`).not.toBe(`${verb}:0`)
      expect(row?.text).toBe(body)
    }
    // No card row anywhere in the buffer is bodiless — the fleet-wide invariant
    // the shipped release violated on 100% of its rows.
    const cards = query({ chat_id: CHAT, limit: 100, include_system: true }).filter(
      (r) => r.role === 'system',
    )
    expect(cards).toHaveLength(verbs.length)
    expect(cards.filter((r) => r.text.length === 0)).toEqual([])
  })
})

describe('#4599: the SLASH-COMMAND card path is recorded too', () => {
  const BOT_INFO = {
    id: 123456, is_bot: true as const, first_name: 'Test', username: 'test_bot',
    can_join_groups: false, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false,
  }

  /**
   * The gateway's REAL transformer stack with the observer installed exactly
   * where gateway.ts installs it (after `installSentTextCapture`), transport
   * stubbed to answer with the true `Message.RichMessageMessage` shape echoing
   * the markdown that was actually POSTed.
   *
   * `editMessageText` re-uses the `message_id` in the payload, so an edit
   * returns the id it edited — the shape the observer's send-vs-edit rule
   * depends on.
   */
  function makeCardBot(observe: (result: unknown, opts?: { verb?: string }) => void) {
    let nextId = 30_000
    const posted: string[] = []
    const fakeFetch = (async (_url: unknown, init: { body?: string } | undefined) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      posted.push(String(payload.__method__ ?? ''))
      const rich = payload.rich_message as { markdown?: unknown } | undefined
      const id = typeof payload.message_id === 'number' ? payload.message_id : nextId++
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: id,
            date: 0,
            chat: { id: Number(CHAT), type: 'private' },
            ...(typeof rich?.markdown === 'string'
              ? { rich_message: { blocks: [{ type: 'paragraph', text: { text: rich.markdown } }] } }
              : { text: String(payload.text ?? '') }),
          },
        }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const bot = new Bot('123456:TEST_TOKEN', { botInfo: BOT_INFO, client: { fetch: fakeFetch } })
    installRichMarkdownGuard(bot)
    installSentTextCapture(bot)
    installSystemMessageObserver(bot, observe)
    return { bot, posted }
  }

  /** A grammy Context for an inbound `/usage`, as the command handler receives it. */
  function makeCtx(bot: Bot): Context {
    return new Context(
      {
        update_id: 1,
        message: {
          message_id: 20_930,
          date: 0,
          chat: { id: Number(CHAT), type: 'private' as const },
          from: { id: 111, is_bot: false, first_name: 'Alice' },
          text: '/usage',
        },
      } as never,
      bot.api,
      BOT_INFO,
    )
  }

  it('a /usage card sent via switchroomReply leaves exactly one non-empty row', async () => {
    // THE #4599 DEFECT, pinned. `switchroomReply` answers every slash command
    // through `ctx.replyWithRichMessage`, which builds its own payload and calls
    // `bot.api.*` directly — it never transits `robustApiCall`, where the #4571
    // recorder was hooked. Measured on a live agent: the `/usage` card at id
    // 20938 left no row, so a quote-reply to it resolved to nothing. A recorder
    // that only sees `robustApiCall` cannot pass this test.
    const observe = makeObserver()
    const { bot } = makeCardBot(observe)
    const switchroomReply = makeSwitchroomReply(() => undefined)
    const BODY = 'Usage this week — Opus 41 percent, Sonnet 12 percent'

    await switchroomReply(makeCtx(bot), BODY, { html: true })

    const cards = query({ chat_id: CHAT, limit: 50, include_system: true }).filter(
      (r) => r.role === 'system',
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]!.text).toBe(BODY)

    // …and the quote-reply the operator actually makes now resolves.
    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: cards[0]!.message_id,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: boundLookup,
    })
    expect(resolved.replyToRole).toBe('system')
    expect(resolved.replyToText).toBe(BODY)
  })

  it('the PLAIN ctx.reply branch of switchroomReply is recorded as well', async () => {
    const observe = makeObserver()
    const { bot } = makeCardBot(observe)
    const switchroomReply = makeSwitchroomReply(() => undefined)

    await switchroomReply(makeCtx(bot), 'plain notice, no markdown', {})

    const cards = query({ chat_id: CHAT, limit: 50, include_system: true }).filter(
      (r) => r.role === 'system',
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]!.text).toBe('plain notice, no markdown')
  })

  it('a wrapped send keeps its verb → kind, and its edits do NOT add a second row', async () => {
    // The behaviour the move must PRESERVE: `robustApiCall` publishes its verb
    // through `withTgSendContext`, so the 117 live `role='system'` rows keep
    // their `kind` (`activity-summary`, `worker-feed`, …) instead of degrading
    // to null now that the recorder no longer sits on that wrapper.
    let clock = 1_000
    const observe = makeObserver(() => clock)
    const { bot } = makeCardBot(observe)

    const sent = await withTgSendContext({ chat_id: CHAT, verb: 'activity-summary.send' }, () =>
      bot.api.sendRichMessage(Number(CHAT), richMessage('Working — 3 tools')),
    )
    const id = (sent as { message_id: number }).message_id

    clock += 60_000
    await withTgSendContext({ chat_id: CHAT, verb: 'activity-summary.edit' }, () =>
      bot.api.editMessageText(Number(CHAT), id, richMessage('Working — 11 tools')),
    )

    const cards = query({ chat_id: CHAT, limit: 50, include_system: true }).filter(
      (r) => r.role === 'system',
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]!.message_id).toBe(id)
    expect(cards[0]!.kind).toBe('activity-summary')
    expect(cards[0]!.text).toBe('Working — 11 tools')
  })

  it('a Telegram REJECTION is never recorded as a card', async () => {
    // grammy resolves the transformer chain with the raw `{ok:false}` body and
    // only throws afterwards, so a failed send reaches the observer as a
    // RESOLVED response. Recording its error object would be #4576 all over.
    const observe = makeObserver()
    const failFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error_code: 400, description: 'chat not found' }),
      }) as unknown as Response) as unknown as typeof fetch
    const bot = new Bot('123456:TEST_TOKEN', { botInfo: BOT_INFO, client: { fetch: failFetch } })
    installSystemMessageObserver(bot, observe)

    await expect(
      bot.api.sendRichMessage(Number(CHAT), richMessage('never lands')),
    ).rejects.toThrow()
    expect(query({ chat_id: CHAT, limit: 50, include_system: true })).toHaveLength(0)
  })
})

describe('the card lane does not pollute normal history reads', () => {
  it('query() (get_recent_messages) lists the conversation, never the cards', () => {
    const observe = makeObserver()
    recordInbound({
      chat_id: CHAT,
      thread_id: null,
      message_id: 20200,
      user: 'alice',
      user_id: '111',
      ts: 1_000,
      text: 'what is the status of the migration?',
    })
    for (const id of [20209, 20210, 20212, 20213]) {
      observe(sentMessage(id, `card ${id}`), { chat_id: CHAT, verb: 'activity-summary.send' })
    }
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [20214],
      texts: ['Migration is applied on all three boxes.'],
      ts: 2_000,
    })

    const listed = query({ chat_id: CHAT, limit: 50 })
    expect(listed.map((r) => r.message_id)).toEqual([20200, 20214])
    expect(listed.some((r) => r.role === 'system')).toBe(false)

    // Opt-in still sees them — resolvable, just not listed.
    const withCards = query({ chat_id: CHAT, limit: 50, include_system: true })
    expect(withCards.map((r) => r.message_id).sort((a, b) => a - b)).toEqual([
      20200, 20209, 20210, 20212, 20213, 20214,
    ])
  })

  it('an authorship-sensitive lookup (reaction trigger) still cannot see a card', () => {
    makeObserver()(sentMessage(20267, 'card'), { chat_id: CHAT, verb: 'activity-summary.send' })
    // Default (no includeSystem) — the pre-#4571 contract, unchanged.
    expect(lookupMessageRoleAndText(CHAT, 20267)).toBeNull()
    expect(lookupMessageRoleAndText(CHAT, 20267, { includeSystem: true })?.role).toBe('system')
  })
})

describe('a real reply always beats the provisional card row', () => {
  it('recordOutbound promotes the id to assistant and leaves exactly one row', () => {
    const observe = makeObserver()
    const ID = 20261
    // The observer fires first — it runs when the API call resolves, strictly
    // before the caller reaches its own recordOutbound.
    observe(sentMessage(ID, 'Migration is applied on all three boxes.'), {
      chat_id: CHAT,
      verb: 'reply',
    })
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [ID],
      texts: ['Migration is applied on all three boxes.'],
      ts: 2_000,
    })

    const rows = query({ chat_id: CHAT, limit: 50, include_system: true })
    expect(rows.filter((r) => r.message_id === ID)).toHaveLength(1)
    expect(rows[0]?.role).toBe('assistant')
    // And a reply pointing at it reads as an ANSWER, not a card.
    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: ID,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: boundLookup,
    })
    expect(resolved.replyToRole).toBe('assistant')
    expect(resolved.replyToKind).toBeUndefined()
  })

  it('promotes even when the observer recorded a DIFFERENT thread for the id', () => {
    // Telegram stamps message_thread_id on reply chains in plain supergroups,
    // so the observer's thread can differ from the gateway's. The unique key
    // folds thread_id, so without the explicit delete BOTH rows would survive
    // and the card could shadow the answer.
    recordSystemOutbound({
      chat_id: CHAT,
      thread_id: 77,
      message_id: 20263,
      kind: 'activity-summary',
      text: 'card',
    })
    recordOutbound({
      chat_id: CHAT,
      thread_id: null,
      message_ids: [20263],
      texts: ['the real answer'],
      ts: 2_000,
    })
    const rows = query({ chat_id: CHAT, limit: 50, include_system: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe('assistant')
  })

  it('a card never overwrites an inbound that already owns the id', () => {
    recordInbound({
      chat_id: CHAT,
      thread_id: null,
      message_id: 20300,
      user: 'alice',
      user_id: '111',
      ts: 1_000,
      text: 'the operator said this',
    })
    expect(
      recordSystemOutbound({
        chat_id: CHAT,
        thread_id: null,
        message_id: 20300,
        kind: 'activity-summary',
        text: 'card',
      }),
    ).toBe(false)
    expect(updateSystemOutboundText({ chat_id: CHAT, message_id: 20300, text: 'card' })).toBe(false)
    const row = lookupMessageRoleAndText(CHAT, 20300, { includeSystem: true })
    expect(row?.role).toBe('user')
    expect(row?.text).toBe('the operator said this')
  })
})

describe('migration onto a live pre-#4571 history.db', () => {
  it('adds `kind` without losing a row, and is a no-op when already migrated', () => {
    _resetForTests()
    const legacyDir = mkdtempSync(join(tmpdir(), 'card-history-legacy-'))
    try {
      // A pre-#4571 schema: no `kind` column, no logical-key index.
      const raw = new Database(join(legacyDir, 'history.db'))
      raw.exec(`
        CREATE TABLE messages (
          chat_id TEXT NOT NULL, thread_id INTEGER, message_id INTEGER NOT NULL,
          role TEXT NOT NULL, user TEXT, user_id TEXT, ts INTEGER NOT NULL,
          text TEXT NOT NULL, attachment_kind TEXT, group_id INTEGER,
          PRIMARY KEY (chat_id, thread_id, message_id)
        )
      `)
      const ins = raw.prepare(
        `INSERT INTO messages (chat_id, thread_id, message_id, role, user, user_id, ts, text)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      const nowSec = Math.floor(Date.now() / 1000)
      for (let i = 0; i < 200; i++) {
        ins.run(CHAT, 19000 + i, i % 2 === 0 ? 'user' : 'assistant', 'alice', '111', nowSec, `row ${i}`)
      }
      raw.close()

      const countRows = () => {
        const d = new Database(join(legacyDir, 'history.db'), { readonly: true })
        try {
          return (d.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c
        } finally {
          d.close()
        }
      }
      expect(countRows()).toBe(200)

      // First migration.
      initHistory(legacyDir, 30)
      expect(countRows()).toBe(200)
      // The new column is usable, and every legacy row kept its exact contents.
      expect(lookupMessageRoleAndText(CHAT, 19000)).toEqual({
        role: 'user',
        text: 'row 0',
        kind: null,
      })
      recordSystemOutbound({
        chat_id: CHAT,
        thread_id: null,
        message_id: 19500,
        kind: 'boot-card',
        text: 'booted',
      })
      _resetForTests()

      // Re-run against the ALREADY-migrated file: idempotent, non-destructive.
      initHistory(legacyDir, 30)
      expect(countRows()).toBe(201)
      expect(lookupMessageRoleAndText(CHAT, 19500, { includeSystem: true })).toEqual({
        role: 'system',
        text: 'booted',
        kind: 'boot-card',
      })
      _resetForTests()
    } finally {
      rmSync(legacyDir, { recursive: true, force: true })
      // Restore the per-test DB the shared afterEach expects to close.
      initHistory(stateDir, 30)
    }
  })
})
