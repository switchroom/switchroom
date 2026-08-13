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
import { guardDollarMath } from './render/dollar-math-guard.js'
import { guardAccidentalEmphasis } from './render/emphasis-guard.js'
import { guardAccidentalBlockConstructs, guardAccidentalHeading } from './render/line-start-guard.js'
import { guardAccidentalInlinePairs } from './render/inline-pairs-guard.js'
import { guardUnsupportedTokens } from './render/unsupported-token-guard.js'

/** The `InputRichMessage` shape grammy 1.44 accepts on send AND edit. */
export interface InputRichMessageMarkdown {
  markdown: string
}

/**
 * Neutralise ALL accidental Telegram markdown typesetting in one composed pass
 * (#3252). Each sub-guard targets a DISJOINT set of trigger characters, skips
 * code spans / fenced blocks verbatim (shared `splitCodeSegments`), is a strict
 * no-op absent a real signal, and is idempotent — so the composition is itself
 * idempotent and safe to apply once per send.
 *
 * ── Ordering (deliberate, not arbitrary) ──────────────────────────────────
 * `guardAccidentalHeading` runs right after emphasis and before block-constructs.
 * It only ever inserts `\` before a line-leading `#{1,6}` run; `#` is inspected
 * and inserted by no other guard (disjoint char set), so its position among the
 * siblings is order-independent — it neither creates nor destroys a signal for
 * any of them.
 *
 * `guardDollarMath` runs LAST. It backslash-escapes `$` → `\$`, and the
 * inline-pairs guard's approximation-tilde signal is `~(?=\$?\.?\d)` — a `~`
 * glued to a `$digit`. If the dollar guard ran first, a body like
 * `~$5M and ~$10M` would become `~\$5M …`, and the interposed `\` would hide
 * the digit-adjacent tildes from `guardAccidentalInlinePairs`, leaving the
 * accidental `~…~` strikethrough pair un-neutralised (a false negative /
 * residual bug). Running inline-pairs FIRST escapes the tildes (`\~$5M`), then
 * the dollar guard escapes the `$` — both spans are killed. Every other pair of
 * guards is disjoint in the characters it inspects AND the characters it
 * inserts (`\_ \* \> \. \~ \=\= \|\|` vs `\$`), so no other insertion can
 * create or destroy a signal for a sibling. Verified by composition tests.
 *
 * Intentional inline math (`$x^2+y^2$`, a native Telegram construct) is
 * PROTECTED from every sub-guard: `splitProtectedSegments` treats a compact
 * non-currency `$…$` span like a code span (see code-segments.ts), so the
 * dollar guard neither counts nor escapes its `$` and the emphasis/caret
 * guards never rewrite its interior.
 */
export function guardAccidentalFormatting(markdown: string): string {
  let out = markdown
  // Repair Telegram-unrenderable tokens FIRST. This pass now strips ONLY caret
  // pairs (`^x^` → `x`): removing a `^` inserts no trigger char for any
  // sibling guard, so it neither creates nor destroys their signals.
  //
  // What this pass deliberately NO LONGER does (wire-verified 2026-08-13 by
  // raw `sendRichMessage` probes): it used to fold `<details>` into a `**> `
  // "expandable blockquote" and delete footnote markers `[^1]`. Both beliefs
  // were false — `<details><summary>` and footnotes are NATIVE rich-markdown
  // constructs (typed `details` / footnote nodes on the wire), while `**>` is
  // MarkdownV2-only syntax the rich path renders as LITERAL `**>` text. The
  // conversion destroyed a supported construct to emit an unsupported one, so
  // it is deleted. `<details>`, footnotes, `<sub>`/`<sup>`/`<u>`, `<aside>`,
  // `tg://` links and task lists all pass through every guard untouched: none
  // of `< > [ ] : /` is a trigger char for the emphasis / heading /
  // block-construct / inline-pair / dollar guards ('composition' tests cover
  // this interaction).
  out = guardUnsupportedTokens(out)
  out = guardAccidentalEmphasis(out)
  out = guardAccidentalHeading(out)
  out = guardAccidentalBlockConstructs(out)
  out = guardAccidentalInlinePairs(out)
  out = guardDollarMath(out)
  return out
}

/**
 * Wrap raw GFM markdown into the rich-message input object.
 *
 * This is a CONVENIENCE adapter — NOT the universal seam. It applies
 * `guardAccidentalFormatting` for the many callers that build a body through
 * it (the reply-tool final answer, draft-stream previews, cards), but it is
 * NOT the one place every `{ markdown }` wire send funnels through: several
 * sites build a raw `{ markdown }` and call `sendRichMessage` /
 * `editMessageText` directly, bypassing this wrapper (see the correctness
 * audit's F1 list — banners, switchroomReply html, approval/folder-picker
 * edits). The REAL universal seam for the #3252 accidental-formatting guards
 * is the grammy API transformer `installRichMarkdownGuard`
 * (`shared/bot-runtime.ts`), installed on the production Bot in gateway boot,
 * which guards EVERY sendRichMessage/editMessageText payload regardless of the
 * call site. This wrapper is kept belt-and-braces: the composed guard is a
 * strict no-op for any body without an accidental-formatting signal and is
 * idempotent, so a body guarded here and re-guarded by the transformer stays
 * byte-identical. `plain`-mode degradations bypass both (they go straight to
 * `sendMessage`, where no markdown parsing happens).
 */
export function richMessage(markdown: string): InputRichMessageMarkdown {
  return { markdown: guardAccidentalFormatting(markdown) }
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
  // A too-long rejection is a LENGTH error, not a parse error — never let the
  // length case fall through here (it would be "recovered" by resending the
  // same oversized body as plain text, which fails again). Classify it
  // separately via isLengthError so the caller re-splits instead.
  if (isLengthError(err)) return false
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

/**
 * True when Telegram rejected the message because the BODY WAS TOO LONG (over
 * the rich-message wire cap), as opposed to a markdown-parse failure.
 *
 * The rich path surfaces this distinctly: `RICH_MESSAGE_TEXT_TOO_LONG`
 * (empirically the description for a body of 32769+ chars). The legacy
 * plain-text path used `MESSAGE_TOO_LONG` / "message is too long" — both are
 * matched here so a caller that hits either re-splits the body
 * (`splitMarkdownChunks`) and resends, instead of misclassifying it as a parse
 * error (and resending the same oversized payload as plain text) or surfacing
 * the raw 400.
 */
export function isLengthError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false
  const d = (err.description || '').toLowerCase()
  return (
    d.includes('rich_message_text_too_long') ||
    d.includes('message_too_long') ||
    d.includes('text_too_long') ||
    d.includes('message is too long') ||
    d.includes('text is too long')
  )
}
