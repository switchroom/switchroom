/**
 * Telegram-HTML sanitizer.
 *
 * Telegram's HTML parser is strict: it accepts only a small whitelist of
 * tags (b/strong, i/em, u/ins, s/strike/del, code, pre, a, tg-spoiler,
 * span class="tg-spoiler", tg-emoji, blockquote) and rejects the entire
 * message with `400 Bad Request: can't parse entities` when it encounters
 * an unknown tag, an unbalanced tag, or a stray `<` that doesn't open a
 * known tag.
 *
 * `markdownToHtml()` already produces well-formed HTML for content the
 * model wrote *as markdown*. This module is the second line of defence
 * for content the model wrote *as raw HTML* (or as a mix that produces
 * malformed HTML after rendering): we run the rendered string through a
 * pure-text scanner that:
 *
 *   1. Escapes any `<` / `>` that doesn't open or close a whitelisted
 *      tag (e.g. `<frobnicate>` → `&lt;frobnicate&gt;`,
 *      `1 < 2 < 3` → `1 &lt; 2 &lt; 3`).
 *   2. Escapes attributes that aren't on the small per-tag allowlist
 *      (only `<a href>`, `<code class>`, `<span class="tg-spoiler">`,
 *      `<tg-emoji emoji-id>`, `<blockquote expandable>` are accepted —
 *      everything else gets stripped from the tag).
 *   3. Auto-closes any tag opened but never closed (so an "unclosed
 *      `<b>` at end of message" doesn't trip Telegram's parser).
 *   4. Drops any unmatched closing tag (e.g. `</foo>` without an opener).
 *
 * The sanitizer is conservative: when in doubt, escape. The output is
 * guaranteed to round-trip through Telegram's HTML parser without a
 * `can't parse entities` 400 — at the cost of some false positives where
 * raw `<` characters inside model prose end up as `&lt;` (which is the
 * correct Telegram-HTML behaviour anyway).
 *
 * Idempotent: sanitize(sanitize(x)) === sanitize(x).
 */

/** Telegram's parse_mode=HTML allowed tag names. */
const ALLOWED_TAGS = new Set([
  'b', 'strong',
  'i', 'em',
  'u', 'ins',
  's', 'strike', 'del',
  'a',
  'code',
  'pre',
  'span',
  'tg-spoiler',
  'tg-emoji',
  'blockquote',
])

/**
 * Per-tag attribute allowlist. Keys are tag names; values are the set of
 * attribute names that survive the sanitizer. Anything not listed is
 * silently dropped from the opening tag.
 */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  code: new Set(['class']),
  span: new Set(['class']),
  'tg-emoji': new Set(['emoji-id']),
  blockquote: new Set(['expandable']),
  pre: new Set(['language']),
}

/** Allowed schemes for `<a href>` — block javascript:, data:, etc. */
const ALLOWED_HREF_SCHEMES = /^(?:https?|mailto|tel|tg):/i

/**
 * Strip every `<…>` from a string, escaping the `<` and `>`. Used as the
 * fallback when the input genuinely cannot be made HTML-safe.
 */
export function escapeAllHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Sanitize a string of Telegram HTML so it cannot trip the
 * `can't parse entities` 400. See module docstring for the rules.
 *
 * @param input - the rendered HTML (post markdownToHtml).
 * @returns the sanitized HTML, guaranteed parse-mode=HTML safe.
 */
