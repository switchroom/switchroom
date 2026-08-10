/**
 * Reply-to buffer fallback + role tag + native partial-quote preference.
 *
 * WHAT THESE PIN (post-reset conversation continuity)
 * ---------------------------------------------------
 * The real incident: after a session reset (`resume_mode: handoff` → fresh
 * session, transcript gone) a user native-REPLIED to one of the BOT's OWN
 * messages ("is this added as a calendar invite yet?"). Telegram delivers
 * `reply_to_message.message_id` on such a reply but NOT the message's `.text`
 * (it omits the text when the reply target is the bot's own message), so the
 * live update carried no antecedent — and the agent had to guess. The bot had
 * already persisted that outbound to `history.db` via `recordOutbound`
 * (role='assistant'); the fix reads it back.
 *
 * These are OUTCOME tests against the real pure builders, not the code paths:
 *   - `resolveReplyToFromBuffer` recovers the text AND the role from a buffer
 *     hit, truncates to the cap, and — critically — sets BOTH the raw
 *     `replyToText` (which the gateway's recordInbound write persists, so the
 *     DB row is non-NULL for future briefings) and the escaped form (for the
 *     envelope). A test that only checked the envelope would pass on the
 *     rejected envelope-only design and miss the NULL-row regression.
 *   - The history-disabled / lookup-throws guard degrades silently (no throw).
 *   - A non-empty LIVE reply text is never overwritten.
 *   - `buildReplyForwardContext` prefers `message.quote.text` (a native
 *     partial quote) over the full parent `.text`.
 *   - `buildInboundEnvelope` emits `reply_to_role` when known and `reply_to_text`
 *     from the recovered escaped form.
 *   - `buildReplyForwardContext` reads a RICH parent's body off
 *     `reply_to_message.rich_message` LIVE (#4598) — the only path that can
 *     resolve a card the buffer never recorded. The last describe block pins
 *     that, including a killer case a buffer-only implementation must fail.
 *
 * The persisted-row-non-NULL half of the 1a contract (which needs a real
 * bun:sqlite history.db) lives in reply-to-buffer-history.test.ts (bun).
 */

import { describe, it, expect } from 'vitest'
import type { Context } from 'grammy'
import {
  buildReplyForwardContext,
  resolveReplyToFromBuffer,
  buildInboundEnvelope,
  type EnvelopeBuildParams,
} from '../gateway/inbound-router.js'

const REPLY_TO_TEXT_MAX = 200

/** A minimal grammy Context carrying only the message fields the builders read. */
function makeCtx(message: Record<string, unknown>): Context {
  return { message: { date: 1_700_000_000, ...message } } as unknown as Context
}

