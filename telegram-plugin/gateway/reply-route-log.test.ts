import { describe, it, expect } from 'vitest'
import { formatReplyRouteLog, type ReplyRouteLogInput } from './reply-route-log.js'

const CHAT_A = '12345678' // DM — the reply target
const CHAT_B = '-1003831053471' // forum supergroup — where the anchor lives

function line(over: Partial<ReplyRouteLogInput> = {}): string {
  return formatReplyRouteLog({
    surface: 'reply',
    chatId: CHAT_A,
    threadId: undefined,
    explicitThreadId: undefined,
    originTurn: null,
    originVia: null,
    liveTurn: null,
    recovered: null,
    frameworkTopicAuthority: true,
    hasDifferentThreadedRecentTurn: () => false,
    ...over,
  })
}

describe('formatReplyRouteLog', () => {
  it('CROSS_CHAT_ANCHOR_DROPPED names BOTH chat ids and the topic that was dropped', () => {
    const out = line({
      liveTurn: { turnId: `${CHAT_B}:635#5388`, sessionChatId: CHAT_B, sessionThreadId: 635 },
    })
    expect(out).toContain('CROSS_CHAT_ANCHOR_DROPPED(')
    expect(out).toContain(`target=${CHAT_A}`)
    expect(out).toContain(`live_chat=${CHAT_B},live_thread=635`)
    expect(out).toContain('routed→-')
  })

  it('a dropped cross-chat anchor is NOT counted as the routing tier (via=none, not via=live)', () => {
    const out = line({
      chatId: CHAT_B,
      liveTurn: { turnId: 'x', sessionChatId: '999', sessionThreadId: 7 },
    })
    expect(out).toContain('via=none')
    expect(out).toContain('late=true')
  })

  it('a dropped cross-chat anchor does NOT raise the UNROUTED alarm (it is a cross-chat send, not a lost reply)', () => {
    const out = line({
      chatId: CHAT_B, // supergroup target, resolved to no topic
      liveTurn: { turnId: 'x', sessionChatId: CHAT_A, sessionThreadId: undefined },
    })
    expect(out).not.toContain('UNROUTED')
    expect(out).toContain('CROSS_CHAT_ANCHOR_DROPPED(')
  })

  it('a SAME-chat live anchor is untouched: via=live, no cross-chat marker', () => {
    const out = line({
      chatId: CHAT_B,
      threadId: 4,
      liveTurn: { turnId: `${CHAT_B}:4#1`, sessionChatId: CHAT_B, sessionThreadId: 4 },
    })
    expect(out).toContain('via=live')
    expect(out).toContain('resolved_thread=4')
    expect(out).not.toContain('CROSS_CHAT_ANCHOR_DROPPED')
  })

  it('an origin anchor from another chat is dropped and reported with its own chat id', () => {
    const out = line({
      originTurn: { turnId: `${CHAT_B}:2#9`, sessionChatId: CHAT_B, sessionThreadId: 2 },
      originVia: 'echo',
      explicitThreadId: 11,
      threadId: 11, // explicit is the only remaining signal
    })
    expect(out).toContain(`origin_chat=${CHAT_B},origin_thread=2`)
    expect(out).toContain('via=explicit')
    expect(out).not.toContain('EXPLICIT_OVERRIDDEN')
  })

  it('UNROUTED still fires for a genuine no-owner supergroup reply (guard did not weaken it)', () => {
    expect(line({ chatId: CHAT_B })).toContain('UNROUTED(supergroup→no-topic)')
  })

  it('EXPLICIT_OVERRIDDEN still fires when a SAME-chat anchor beats the model explicit', () => {
    const out = line({
      chatId: CHAT_B,
      explicitThreadId: 99,
      threadId: 4,
      originTurn: { turnId: `${CHAT_B}:4#1`, sessionChatId: CHAT_B, sessionThreadId: 4 },
      originVia: 'echo',
    })
    expect(out).toContain('EXPLICIT_OVERRIDDEN(model→99,routed→4)')
    expect(out).toContain('via=origin')
  })

  it('MISROUTE_RISK reads the FILTERED live anchor — a cross-chat live turn cannot raise it', () => {
    const out = line({
      chatId: CHAT_B,
      liveTurn: { turnId: 'x', sessionChatId: CHAT_A, sessionThreadId: 3 },
      hasDifferentThreadedRecentTurn: () => true,
    })
    expect(out).not.toContain('MISROUTE_RISK')
  })
})
