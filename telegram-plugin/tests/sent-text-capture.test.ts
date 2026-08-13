/**
 * Card-body capture — wire-level outcome tests (#4576 follow-up).
 *
 * The defect being pinned: #4576 landed the card-history lane, and every
 * `role='system'` row it wrote across the whole fleet had `length(text) = 0`.
 * The lane's own tests passed because their fixtures hand-built a Telegram
 * `Message` with a `text` field — a shape no card send has EVER produced. Every
 * gateway card goes out via Bot API 10.1 `sendRichMessage`, whose response is a
 * `Message.RichMessageMessage`: body under `rich_message.blocks`, no `text`, no
 * `caption`. `extractSentMessage` read `msg.text ?? msg.caption ?? ''` and therefore
 * resolved `''` 100% of the time, and a quote-reply to a card gave the agent the
 * card's KIND but never its BODY.
 *
 * So these tests deliberately do NOT hand-build a response. They drive a REAL
 * grammy `Bot` with the production transformer stack and a stubbed transport
 * that answers with the REAL rich-message response shape, then assert the body
 * survives to the history writer. A test that builds its own `{ text }` fixture
 * cannot fail on this bug and is not a test of it.
 *
 * Equally: a test that hand-builds its own `{ markdown }` PAYLOAD cannot fail
 * on the escaping bug. The production caller is `richMessage(body)`, which runs
 * `guardAccidentalFormatting` in the CALLER — before any transformer can see it
 * — so every send here goes THROUGH `richMessage()`, never around it.
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
 * `@grammyjs/types` 4.0.0 (the version `grammy@^1.45` resolves)
 * `message.d.ts:98` (`RichMessageMessage = CommonMessage &
 * MsgWith<"rich_message">`) and `:184` (`rich_message?: RichMessage`), and
 * against the Bot API reference: `sendRichMessage` "On success, the sent
 * Message is returned", `Message.rich_message: RichMessage` "Optional. Message
 * is a rich formatted message", `RichMessage.blocks` "Content of the message".
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
  // `expected` is the body the history row MUST end up carrying — Telegram's
  // RENDERED form, which is what the response echoes and what the operator saw.
  const cases: {
    name: string
    expected: string
    send: (bot: Bot) => Promise<unknown>
    respond: (method: string) => unknown
  }[] = [
    {
      name: 'activity-summary.send / boot-card / issues-card / worker-feed (sendRichMessage)',
      expected: '⚙️ Working — reading history.ts, 3 tools',
      send: (bot) =>
        bot.api.sendRichMessage(CHAT, richMessage('⚙️ Working — reading history.ts, 3 tools')),
      respond: () => richMessageResponse(20395, '⚙️ Working — reading history.ts, 3 tools'),
    },
    {
      name: 'activity-summary.edit / rollout-status-edit (rich editMessageText)',
      expected: '⚙️ Working — 11 tools, editing gateway.ts',
      send: (bot) =>
        bot.api.editMessageText(CHAT, 20395, richMessage('⚙️ Working — 11 tools, editing gateway.ts')),
      respond: () => richMessageResponse(20395, '⚙️ Working — 11 tools, editing gateway.ts'),
    },
    {
      // The one row where the sent markdown and the rendered response DIVERGE.
      // The stored antecedent is the rendered form: `**Approve**` reaches the
      // operator's screen as bold "Approve", and that is what they quoted.
      name: 'permission_request (sendRichMessage with an inline keyboard)',
      expected: 'Approve docker restart switchroom-clerk?',
      send: (bot) =>
        bot.api.sendRichMessage(CHAT, richMessage('**Approve** `docker restart switchroom-clerk`?'), {
          reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'ok' }]] },
        }),
      respond: () => richMessageResponse(20406, 'Approve docker restart switchroom-clerk?'),
    },
    {
      name: 'privacy-reset-alert / restart notices (plain sendMessage)',
      expected: 'Restarting — back in a moment.',
      send: (bot) => bot.api.sendMessage(CHAT, 'Restarting — back in a moment.'),
      respond: () => plainMessageResponse(20410, 'Restarting — back in a moment.'),
    },
    {
      name: 'a media card (sendPhoto caption)',
      expected: 'fleet quota, last 24h',
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
      expect(extracted!.text).toBe(c.expected)
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
      expect(written[0].text).toBe(c.expected)
    })
  }

  /**
   * The fidelity property, asserted through the REAL caller.
   *
   * `richMessage()` runs `guardAccidentalFormatting` in the CALLER, upstream of
   * every transformer, so the request-side stamp on this path is the ESCAPED
   * wire form and there is no seam that could make it otherwise. A test that
   * hand-builds `{ markdown: '…' }` bypasses that and passes even when the
   * stored body is `sent\_text\_capture.ts`. These send through `richMessage()`
   * and assert the STORED body is the clean one — which is only true because
   * the observer prefers the response's rendered `rich_message`.
   */
  const escaping: { body: string; wire: string }[] = [
    { body: '⚙️ Working — editing sent_text_capture.ts', wire: '⚙️ Working — editing sent\\_text\\_capture.ts' },
    { body: '💸 Spend today: $12.40 (~$0.50/turn)', wire: '💸 Spend today: \\$12.40 (~\\$0.50/turn)' },
    { body: '#4576 landed', wire: '\\#4576 landed' },
  ]
  for (const { body, wire } of escaping) {
    it(`stores ${JSON.stringify(body)} unescaped, though the wire carries ${JSON.stringify(wire)}`, async () => {
      const { bot, calls } = makeBot(() => richMessageResponse(4576, body))
      // The production call, verbatim: richMessage() escapes, then we send.
      const result = await bot.api.sendRichMessage(CHAT, richMessage(body))

      // Pin the premise: the wire really is escaped, so the request-side stamp
      // cannot be the source of a clean stored body.
      expect((calls[calls.length - 1].body.rich_message as { markdown: string }).markdown).toBe(wire)
      expect(readSentText(result)).toBe(wire)

      // The outcome: what lands in history.db round-trips unescaped.
      const written: string[] = []
      const observe = makeSystemMessageObserver({
        insert: (a) => {
          written.push(a.text)
          return true
        },
        updateText: () => true,
      })
      observe(result, { chat_id: String(CHAT), verb: 'activity-summary.send' })
      expect(written).toEqual([body])
    })
  }

  it('stamps nothing on the bodiless verbs, so the observer still ignores them', async () => {
    const { bot } = makeBot(() => true)
    const pinned = await bot.api.pinChatMessage(CHAT, 42)
    expect(pinned).toBe(true)
    expect(extractSentMessage(pinned, { chat_id: String(CHAT) })).toBeNull()
  })
})

