/**
 * Secret detection entrypoint for the Telegram plugin.
 *
 * `detectSecrets(text)` returns a normalized list of detections — each with
 * a rule id, the matched bytes, byte-offsets in the original text, a
 * confidence tier, a suppression flag, and a suggested vault slug.
 *
 * Detection stack (order = precedence on ties):
 *   1. Anchored provider prefixes (sk-ant-, ghp_, AIza..., etc.)
 *   2. Structured patterns (KEY=value, JSON fields, Authorization Bearer,
 *      PEM blocks, CLI flags)
 *   3. KEY=VALUE heuristic with Shannon-entropy gate (≥ 4.0)
 *
 * Big inputs (>32 KB) are chunked into 16 KB windows with 1 KB overlap
 * (chunker.ts) for ReDoS bounding; we dedupe by byte-offset after.
 *
 * Nearby test/mock/example/fixture/dummy markers (within 40 chars) demote
 * a hit to `suppressed: true`. The caller decides what that means (our
 * convention: suppressed high-confidence → ambiguous, user is asked).
 *
 * Secretlint is integrated as an async supplementary source via
 * `detectSecretsAsync`. The sync `detectSecrets` keeps the fast vendored-
 * pattern path for callers on the hot path (Telegram message ingest).
 * Gitleaks TOML is loaded via `gitleaks-loader.ts`.
 */
import { ALL_PATTERNS } from './patterns.js'
import { scanKeyValue, type RawHit } from './kv-scanner.js'
import { chunk } from './chunker.js'
import { isSuppressed } from './suppressor.js'
import { deriveSlug } from './slug.js'

export interface Detection {
  rule_id: string
  matched_text: string
  /** Byte offset into the original input text. */
  start: number
  /** Byte offset (exclusive) into the original input text. */
  end: number
  confidence: 'high' | 'ambiguous'
  suppressed: boolean
  /**
   * Deterministic suggested vault key. Computed without reading the real
   * vault; the caller may re-derive with `deriveSlug` when writing, passing
   * the current vault key set to avoid collisions.
   */
  suggested_slug: string
  /**
   * Free-form key name the detector thinks described this secret, e.g.
   * `ANTHROPIC_API_KEY` when the pattern was `env_key_value`. Used by
   * `deriveSlug` as the preferred slug source.
   */
  key_name?: string
}

export function detectSecrets(text: string): Detection[] {
  if (!text || text.length === 0) return []

  // Chunk for ReDoS bounding; small inputs return a single window.
  const windows = chunk(text)

  // Collect raw hits with global offsets.
  const raw: RawHit[] = []

  for (const win of windows) {
    for (const p of ALL_PATTERNS) {
      // Make sure we're running a stateless global scan per window.
      const re = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : p.regex.flags + 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(win.text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++
          continue
        }
        const cap = p.captureIndex === 0 ? m[0] : m[p.captureIndex]
        if (!cap) continue
        const matchStart = p.captureIndex === 0 ? m.index : m.index + m[0].indexOf(cap)
        if (matchStart < 0) continue
        const globalStart = win.offset + matchStart
        const globalEnd = globalStart + cap.length
        // For env_key_value (captureIndex=3), the LHS is group 1.
        const keyName = p.rule_id === 'env_key_value' ? m[1] : undefined
        raw.push({
          rule_id: p.rule_id,
          start: globalStart,
          end: globalEnd,
          matched_text: cap,
          key_name: keyName,
          confidence: 'high',
        })
      }
    }
    // KV heuristic scanner runs per window too.
    const kvHits = scanKeyValue(win.text)
    for (const h of kvHits) {
      raw.push({ ...h, start: h.start + win.offset, end: h.end + win.offset })
    }
  }

  // Dedupe by range + rule. If two rules hit the same range, prefer the
  // earlier one in `ALL_PATTERNS` (higher precedence).
  const deduped = dedupeRaw(raw)

  // Resolve overlaps — drop any hit fully contained inside a higher-precedence
  // hit on the same range.
  const final = dropOverlaps(deduped)

  // Upgrade to Detection shape + compute slug + check suppressor.
  const existing = new Set<string>()
  const out: Detection[] = []
  for (const h of final) {
    const suggested_slug = deriveSlug(
      { key_name: h.key_name, rule_id: h.rule_id },
      existing,
    )
    existing.add(suggested_slug)
    out.push({
      rule_id: h.rule_id,
      matched_text: h.matched_text,
      start: h.start,
      end: h.end,
      confidence: h.confidence,
      suppressed: isSuppressed(text, h.start, h.end),
      suggested_slug,
      key_name: h.key_name,
    })
  }
  // Stable sort by start offset so callers can rewrite left-to-right.
  out.sort((a, b) => a.start - b.start)
  return out
}

