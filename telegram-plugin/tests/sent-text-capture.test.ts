/**
 * Card-body capture — wire-level outcome tests (#4576 follow-up).
 *
 * The defect being pinned: #4576 landed the card-history lane, and every
 * `role='system'` row it wrote across the whole fleet had `length(text) = 0`.
 * The lane's own tests passed because their fixtures hand-built a Telegram
 * `Message` with a `text` field — a shape no card send has EVER produced. Every
 * gateway card goes out via Bot API 10.1 `sendRichMessage`, whose response is a
 * `Message.RichMessageMessage`: body under `rich_message.blocks`, no `text`, no
 * `caption`. `extractSentMessage`'s `msg.text ?? msg.caption ?? ''` therefore
 * resolved `''` 100% of the time, and a quote-reply to a card gave the agent the
 * card's KIND but never its BODY.
 *
 * So these tests deliberately do NOT hand-build a response. They drive a REAL
 * grammy `Bot` with the production transformer stack and a stubbed transport
 * that answers with the REAL rich-message response shape, then assert the body
 * survives to the history writer. A test that builds its own `{ text }` fixture
 * cannot fail on this bug and is not a test of it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { Bot } from 'grammy'
import { installTgPostLogger, installRichMarkdownGuard } from '../shared/bot-runtime.js'
import {
  installSentTextCapture,
  outboundPayloadText,
  readSentText,
  attachSentText,
} from '../shared/sent-text-capture.js'
import { richMessage } from '../rich-send.js'
import { makeSystemMessageObserver, extractSentMessage } from '../gateway/system-message-observer.js'

const CHAT = 5550001

/**
 * The response Telegram actually returns for `sendRichMessage` — the body lives
 * in `rich_message.blocks`; `text` and `caption` are ABSENT. Verified against
 * `@grammyjs/types` 4.0.0 `message.d.ts:98` (`RichMessageMessage = CommonMessage
 * & MsgWith<"rich_message">`) and `:184` (`rich_message?: RichMessage`).
 */
function richMessageResponse(messageId: number, rendered: string) {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: CHAT, type: 'private' },
    rich_message: { blocks: [{ type: 'paragraph', text: { text: rendered } }] },
  }
}

/** A plain `sendMessage` response, for the verbs that don't go rich. */
function plainMessageResponse(messageId: number, text: string) {
  return { message_id: messageId, date: 0, chat: { id: CHAT, type: 'private' }, text }
}

/**
 * A real grammy Bot wired with the PRODUCTION transformer stack in the
 * production order (logger → fmt guard → text capture), transport stubbed. The
 * stub answers each method from `respond`, so a test can return the true
 * rich-message shape rather than inventing one.
 */
function makeBot(respond: (method: string, body: Record<string, unknown>) => unknown) {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const fakeFetch = (async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split('/').pop() ?? ''
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    calls.push({ method, body })
    const result = respond(method, body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
    } as unknown as Response
  }) as unknown as typeof fetch

  const bot = new Bot('123456:TEST_TOKEN', {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
    client: { fetch: fakeFetch },
  })
  installTgPostLogger(bot)
  installRichMarkdownGuard(bot)
  installSentTextCapture(bot)
  return { bot, calls }
}

describe('outboundPayloadText — the body a request is about to POST', () => {
  it('reads the rich-message markdown (the shape every card send uses)', () => {
    expect(outboundPayloadText({ chat_id: 1, rich_message: { markdown: '**Working**' } })).toBe(
      '**Working**',
    )
  })

  it('reads html and flattens blocks for rich payloads that are not markdown', () => {
    expect(outboundPayloadText({ rich_message: { html: '<b>hi</b>' } })).toBe('<b>hi</b>')
    expect(
      outboundPayloadText({
        rich_message: { blocks: [{ text: 'top' }, { blocks: [{ text: 'nested' }] }] },
      }),
    ).toBe('top\nnested')
  })

  it('reads plain text and media captions', () => {
    expect(outboundPayloadText({ text: 'restarting…' })).toBe('restarting…')
    expect(outboundPayloadText({ caption: 'chart for July' })).toBe('chart for July')
  })

  it('returns null for the bodiless verbs (pin/delete/reaction/getUpdates)', () => {
    expect(outboundPayloadText({ chat_id: 1, message_id: 2 })).toBeNull()
    expect(outboundPayloadText(undefined)).toBeNull()
    expect(outboundPayloadText('nonsense')).toBeNull()
  })
})

