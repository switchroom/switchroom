/**
 * Shared friendly-model formatter for progress / activity surfaces.
 *
 * Every progress card renders the model actually in use, sourced LIVE from the
 * session transcripts (`message.model` on each `type:"assistant"` line — the
 * exact resolved model for that API call). This module owns the two pure
 * decisions both the capture side (session-tail projection) and the render side
 * (activity/worker cards) depend on:
 *
 *   - `isModelSentinel(v)` — is this a value we must NOT treat as a real model?
 *     Compaction / synthetic transcript lines carry `model:"<synthetic>"`, and
 *     test fixtures may carry junk. Anything starting with `<`, empty, or not
 *     shaped like a model id is a sentinel: the capture side SKIPS it and keeps
 *     the previous value; it is never rendered.
 *   - `formatModelLabel(v)` — the short friendly form shown on a card's metrics
 *     line (e.g. `claude-opus-4-8` → `opus 4.8`). Returns null for sentinels so
 *     the caller simply omits the model field (never guesses from config).
 *
 * Friendly-form rules (verified against live fleet transcript values):
 *   - `claude-opus-4-8`            → `opus 4.8`
 *   - `claude-sonnet-5`           → `sonnet 5`
 *   - `claude-haiku-4-5-20251001` → `haiku 4.5`   (trailing YYYYMMDD dropped)
 *   - `sr-glm-5`, `sr-gpt-5.5`    → verbatim (LiteLLM routing ids stay literal)
 *   - anything else               → verbatim (unknown but model-shaped)
 */

/** Trailing 8-digit date stamp (YYYYMMDD) on a claude model id — dropped. */
const DATE_SUFFIX = /^\d{8}$/

/**
 * True when `model` must NOT be treated as a real resolved model. Compaction /
 * synthetic lines write `model:"<synthetic>"`; fixtures may carry junk. Callers
 * that see a sentinel keep the previously-seen model (or omit the field).
 */
export function isModelSentinel(model: unknown): boolean {
  if (typeof model !== 'string') return true
  const m = model.trim()
  if (m.length === 0) return true
  // Synthetic / placeholder sentinels: `<synthetic>`, `<compact>`, etc.
  if (m.startsWith('<')) return true
  // Model ids are simple tokens (letters, digits, dot, dash, underscore,
  // slash). Anything with whitespace or leading punctuation is junk.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(m)) return true
  return false
}

/**
 * Short friendly label for a resolved model id, or null when `model` is absent
 * or a sentinel (caller omits the field — never guesses). See module header for
 * the rules.
 */
export function formatModelLabel(model: string | null | undefined): string | null {
  if (model == null) return null
  const m = model.trim()
  if (isModelSentinel(m)) return null
  // LiteLLM / self-routed ids stay verbatim — the sr- prefix is meaningful.
  if (m.startsWith('sr-')) return m
  if (m.startsWith('claude-')) {
    const rest = m.slice('claude-'.length)
    const parts = rest.split('-').filter((p) => p.length > 0)
    if (parts.length === 0) return m
    const family = parts[0]
    const version = parts.slice(1).filter((p) => !DATE_SUFFIX.test(p))
    if (version.length === 0) return family
    return `${family} ${version.join('.')}`
  }
  // Unknown but model-shaped (a future family, a bare alias) — show verbatim.
  return m
}
