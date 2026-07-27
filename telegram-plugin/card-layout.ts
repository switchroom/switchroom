/**
 * Card layout core — the ONE place a status/progress card is composed.
 *
 * Every card the gateway paints (🤖 agent, 🛠 single worker, 🛠 WORKERS
 * combined, and their overflow/terminal variants) is expressed as a
 * {@link CardSpec}: fixed `chrome` lines, N `sections` (each an optional
 * header plus a windowed `✓`/`→` step trail), and fixed `footer` lines. The
 * renderers in `tool-activity-summary.ts` / `worker-activity-feed.ts` are
 * CONFIGURATIONS of this module, not parallel implementations.
 *
 * Two things used to exist twice and agreed only by hand (#3844):
 *
 *   1. **Header composition.** The combined card built its own row header
 *      instead of going through `renderActivityHeader`, so the metrics run
 *      (`{elapsed} · {n} tools · {t} tok · {model}`) was written out in two
 *      places. It is now composed exactly once, by {@link metricsRun}, which
 *      the agent header, the worker header, the combined row header and the
 *      combined glance line all read.
 *   2. **Char-budget enforcement.** The combined card carried its own
 *      row-shrinking loop instead of the status card's `fitCardToBudget`.
 *      There is now exactly one budget enforcer — {@link fitCardToBudget} —
 *      a generic "render at progressively deeper shrink levels, take the
 *      first that fits" loop. Each card supplies what a shrink level MEANS
 *      (drop the oldest bullet / drop the newest row); nothing else compares
 *      a rendered card against `STATUS_CARD_CHAR_BUDGET`.
 *
 * Nothing in here knows about workers, turns, or Telegram transport — it is
 * pure string composition, so a card variant can be rendered (and asserted)
 * without any of the feed machinery.
 */

import { escapeMarkdown, stripMarkdown, truncate, stackCardLines } from './card-format.js'
import { formatModelLabel } from './model-label.js'
import { STATUS_CARD_CHAR_BUDGET, STATUS_LINE_MAX, STATUS_ROLLING_LINES } from './status-no-truncate.js'

// ─── Metrics composition (the single header vocabulary) ─────────────────────

