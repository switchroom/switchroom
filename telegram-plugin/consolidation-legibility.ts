/**
 * Consolidation-driven chat-legible memory surface — hindsight Phase 4,
 * the "updated what I know about Y" side (RFC
 * `reference/rfcs/hindsight-synthesis-layers.md`, Phase 4).
 *
 * #2858 shipped the STORE/CORRECT side driven by deterministic tool-call
 * observation of the interactive session (`create_directive` →
 * "📌 remembered", `invalidate_memory` / demote → "✂️ forgot"). That path
 * sees only what the *foreground* agent explicitly does with memory tools.
 *
 * The RFC also names the poll-free UPDATE side: when the *background*
 * consolidation engine actually distils new durable observations (or
 * supersedes stale ones) it emits a `consolidation.completed` webhook, and
 * that is the honest signal for a terse "🧠 updated what I know about Y"
 * line. This module is the consumer for that webhook.
 *
 * Two hard constraints from the RFC and the `remember-across-sessions` job
 * shape every choice here:
 *
 *   1. **Sparse + material-only.** Consolidation fires on *every* retain
 *      (`retainEveryNTurns=1`), so the raw webhook stream is per-turn. A
 *      line per fire would BE the "regurgitating old facts unprompted just
 *      to prove it remembered" anti-pattern the job forbids. So we surface
 *      a line ONLY when a consolidation genuinely *stored* or *corrected* a
 *      durable memory (`detectConsolidationEvent` returns null otherwise),
 *      AND we rate-limit hard (`ConsolidationRateLimiter`) so bursts of
 *      material consolidations collapse to at most one line per interval.
 *
 *   2. **OFF by default.** Unlike the #2858 tool-observation path (default
 *      ON — it fires on rare, unambiguous, user-initiated tool calls), this
 *      path is driven by an unbounded background engine and by a webhook the
 *      pinned hindsight image does not yet emit. It stays OFF until an
 *      operator opts in (`SWITCHROOM_CONSOLIDATION_LEGIBILITY=1`), matching
 *      the RFC's "sparse, not per-turn … clearly gated" language.
 *
 * No model call, no polling, no `claude -p` — this is a pure consumer of a
 * webhook the receiver already verified + forwarded (claude-native clean).
 */

import { stripMarkdown, truncate } from './card-format.js'

/** The hindsight webhook source + event this module consumes. */
export const HINDSIGHT_WEBHOOK_SOURCE = 'hindsight'
export const CONSOLIDATION_COMPLETED_EVENT = 'consolidation.completed'

/**
 * OPT-IN — the operator must set SWITCHROOM_CONSOLIDATION_LEGIBILITY to a
 * truthy value ('1' / 'true' / 'on' / 'yes') to enable. Default OFF: the
 * literal opposite of the #2858 tool-observation path's default-ON switch,
 * deliberately, because this side is driven by an unbounded background
 * engine (RFC: "sparse, not per-turn"; "clearly gated").
 */
