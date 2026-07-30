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
 * Big inputs (>32 KB) are chunked into 16 KB windows with 8 KB overlap
 * (chunker.ts) for ReDoS bounding; we dedupe by byte-offset after. The
 * overlap must exceed the largest single secret (an 8192-bit RSA PEM is
 * ~6.5 KB) so a boundary-straddling key is never split across windows.
 *
 * Nearby test/mock/example/fixture/dummy markers (within 40 chars) demote
 * a hit to `suppressed: true`. The caller decides what that means (our
 * convention: suppressed high-confidence → ambiguous, user is asked).
 *
 * Detection is vendored-patterns-only and synchronous: every live caller
 * (inbound gate, outbound scrub, `redact.ts`, `pipeline.ts`) runs
 * `detectSecrets`. There is deliberately NO Secretlint/async "safety net"
 * layered underneath — an earlier `detectSecretsAsync` + Secretlint wrapper
 * was never wired into any live path (test-only), so it was a false safety
 * net and has been removed (2026-07 secret-scrub review, tp-support F1).
 * Arming a new async scanner belongs in its own validated change, not the
 * scrub-coverage PR. Gitleaks TOML is loaded via `gitleaks-loader.ts`.
 */
import { ALL_PATTERNS } from './patterns.js'
import { scanKeyValue, scanMemorablePasswords, type RawHit } from './kv-scanner.js'
import { scanDbUris } from './db-uri.js'
import { INERT_GATED_RULES, isInertValue } from './inert-values.js'
import { scanGenericSecrets } from './generic-entropy.js'
import { shannonEntropy } from './entropy.js'
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
        // Inert VALUE gate. `PASSWORD: ${DB_PASSWORD}`,
        // `POSTGRES_PASSWORD: vault:pg/password`,
        // `JWT_SECRET=<generate-with-openssl-rand>` and `--token <value>`
        // are documentation, not credentials — and a vault key NAME is
        // exactly what an agent is meant to remember, so masking it
        // deletes information and keeps none. Until #3982's review this
        // list applied only inside the memorable-password rule, so letter
        // case decided the outcome: `password: ${DB_PASSWORD}` survived
        // and `PASSWORD: ${DB_PASSWORD}` was destroyed. See
        // inert-values.ts.
        if (INERT_GATED_RULES.has(p.rule_id) && isInertValue(cap)) continue
        // 2026-05-12: shape gate on env_key_value — the pattern matches
        // any value after an ALLCAPS *_KEY/_TOKEN/_SECRET/_PASSWORD
        // identifier, which previously fired on casual chat like
        // "MY_TOKEN=hello" or "OPENAI_API_KEY=sk-yourkey" (placeholder
        // values, code-shaped human language). Operator UAT reproduced
        // this on 2026-05-12 — the redaction pipeline was deleting the
        // operator's *question* and staging a card asking them to save
        // the literal word "hello" as a vault entry.
        //
        // Mirror the kv_entropy gate from kv-scanner.ts: require
        // BOTH a length floor (cuts short placeholders) AND a Shannon
        // entropy floor (cuts low-randomness words like "hello",
        // "yourkey", "foo"). Threshold is slightly looser than
        // kv_entropy's 4.0 because the LHS structure already gives us
        // higher confidence that this IS an env declaration.
        // See tests/secret-detect-false-positives.test.ts for the
        // pinned cases.
        if (p.rule_id === 'env_key_value') {
          const ENV_KV_MIN_LEN = 12
          const ENV_KV_MIN_ENTROPY = 3.5
          if (cap.length < ENV_KV_MIN_LEN) continue
          if (shannonEntropy(cap) < ENV_KV_MIN_ENTROPY) continue
        }
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
    // Connection-URI credentials (`postgres://user:pass@host`) — the
    // scheme-agnostic shape url-redact.ts cannot see.
    for (const h of scanDbUris(win.text)) {
      raw.push({ ...h, start: h.start + win.offset, end: h.end + win.offset })
    }
    // Human-memorable passwords behind an explicit `password` label — the
    // shape the Shannon-entropy gate above is structurally blind to.
    for (const h of scanMemorablePasswords(win.text)) {
      raw.push({ ...h, start: h.start + win.offset, end: h.end + win.offset })
    }
    // Generic bare-high-entropy fallback (ambiguous). Catches standalone
    // tokens no prefix/KV rule matched. dropOverlaps/dedupeRaw below prefer
    // a high-confidence pattern hit over a generic one on the same range,
    // so a recognized token isn't double-flagged.
    const genHits = scanGenericSecrets(win.text)
    for (const h of genHits) {
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
 * Drop an AMBIGUOUS hit that is fully contained inside another (larger)
 * hit — e.g. a `generic_high_entropy` sub-span sitting inside a recognized
 * high token, or inside an Authorization Bearer match. Narrow by design:
 * it never drops a high-confidence hit and never touches high-vs-high
 * overlaps, so it can't suppress a real detection — it only removes the
 * redundant low-precision sub-spans the generic fallback can emit.
 */
function dropOverlaps(hits: RawHit[]): RawHit[] {
  const out = hits.filter(
    (h) =>
      !(
        h.confidence === 'ambiguous' &&
        hits.some(
          (o) =>
            o !== h &&
            o.start <= h.start &&
            o.end >= h.end &&
            !(o.start === h.start && o.end === h.end),
        )
      ),
  )
  // Sort by start offset for deterministic downstream handling.
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out
}

export { maskToken } from './mask.js'
export { redactUrls } from './url-redact.js'
export { deriveSlug } from './slug.js'
