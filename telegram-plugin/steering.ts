/**
 * Pure helpers for mid-turn steering and the `/queue` opt-in.
 *
 * Context: Telegram messages that arrive while a prior turn is still in
 * flight are today queued by Claude Code's native FIFO (see
 * session-tail.ts:11) and relayed with `meta.steering="true"` so the
 * model knows it landed behaviourally-late. The plugin now additionally
 * enriches that notification with priors (seconds_since_turn_start,
 * prior_assistant_preview) and accepts an explicit `/queue ` / `/q `
 * prefix that the user can type to declare "this is a new task, not a
 * steer". These helpers are pure so server.ts stays testable without
 * standing up grammy.
 */
import { escapeHtml } from './format.js'

/**
 * Detect and strip the `/queue ` or `/q ` opt-in prefix.
 *
 * Rules (intentionally strict so we don't match `/queued` or `/q\nfoo`):
 *   - Must start with `/queue ` or `/q ` (exactly one leading slash,
 *     keyword case-insensitive, MANDATORY single space after keyword).
 *   - No leading whitespace — first character must be `/`.
 *   - Keyword must be `queue` or `q` exactly; `/queued`, `/queuefoo`,
 *     `/queue\tfoo` all fail to match.
 *   - On match, only the first prefix is stripped. `/queue /q foo`
 *     returns `{queued: true, body: "/q foo"}` — we do not recurse.
 *   - On match, the returned body is whitespace-trimmed.
 *   - `/queue` alone (no trailing space) does NOT match (we require the
 *     space so the prefix can't collide with a message that literally
 *     starts with the word "queue"). Document in tests.
 */
export function parseQueuePrefix(body: string): { queued: boolean; body: string } {
  const m = /^\/(queue|q) (.*)$/is.exec(body)
  if (!m) return { queued: false, body }
  return { queued: true, body: m[2]!.trim() }
}

/**
 * Escape the five XML attribute entities. Idempotent on already-safe
 * strings because the order is &-first (any `&amp;` we produce won't be
 * re-processed — the first pass only rewrites bare `&`).
 */
export function escapeXmlAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Produce a short, safe preview of the last assistant turn for injection
 * as an XML attribute. Strips HTML tags (so `<b>foo</b>` becomes `foo`),
 * collapses all whitespace runs into single spaces, truncates to
 * `maxChars` visible characters, then XML-escapes.
 *
 * We do NOT decode HTML entities — a literal `&amp;` in the source
 * survives as `&amp;amp;` after escape, which is fine: the attribute is
 * for the model's situational awareness, not faithful rendering.
 */
export function formatPriorAssistantPreview(text: string, maxChars = 200): string {
  // Strip HTML tags. Anything angle-bracketed between < and > goes away;
  // this is deliberately liberal (no tag-name whitelist) because the
  // preview is for the model's eyes only.
  const stripped = text.replace(/<[^>]*>/g, '')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  const truncated = collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed
  return escapeXmlAttribute(truncated)
}

export interface ChannelMetaAttributeOptions {
  queued?: boolean
  steering?: boolean
  priorTurnInProgress?: boolean
  secondsSinceTurnStart?: number
  /** Already-escaped preview (as returned by formatPriorAssistantPreview). */
  priorAssistantPreview?: string
}

/**
 * Build the extra attributes for the `<channel>` open tag. Returns a
 * space-prefixed string (or empty string if no attributes apply) so the
 * caller can concatenate it directly after the existing attributes.
 *
 * Order is fixed (documented here, tested in steering.test.ts):
 *   queued, steering, prior_turn_in_progress,
 *   seconds_since_turn_start, prior_assistant_preview
 *
 * Attributes with missing / undefined values are omitted entirely rather
 * than emitted as empty strings. `queued` and `steering` are treated as
 * mutually exclusive by the caller in server.ts — this helper does not
 * enforce that invariant; if both are true, both are emitted.
 */
export function buildChannelMetaAttributes(opts: ChannelMetaAttributeOptions): string {
  const parts: string[] = []
  if (opts.queued) parts.push('queued="true"')
  if (opts.steering) parts.push('steering="true"')
  if (opts.priorTurnInProgress) parts.push('prior_turn_in_progress="true"')
  if (opts.priorTurnInProgress && typeof opts.secondsSinceTurnStart === 'number') {
    parts.push(`seconds_since_turn_start="${Math.max(0, Math.floor(opts.secondsSinceTurnStart))}"`)
  }
  if (opts.priorTurnInProgress && opts.priorAssistantPreview != null && opts.priorAssistantPreview.length > 0) {
    parts.push(`prior_assistant_preview="${opts.priorAssistantPreview}"`)
  }
  return parts.length === 0 ? '' : ' ' + parts.join(' ')
}

/** Re-export so callers that want HTML-escape for body content don't need a second import. */
export { escapeHtml }