describe('attachSentText / readSentText', () => {
  it('stamps the Message inside an ok envelope, invisibly to every normal reader', () => {
    const env = { ok: true, result: { message_id: 7, chat: { id: CHAT } } }
    attachSentText(env, 'the card body')
    expect(readSentText(env.result)).toBe('the card body')
    // Invisible: no new enumerable key, JSON round-trip unchanged.
    expect(Object.keys(env.result)).toEqual(['message_id', 'chat'])
    expect(JSON.parse(JSON.stringify(env.result))).toEqual({ message_id: 7, chat: { id: CHAT } })
  })

  it('no-ops on the non-Message results a transformer also sees', () => {
    expect(() => attachSentText({ ok: true, result: true }, 'x')).not.toThrow()
    expect(() => attachSentText({ ok: false, error_code: 400 }, 'x')).not.toThrow()
    expect(() => attachSentText(undefined, 'x')).not.toThrow()
    expect(readSentText(true)).toBeNull()
    expect(readSentText({ message_id: 1 })).toBeNull()
  })
})

describe('the card body survives the real send path, for every verb a card uses', () => {
  // Each row is a production card send verb reduced to the API call it makes.
  // `expected` is the body the history row MUST end up carrying.
  const cases: {
    name: string
    body: string
    send: (bot: Bot) => Promise<unknown>
    respond: (method: string) => unknown
  }[] = [
    {
      name: 'activity-summary.send / boot-card / issues-card / worker-feed (sendRichMessage)',
      body: '⚙️ Working — reading history.ts, 3 tools',
      send: (bot) =>
        bot.api.sendRichMessage(CHAT, richMessage('⚙️ Working — reading history.ts, 3 tools')),
      respond: () => richMessageResponse(20395, '⚙️ Working — reading history.ts, 3 tools'),
    },
    {
      name: 'activity-summary.edit / rollout-status-edit (rich editMessageText)',
      body: '⚙️ Working — 11 tools, editing gateway.ts',
      send: (bot) =>
        bot.api.editMessageText(CHAT, 20395, richMessage('⚙️ Working — 11 tools, editing gateway.ts')),
      respond: () => richMessageResponse(20395, '⚙️ Working — 11 tools, editing gateway.ts'),
    },
    {
      name: 'permission_request (sendRichMessage with an inline keyboard)',
      body: '**Approve** `docker restart switchroom-clerk`?',
      send: (bot) =>
        bot.api.sendRichMessage(CHAT, richMessage('**Approve** `docker restart switchroom-clerk`?'), {
          reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'ok' }]] },
        }),
      respond: () => richMessageResponse(20406, 'Approve docker restart switchroom-clerk?'),
    },
    {
      name: 'privacy-reset-alert / restart notices (plain sendMessage)',
      body: 'Restarting — back in a moment.',
      send: (bot) => bot.api.sendMessage(CHAT, 'Restarting — back in a moment.'),
      respond: () => plainMessageResponse(20410, 'Restarting — back in a moment.'),
    },
    {
      name: 'a media card (sendPhoto caption)',
      body: 'fleet quota, last 24h',
      send: (bot) => bot.api.sendPhoto(CHAT, 'file-id', { caption: 'fleet quota, last 24h' }),
      respond: () => ({
        message_id: 20411,
        date: 0,
        chat: { id: CHAT, type: 'private' },
        photo: [{ file_id: 'file-id', file_unique_id: 'u', width: 1, height: 1 }],
        caption: 'fleet quota, last 24h',
      }),
    },
  ]

  for (const c of cases) {
    it(`${c.name} → the observer records a NON-EMPTY body`, async () => {
      const { bot } = makeBot(c.respond)
      const result = await c.send(bot)

      // The outcome that #4576 got wrong: the extractor yields the real body.
      const extracted = extractSentMessage(result, { chat_id: String(CHAT) })
      expect(extracted).not.toBeNull()
      expect(extracted!.text).toBe(c.body)
      expect(extracted!.text.length).toBeGreaterThan(0)

      // …and it reaches the history writer that way.
      const written: { text: string; kind: string | null }[] = []
      const observe = makeSystemMessageObserver({
        insert: (a) => {
          written.push({ text: a.text, kind: a.kind })
          return true
        },
        updateText: () => true,
      })
      observe(result, { chat_id: String(CHAT), verb: 'activity-summary.send' })
      expect(written).toHaveLength(1)
      expect(written[0].text).toBe(c.body)
    })
  }

  it('captures the body the CALLER wrote, not the wire-escaped form', async () => {
    // The fmt guard escapes `#` on the wire; the stored antecedent should read
    // as the operator saw it. Capture composes outside the guard for this reason.
    const { bot, calls } = makeBot(() => richMessageResponse(1, '#4576 landed'))
    const result = await bot.api.sendRichMessage(CHAT, { markdown: '#4576 landed' })
    expect((calls[calls.length - 1].body.rich_message as { markdown: string }).markdown).toBe(
      '\\#4576 landed',
    )
    expect(readSentText(result)).toBe('#4576 landed')
  })

  it('stamps nothing on the bodiless verbs, so the observer still ignores them', async () => {
    const { bot } = makeBot(() => true)
    const pinned = await bot.api.pinChatMessage(CHAT, 42)
    expect(pinned).toBe(true)
    expect(extractSentMessage(pinned, { chat_id: String(CHAT) })).toBeNull()
  })
})

