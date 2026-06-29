/**
 * Rich-message send/edit helpers (Bot API 10.1, #2669).
 *
 * Every outbound message in the plugin goes through `sendRichMessage` /
 * `editMessageText({ markdown })` with raw GFM markdown. These two tiny
 * helpers build the canonical call shape so the ~dozens of card surfaces
 * and the gateway core all share ONE rendering path:
 *
 *   - `richMessage(text)` → `{ markdown: text }`, the `InputRichMessage`
 *     accepted by both `sendRichMessage` and `editMessageText`.
 *   - `isParseEntitiesError(err)` → true when Telegram rejected the body
 *     because it couldn't parse the markdown entities. There is NO new
 *     rich-specific error class in grammy 1.44 — a malformed-markdown
 *     failure still throws `GrammyError` with the standard
 *     `{ ok:false, error_code:400, description }` shape, the same family
 *     as the legacy "can't parse entities" 400. Callers recover by
 *     resending the SAME message id as plain text (no rich, no parse_mode).
 */

import { GrammyError } from 'grammy'

/** The `InputRichMessage` shape grammy 1.44 accepts on send AND edit. */
export interface InputRichMessageMarkdown {
  markdown: string
}

/** Wrap raw GFM markdown into the rich-message input object. */
export function richMessage(markdown: string): InputRichMessageMarkdown {
  return { markdown }
}

/**
 * True when Telegram rejected a message because it couldn't parse the
 * markdown entities we sent. These 400s are deliberately NOT swallowed or
 * retried by the retry policy — they surface to the caller, which recovers
 * by resending the body as plain text (a literal string, no rich-message
 * wrapper, so the parser never runs). Same "caller-level fallback" contract
 * the old HTML path used.
 */
export function isParseEntitiesError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false
  const d = (err.description || '').toLowerCase()
  return (
    d.includes("can't parse entities") ||
    d.includes('can’t parse entities') ||
    d.includes("can't parse") ||
    d.includes('can’t parse') ||
    d.includes('parse markdown') ||
    d.includes('parse rich') ||
    d.includes("can't find end of the entity") ||
    d.includes('can’t find end of the entity') ||
    d.includes('unsupported start tag') ||
    d.includes('unclosed start tag') ||
    // covers both "expected end tag" and "unexpected end tag"
    d.includes('expected end tag')
  )
}