/** Format elapsed milliseconds for display in the activity header (e.g. "12s", "2m05s"). */
export function formatFeedElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${(s % 60).toString().padStart(2, '0')}s`
}

/**
 * Compact token-count formatter for the activity card's metrics line:
 *   <1000        → raw          ("940")
 *   ≥1000, <1e6  → one-decimal k ("12.4k", "1.0k")
 *   ≥1e6         → one-decimal M ("1.2M")
 * Negative / non-finite inputs clamp to "0". The caller appends " tok".
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.floor(n))
  if (n < 1_000_000) {
    // Round to the displayed 1-decimal k FIRST: inputs in [999_950, 999_999]
    // round to "1000.0k", which must promote into the M branch rather than
    // render a nonsense "1000.0k". Fall through when the rounded k reaches 1000.
    const k = Number((n / 1000).toFixed(1))
    if (k < 1000) return `${k.toFixed(1)}k`
  }
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * The ` · {N} tok` metrics segment, or '' when there are no tokens to show.
 * A 0 / undefined total (a worker that emitted no usage — e.g. a non-Claude
 * transcript) OMITS the segment entirely so the line stays clean; every card
 * that shows tokens reads this one predicate so they never diverge.
 */
export function tokenSegment(totalTokens: number | undefined): string {
  if (totalTokens == null || totalTokens <= 0) return ''
  return ` · ${formatTokenCount(totalTokens)} tok`
}

/** `tool` / `tools`, pluralised once for every surface that prints a tool count. */
export function toolWord(n: number): string {
  return n === 1 ? 'tool' : 'tools'
}

/** Terminal/running state a card (or a row on it) can report. */
export type CardState = 'running' | 'done' | 'failed' | 'incomplete'

/**
 * The metrics RUN — the dot-separated `{elapsed} · {n} tools · {t} tok · {model}`
 * text that every card header carries, WITHOUT the italic wrapper (callers own
 * the wrapper because they place the leading separator differently).
 *
 * This is the single composition point the audit (#3844) found forked: the
 * combined card's row header spelled the same run out by hand, so a change to
 * (say) token placement had to be made twice and agreed only by inspection.
 *
 * `running` puts elapsed FIRST (it is the live fact); a terminal state leads
 * with the state word and moves elapsed to the tail, so a failed or reaped
 * worker never reads as done.
 */
export function metricsRun(
  elapsedMs: number,
  toolCount: number,
  state: CardState,
  totalTokens?: number,
  model?: string,
): string {
  const elapsed = formatFeedElapsed(elapsedMs)
  const tokPart = tokenSegment(totalTokens)
  const modelLabel = formatModelLabel(model)
  const modelPart = modelLabel != null ? ` · ${escapeMarkdown(modelLabel)}` : ''
  return state === 'running'
    ? `${elapsed} · ${toolCount} ${toolWord(toolCount)}${tokPart}${modelPart}`
    : `${state} · ${toolCount} ${toolWord(toolCount)}${tokPart} · ${elapsed}${modelPart}`
}

/**
 * Line 1 of a card: `<emoji> <b>LABEL</b> · <i>description</i>` (description
 * optional). Shared by the agent card, the worker card and the static
 * superseded notice, so the card's type chrome is composed in one place.
 */
export function renderCardTitleLine(emoji: string, label: string, description: string): string {
  const descPart = description.length > 0 ? ` · _${escapeMarkdown(description)}_` : ''
  return `${emoji} **${escapeMarkdown(label)}**${descPart}`
}

/**
 * Render a two-line header for an activity card.
 *
 * Line 1: `<emoji> <b>Label</b> · <i>description</i>`  (description optional)
 * Line 2: the metrics run, italicised.
 *
 * Returns a two-element array of ready Telegram markdown lines (no trailing
 * newline).
 */
export function renderActivityHeader(
  emoji: string,
  label: string,
  description: string,
  elapsedMs: number,
  toolCount: number,
  state: CardState,
  model?: string,
  totalTokens?: number,
): [string, string] {
  return [
    renderCardTitleLine(emoji, label, description),
    `_${metricsRun(elapsedMs, toolCount, state, totalTokens, model)}_`,
  ]
}

// ─── Per-line truncation pipeline ───────────────────────────────────────────
//
// Per RAW line, in this EXACT order:
//   1. stripMarkdown(raw)
//   2. .replace(/\s+/g, ' ').trim()
//   3. truncate(_, STATUS_LINE_MAX)
//   4. escapeMarkdown(_)   ← escape is ALWAYS the last per-line op.
// Escaping last is load-bearing: clipping an already-escaped string can split
// a markdown escape (\* → \), which renders wrong.

/** Clean + clip + escape a single raw step line. Returns ready-to-wrap markdown. */
export function escapeStepLine(raw: string): string {
  const cleaned = stripMarkdown(raw).replace(/\s+/g, ' ').trim()
  return escapeMarkdown(truncate(cleaned, STATUS_LINE_MAX))
}

/** The cleaned (unescaped) form of a raw line — the input to `truncate`. */
export function cleanStepLine(raw: string): string {
  return stripMarkdown(raw).replace(/\s+/g, ' ').trim()
}

// ─── Card spec ──────────────────────────────────────────────────────────────

/**
 * How a FINISHED step bullet is drawn.
 *   'struck' — `~~_✓ step_~~`, the normal card body.
 *   'plain'  — `_step_`, used by the char-budget shrink levels where the
 *              strike/✓ chrome is spent bytes on a card already over the wire
 *              limit.
 */
export type DoneStyle = 'struck' | 'plain'

/** One section of a card: an optional header plus a windowed step trail. */
export interface CardSection {
  /** Ready lines emitted above this section's steps (the combined row header). */
  header?: string[]
  /** ALREADY-ESCAPED step lines, oldest → newest. */
  steps: string[]
  /** Trailing steps shown; the remainder collapses to a `+N earlier…` marker. */
  window: number
  /** When true every step renders done — no live `→` bullet. */
  allDone?: boolean
  /** Heartbeat suffix rendered INSIDE the newest in-progress bullet. */
  liveSuffix?: string
  /**
   * Literal prefix on EVERY line this section emits (marker, bullets,
   * placeholder), OUTSIDE the markdown spans so it never lands inside an
   * emphasis run.
   */
  indent?: string
  /**
   * Token before a done step and inside the overflow marker. `'✓ '` on a normal
   * body; `''` for the `↳` nested-child block, whose `↳` glyph already marks it.
   */
  doneMark?: string
  /** See {@link DoneStyle}. Default 'struck'. */
  doneStyle?: DoneStyle
  /** Emitted (with `indent`) when this section has no steps at all. */
  placeholder?: string
}

/** A whole card, as fixed chrome + sections + fixed footer. */
export interface CardSpec {
  /** Lines above every section — the card header, or the combined glance line. */
  chrome?: string[]
  sections: CardSection[]
  /** Lines below every section — `✓ N steps`, the result block, the spill line. */
  footer?: string[]
}

/**
 * Emit one section's lines into `out`. This is the single `✓`/`→` bullet
 * emitter: every step line on every card comes through here.
 */
export function emitSection(out: string[], section: CardSection): void {
  const indent = section.indent ?? ''
  const doneMark = section.doneMark ?? '✓ '
  const doneStyle = section.doneStyle ?? 'struck'
  const allDone = section.allDone === true
  const liveSuffix = section.liveSuffix ?? ''
  if (section.header != null) out.push(...section.header)
  if (section.steps.length === 0) {
    if (section.placeholder != null) out.push(`${indent}${section.placeholder}`)
    return
  }
  const shown = section.steps.slice(-Math.max(1, section.window))
  const hidden = section.steps.length - shown.length
  if (hidden > 0) out.push(`${indent}_${doneMark}+${hidden} earlier…_`)
  const lastIdx = shown.length - 1
  shown.forEach((s, i) => {
    if (!allDone && i === lastIdx) {
      out.push(`${indent}**→ ${s}${liveSuffix}**`)
      return
    }
    out.push(doneStyle === 'plain' ? `${indent}_${s}_` : `${indent}~~_${doneMark}${s}_~~`)
  })
}

/**
 * Shared step-feed emitter (back-compat signature). Appends `✓`/`→` bullet
 * lines to `out` for the given ALREADY-ESCAPED step strings. Thin wrapper over
 * {@link emitSection}.
 */
export function renderStepFeed(
  out: string[],
  steps: string[],
  allDone: boolean,
  liveSuffix = '',
  window: number = STATUS_ROLLING_LINES,
  indent = '',
): void {
  emitSection(out, { steps, window, allDone, liveSuffix, indent })
}

/** Flatten a spec to its ordered card lines. */
export function cardSpecLines(spec: CardSpec): string[] {
  const out: string[] = [...(spec.chrome ?? [])]
  for (const section of spec.sections) emitSection(out, section)
  out.push(...(spec.footer ?? []))
  return out
}

/**
 * Join card lines with GFM hard breaks so the styled prose lines don't collapse
 * onto one visual line in the rich-message renderer — see `stackCardLines`.
 *
 * `collapseSafe` is unconditional here: every card this module renders is a
 * PINNED surface, and Telegram's pinned bar shows a pinned message collapsed to
 * one line with the newlines dropped and nothing substituted (#3666).
 */
export function stackCard(lines: string[]): string {
  return stackCardLines(lines, { collapseSafe: true })
}

/** Render a spec straight to wire text, with no budget enforcement. */
export function renderCardSpec(spec: CardSpec): string {
  return stackCard(cardSpecLines(spec))
}

// ─── The one char-budget enforcer ───────────────────────────────────────────

/** One shrink level's rendered candidate. */
export interface CardCandidate {
  spec: CardSpec
  /**
   * An additional card-specific ceiling this candidate violates (the combined
   * card's total body-line budget). A candidate that fits the char budget but
   * sets this is still rejected, so both ceilings are enforced by one loop.
   */
  overflow?: boolean
}

/**
 * THE char-budget backstop — the only place a rendered card is measured against
 * `STATUS_CARD_CHAR_BUDGET`.
 *
 * `build(level)` renders the card at progressively deeper shrink levels
 * (level 0 = the full card). The first level whose rendered text fits the
 * budget and clears its own `overflow` flag wins; if even `maxLevel` does not
 * fit, that deepest render is returned — a card is always emitted, never
 * dropped.
 *
 * What a level MEANS is the caller's business and is genuinely card-specific:
 * the status card drops its oldest bullet (and, at its deepest level, truncates
 * an oversized newest bullet), while the combined card drops its newest worker
 * row into `+M more working…`. The MECHANISM — render, measure, accept or go
 * deeper — exists only here.
 */
export function fitCardToBudget(
  build: (level: number) => CardCandidate,
  maxLevel: number,
): string {
  let text = ''
  for (let level = 0; level <= maxLevel; level++) {
    const candidate = build(level)
    text = renderCardSpec(candidate.spec)
    if (candidate.overflow !== true && text.length <= STATUS_CARD_CHAR_BUDGET) return text
  }
  return text
}