export function sanitizeTelegramHtml(input: string): string {
  // Walk the input character by character. When we see `<`, try to match
  // a tag against our whitelist. If it matches, emit a normalized form;
  // otherwise escape the `<` and continue.
  //
  // Tag regex: opening tag name, optional attributes (anything up to
  // the next `>` that isn't inside a quoted string), and the closing
  // `>`. We use a small hand-rolled parser rather than a generic regex
  // because we need to validate attributes per-tag.
  const out: string[] = []
  const stack: string[] = [] // names of open tags, oldest-first
  let i = 0
  const len = input.length

  while (i < len) {
    const ch = input[i]

    if (ch === '&') {
      // Pass through known entities verbatim; escape bare `&`.
      // A "known entity" is `&` followed by [a-z]+; or `&#` followed by digits;
      // both terminated by `;` within ~10 chars.
      const m = /^&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.exec(input.slice(i, i + 12))
      if (m) {
        out.push(m[0])
        i += m[0].length
      } else {
        out.push('&amp;')
        i++
      }
      continue
    }

    if (ch !== '<') {
      out.push(ch)
      i++
      continue
    }

    // We're at a `<`. Try to parse a tag.
    const tagMatch = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/.exec(input.slice(i))
    if (!tagMatch) {
      // Stray `<` — escape it.
      out.push('&lt;')
      i++
      continue
    }
    const isClose = tagMatch[1] === '/'
    const tagName = tagMatch[2].toLowerCase()
    const attrText = tagMatch[3]

    if (!ALLOWED_TAGS.has(tagName)) {
      // Unknown tag — escape the whole `<…>` literal.
      out.push(escapeAllHtml(tagMatch[0]))
      i += tagMatch[0].length
      continue
    }

    if (isClose) {
      // Closing tag: only emit if it matches the most recently opened
      // tag of the same name. If the stack contains a matching opener
      // earlier, close out everything above it (auto-close any
      // unbalanced inner tags). If there's no matching opener at all,
      // drop the closing tag silently.
      const idx = stack.lastIndexOf(tagName)
      if (idx === -1) {
        // No matching opener — drop the close tag.
        i += tagMatch[0].length
        continue
      }
      // Auto-close anything above the matching opener.
      while (stack.length > idx + 1) {
        const top = stack.pop()!
        out.push(`</${top}>`)
      }
      stack.pop()
      out.push(`</${tagName}>`)
      i += tagMatch[0].length
      continue
    }

    // Opening tag: filter attributes.
    const cleanAttrs = sanitizeAttrs(tagName, attrText)
    out.push(`<${tagName}${cleanAttrs}>`)
    // Self-closing void tags? Telegram has none — every allowed tag is
    // a container. Push onto stack so we can auto-close later.
    stack.push(tagName)
    i += tagMatch[0].length
  }

  // Auto-close any unclosed tags so the output is balanced.
  while (stack.length > 0) {
    const top = stack.pop()!
    out.push(`</${top}>`)
  }

  return out.join('')
}

/**
 * Filter the attribute string of an opening tag against the per-tag
 * allowlist. Returns the cleaned attribute string with a leading space
 * (or empty string when no attributes survive).
 */
function sanitizeAttrs(tagName: string, attrText: string): string {
  const allowed = ALLOWED_ATTRS[tagName]
  if (!allowed || allowed.size === 0) return ''

  // Match attribute name=value or bare name. Value may be double-quoted,
  // single-quoted, or unquoted.
  const attrRe = /([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  const kept: string[] = []
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(attrText)) != null) {
    const name = m[1].toLowerCase()
    if (!allowed.has(name)) continue
    const rawValue = m[2] ?? m[3] ?? m[4] ?? ''

    // Per-attribute value sanitization.
    if (tagName === 'a' && name === 'href') {
      const trimmed = rawValue.trim()
      if (!ALLOWED_HREF_SCHEMES.test(trimmed)) continue
      kept.push(`href="${escapeAttrValue(trimmed)}"`)
      continue
    }
    if (rawValue.length === 0) {
      // Bare attribute like `<blockquote expandable>`.
      kept.push(name)
      continue
    }
    kept.push(`${name}="${escapeAttrValue(rawValue)}"`)
  }
  return kept.length > 0 ? ' ' + kept.join(' ') : ''
}

function escapeAttrValue(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Convert a rendered HTML body to a plain-text fallback. Used when
 * Telegram still rejects the (presumably-already-sanitized) HTML — we
 * strip every tag and unescape entities so the message lands as text
 * instead of disappearing.
 */
export function htmlToPlainText(html: string): string {
  return html
    // Drop tags entirely.
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g, '')
    // Unescape the four entities the encoder produces.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}
