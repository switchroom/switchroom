/**
 * Outcome pins for the media-envelope inbound handlers extracted from
 * gateway.ts (switchroom#2996 P6 cluster A). Each handler is driven with a
 * fake grammy ctx + mock dispatch deps; the assertions pin the EXACT text
 * envelope forwarded to `handleInbound` (and the stderr log line, and the
 * ack/refuse dispatch) — the behaviour the gateway previously produced inline.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Context } from 'grammy'
import {
  safeName,
  PASSPORT_REFUSAL_TEXT,
  handleContactMessage,
  handleLocationMessage,
  handleVenueMessage,
  handlePollMessage,
  handleWebAppDataMessage,
  handleUsersSharedMessage,
  handleChatSharedMessage,
  handleSuccessfulPaymentMessage,
  handlePassportDataMessage,
  type MediaEnvelopeDeps,
} from '../gateway/media-message-handlers.js'

function makeDeps() {
  const handleInbound = vi.fn(async () => {})
  const handleAckOnly = vi.fn(async () => {})
  const handleRefusal = vi.fn(async () => {})
  const logs: string[] = []
  const deps: MediaEnvelopeDeps = {
    handleInbound,
    handleAckOnly,
    handleRefusal,
    log: line => logs.push(line),
  }
  return { deps, handleInbound, handleAckOnly, handleRefusal, logs }
}

// Build a fake ctx whose `message` carries the given content key + a chat id.
function ctxWith(content: Record<string, unknown>, chatId: number | null = 42): any {
  return {
    message: content,
    chat: chatId == null ? undefined : { id: chatId },
  }
}

describe('safeName', () => {
  it('strips framing/injection characters', () => {
    expect(safeName('a<b>[c]\r\nd;e')).toBe('a_b__c___d_e')
  })
  it('passes undefined through', () => {
    expect(safeName(undefined)).toBeUndefined()
  })
})

describe('handleContactMessage', () => {
  it('renders the contact envelope and forwards it', async () => {
    const { deps, handleInbound, logs } = makeDeps()
    const ctx = ctxWith({
      contact: { phone_number: '+15551234', first_name: 'Ada', last_name: 'Love', user_id: 7 },
    })
    await handleContactMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(contact: name="Ada Love" phone="+15551234" user_id=7)',
      undefined,
    )
    expect(logs[0]).toBe('telegram gateway: inbound contact from chat=42\n')
  })

  it('falls back to ? for missing fields and omits user_id', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({ contact: {} })
    await handleContactMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(ctx, '(contact: name="?" phone="?")', undefined)
  })

  it('logs and swallows a builder error without forwarding', async () => {
    const { deps, handleInbound, logs } = makeDeps()
    // ctx.message is null → property access throws inside try.
    const ctx = { message: null, chat: { id: 42 } } as unknown as Context
    await handleContactMessage(ctx as any, deps)
    expect(handleInbound).not.toHaveBeenCalled()
    expect(logs.some(l => l.startsWith('telegram gateway: contact handler error:'))).toBe(true)
  })
})

describe('handleLocationMessage', () => {
  it('renders lat/lon at 6dp with live_period', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({ location: { latitude: 12.3, longitude: -45.6, live_period: 60 } })
    await handleLocationMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(location: lat=12.300000 lon=-45.600000 live_period=60s)',
      undefined,
    )
  })
  it('omits live_period when absent and ? for non-numeric coords', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({ location: {} })
    await handleLocationMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(ctx, '(location: lat=? lon=?)', undefined)
  })
})

describe('handleVenueMessage', () => {
  it('renders the venue envelope', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({
      venue: { title: 'Cafe', address: '1 St', location: { latitude: 1, longitude: 2 } },
    })
    await handleVenueMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(venue: title="Cafe" address="1 St" lat=1.000000 lon=2.000000)',
      undefined,
    )
  })
})

describe('handlePollMessage', () => {
  it('renders question, count, anonymity and first-10 choices', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({
      poll: {
        question: 'Pick',
        is_anonymous: true,
        options: [{ text: 'A' }, { text: 'B' }],
      },
    })
    await handlePollMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(poll: question="Pick" options=2 anonymous choices=[A | B])',
      undefined,
    )
  })
})

describe('handleWebAppDataMessage', () => {
  it('renders JSON-encoded data and logs byte count', async () => {
    const { deps, handleInbound, logs } = makeDeps()
    const ctx = ctxWith({ web_app_data: { data: 'hi', button_text: 'Go' } })
    await handleWebAppDataMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(web_app_data: button="Go" data="hi")',
      undefined,
    )
    expect(logs[0]).toContain('button="Go" bytes=2')
  })
  it('truncates oversized data at 4096 chars', async () => {
    const { deps, handleInbound } = makeDeps()
    const big = 'x'.repeat(5000)
    const ctx = ctxWith({ web_app_data: { data: big, button_text: 'B' } })
    await handleWebAppDataMessage(ctx, deps)
    const arg = (handleInbound as any).mock.calls[0][1] as string
    expect(arg).toContain('…(truncated)')
    expect(arg).toContain(JSON.stringify('x'.repeat(4096) + '…(truncated)'))
  })
})

describe('handleUsersSharedMessage', () => {
  it('renders shared user ids and count', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({ users_shared: { request_id: 9, users: [{ user_id: 1 }, { user_id: 2 }] } })
    await handleUsersSharedMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(users_shared: request_id=9 user_ids=[1,2] count=2)',
      undefined,
    )
  })
})

describe('handleChatSharedMessage', () => {
  it('renders shared chat with optional title', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({ chat_shared: { request_id: 3, chat_id: -100, title: 'Grp' } })
    await handleChatSharedMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(chat_shared: request_id=3 chat_id=-100 title="Grp")',
      undefined,
    )
  })
  it('omits title when absent', async () => {
    const { deps, handleInbound } = makeDeps()
    const ctx = ctxWith({ chat_shared: { request_id: 3, chat_id: -100 } })
    await handleChatSharedMessage(ctx, deps)
    expect(handleInbound).toHaveBeenCalledWith(
      ctx,
      '(chat_shared: request_id=3 chat_id=-100)',
      undefined,
    )
  })
})

describe('handleSuccessfulPaymentMessage', () => {
  it('logs structured fields and ack-only-warns, never forwarding', async () => {
    const { deps, handleInbound, handleAckOnly, logs } = makeDeps()
    const ctx = ctxWith({
      successful_payment: {
        currency: 'USD',
        total_amount: 500,
        invoice_payload: 'order-1',
        provider_payment_charge_id: 'pc',
        telegram_payment_charge_id: 'tc',
      },
    })
    await handleSuccessfulPaymentMessage(ctx, deps)
    expect(handleInbound).not.toHaveBeenCalled()
    expect(handleAckOnly).toHaveBeenCalledWith(ctx, 'successful_payment', { warn: true })
    expect(logs[0]).toContain('currency=USD total_amount=500')
    expect(logs[0]).toContain('payload="order-1"')
  })
})

describe('handlePassportDataMessage', () => {
  it('refuses with the fixed message and never forwards', async () => {
    const { deps, handleInbound, handleRefusal } = makeDeps()
    const ctx = ctxWith({ passport_data: {} })
    await handlePassportDataMessage(ctx, deps)
    expect(handleInbound).not.toHaveBeenCalled()
    expect(handleRefusal).toHaveBeenCalledWith(ctx, 'passport_data', PASSPORT_REFUSAL_TEXT)
  })
})
