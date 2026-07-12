/**
 * Pure helpers for forwarded-message origin metadata — kept out of
 * `gateway.ts` (same pattern as `coalesce-attachments.ts`) so the parsing,
 * escaping, and numbered-sibling logic can be unit-tested without the
 * gateway's `loadAccess()` / IPC machinery.
 *
 * When a user forwards a message to the bot, Telegram stamps
 * `message.forward_origin` SERVER-side (Bot API 7.0+). Unlike the message
 * body — which the forwarding user fully controls — the origin record
 * cannot be forged by typing, so it is the trusted lane for "who
 * originally sent this". The gateway surfaces it to the agent as
 * `forwarded_*` channel-meta ATTRIBUTES only; origin info is never
 * injected into the body text, keeping the attacker-influenceable body
 * and the server-stamped provenance on separate lanes.
 *
 * Caveat surfaced via `forwarded_from_type="hidden_user"`: a sender who
 * enabled forward privacy yields only a self-reported display name with
 * NO verifiable id — agents can see the name but must not treat it as an
 * authenticated identity.
 */

import type { MessageOrigin } from 'grammy/types'
import { escapeXmlAttribute } from '../steering.js'

/**
 * Cap on the human-readable origin name/title. Names and titles are
 * attacker-controlled (a hostile account can set a 4KB display name);
 * mirror the REPLY_TO_TEXT_MAX truncate-then-escape pattern with a cap
 * sized for names rather than message previews.
 */
export const FORWARDED_FROM_NAME_MAX = 100

export type ForwardOriginType = 'user' | 'hidden_user' | 'chat' | 'channel'

/**
 * Normalized origin record. `name` is RAW (truncated but unescaped) so it
 * can be persisted verbatim to the SQLite history buffer — the XML
 * escaping happens at the channel-meta boundary in
 * `buildForwardOriginMeta`, same split as `replyToText` /
 * `replyToTextEscaped` in the gateway inbound handler.
 */
export interface ForwardOriginInfo {
  /** Human-readable name/title of the original sender (raw, truncated). */
  name: string
  type: ForwardOriginType
  /** Numeric id when the origin shape exposes one (user id / chat id). */
  id?: number
  /** Unix seconds of the original message (`forward_origin.date`). */
  date?: number
  /** Channel origins only: the message id inside the origin channel. */
  messageId?: number
}

function truncateName(name: string): string {
  return name.length > FORWARDED_FROM_NAME_MAX
    ? name.slice(0, FORWARDED_FROM_NAME_MAX - 1) + '…'
    : name
}

/** Join first/last name plus a trailing `(@username)` when present. */
function personName(parts: {
  first_name?: string
  last_name?: string
  username?: string
}): string {
  const name = [parts.first_name, parts.last_name]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
  const handle = parts.username ? `(@${parts.username})` : ''
  return [name, handle].filter((p) => p.length > 0).join(' ')
}

/** Chat/channel title plus a trailing `(@username)` when present. */
function chatTitle(chat: {
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}): string {
  // Defensive: `Chat` is a union — groups/channels carry `title`, a
  // private chat carries first/last name instead. Fall through so a
  // malformed/unexpected shape still yields whatever name exists.
  if (chat.title && chat.title.length > 0) {
    const handle = chat.username ? `(@${chat.username})` : ''
    return [chat.title, handle].filter((p) => p.length > 0).join(' ')
  }
  return personName(chat)
}

/**
 * Parse Telegram's `message.forward_origin` into a normalized record.
 * Returns `undefined` for non-forwarded messages, unknown origin types,
 * and records so malformed that no human-readable name can be recovered
 * (the attrs are context, not a gate — degrading to "no origin metadata"
 * is safe; inventing a name is not).
 *
 * Accepts `unknown`-ish input defensively: the origin arrives from the
 * Telegram wire and future Bot API versions may add origin types this
 * build doesn't know.
 */
