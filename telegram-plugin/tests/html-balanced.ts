/**
 * Tiny HTML tag-balance validator for the Telegram allowlist.
 *
 * Replaces fast-check (not a current dep, see #662 P1) — paired with
 * vitest `it.each` it gives us property-style coverage across many
 * randomised renderer inputs without a new dependency.
 *
 * Telegram's HTML parser only accepts a small allowlist of tags
 * (https://core.telegram.org/bots/api#html-style). Anything outside
 * the allowlist is treated as raw text — we don't try to validate it.
 *
 * Self-closing tags inside Telegram's allowlist: only `<br/>` (and even
 * that is normalised to `\n`). We treat any `<x/>` as self-closing for
 * robustness, but emit nothing into the stack.
 */

const ALLOWED = new Set([
  'b', 'strong',
  'i', 'em',
  'u', 'ins',
  's', 'strike', 'del',
  'a',
  'code',
  'pre',
  'tg-spoiler',
  'span',
  'tg-emoji',
  'blockquote',
  'br',
])

export interface BalanceResult {
  balanced: boolean
  openTags: string[]
  extraCloses: string[]
}

export function isBalancedHtml(html: string): BalanceResult {
  const stack: string[] = []
  const extraCloses: string[] = []
  // Match tags but skip HTML entities (`&lt;` etc) — those are NOT tags.
  const re = /<\/?\s*([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const raw = m[0]
    const name = m[1].toLowerCase()
    if (!ALLOWED.has(name)) continue
    const isClose = raw.startsWith('</')
    const selfClose = raw.endsWith('/>') || name === 'br'
    if (selfClose && !isClose) continue
    if (isClose) {
      const top = stack[stack.length - 1]
      if (top === name) {
        stack.pop()
      } else {
        extraCloses.push(name)
      }
    } else {
      stack.push(name)
    }
  }
  return { balanced: stack.length === 0 && extraCloses.length === 0, openTags: stack, extraCloses }
}