describe('resolveReplyToFromBuffer — reply-to buffer fallback (1a)', () => {
  it('recovers a bot-authored antecedent: sets raw text, escaped text, AND role', () => {
    // Live update: a native reply to the bot's own message → id present, text empty.
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 42,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: (id) =>
        id === 42
          ? { role: 'assistant', text: 'Added the calendar invite for Friday 3pm.' }
          : null,
    })
    // Raw text (for the SQLite recordInbound write — NOT envelope-only).
    expect(out.replyToText).toBe('Added the calendar invite for Friday 3pm.')
    // Escaped form (for the channel-meta reply_to_text).
    expect(out.replyToTextEscaped).toBe('Added the calendar invite for Friday 3pm.')
    // Role disambiguates "you are replying to the bot's own message".
    expect(out.replyToRole).toBe('assistant')
  })

  it("tags a person's message as role='user'", () => {
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 7,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => ({ role: 'user', text: 'the thing I asked earlier' }),
    })
    expect(out.replyToRole).toBe('user')
    expect(out.replyToText).toBe('the thing I asked earlier')
  })

  it('truncates the recovered text to REPLY_TO_TEXT_MAX (raw and escaped)', () => {
    const long = 'x'.repeat(500)
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 1,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => ({ role: 'assistant', text: long }),
    })
    // Raw: sliced to max-1 chars + ellipsis = exactly max glyphs.
    expect([...(out.replyToText ?? '')].length).toBe(REPLY_TO_TEXT_MAX)
    expect(out.replyToText?.endsWith('…')).toBe(true)
    expect([...(out.replyToTextEscaped ?? '')].length).toBe(REPLY_TO_TEXT_MAX)
  })

  it('does NOT overwrite a non-empty LIVE reply text (reply to a person, or a partial quote)', () => {
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 9,
      replyToText: 'live raw text',
      replyToTextEscaped: 'live escaped text',
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => ({ role: 'user', text: 'STALE BUFFER TEXT' }),
    })
    expect(out.replyToText).toBe('live raw text')
    expect(out.replyToTextEscaped).toBe('live escaped text')
    // …but the lookup still supplies the ROLE, which has no live-update source.
    expect(out.replyToRole).toBe('user')
  })

  it('a missing row does not clobber a live reply text', () => {
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 9,
      replyToText: 'live raw text',
      replyToTextEscaped: 'live escaped text',
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => null,
    })
    expect(out.replyToText).toBe('live raw text')
    expect(out.replyToRole).toBeUndefined()
    expect(out.replyToKind).toBeUndefined()
  })

  it('history-disabled guard: never calls lookup, degrades to id-only, does not throw', () => {
    let called = false
    const call = () =>
      resolveReplyToFromBuffer({
        replyToMessageId: 5,
        replyToText: undefined,
        replyToTextEscaped: undefined,
        historyEnabled: false,
        replyToTextMax: REPLY_TO_TEXT_MAX,
        lookup: () => {
          called = true
          throw new Error('requireDb would throw with history disabled')
        },
      })
    expect(call).not.toThrow()
    expect(called).toBe(false)
    expect(call().replyToText).toBeUndefined()
    expect(call().replyToRole).toBeUndefined()
  })

  it('a lookup that throws (requireDb mid-run) degrades silently', () => {
    let out: ReturnType<typeof resolveReplyToFromBuffer> | undefined
    expect(() => {
      out = resolveReplyToFromBuffer({
        replyToMessageId: 5,
        replyToText: undefined,
        replyToTextEscaped: undefined,
        historyEnabled: true,
        replyToTextMax: REPLY_TO_TEXT_MAX,
        lookup: () => {
          throw new Error('SQLITE_ERROR')
        },
      })
    }).not.toThrow()
    expect(out?.replyToText).toBeUndefined()
    expect(out?.replyToRole).toBeUndefined()
  })

  it('a missing row (reacted-to message predates retention) yields id-only', () => {
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 999,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => null,
    })
    expect(out.replyToText).toBeUndefined()
    expect(out.replyToRole).toBeUndefined()
  })

  it('a row with empty text still surfaces the role (authorship known, text redacted)', () => {
    const out = resolveReplyToFromBuffer({
      replyToMessageId: 3,
      replyToText: undefined,
      replyToTextEscaped: undefined,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => ({ role: 'assistant', text: '' }),
    })
    expect(out.replyToRole).toBe('assistant')
    expect(out.replyToText).toBeUndefined()
  })
})

describe('buildReplyForwardContext — native partial-quote preference (2a)', () => {
  it('prefers message.quote.text over the full parent .text', () => {
    const ctx = makeCtx({
      reply_to_message: { message_id: 100, text: 'the entire long parent message body' },
      quote: { text: 'the exact fragment I selected', position: 5, is_manual: true },
    })
    const out = buildReplyForwardContext({ ctx, coalescedForwardOrigins: undefined, replyToTextMax: REPLY_TO_TEXT_MAX })
    expect(out.replyToMessageId).toBe(100)
    expect(out.replyToText).toBe('the exact fragment I selected')
    expect(out.replyToTextEscaped).toBe('the exact fragment I selected')
  })

  it('falls back to the parent .text when there is no quote', () => {
    const ctx = makeCtx({
      reply_to_message: { message_id: 101, text: 'parent body only' },
    })
    const out = buildReplyForwardContext({ ctx, coalescedForwardOrigins: undefined, replyToTextMax: REPLY_TO_TEXT_MAX })
    expect(out.replyToText).toBe('parent body only')
  })

  it('leaves reply text empty when the bot-authored parent carries no text (the 1a trigger)', () => {
    const ctx = makeCtx({ reply_to_message: { message_id: 102 } })
    const out = buildReplyForwardContext({ ctx, coalescedForwardOrigins: undefined, replyToTextMax: REPLY_TO_TEXT_MAX })
    expect(out.replyToMessageId).toBe(102)
    expect(out.replyToText).toBeUndefined()
    expect(out.replyToTextEscaped).toBeUndefined()
  })
})