export function isConsolidationLegibilityEnabled(envVal: string | undefined): boolean {
  if (envVal == null) return false
  const v = envVal.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

export type ConsolidationLegibilityKind = 'updated' | 'revised'

export interface ConsolidationLegibilityEvent {
  /** `updated` — new durable observation(s) distilled; `revised` — an
   *  existing memory was superseded/invalidated by consolidation. `revised`
   *  is the higher-signal framing and wins when both happened. */
  kind: ConsolidationLegibilityKind
  /** Best-effort human subject ("your deploy preferences"). May be empty —
   *  the render then falls back to a bare "updated what I know about you".
   *  Raw (unescaped); `renderConsolidationLine` cleans it. */
  topic: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Coerce a numeric-ish field (number, or a numeric string) to a count ≥ 0. */
function asCount(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? Math.floor(v) : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  // An array field (e.g. `observations: [...]`) counts by length.
  if (Array.isArray(v)) return v.length
  return 0
}

/** First non-empty count across a set of tolerant field aliases. */
function firstCount(payload: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const c = asCount(payload[k])
    if (c > 0) return c
  }
  return 0
}

/**
 * Best-effort human subject of the consolidation. The webhook is RFC-only
 * (the pinned image does not emit it yet), so tolerate a range of shapes:
 * an explicit `subject` / `topic`, the first entry of `subjects`/`entities`,
 * or the `subject`/`statement` of the first observation. Anything opaque
 * (a bank_id, a uuid) is left to the empty fallback.
 */
function extractTopic(payload: Record<string, unknown>): string {
  const direct = asString(payload.subject).trim() || asString(payload.topic).trim()
  if (direct) return direct

  for (const key of ['subjects', 'entities', 'topics']) {
    const arr = payload[key]
    if (Array.isArray(arr)) {
      for (const el of arr) {
        if (typeof el === 'string' && el.trim()) return el.trim()
        if (el && typeof el === 'object') {
          const name = asString((el as Record<string, unknown>).name).trim()
          if (name) return name
        }
      }
    }
  }

  const obs = payload.observations
  if (Array.isArray(obs) && obs.length > 0 && obs[0] && typeof obs[0] === 'object') {
    const o = obs[0] as Record<string, unknown>
    const sub = asString(o.subject).trim()
    if (sub) return sub
    const stmt = asString(o.statement).trim()
    if (stmt) return stmt
  }
  return ''
}

/**
 * Decide whether a `consolidation.completed` payload represents a MATERIAL
 * durable change — a genuine store or correct — or null if it is a routine
 * no-op consolidation (the common case, which must surface NO line).
 *
 * Pure, no I/O. Tolerant of the RFC-only payload's exact field names.
 */
export function detectConsolidationEvent(
  payload: Record<string, unknown> | undefined,
): ConsolidationLegibilityEvent | null {
  if (payload == null || typeof payload !== 'object') return null

  const stored = firstCount(payload, [
    'stored',
    'created',
    'added',
    'new_observations',
    'observations_created',
    'observations',
  ])
  const corrected = firstCount(payload, [
    'corrected',
    'invalidated',
    'superseded',
    'removed',
    'demoted',
  ])

  // Immaterial: nothing durable stored, nothing corrected. This is the
  // overwhelming majority of consolidation fires — surface nothing.
  if (stored === 0 && corrected === 0) return null

  // A correction ("what I believed changed") is higher-signal than another
  // stored fact, so it wins the framing when both happened.
  const kind: ConsolidationLegibilityKind = corrected > 0 ? 'revised' : 'updated'
  return { kind, topic: extractTopic(payload) }
}

/** HTML-escape for parse_mode:'HTML' (escape the 3 entity-significant chars). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Max chars of subject shown on the one-liner. */
const TOPIC_MAX = 120

/**
 * Render the terse one-line surface (Telegram HTML). Sent as a real
 * `sendMessage` with notifications suppressed — a status surface, never a
 * device ping.
 *
 *   🧠 <i>updated what I know</i> about "your deploy preferences"
 *   🧠 <i>revised what I know</i> about "the old runbook"
 *   🧠 <i>updated what I know about you.</i>        (no legible subject)
 */
export function renderConsolidationLine(ev: ConsolidationLegibilityEvent): string {
  const verb = ev.kind === 'revised' ? 'revised' : 'updated'
  const clean = truncate(stripMarkdown(ev.topic).replace(/\s+/g, ' ').trim(), TOPIC_MAX)
  if (clean.length === 0) return `🧠 <i>${verb} what I know about you.</i>`
  return `🧠 <i>${verb} what I know</i> about "${escapeHtml(clean)}"`
}

export interface ConsolidationRateLimiterOptions {
  /** Minimum gap between ANY two surfaced lines for one agent. Collapses a
   *  burst of material consolidations to at most one line per window.
   *  Default 10 min. */
  minIntervalMs?: number
  /** Suppress an IDENTICAL line (same kind+topic) for this long even if the
   *  min-interval has passed — stops "updated about X" repeating as the
   *  engine re-derives the same observation. Default 1 hour. */
  dedupWindowMs?: number
  /** Clock override (tests). */
  now?: () => number
}

const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000
/** Cap on retained per-signature timestamps so the map can't grow unbounded
 *  under a long-lived gateway. */
const MAX_TRACKED_SIGNATURES = 512

/**
 * Per-agent rate limiter for the consolidation surface. Two independent
 * gates, both must pass:
 *
 *   - **min-interval** — at most one line per agent per `minIntervalMs`,
 *     regardless of subject. This is the anti-spam floor.
 *   - **dedup** — the same (kind+topic) signature is suppressed for
 *     `dedupWindowMs` even across the interval boundary.
 *
 * Stateful + long-lived: the gateway constructs ONE instance and reuses it
 * across events. Deterministic under an injected clock (tests).
 */
export class ConsolidationRateLimiter {
  private readonly minIntervalMs: number
  private readonly dedupWindowMs: number
  private readonly clock: () => number
  private readonly lastEmit = new Map<string, number>()
  private readonly recentSig = new Map<string, number>()

  constructor(opts: ConsolidationRateLimiterOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS
    this.clock = opts.now ?? Date.now
  }

  /**
   * True when a line for (`agent`, `signature`) may be surfaced now, and
   * records the emit. False (and records nothing) when either gate blocks.
   * `signature` should be stable for identical lines (e.g. `kind:topic`).
   */
  allow(agent: string, signature: string, now?: number): boolean {
    const t = now ?? this.clock()

    const last = this.lastEmit.get(agent)
    if (last !== undefined && t - last < this.minIntervalMs) return false

    const sigKey = `${agent}\0${signature}`
    const seen = this.recentSig.get(sigKey)
    if (seen !== undefined && t - seen < this.dedupWindowMs) return false

    this.lastEmit.set(agent, t)
    this.recentSig.set(sigKey, t)
    this.pruneSignatures(t)
    return true
  }

  /** Drop signature entries older than the dedup window; hard-cap the map. */
  private pruneSignatures(now: number): void {
    for (const [k, ts] of this.recentSig) {
      if (now - ts >= this.dedupWindowMs) this.recentSig.delete(k)
    }
    if (this.recentSig.size > MAX_TRACKED_SIGNATURES) {
      // Evict oldest until back under the cap (insertion order ≈ age).
      const excess = this.recentSig.size - MAX_TRACKED_SIGNATURES
      let i = 0
      for (const k of this.recentSig.keys()) {
        if (i++ >= excess) break
        this.recentSig.delete(k)
      }
    }
  }
}

/** Stable dedup signature for an event (kind + normalised topic). */
export function consolidationSignature(ev: ConsolidationLegibilityEvent): string {
  return `${ev.kind}:${ev.topic.replace(/\s+/g, ' ').trim().toLowerCase()}`
}