describe('regression: the pre-fix response shape', () => {
  it('a rich-message response with NO capture stamp still yields a body, not ""', () => {
    // Belt-and-braces layer 2: a Message that never transited a capture-installed
    // bot (a second Bot instance, a replayed response) falls back to flattening
    // the echoed `rich_message` rather than storing an empty row.
    const raw = richMessageResponse(20395, '⚙️ Working — 3 tools')
    expect(readSentText(raw)).toBeNull()
    expect(extractSentMessage(raw, { chat_id: String(CHAT) })?.text).toBe('⚙️ Working — 3 tools')
  })

  it('an unrecognised bodiless shape fires the empty-text alarm exactly once per kind', () => {
    const alarms: { kind: string | null }[] = []
    const observe = makeSystemMessageObserver({
      insert: () => true,
      updateText: () => true,
      onEmptyText: (i) => alarms.push({ kind: i.kind }),
    })
    for (const id of [1, 2, 3]) {
      observe({ message_id: id, chat: { id: CHAT } }, { chat_id: String(CHAT), verb: 'mystery-card' })
    }
    observe({ message_id: 9, chat: { id: CHAT } }, { chat_id: String(CHAT), verb: 'other-card' })
    expect(alarms).toEqual([{ kind: 'mystery-card' }, { kind: 'other-card' }])
  })

  it('an empty refresh never blanks a body that was already stored', () => {
    const rows = new Map<number, string>()
    let now = 1_000
    const observe = makeSystemMessageObserver({
      insert: (a) => {
        rows.set(a.message_id, a.text)
        return true
      },
      updateText: (a) => {
        rows.set(a.message_id, a.text)
        return true
      },
      now: () => now,
    })
    observe(
      { message_id: 5, chat: { id: CHAT }, rich_message: { blocks: [{ text: { text: 'card v1' } }] } },
      { chat_id: String(CHAT), verb: 'activity-summary.send' },
    )
    expect(rows.get(5)).toBe('card v1')

    now += 10 * 60_000
    // A later edit whose body did not reach us for any reason.
    observe({ message_id: 5, chat: { id: CHAT } }, { chat_id: String(CHAT), verb: 'activity-summary.edit' })
    expect(rows.get(5)).toBe('card v1')
  })
})

/**
 * The capture only works if it is actually installed. grammY's transformers are
 * anonymous fns with nothing to grip at runtime, so the wiring is pinned at the
 * source level — the same approach `format-guard-pins.test.ts` uses for the
 * markdown guard. Without this, a refactor could silently drop the seam and
 * every card row would go back to being empty with no test turning red.
 */
describe('boot wiring: installSentTextCapture is on the production Bot', () => {
  const gatewayPath = resolve(
    dirname(fileURLToPath(import.meta.url)), '..', 'gateway', 'gateway.ts',
  )
  const src = readFileSync(gatewayPath, 'utf8')
  const sourceFile = ts.createSourceFile(gatewayPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  it("imports installSentTextCapture from '../shared/sent-text-capture.js'", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\binstallSentTextCapture\b[^}]*\}\s*from\s*'\.\.\/shared\/sent-text-capture\.js'/,
    )
  })

  it('calls installSentTextCapture(bot) exactly once inside initGatewayBot()', () => {
    const fn = sourceFile.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'initGatewayBot',
    )
    expect(fn?.body).toBeDefined()
    let count = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'installSentTextCapture'
      ) {
        count++
        expect(node.arguments[0]?.getText(sourceFile)).toBe('bot')
      }
      ts.forEachChild(node, visit)
    }
    visit(fn!.body!)
    expect(count).toBe(1)
  })

  it('installs it AFTER the markdown guard, so it captures the pre-escape body', () => {
    expect(src.indexOf('installRichMarkdownGuard(bot)')).toBeLessThan(
      src.indexOf('installSentTextCapture(bot)'),
    )
  })

  it('gets the empty-body alarm WITHOUT having to wire it — it is the default', () => {
    // gateway.ts constructs the observer with insert/updateText only (it is
    // under the anti-inflation line ratchet, switchroom#2996). So the alarm
    // that makes a recurrence loud instead of silent-for-a-release, as #4576
    // was, has to be the observer's DEFAULT — opting out must be the explicit
    // act. Asserted as behaviour, not as a source pattern.
    const written: string[] = []
    const stderrWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
      written.push(String(chunk))
      return true
    }
    try {
      const observe = makeSystemMessageObserver({
        insert: () => true,
        updateText: () => true,
      })
      observe({ message_id: 991, chat: { id: 5550001 } }, { chat_id: '5550001', verb: 'boot-card' })
    } finally {
      ;(process.stderr as unknown as { write: unknown }).write = stderrWrite
    }
    expect(written.join('')).toContain('card-history text capture MISSED kind=boot-card')
  })
})