/**
 * Rich-message parents (#4598).
 *
 * Every card the gateway posts ships via Bot API 10.1 `sendRichMessage`, so a
 * native reply to one delivers a `reply_to_message` with `rich_message.blocks`
 * populated and `text` / `caption` ABSENT. Measured on the wire against a real
 * bot: keys `[message_id, from, chat, date, rich_message]`.
 *
 * Before #4598 the body of a card antecedent was 100% buffer-sourced, so a
 * card that never made it into `history.db` — posted while the gateway was
 * down, or through a send path that bypassed the recording chokepoint — was
 * permanently unresolvable no matter how the recording side was fixed. These
 * pin the LIVE read.
 */
describe('buildReplyForwardContext — rich_message parent (#4598)', () => {
  /** The shape Telegram actually delivers for a reply to a card. */
  function richParent(message_id: number) {
    return {
      message_id,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: [{ type: 'bold', text: 'Usage' }, ' this week'] },
          { type: 'paragraph', text: 'Opus 41% then Sonnet 12%' },
        ],
      },
    }
  }

  const RENDERED = 'Usage this week\nOpus 41% then Sonnet 12%'

  it('reads the parent body off rich_message when text and caption are absent', () => {
    const ctx = makeCtx({ reply_to_message: richParent(9938) })
    const out = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })
    expect(out.replyToMessageId).toBe(9938)
    expect(out.replyToText).toBe(RENDERED)
    expect(out.replyToTextEscaped).toBe(RENDERED)
  })

  it('truncates a long rich body to the cap, like every other antecedent', () => {
    const ctx = makeCtx({
      reply_to_message: {
        message_id: 1,
        rich_message: { blocks: [{ type: 'paragraph', text: 'x'.repeat(400) }] },
      },
    })
    const out = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })
    expect(out.replyToText).toHaveLength(REPLY_TO_TEXT_MAX)
    expect(out.replyToText?.endsWith('…')).toBe(true)
  })

  it('yields undefined (not empty string) for an unrenderable block tree, so the buffer still runs', () => {
    // A thinking-only / media-stripped card renders to nothing. It must fall
    // THROUGH to the buffer rather than pinning the antecedent to ''.
    const ctx = makeCtx({
      reply_to_message: { message_id: 5, rich_message: { blocks: [{ type: 'thinking' }] } },
    })
    const live = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })
    expect(live.replyToText).toBeUndefined()
    expect(live.replyToTextEscaped).toBeUndefined()

    const out = resolveReplyToFromBuffer({
      replyToMessageId: live.replyToMessageId,
      replyToText: live.replyToText,
      replyToTextEscaped: live.replyToTextEscaped,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => ({ role: 'system', text: 'stored card body', kind: 'activity-summary' }),
    })
    expect(out.replyToText).toBe('stored card body')
    expect(out.replyToKind).toBe('activity-summary')
  })

  it('prefers a native partial quote over the rich parent body', () => {
    const ctx = makeCtx({
      reply_to_message: richParent(7),
      quote: { text: 'Opus 41%', position: 5, is_manual: true },
    })
    const out = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })
    expect(out.replyToText).toBe('Opus 41%')
  })

  it('THE BUFFER-ONLY KILLER: the live rich body wins over a DIFFERENT stored row', () => {
    // A buffer-only implementation resolves this reply from the stored row and
    // returns the STALE text — which is the point: this is the one test in the
    // file that a recording-side-only fix cannot pass. The lookup DOES run
    // (role/kind have no live source, see the next test) but it must not be
    // allowed to win the text, so the stub deliberately returns a different
    // body from the one on the wire.
    const ctx = makeCtx({ reply_to_message: richParent(9925) })
    const live = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })

    let lookupCalls = 0
    const out = resolveReplyToFromBuffer({
      replyToMessageId: live.replyToMessageId,
      replyToText: live.replyToText,
      replyToTextEscaped: live.replyToTextEscaped,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      lookup: () => {
        lookupCalls++
        return { role: 'system', text: 'STALE BUFFER TEXT', kind: 'usage-card' }
      },
    })

    expect(out.replyToText).toBe(RENDERED)
    expect(out.replyToTextEscaped).toBe(RENDERED)
    expect(out.replyToText).not.toContain('STALE BUFFER TEXT')
    // The row was consulted — for role/kind only, never for the body.
    expect(lookupCalls).toBe(1)
  })

  it('a live-resolved rich body still carries reply_to_role AND reply_to_kind through the envelope', () => {
    // The regression the `liveTextEmpty` gate introduced: an operator FULL-
    // replies (no partial quote) to a live activity card whose row IS in
    // history.db. The body now resolves live off `rich_message` — and if that
    // short-circuits the lookup, the envelope loses `reply_to_role="system"`
    // and `reply_to_kind="activity-summary"` entirely, killing the #4571 kind
    // lane for exactly the case it was built for.
    const ctx = makeCtx({ reply_to_message: richParent(9925) })
    const live = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })
    const resolved = resolveReplyToFromBuffer({
      replyToMessageId: live.replyToMessageId,
      replyToText: live.replyToText,
      replyToTextEscaped: live.replyToTextEscaped,
      historyEnabled: true,
      replyToTextMax: REPLY_TO_TEXT_MAX,
      // The row IS recorded — same card, stored body.
      lookup: () => ({ role: 'system', text: RENDERED, kind: 'activity-summary' }),
    })
    expect(resolved.replyToRole).toBe('system')
    expect(resolved.replyToKind).toBe('activity-summary')

    const msg = buildInboundEnvelope(
      makeEnvelopeParams({
        ctx,
        replyToMessageId: live.replyToMessageId,
        replyToTextEscaped: resolved.replyToTextEscaped,
        replyToRole: resolved.replyToRole,
        replyToKind: resolved.replyToKind,
      }),
    )
    expect(msg.meta?.reply_to_text).toBe(RENDERED)
    expect(msg.meta?.reply_to_role).toBe('system')
    expect(msg.meta?.reply_to_kind).toBe('activity-summary')
  })

  it('carries the live rich body through to the inbound envelope', () => {
    const ctx = makeCtx({ reply_to_message: richParent(9925) })
    const live = buildReplyForwardContext({
      ctx,
      coalescedForwardOrigins: undefined,
      replyToTextMax: REPLY_TO_TEXT_MAX,
    })
    const msg = buildInboundEnvelope(
      makeEnvelopeParams({
        ctx,
        replyToMessageId: live.replyToMessageId,
        replyToTextEscaped: live.replyToTextEscaped,
      }),
    )
    expect(msg.meta?.reply_to_message_id).toBe('9925')
    expect(msg.meta?.reply_to_text).toBe(RENDERED)
  })
})

