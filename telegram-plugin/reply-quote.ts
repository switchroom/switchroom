/**
 * Surgical quote-reply parameters (`reply_parameters.quote`).
 *
 * The `reply` / `stream_reply` tools document a `quote_text` argument: quote a
 * specific fragment of the message being replied to, so the reply visibly
 * anchors on that fragment instead of the whole message.
 *
 * WIRE SHAPE — the bug this module exists to make unrepeatable
 * ------------------------------------------------------------
 * Bot API `ReplyParameters` (https://core.telegram.org/bots/api#replyparameters):
 *
 *   quote           String   Quoted part of the message to be replied to;
 *                            0-1024 characters after entities parsing.
 *   quote_parse_mode String  Mode for parsing entities in the quote.
 *   quote_entities   Array   Entities in the quote.
 *   quote_position   Integer Position of the quote in the original message in
 *                            UTF-16 code units.
 *
 * `quote` is a **String** and `quote_position` is a **separate sibling
 * Integer**. Both send sites used to emit `quote: { text, position: 0 }` — an
 * object — so Telegram rejected every quoted reply with
 * `400 Bad Request: field "quote" must be of type String`, the reply threw, and
 * the agent re-attempted a payload that could never be accepted. A fleet sweep
 * of `tg-post method=sendRichMessage … status=err` lines found 378 of 384 total
 * send failures were this one error (agent `overlord`, 2026-07-29 → 07-30, in
 * retry bursts). The feature had never worked.
 *
 * DELIBERATE OMISSIONS
 * --------------------
 * - **No `quote_position`.** Telegram locates the quote text on its own; a
 *   fabricated `0` is what encouraged the object shape in the first place, and
 *   neither send site has a real position source (the model supplies text, not
 *   an offset). A wrong position is worse than none: it either mislocates the
 *   highlight or 400s.
 * - **No `quote_parse_mode` / `quote_entities`, and therefore NO HTML
 *   escaping.** With no parse mode the quote is matched as literal text, which
 *   is exactly what `quote_text` carries (plain text the model copied out of
 *   the user's message). Escaping it (`&` → `&amp;`) would make the string stop
 *   being an exact substring of the original and guarantee a rejection.
 *
 * REJECTION HANDLING
 * ------------------
 * The quote must be an exact substring of the target message; Telegram 400s
 * when it isn't found. That is a *quote* failure, not an answer failure — the
 * reply body is still correct and must still be delivered. {@link
 * isQuoteRejectionError} classifies it and {@link dropQuoteFromSendOpts}
 * produces the same options with the quote removed, so callers can retry once
 * and land the reply as an ordinary (unquoted) reply.
 */

import { GrammyError } from 'grammy'

import { isHtmlParseRejectError, isMessageTooLongError } from './retry-api-call.js'

/** Bot API cap: `quote` is 0-1024 characters after entities parsing. */
export const QUOTE_MAX_CHARS = 1024

/**
 * Normalize a caller-supplied `quote_text` into the string Telegram accepts, or
 * `null` when there is nothing worth quoting.
 *
 * - empty / whitespace-only ⇒ `null` (an empty quote highlights nothing and is
 *   a guaranteed rejection).
 * - longer than {@link QUOTE_MAX_CHARS} ⇒ truncated. A PREFIX of an exact
 *   substring is still an exact substring, so truncation still matches the
 *   original message, whereas an over-length quote is a certain 400. The cut
 *   never splits a surrogate pair (a lone surrogate is not valid UTF-8 on the
 *   wire).
 * - otherwise verbatim — never escaped, never trimmed (leading/trailing spaces
 *   are part of the substring the user may have selected).
 */
export function normalizeQuoteText(quoteText: string | null | undefined): string | null {
  if (typeof quoteText !== 'string') return null
  if (quoteText.trim().length === 0) return null
  if (quoteText.length <= QUOTE_MAX_CHARS) return quoteText
  let end = QUOTE_MAX_CHARS
  const code = quoteText.charCodeAt(end - 1)
  // High surrogate at the cut boundary ⇒ drop it rather than emit half a pair.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return quoteText.slice(0, end)
}

/**
 * Build the `reply_parameters` object for a reply to `messageId`, optionally
 * carrying a surgical quote.
 *
 * This is the ONLY place the `quote` field is constructed. Both send sites (the
 * `reply` chunk loop in `gateway/outbound-send-path.ts` and the `stream_reply`
 * controller in `stream-controller.ts`) call it, so the wire shape cannot drift
 * apart again.
 */
export function buildReplyParameters(
  messageId: number,
  quoteText?: string | null,
): { message_id: number; quote?: string } {
  const quote = normalizeQuoteText(quoteText)
  return { message_id: messageId, ...(quote != null ? { quote } : {}) }
}

/**
 * True when Telegram rejected the send because of the QUOTE, not the body.
 *
 * Covers the "quote isn't in the original message" family (the documented
 * failure mode) and any other 400 naming the quote — matched on the word rather
 * than one exact phrase, because the Bot API's wording for this class has
 * changed before (`QUOTE_TEXT_INVALID` vs the prose form) and a missed match
 * costs the whole answer.
 *
 * A BODY error must never be claimed here, though, and the word alone is not
 * enough to tell them apart: `<blockquote>` in a rich body produces
 * `can't parse entities: Can't find end tag corresponding to start tag
 * "blockquote"` / `Unsupported start tag "blockquote"` — 400s that contain the
 * substring "quote" but are PARSE failures. Claiming one would drop the quote
 * and resend the same unparseable body, hit the same 400, and throw straight
 * out of the caller's fallback ladder — losing the answer that the plain-text
 * rescue would otherwise have delivered. So defer to the body classifiers
 * first, exactly as `isHtmlParseRejectError` defers to `isMessageTooLongError`
 * (retry-api-call.ts) for the same reason. No false negative results: the real
 * quote rejections (`QUOTE_TEXT_INVALID`, "message quote not found") contain
 * neither a parse phrase nor a length phrase.
 */
export function isQuoteRejectionError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false
  if (isHtmlParseRejectError(err) || isMessageTooLongError(err)) return false
  return (err.description || '').toLowerCase().includes('quote')
}

/** True when `opts` carries a `reply_parameters.quote`. Structural on purpose:
 *  the reply path builds untyped `Record<string, unknown>` send options and the
 *  stream path a typed `StreamSendOpts`, and both must be checkable. */
export function sendOptsHaveQuote(opts: object): boolean {
  const rp = (opts as { reply_parameters?: { quote?: unknown } }).reply_parameters
  return rp != null && typeof rp === 'object' && rp.quote != null
}

/**
 * Same send options with the surgical quote removed — the retry payload after a
 * {@link isQuoteRejectionError}. Everything else (reply target, thread, markup,
 * notification) is preserved, so the answer still lands as a reply to the right
 * message; only the highlight is sacrificed.
 */
export function dropQuoteFromSendOpts<T extends object>(opts: T): T {
  if (!sendOptsHaveQuote(opts)) return { ...opts }
  const rp = { ...((opts as { reply_parameters: Record<string, unknown> }).reply_parameters) }
  delete rp.quote
  delete rp.quote_parse_mode
  delete rp.quote_entities
  delete rp.quote_position
  return { ...opts, reply_parameters: rp }
}
