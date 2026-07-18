/**
 * Media-envelope inbound handlers (switchroom#2996 P6 cluster A).
 *
 * The "envelope" `message:*` content types that carry structured metadata the
 * gateway renders into a compact text envelope for the agent — contact,
 * location, venue, poll, web_app_data, users_shared, chat_shared — plus the
 * two money/identity outliers that are deliberately NOT forwarded to the agent
 * (successful_payment → log-and-ack, passport_data → refuse), plus the
 * situational ack-only leaves (dice/game/story/paid_media → log-and-react,
 * switchroom#2996 P6 cluster B).
 *
 * Extracted VERBATIM out of gateway.ts (the P0a `registerGatewayHandlers`
 * block) so the rendering logic is unit-testable against a fake ctx + mock
 * dispatch deps, instead of living inline in a side-effecting module that
 * cannot be imported. The `bot.on('message:*')` registration lines stay in
 * gateway.ts (their ORDER is a load-bearing invariant pinned by
 * gateway-handler-registration-wiring.test.ts); each now delegates to the
 * matching handler here.
 *
 * Dispatch surfaces (`handleInbound`, `handleAckOnly`, `handleRefusal`) and
 * the stderr log sink are injected via `MediaEnvelopeDeps` — no gateway
 * module-scope globals are read here (switchroom#2996 Amendment 9).
 */

import type { Context, Filter } from 'grammy'

/**
 * Sanitize a user-supplied string for inclusion in a text envelope: strips
 * the characters that could break the envelope framing or inject markup
 * (`<>[]`, CR/LF, `;`). Shared with the attachment handlers (photo/document/
 * audio/video/animation) that still live inline in gateway.ts — imported
 * there — so it lives here as the single owner.
 */
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

/**
 * Polite, fixed refusal for inbound Telegram Passport data — a regulated
 * identity-document flow we explicitly do not process (never forwarded to the
 * LLM-driven agent).
 */
export const PASSPORT_REFUSAL_TEXT =
  "Sorry, I don't handle Telegram Passport data. Please share identity documents through a supported channel — your agent does not process encrypted Passport payloads."

/**
 * Injected dispatch + logging surfaces. `handleInbound` is the normal inbound
 * pipeline (same access gating / forward-origin parsing as every content
 * handler); `handleAckOnly` reacts without forwarding; `handleRefusal` replies
 * a refusal and never forwards; `log` is the stderr sink.
 */
export interface MediaEnvelopeDeps {
  handleInbound: (ctx: Context, text: string, downloadImage: undefined) => Promise<void>
  handleAckOnly: (
    ctx: Context,
    kind: string,
    opts?: { emoji?: string; warn?: boolean },
  ) => Promise<void>
  handleRefusal: (ctx: Context, kind: string, refusalText: string) => Promise<void>
  log: (line: string) => void
}

export async function handleContactMessage(
  ctx: Filter<Context, 'message:contact'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const c = ctx.message.contact
    const phone = safeName(c.phone_number) ?? '?'
    const first = safeName(c.first_name) ?? ''
    const last = safeName(c.last_name) ?? ''
    const name = [first, last].filter(Boolean).join(' ') || '?'
    const userIdPart = c.user_id != null ? ` user_id=${c.user_id}` : ''
    const text = `(contact: name="${name}" phone="${phone}"${userIdPart})`
    deps.log(`telegram gateway: inbound contact from chat=${ctx.chat?.id ?? '?'}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: contact handler error: ${(err as Error).message}\n`)
  }
}

export async function handleLocationMessage(
  ctx: Filter<Context, 'message:location'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const loc = ctx.message.location
    const lat = typeof loc.latitude === 'number' ? loc.latitude.toFixed(6) : '?'
    const lon = typeof loc.longitude === 'number' ? loc.longitude.toFixed(6) : '?'
    const live = (loc as { live_period?: number }).live_period != null
      ? ` live_period=${(loc as { live_period?: number }).live_period}s`
      : ''
    const text = `(location: lat=${lat} lon=${lon}${live})`
    deps.log(`telegram gateway: inbound location from chat=${ctx.chat?.id ?? '?'}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: location handler error: ${(err as Error).message}\n`)
  }
}

export async function handleVenueMessage(
  ctx: Filter<Context, 'message:venue'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const v = ctx.message.venue
    const title = safeName(v.title) ?? '?'
    const address = safeName(v.address) ?? '?'
    const lat = typeof v.location?.latitude === 'number' ? v.location.latitude.toFixed(6) : '?'
    const lon = typeof v.location?.longitude === 'number' ? v.location.longitude.toFixed(6) : '?'
    const text = `(venue: title="${title}" address="${address}" lat=${lat} lon=${lon})`
    deps.log(`telegram gateway: inbound venue from chat=${ctx.chat?.id ?? '?'}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: venue handler error: ${(err as Error).message}\n`)
  }
}

export async function handlePollMessage(
  ctx: Filter<Context, 'message:poll'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const p = ctx.message.poll
    const q = safeName(p.question) ?? '?'
    const optsCount = Array.isArray(p.options) ? p.options.length : 0
    const optsList = Array.isArray(p.options)
      ? p.options.slice(0, 10).map(o => safeName((o as { text?: string }).text) ?? '?').join(' | ')
      : ''
    const anon = p.is_anonymous ? ' anonymous' : ''
    const text = `(poll: question="${q}" options=${optsCount}${anon}${optsList ? ` choices=[${optsList}]` : ''})`
    deps.log(`telegram gateway: inbound poll from chat=${ctx.chat?.id ?? '?'}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: poll handler error: ${(err as Error).message}\n`)
  }
}