function makeEnvelopeParams(overrides: Partial<EnvelopeBuildParams>): EnvelopeBuildParams {
  return {
    ctx: makeCtx({}),
    chat_id: '5550001',
    messageThreadId: undefined,
    msgId: 200,
    effectiveText: 'is this added as a calendar invite yet?',
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
    replyToMessageId: 42,
    replyToTextEscaped: undefined,
    replyToRole: undefined,
    forwardOriginMeta: {},
    topicFramingEnabled: false,
    personDirectory: { byTelegramKey: {} },
    isDmChatId: () => true,
    ...overrides,
  }
}

describe('buildInboundEnvelope — reply_to_role + reply_to_text emission', () => {
  it('emits reply_to_role and reply_to_text when the buffer fallback recovered them', () => {
    const msg = buildInboundEnvelope(
      makeEnvelopeParams({
        replyToMessageId: 42,
        replyToTextEscaped: 'Added the calendar invite for Friday 3pm.',
        replyToRole: 'assistant',
      }),
    )
    expect(msg.meta?.reply_to_message_id).toBe('42')
    expect(msg.meta?.reply_to_text).toBe('Added the calendar invite for Friday 3pm.')
    expect(msg.meta?.reply_to_role).toBe('assistant')
  })

  it('omits reply_to_role when unknown (no buffer hit) but still emits the id', () => {
    const msg = buildInboundEnvelope(
      makeEnvelopeParams({ replyToMessageId: 42, replyToTextEscaped: undefined, replyToRole: undefined }),
    )
    expect(msg.meta?.reply_to_message_id).toBe('42')
    expect('reply_to_role' in (msg.meta ?? {})).toBe(false)
    expect('reply_to_text' in (msg.meta ?? {})).toBe(false)
  })

  it("emits reply_to_role='user' for a recovered person message", () => {
    const msg = buildInboundEnvelope(
      makeEnvelopeParams({
        replyToTextEscaped: 'the thing I asked earlier',
        replyToRole: 'user',
      }),
    )
    expect(msg.meta?.reply_to_role).toBe('user')
  })
})
