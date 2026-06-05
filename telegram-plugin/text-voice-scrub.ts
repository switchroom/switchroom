/**
 * text-voice-scrub.ts — deterministic prose-style enforcement at the
 * gateway.
 *
 * Background. Despite three landed soft fixes (SOUL.md.hbs "never use
 * em-dashes" rule, PR #1177 voice consolidation, the /humanizer skill),
 * sampling 2,867 recent fleet outbound replies on 2026-05-23 showed
 * em-dashes still present in 73% of agent messages (3.23 per 1k chars).
 * Soft layer was not winning. The operator's framing is the same one
 * that drove the over-ping safety net (#1674) and the silent-reply
 * auto-edit (#1677): when the model authors voice and the framework
 * owns enforcement, soft instructions fail under load. Make the
 * framework do it.
 *
 * Scope. Two mechanical transforms, both semantically safe:
 *   1. Em / en dashes -> comma/period/hyphen. Pure transform with no
 *      semantic loss on whitespace-separated prose; a no-op inside code
 *      or a URL.
 *   2. Leading sycophancy openers ("You're absolutely right", "Great
 *      catch", "Exactly right") -> deleted, next word recapitalized. A
 *      leading pure-affirmation clause carries near-zero meaning, so
 *      removing it strips the AI-tell without touching the substance.
 *      Conservative by construction: only at the very start, only the
 *      known affirmation set, only when real content follows (a
 *      standalone "You're absolutely right!" ack is left intact).
 *
 * Still scoped OUT: the wider mid-sentence "AI-tell phrase denylist"
 * (smoking gun, delve, etc.). Substituting those mid-clause risks
 * semantic loss, so they stay with the prompt-side voice guidance
 * (the turn-pacing VOICE directive), not this mechanical gate.
 *
 * Pipeline integration. Apply BEFORE markdownToHtml so the scrub
 * runs on the original model text, not on rendered HTML where
 * the dash might already be tag-escaped or live inside a parked
 * code-block placeholder. Apply BEFORE outboundDedup.check so
 * dedup keys see the post-scrub content (same text from a retry
 * collapses cleanly).
 *
 * Code-region awareness. The scrubber MUST preserve dashes inside:
 *   - fenced code blocks: ```lang\n...\n```
 *   - inline code: `...`
 *   - explicit Telegram HTML code tags: <code>...</code>, <pre>...</pre>
 *   - URLs (rare to contain em-dashes, but technically valid IDN)
 * The strategy is to park each protected region with a sentinel,
 * scrub the rest, then restore. Mirrors the well-trodden
 * markdownToHtml() codeBlocks/inlineCode placeholder pattern at
 * format.ts:254-272.
 *
 * Kill switch. `SWITCHROOM_DISABLE_VOICE_SCRUB=1` returns the input
 * unchanged and reports zero replacements. Same shape every other
 * gateway safety net uses; rollback is one env var + agent restart.
 */

export interface VoiceScrubResult {
  /** The scrubbed text. Equal to input when no replacements made or
   *  when the kill switch is set. */
  scrubbed: string
  /** TOTAL voice changes across the whole input = dash replacements +
   *  leading-affirmation strips. Callers gate on `replaced > 0` to decide
   *  whether to apply `scrubbed`, so this MUST count every change (an
   *  opener-only strip with zero dashes still needs `replaced > 0`).
   *  Surfaces to the runtime-metrics fan-out as the fleet voice-scrub
   *  rate. */
  replaced: number
  /** Breakdown: leading sycophancy openers stripped (subset of
   *  `replaced`). Lets the dashboard separate opener-strips from dash
   *  fixes. */
  openersStripped: number
}

const NULL = '\x00'
const FENCE_PH = `${NULL}VS_FENCE`
const INLINE_PH = `${NULL}VS_INLINE`
const HTML_CODE_PH = `${NULL}VS_HTMLCODE`
const HTML_PRE_PH = `${NULL}VS_HTMLPRE`
const URL_PH = `${NULL}VS_URL`