export async function handleWebAppDataMessage(
  ctx: Filter<Context, 'message:web_app_data'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const w = ctx.message.web_app_data
    // web_app_data.data is arbitrary user-supplied string from the
    // mini-app — pass it through but cap length so a malicious mini-app
    // can't blast the agent with multi-MB payloads.
    const raw = typeof w.data === 'string' ? w.data : ''
    const data = raw.length > 4096 ? raw.slice(0, 4096) + '…(truncated)' : raw
    const button = safeName(w.button_text) ?? '?'
    const text = `(web_app_data: button="${button}" data=${JSON.stringify(data)})`
    deps.log(`telegram gateway: inbound web_app_data from chat=${ctx.chat?.id ?? '?'} button="${button}" bytes=${raw.length}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: web_app_data handler error: ${(err as Error).message}\n`)
  }
}

export async function handleUsersSharedMessage(
  ctx: Filter<Context, 'message:users_shared'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const u = ctx.message.users_shared
    const users = Array.isArray(u.users) ? u.users : []
    const ids = users.map(usr => String((usr as { user_id?: number }).user_id ?? '?')).join(',')
    const text = `(users_shared: request_id=${u.request_id ?? '?'} user_ids=[${ids}] count=${users.length})`
    deps.log(`telegram gateway: inbound users_shared from chat=${ctx.chat?.id ?? '?'} count=${users.length}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: users_shared handler error: ${(err as Error).message}\n`)
  }
}

export async function handleChatSharedMessage(
  ctx: Filter<Context, 'message:chat_shared'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  try {
    const c = ctx.message.chat_shared
    const title = safeName((c as { title?: string }).title) ?? ''
    const titlePart = title ? ` title="${title}"` : ''
    const text = `(chat_shared: request_id=${c.request_id ?? '?'} chat_id=${c.chat_id ?? '?'}${titlePart})`
    deps.log(`telegram gateway: inbound chat_shared from chat=${ctx.chat?.id ?? '?'} shared_chat_id=${c.chat_id ?? '?'}\n`)
    await deps.handleInbound(ctx, text, undefined)
  } catch (err) {
    deps.log(`telegram gateway: chat_shared handler error: ${(err as Error).message}\n`)
  }
}

export async function handleSuccessfulPaymentMessage(
  ctx: Filter<Context, 'message:successful_payment'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  // Money has changed hands — log loudly with the structured fields a
  // reconciliation script would want. Do NOT forward to the agent; an
  // LLM should not be in the loop for confirming receipts.
  try {
    const p = ctx.message.successful_payment
    deps.log(
      `telegram gateway: inbound successful_payment from chat=${ctx.chat?.id ?? '?'} ` +
      `currency=${p.currency ?? '?'} total_amount=${p.total_amount ?? '?'} ` +
      `payload="${safeName(p.invoice_payload) ?? ''}" ` +
      `provider_charge=${safeName(p.provider_payment_charge_id) ?? '?'} ` +
      `telegram_charge=${safeName(p.telegram_payment_charge_id) ?? '?'}\n`,
    )
  } catch (err) {
    deps.log(`telegram gateway: successful_payment log failed: ${(err as Error).message}\n`)
  }
  await deps.handleAckOnly(ctx, 'successful_payment', { warn: true })
}

export async function handleDiceMessage(
  ctx: Filter<Context, 'message:dice'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  deps.log(`telegram gateway: inbound dice from chat=${ctx.chat?.id ?? '?'}\n`)
  await deps.handleAckOnly(ctx, 'dice', { emoji: '🎲' })
}

export async function handleGameMessage(
  ctx: Filter<Context, 'message:game'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  deps.log(`telegram gateway: inbound game from chat=${ctx.chat?.id ?? '?'}\n`)
  await deps.handleAckOnly(ctx, 'game')
}

export async function handleStoryMessage(
  ctx: Filter<Context, 'message:story'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  deps.log(`telegram gateway: inbound story from chat=${ctx.chat?.id ?? '?'}\n`)
  await deps.handleAckOnly(ctx, 'story')
}

export async function handlePaidMediaMessage(
  ctx: Filter<Context, 'message:paid_media'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  deps.log(`telegram gateway: inbound paid_media from chat=${ctx.chat?.id ?? '?'}\n`)
  await deps.handleAckOnly(ctx, 'paid_media', { warn: true })
}

export async function handlePassportDataMessage(
  ctx: Filter<Context, 'message:passport_data'>,
  deps: MediaEnvelopeDeps,
): Promise<void> {
  // Telegram Passport is a regulated identity-document flow. Forwarding
  // the encrypted credentials to an LLM-driven agent would be reckless;
  // we explicitly refuse to handle it and tell the user so they can
  // route via the proper channel. Logged at SECURITY level so operators
  // can see if a passport_data inbound ever lands here (an outlier worth
  // investigating).
  await deps.handleRefusal(ctx, 'passport_data', PASSPORT_REFUSAL_TEXT)
}