function dedupeRaw(raw: RawHit[]): RawHit[] {
  const seen = new Map<string, RawHit>()
  for (const h of raw) {
    const key = `${h.start}:${h.end}`
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, h)
      continue
    }
    // Prefer high over ambiguous.
    if (existing.confidence === 'ambiguous' && h.confidence === 'high') {
      seen.set(key, h)
    }
  }
  return Array.from(seen.values())
}

/**
 * Drop hits fully contained inside another hit. Keeps the outer (typically
 * broader / higher-signal) hit — e.g. a JWT match wholly inside an
 * Authorization Bearer match keeps the Bearer.
 */
function dropOverlaps(hits: RawHit[]): RawHit[] {
  const sorted = [...hits].sort((a, b) => (a.end - a.start) - (b.end - b.start))
  const out: RawHit[] = []
  for (const h of sorted) {
    const contained = out.some(
      (existing) =>
        existing !== h &&
        existing.start <= h.start &&
        existing.end >= h.end &&
        !(existing.start === h.start && existing.end === h.end),
    )
    if (!contained) out.push(h)
  }
  // Re-sort by start offset for deterministic downstream handling.
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out
}

export { maskToken } from './mask.js'
export { redactUrls } from './url-redact.js'
export { deriveSlug } from './slug.js'
export { detectViaSecretlint } from './secretlint-source.js'

/**
 * Async detection pipeline — runs `detectSecrets` (fast vendored engine)
 * and Secretlint in parallel, then merges the results by deduping on
 * `[start, end)` byte ranges. If Secretlint and a vendored pattern both
 * match the same span, the first one wins (vendored, since it's listed
 * first in the merge array below).
 *
 * Slug collisions are re-resolved on the merged list so the overall
 * output has unique `suggested_slug` values.
 */
export async function detectSecretsAsync(text: string): Promise<Detection[]> {
  if (!text || text.length === 0) return []
  const [vendored, viaSecretlint] = await Promise.all([
    Promise.resolve(detectSecrets(text)),
    // Lazy-import keeps the sync `detectSecrets` path free of Secretlint
    // initialization cost; paid once on first async call.
    import('./secretlint-source.js').then((m) => m.detectViaSecretlint(text)),
  ])

  // Merge with range-based dedupe. Vendored first wins on exact ties.
  const seen = new Map<string, Detection>()
  for (const d of vendored) {
    const key = `${d.start}:${d.end}`
    if (!seen.has(key)) seen.set(key, d)
  }
  for (const d of viaSecretlint) {
    const key = `${d.start}:${d.end}`
    if (!seen.has(key)) seen.set(key, d)
  }

  // Re-derive slugs against the merged set (Secretlint and vendored each
  // had independent `existing` sets; we coalesce here).
  const existing = new Set<string>()
  const out: Detection[] = Array.from(seen.values())
    .sort((a, b) => a.start - b.start)
    .map((d) => {
      const slug = deriveSlug({ key_name: d.key_name, rule_id: d.rule_id }, existing)
      existing.add(slug)
      return { ...d, suggested_slug: slug }
    })
  return out
}