const URL_RE = /https?:\/\/\S+/g

function enabled(): boolean {
  const v = process.env.SWITCHROOM_DISABLE_VOICE_SCRUB
  return !(v === '1' || v === 'true')
}

/**
 * Leading sycophancy/affirmation openers. Matched ONLY at the very start
 * of the message, ONLY this known pure-filler set, and the trailing
 * punctuation/separators (incl. em/en dash) are consumed with it.
 *
 * Deliberately excludes bare "you're right" (often load-bearing, e.g.
 * "you're right that X") and "great/good question" (overlaps the
 * legitimate short-ack pattern). Kept to phrases whose only content is
 * the affirmation itself. Apostrophe matches straight or curly.
 *
 * The affirmation must be followed by end-of-string OR a clause/sentence
 * separator (punctuation, possibly with surrounding whitespace) — NOT a
 * bare space into more words. This is what stops over-strips like
 * "Spot on the map shows...", "Good catch basin overflow...", "Exactly
 * right now, the count is 3" — there the phrase is a literal sentence
 * start, not a detachable affirmation. "Spot on, the value is 5" (comma)
 * still strips.
 */
const LEADING_AFFIRMATION_RE =
  /^(\s*)(you(?:['’]| a)re absolutely right|you(?:['’]| a)re so right|you(?:['’]| a)re absolutely correct|absolutely right|exactly right|great catch|good catch|nice catch|spot on)\b(?:\s*$|\s*[!.,;:—–-][\s!.,;:—–-]*)/i

/**
 * Strip a single leading affirmation opener and recapitalize the next
 * word. No-op (count 0) when there's no match, or when stripping would
 * leave no substantive content (a standalone affirmation ack survives).
 */
function stripLeadingAffirmation(text: string): { out: string; count: number } {
  const m = LEADING_AFFIRMATION_RE.exec(text)
  if (!m) return { out: text, count: 0 }
  const leadingWs = m[1] ?? ''
  const rest = text.slice(m[0].length)
  if (rest.trim().length === 0) return { out: text, count: 0 }
  // Recapitalize the first alphabetic char of the remainder so the new
  // opening word reads as a sentence start.
  const recapped = rest.replace(/^(\s*)([a-z])/, (_m, ws: string, ch: string) => ws + ch.toUpperCase())
  return { out: leadingWs + recapped, count: 1 }
}

/**
 * Park code-like regions behind placeholders so the dash-replacement
 * pass can't touch them. Returns the parked-string and the original
 * fragments keyed by index.
 */
function park(text: string): {
  parked: string
  parts: Array<{ prefix: string; idx: number; raw: string }>
} {
  const parts: Array<{ prefix: string; idx: number; raw: string }> = []
  let parked = text

  // Order matters: fenced first (so a ` inside a fence isn't taken
  // as inline-code start), then HTML code tags, then inline backticks,
  // then URLs.
  parked = parked.replace(/```[\s\S]*?```/g, (m) => {
    const idx = parts.length
    parts.push({ prefix: FENCE_PH, idx, raw: m })
    return `${FENCE_PH}${idx}${NULL}`
  })
  parked = parked.replace(/<pre>[\s\S]*?<\/pre>/gi, (m) => {
    const idx = parts.length
    parts.push({ prefix: HTML_PRE_PH, idx, raw: m })
    return `${HTML_PRE_PH}${idx}${NULL}`
  })
  parked = parked.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, (m) => {
    const idx = parts.length
    parts.push({ prefix: HTML_CODE_PH, idx, raw: m })
    return `${HTML_CODE_PH}${idx}${NULL}`
  })
  parked = parked.replace(/`[^`\n]+`/g, (m) => {
    const idx = parts.length
    parts.push({ prefix: INLINE_PH, idx, raw: m })
    return `${INLINE_PH}${idx}${NULL}`
  })
  parked = parked.replace(URL_RE, (m) => {
    const idx = parts.length
    parts.push({ prefix: URL_PH, idx, raw: m })
    return `${URL_PH}${idx}${NULL}`
  })

  return { parked, parts }
}

function restore(
  text: string,
  parts: Array<{ prefix: string; idx: number; raw: string }>,
): string {
  let restored = text
  // Restore in reverse-insertion order so a placeholder accidentally
  // emitted by a nested replacement gets the right raw region.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!
    restored = restored.replace(`${p.prefix}${p.idx}${NULL}`, () => p.raw)
  }
  return restored
}

/**
 * Replace em / en dashes with context-appropriate punctuation.
 *
 * Rules, applied in order:
 *   1. ` — ` / ` – ` (flanked by single space) → `, ` if followed by a
 *      lowercase or open-paren character; otherwise `. ` if followed by
 *      an uppercase or end-of-string. Heuristic: lowercase = mid-clause
 *      continuation (comma reads naturally); uppercase = new sentence
 *      (period reads naturally).
 *   2. End-of-line dash (` —\n` / ` –\n`) → `.\n` — treat as full stop.
 *   3. Bare dash with no flanking spaces between word chars
 *      (e.g. "word—word") → `, ` — the missing-space form is rarer but
 *      semantically the same as #1.
 *   4. Surviving dash (uncommon, e.g. at sentence start "— note") → `-`
 *      so the message still renders without the AI tell.
 */
function replaceDashes(text: string): { out: string; replaced: number } {
  let replaced = 0
  let out = text

  // #1: spaced em-dash mid-prose. Decide between ", " and ". " on
  // the leading character of the following token.
  out = out.replace(/(\S) [—–] (\S)/g, (_m, before: string, after: string) => {
    replaced++
    // If `after` is uppercase ASCII or one of a known sentence-starter
    // set, treat as new sentence; otherwise a parenthetical comma.
    const sentenceStart = /[A-Z]/.test(after)
    return sentenceStart ? `${before}. ${after}` : `${before}, ${after}`
  })

  // #2: dash at end of line. Treat as full stop.
  out = out.replace(/ [—–](\s*\n)/g, (_m, ws: string) => {
    replaced++
    return `.${ws}`
  })

  // #3: bare dash between word chars (no flanking spaces). Treat as
  // missing-space form of #1; comma is the safe fallback.
  out = out.replace(/(\w)[—–](\w)/g, (_m, before: string, after: string) => {
    replaced++
    return `${before}, ${after}`
  })

  // #4: anything still standing — convert to ASCII hyphen so no
  // typographic dash escapes the gate. Rare path; covers leading
  // "— note" / quoted dash / etc.
  out = out.replace(/[—–]/g, () => {
    replaced++
    return '-'
  })

  return { out, replaced }
}

/**
 * Public entry: strip a leading sycophancy opener and scrub em/en dashes
 * from outbound text, preserving anything inside code and URLs.
 *
 * Order: park code/URLs -> strip leading affirmation -> replace dashes ->
 * restore. The opener strip runs on parked text so it can never touch a
 * code region, and before the dash pass so a dash trailing the opener is
 * consumed by the strip rather than converted.
 *
 * Pure: no IO, no module-scope state, deterministic. Kill switch is
 * checked per call so an operator can flip it via env var without a
 * restart of an in-process test.
 */
export function scrubVoice(text: string): VoiceScrubResult {
  if (!enabled() || text.length === 0) {
    return { scrubbed: text, replaced: 0, openersStripped: 0 }
  }
  const { parked, parts } = park(text)
  const opener = stripLeadingAffirmation(parked)
  const { out, replaced } = replaceDashes(opener.out)
  const total = replaced + opener.count
  if (total === 0) {
    return { scrubbed: text, replaced: 0, openersStripped: 0 }
  }
  return { scrubbed: restore(out, parts), replaced: total, openersStripped: opener.count }
}