describe('the request-side stamp is the FALLBACK tier, never the preferred one', () => {
  it('a response whose rich blocks render to nothing falls back to the stamped body', async () => {
    // A media-only card: `rich_message` is present but flattens to '', and
    // there is no `text` / `caption`. Without the stamp this row would be
    // empty; with it, the escaped-but-readable request body is stored.
    const { bot } = makeBot(() => ({
      message_id: 20500,
      date: 0,
      chat: { id: CHAT, type: 'private' },
      rich_message: { blocks: [{ type: 'anchor', name: 'top' }] },
    }))
    const result = await bot.api.sendRichMessage(CHAT, richMessage('fleet quota chart'))
    expect(extractSentMessage(result, { chat_id: String(CHAT) })?.text).toBe('fleet quota chart')
  })

  it('the response wins whenever it has a body, even though a stamp is present', async () => {
    const { bot } = makeBot(() => richMessageResponse(20501, 'rendered by Telegram'))
    const result = await bot.api.sendRichMessage(CHAT, richMessage('written by the caller'))
    expect(readSentText(result)).toBe('written by the caller')
    expect(extractSentMessage(result, { chat_id: String(CHAT) })?.text).toBe('rendered by Telegram')
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

  it('the edit throttle NEVER pins an empty row empty — the first real body always lands', () => {
    // The dual of the rule above, and the gap that kept the #4576 symptom alive
    // on a row the once-per-kind alarm had already stopped reporting: a bodiless
    // FIRST observation inserts '' and starts the 20s throttle clock, so the
    // real body arriving 3s later was dropped and the row stayed unusable.
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
      onEmptyText: () => {},
    })
    // Open the card with a response we could not read a body out of.
    observe({ message_id: 7, chat: { id: CHAT } }, { chat_id: String(CHAT), verb: 'activity-summary.send' })
    expect(rows.get(7)).toBe('')

    // 3s later — well inside DEFAULT_EDIT_REFRESH_MS — the real body arrives.
    now += 3_000
    observe(
      { message_id: 7, chat: { id: CHAT }, rich_message: { blocks: [{ text: { text: '⚙️ Working — 3 tools' } }] } },
      { chat_id: String(CHAT), verb: 'activity-summary.edit' },
    )
    expect(rows.get(7)).toBe('⚙️ Working — 3 tools')

    // …and the throttle resumes normally once there IS something to protect.
    now += 3_000
    observe(
      { message_id: 7, chat: { id: CHAT }, rich_message: { blocks: [{ text: { text: '⚙️ Working — 9 tools' } }] } },
      { chat_id: String(CHAT), verb: 'activity-summary.edit' },
    )
    expect(rows.get(7)).toBe('⚙️ Working — 3 tools')
  })

  it('the alarm dedup key does not collapse every UNTAGGED verb into one bucket', () => {
    // `kind ?? '<untagged>'` meant the first bodiless send with no `verb`
    // permanently silenced the alarm for every other untagged verb in the
    // process — including a real regression.
    const alarms: { kind: string | null; id: number }[] = []
    const observe = makeSystemMessageObserver({
      insert: () => true,
      updateText: () => true,
      onEmptyText: (i) => alarms.push({ kind: i.kind, id: i.message_id }),
    })
    // Two DIFFERENT untagged-kind verbs: `normalizeSendVerb` returns null for a
    // blank verb, so both land in the no-kind lane.
    observe({ message_id: 31, chat: { id: CHAT } }, { chat_id: String(CHAT), verb: '   ' })
    observe({ message_id: 32, chat: { id: CHAT } }, { chat_id: String(CHAT) })
    expect(alarms).toEqual([
      { kind: null, id: 31 },
      { kind: null, id: 32 },
    ])
  })

  it('does not alarm on the verbs that are BODILESS by construction', () => {
    // sendSticker / sendAnimation / sendVoice / forwardMessage-of-media all
    // resolve a Message with no text by design. An alarm there is identical in
    // format to a real regression and unactionable, so it teaches readers to
    // ignore the alarm.
    const alarms: string[] = []
    const observe = makeSystemMessageObserver({
      insert: () => true,
      updateText: () => true,
      onEmptyText: (i) => alarms.push(i.kind ?? '<none>'),
    })
    const bodiless = [
      { message_id: 41, chat: { id: CHAT }, sticker: { file_id: 's', file_unique_id: 'u' } },
      { message_id: 42, chat: { id: CHAT }, animation: { file_id: 'a', file_unique_id: 'u' } },
      { message_id: 43, chat: { id: CHAT }, voice: { file_id: 'v', file_unique_id: 'u', duration: 2 } },
      { message_id: 44, chat: { id: CHAT }, photo: [{ file_id: 'p', file_unique_id: 'u' }] },
      { message_id: 45, chat: { id: CHAT }, checklist: { title: 'rollout', tasks: [] } },
    ]
    for (const b of bodiless) observe(b, { chat_id: String(CHAT), verb: 'sendSticker' })
    expect(alarms).toEqual([])

    // A regressed CARD is a rich_message response that rendered to nothing —
    // it carries none of those keys, so it still alarms.
    observe(
      { message_id: 46, chat: { id: CHAT }, rich_message: { blocks: [] } },
      { chat_id: String(CHAT), verb: 'activity-summary.send' },
    )
    expect(alarms).toEqual(['activity-summary'])
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

  it('installs it AFTER the markdown guard, so it composes outside it', () => {
    // Note what this does NOT claim: composing outside the guard TRANSFORMER
    // does not yield a pre-escape body on the dominant card path, because
    // `richMessage()` escapes in the caller (see the escaping cases above). It
    // only matters for the call sites that build a raw `{ markdown }` and skip
    // `richMessage()`. Kept as an ordering pin, not as a fidelity claim.
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