export function parseForwardOrigin(
  origin: MessageOrigin | undefined,
): ForwardOriginInfo | undefined {
  if (origin == null || typeof origin !== 'object') return undefined
  const date = typeof origin.date === 'number' ? origin.date : undefined
  switch (origin.type) {
    case 'user': {
      const u = origin.sender_user
      if (u == null || typeof u !== 'object') return undefined
      const name = personName(u)
      if (name.length === 0) {
        // No printable name at all — fall back to the (unforgeable) id.
        if (typeof u.id !== 'number') return undefined
        return { name: String(u.id), type: 'user', id: u.id, date }
      }
      return {
        name: truncateName(name),
        type: 'user',
        ...(typeof u.id === 'number' ? { id: u.id } : {}),
        date,
      }
    }
    case 'hidden_user': {
      // Forward-privacy senders: `sender_user_name` is a SELF-REPORTED
      // display name with no verifiable id. The `hidden_user` type marker
      // is the agent's signal to treat the name as unauthenticated.
      const name = typeof origin.sender_user_name === 'string'
        ? origin.sender_user_name
        : ''
      if (name.length === 0) return undefined
      return { name: truncateName(name), type: 'hidden_user', date }
    }
    case 'chat': {
      const c = origin.sender_chat
      if (c == null || typeof c !== 'object') return undefined
      const name = chatTitle(c)
      if (name.length === 0) {
        if (typeof c.id !== 'number') return undefined
        return { name: String(c.id), type: 'chat', id: c.id, date }
      }
      return {
        name: truncateName(name),
        type: 'chat',
        ...(typeof c.id === 'number' ? { id: c.id } : {}),
        date,
      }
    }
    case 'channel': {
      const c = origin.chat
      if (c == null || typeof c !== 'object') return undefined
      const name = chatTitle(c)
      const messageId = typeof origin.message_id === 'number' ? origin.message_id : undefined
      if (name.length === 0) {
        if (typeof c.id !== 'number') return undefined
        return { name: String(c.id), type: 'channel', id: c.id, date, messageId }
      }
      return {
        name: truncateName(name),
        type: 'channel',
        ...(typeof c.id === 'number' ? { id: c.id } : {}),
        date,
        messageId,
      }
    }
    default:
      // Unknown future origin type — no metadata beats wrong metadata.
      return undefined
  }
}

/**
 * Identity key for burst dedup: same-typed origins with the same id are
 * one origin; id-less shapes (hidden_user) fall back to the name.
 */
export function forwardOriginKey(o: ForwardOriginInfo): string {
  return o.id != null ? `${o.type}:${o.id}` : `${o.type}:${o.name}`
}

/**
 * Collapse the per-message origins of a coalesced burst into the DISTINCT
 * origins in arrival order. A 10-part album forwarded from one channel
 * yields ONE origin (attrs emitted once); a burst mixing forwards from two
 * different senders yields two (the second gets `forwarded_from_2` etc.).
 * Non-forwarded entries (`undefined`) are skipped. First occurrence wins,
 * so the emitted `forwarded_date` is the first message's origin date.
 */
export function dedupeForwardOrigins(
  origins: Array<ForwardOriginInfo | undefined>,
): ForwardOriginInfo[] {
  const seen = new Set<string>()
  const out: ForwardOriginInfo[] = []
  for (const o of origins) {
    if (o == null) continue
    const key = forwardOriginKey(o)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(o)
  }
  return out
}

/**
 * Build the `forwarded_*` channel-meta fields. Fixed per-origin attribute
 * order (documented here, tested in forward-origin.test.ts):
 *   forwarded_from, forwarded_from_type, forwarded_from_id, forwarded_date
 * The primary field is the human-readable NAME; the numeric id is
 * supplementary and follows it. The first origin gets the bare keys;
 * subsequent distinct origins get `_2`, `_3`, … suffixes — the same
 * numbered-sibling convention as `image_path_2` / `attachment_file_id_2`.
 *
 * Names/titles are attacker-controlled, so every value that can carry
 * user text goes through `escapeXmlAttribute` (the same escaper
 * `formatReplyToText` uses) before landing in the channel tag.
 */
export function buildForwardOriginMeta(
  origins: ForwardOriginInfo[],
): Record<string, string> {
  const out: Record<string, string> = {}
  origins.forEach((o, i) => {
    const suffix = i === 0 ? '' : `_${i + 1}`
    out[`forwarded_from${suffix}`] = escapeXmlAttribute(truncateName(o.name))
    out[`forwarded_from_type${suffix}`] = o.type
    if (o.id != null) out[`forwarded_from_id${suffix}`] = String(o.id)
    if (o.date != null) {
      out[`forwarded_date${suffix}`] = new Date(o.date * 1000).toISOString()
    }
  })
  return out
}

/** ISO form of an origin date for the SQLite history record. */
export function forwardOriginDateIso(o: ForwardOriginInfo | undefined): string | null {
  if (o?.date == null) return null
  return new Date(o.date * 1000).toISOString()
}
