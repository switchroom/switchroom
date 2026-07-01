/**
 * Speech normalization for OUTBOUND voice replies (voice-out).
 *
 * The problem: the agent's reply is Markdown-flavoured text. A TTS engine
 * (Kokoro sidecar or OpenAI) reads it LITERALLY — so `~about 3`, `**bold**`,
 * `` `code` ``, `# Heading`, `[label](https://…)`, and code fences all get
 * spoken as "tilde", "asterisk asterisk", "backtick", "hash", or the raw URL
 * read character-by-character. That is exactly the operator feedback: the
 * voice is good but it pronounces the markup.
 *
 * `normalizeForSpeech` is a PURE string→string pass applied to the reply text
 * BEFORE it is handed to any TTS engine. It replaces the older, partial
 * `stripMarkdown` pass on the voice-out path (that one left `~`, code fences,
 * tables, and arrows leaking through). It is deliberately conservative: the
 * goal is natural prose, not aggressive rewriting — when in doubt it leaves
 * real words alone.
 *
 * Documented behavioural choices (the "sensible defaults" the task allows):
 *   - Inline code (`` `x` ``): the backticks are dropped, the CONTENT is
 *     kept and spoken. Short inline code is usually a word/identifier the
 *     listener wants to hear.
 *   - Fenced code blocks (``` … ```): DROPPED entirely and replaced with a
 *     short spoken placeholder ("(code block omitted)"). Reading a block of
 *     code aloud is noise; a listener on a bike can't act on it anyway.
 *   - Links `[text](url)`: spoken as just `text`; the URL is dropped. A bare
 *     autolink `<https://…>` or a raw URL is replaced with "a link" so the
 *     engine never spells out a URL character-by-character.
 *   - `~` is DROPPED (not read as "tilde", not expanded to "about") — it is
 *     ambiguous (strikethrough marker vs. approx) and dropping is the safest
 *     choice that never mangles a real word.
 *   - `->` / `=>` / `→` become the spoken word "to".
 *   - A tiny, well-tested set of trivially-safe abbreviations is expanded
 *     ("e.g." → "for example", "i.e." → "that is", "etc." → "and so on").
 *     Anything ambiguous is left alone.
 */

/** Replace a fenced code block with a spoken placeholder. */
const CODE_BLOCK_PLACEHOLDER = 'code block omitted'

/**
 * Convert a Markdown/plain reply into clean text for a TTS engine.
 * Pure and deterministic — same input always yields the same output.
 */
export function normalizeForSpeech(input: string): string {
  if (!input) return ''
  let s = input.replace(/\r\n?/g, '\n')

  // 1. Fenced code blocks first (```lang … ``` or ~~~ … ~~~) — drop the
  //    whole block before any inline processing can see its contents.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, `$1${CODE_BLOCK_PLACEHOLDER}.`)
  // An unterminated fence (opening ``` with no close) — drop to end.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/g, `$1${CODE_BLOCK_PLACEHOLDER}.`)

  // 2. Images ![alt](url) → alt text (or drop when alt is empty).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 3. Links [text](url) → text ; drop the URL entirely.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 4. Autolinks <https://…> and bare URLs → "a link" (never spell a URL).
  s = s.replace(/<https?:\/\/[^>\s]+>/gi, 'a link')
  s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, 'a link')

  // 5. Inline code `x` → x (keep content, drop backticks). Run before the
  //    generic backtick sweep so paired spans are handled cleanly.
  s = s.replace(/`([^`\n]+)`/g, '$1')
  // Any residual backticks → drop.
  s = s.replace(/`/g, '')

  // 6. Emphasis markers. Paired forms first (longest marker first), then
  //    strip residual markup-by-construction doubles. A LONE `*` or `_` in
  //    the middle of maths/words is left alone (see step 11).
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  s = s.replace(/___(.+?)___/g, '$1')
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/\*(.+?)\*/g, '$1')
  s = s.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, '$1')
  // Strikethrough ~~text~~ → text.
  s = s.replace(/~~(.+?)~~/g, '$1')

  // 7. Leading block markup, per line: headings, blockquotes, list markers.
  //    List bullets/numbers become a natural sentence pause rather than a
  //    spoken "dash" / "1 dot".
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  s = s.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '')

  // 8. Horizontal rules (---, ___, ***) on their own line → drop.
  s = s.replace(/^[ \t]{0,3}([-_*])\1{2,}[ \t]*$/gm, '')

  // 9. Table syntax: drop pipes and separator rows so tables read as prose.
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '')
  s = s.replace(/\|/g, ' ')

  // 10. Arrows → the spoken word "to".
  s = s.replace(/[=-]>/g, ' to ')
  s = s.replace(/[→⇒]/g, ' to ')

  // 11. Stray tildes (approx / leftover markers) → drop. Ambiguous; dropping
  //     is the safe choice that never mangles a real word.
  s = s.replace(/~/g, '')

  // 12. Trivially-safe abbreviation expansions (case-insensitive, only at a
  //     word boundary followed by space/comma). Kept minimal on purpose.
  s = s.replace(/\be\.g\.,?/gi, 'for example,')
  s = s.replace(/\bi\.e\.,?/gi, 'that is,')
  s = s.replace(/\betc\./gi, 'and so on')

  // 13. Collapse excessive punctuation the engine would over-emphasise.
  s = s.replace(/([!?.]){2,}/g, '$1')

  // 14. Whitespace → sentence flow. Blank lines become a sentence break so
  //     paragraphs don't run together; everything else collapses to a single
  //     space.
  s = s.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '. ')
  s = s.replace(/\s*\n\s*/g, ' ')
  s = s.replace(/[ \t]{2,}/g, ' ')
  // Tidy artifacts from the paragraph→". " substitution (". ." → ". ").
  s = s.replace(/\.\s*\.(\s|$)/g, '.$1')
  s = s.replace(/\s+([,.!?;:])/g, '$1')

  return s.trim()
}
