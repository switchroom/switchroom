/**
 * llm-error-present.ts — humanized, cross-surface-deduped presentation of an
 * LLM/API error, so a raw `b'{"type":"error",…}'` line never reaches a user.
 *
 * THE PROBLEM this closes
 * -----------------------
 * One Anthropic error JSONL line fans out to THREE independent render surfaces,
 * none consulting each other, each historically printing the raw `detail`
 * string with its `b'{…}'` byte-blob attached:
 *   1. the agent turn-end "done" card (tool-activity-summary result block),
 *   2. the operator-event "🚦 Rate limited" card (raw `detail`), and
 *   3. the reply/answer passthrough (the synthetic-assistant error text relayed
 *      as the turn's answer).
 *
 * This module owns the ONE clean rendering + the ONE dedup authority the three
 * surfaces consult, so a fan-out produces EXACTLY ONE user-facing message with
 * NO raw JSON. It reuses the existing classifiers rather than re-deriving them:
 * `classify429Detail` (throttle-tier.ts), `detectModelUnavailable` /
 * `parseResetTime` (model-unavailable.ts), `isLitellmProxyLocal429` /
 * `isTransientUpstreamSignal` (model-unavailable.ts), `classifyClaudeError`
 * (operator-events.ts). `coreText` is ALWAYS built from a per-kind template —
 * never from the raw `detail` — and `stripRawErrorBytes` is the belt-and-braces
 * scrub so even the enrichment `reason` can carry no JSON.
 *
 * Pure module: no IPC, no bot, no FS. The only mutable state is the
 * `ErrorPresenceGate` singleton (an in-memory dedup ledger), driven by an
 * injectable `now`.
 */

import {
  detectModelUnavailable,
  isLitellmProxyLocal429,
  parseResetTime,
} from './model-unavailable.js'
import { classify429Detail } from './throttle-tier.js'
import { classifyClaudeError } from './operator-events.js'
import type { InlineKeyboardMarkup } from './operator-events.js'
import { looksLikeRawApiError } from './pty-partial-handler.js'
import { stripRawErrorBytes } from './raw-error-scrub.js'
import { fmtLocalClock, tzAbbrev } from './shared/local-time.js'

export { stripRawErrorBytes } from './raw-error-scrub.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type LlmErrorKind =
  | 'rate_limit'
  | 'overload_529'
  | 'quota_wall'
  | 'auth'
  | 'model_unavailable'
  | 'transient'
  | 'unknown'

export type LlmErrorSource = 'anthropic' | 'litellm-local' | 'network'

export interface ParsedLlmError {
  kind: LlmErrorKind
  /** Human, JSON-STRIPPED one-liner built from a per-kind template. Never raw. */
  coreText: string
  /** Optional extra human context (also JSON-stripped). */
  reason?: string
  /** Parsed reset instant, when the source carried one. */
  resetAt?: Date
  /** Parsed retry-after window in ms, when the source carried one. */
  retryAfterMs?: number
  /** Resolved model id, when the source named one. */
  model?: string
  /** Anthropic `request_id`, when present — the strongest dedup key. */
  requestId?: string
  source: LlmErrorSource
  /** True when the harness is still retrying this error internally (mid-retry). */
  autoRetrying: boolean
  /** True when the failure is final (NOT an in-flight retry). */
  terminal: boolean
}

/** Optional retry-state annotations Claude Code stamps on a retried error line. */
export interface LlmErrorRetryState {
  retryAttempt: number | null
  maxRetries: number | null
}

// ─── request_id extraction ───────────────────────────────────────────────────

/** Pull an Anthropic `request_id` out of a raw string, or undefined. */
export function extractRequestId(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const m =
    raw.match(/["']request[_-]?id["']\s*:\s*["']([A-Za-z0-9._-]+)["']/i) ??
    raw.match(/\brequest[_-]?id[=:]\s*([A-Za-z0-9._-]+)/i)
  return m ? m[1] : undefined
}

/** Pull a resolved model id (`claude-…`, `sr-…`) out of a raw string, or undefined. */
function extractModel(raw: string): string | undefined {
  const m = raw.match(/["']?model["']?\s*[=:]\s*["']?((?:claude|sr)[A-Za-z0-9._-]+)/i)
  return m ? m[1] : undefined
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const TRANSIENT_KINDS: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>([
  'rate_limit',
  'overload_529',
  'transient',
])

/** The always-actionable kinds — NEVER silenced, even inside a collapse window. */
export function isActionableKind(kind: LlmErrorKind): boolean {
  return kind === 'auth' || kind === 'quota_wall'
}

/**
 * Parse a raw error string (a session-tail `detail`, an isApiErrorMessage
 * text, or a raw stderr line) into a structured, JSON-free ParsedLlmError.
 * Reuses the existing wording classifiers; maps their kinds into this union.
 */
export function parseLlmError(
  raw: string,
  retryState?: LlmErrorRetryState,
): ParsedLlmError {
  const text = typeof raw === 'string' ? raw : ''
  const requestId = extractRequestId(text)
  const model = extractModel(text)

  // Reset / retry-after best-effort (Anthropic + relative wordings).
  const resetAt = parseResetTime(text)
  const retryAfterMs =
    resetAt != null ? Math.max(0, resetAt.getTime() - Date.now()) : undefined

  const { kind, source } = classifyKindAndSource(text)

  // Retry / terminal semantics. Only the transient family can be mid-retry;
  // auth / quota_wall / model_unavailable are terminal by construction.
  let autoRetrying = false
  let terminal = true
  if (TRANSIENT_KINDS.has(kind)) {
    const { retryAttempt, maxRetries } = retryState ?? { retryAttempt: null, maxRetries: null }
    if (retryAttempt != null && maxRetries != null) {
      autoRetrying = retryAttempt < maxRetries
      terminal = retryAttempt >= maxRetries
    } else {
      // No retry annotation: treat as a surfaced (terminal) failure — Claude
      // writes the user-facing error shape only after its own retries are done.
      autoRetrying = false
      terminal = true
    }
  }

  const reasonRaw = stripRawErrorBytes(text)
  const reason = reasonRaw.length > 0 && reasonRaw.length <= 200 ? reasonRaw : undefined

  return {
    kind,
    coreText: buildCoreText(kind, source),
    ...(reason != null ? { reason } : {}),
    ...(resetAt != null ? { resetAt } : {}),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    ...(model != null ? { model } : {}),
    ...(requestId != null ? { requestId } : {}),
    source,
    autoRetrying,
    terminal,
  }
}

function classifyKindAndSource(text: string): { kind: LlmErrorKind; source: LlmErrorSource } {
  const lower = text.toLowerCase()

  // 1. Auth — always terminal, always actionable.
  const claudeKind = classifyClaudeError({ message: text, type: text })
  if (claudeKind === 'credentials-expired' || claudeKind === 'credentials-invalid') {
    return { kind: 'auth', source: 'anthropic' }
  }

  // 2. LiteLLM-proxy-LOCAL 429 — the proxy's own limiter, never Anthropic.
  //    Checked before the generic quota/overload matchers because some LiteLLM
  //    bodies contain the word "limit" that a quota matcher could seize on.
  if (isLitellmProxyLocal429(text)) {
    return { kind: 'rate_limit', source: 'litellm-local' }
  }

  // 3. Model-unavailable detector owns quota-wall / overload / network wording.
  const mu = detectModelUnavailable(text)
  if (mu != null) {
    if (mu.kind === 'quota_exhausted') return { kind: 'quota_wall', source: 'anthropic' }
    if (mu.kind === 'network') return { kind: 'transient', source: 'network' }
    // mu.kind === 'overload' | 'rate_limited' — split 529 overload from a 429.
    if (
      lower.includes('529') ||
      lower.includes('overloaded')
    ) {
      return { kind: 'overload_529', source: 'anthropic' }
    }
    // A 429-family transient. Three-way classify picks the source nuance; all
    // land on the calm rate_limit kind here.
    const c = classify429Detail(text)
    return {
      kind: 'rate_limit',
      source: c === 'litellm-local' ? 'litellm-local' : 'anthropic',
    }
  }

  // 4. Credit balance is a quota-family wall (actionable).
  if (claudeKind === 'credit-exhausted') {
    return { kind: 'quota_wall', source: 'anthropic' }
  }

  // 5. Bare rate-limit classification from the operator taxonomy.
  if (claudeKind === 'rate-limited') {
    return { kind: 'rate_limit', source: 'anthropic' }
  }
  if (claudeKind === 'unknown-5xx') {
    return { kind: 'overload_529', source: 'anthropic' }
  }

  return { kind: 'unknown', source: 'anthropic' }
}

function buildCoreText(kind: LlmErrorKind, source: LlmErrorSource): string {
  switch (kind) {
    case 'rate_limit':
      return source === 'litellm-local'
        ? 'Hit the local proxy rate limit — retrying automatically.'
        : 'Rate limited by Anthropic — retrying automatically.'
    case 'overload_529':
      return 'Anthropic is overloaded (529) — retrying automatically.'
    case 'quota_wall':
      return 'Usage limit reached on this Claude subscription.'
    case 'auth':
      return 'Claude login needs re-authentication.'
    case 'model_unavailable':
      return 'The model is temporarily unavailable.'
    case 'transient':
      return source === 'network'
        ? "Couldn't reach Anthropic (network) — retrying automatically."
        : 'A temporary upstream hiccup — retrying automatically.'
    case 'unknown':
      return 'The model returned an error.'
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export interface RenderedLlmError {
  text: string
  keyboard?: InlineKeyboardMarkup
}

/**
 * Format a reset instant in the operator's local tz plus a relative tail, e.g.
 * `clears ~4:52pm AEST (~in 38m)`. Returns '' when there is no reset to show.
 */
export function formatResetLocal(resetAt: Date | undefined, tz: string, now: Date = new Date()): string {
  if (resetAt == null) return ''
  const ms = resetAt.getTime()
  if (!Number.isFinite(ms)) return ''
  const clock = fmtLocalClock(ms, tz)
  const abbrev = tzAbbrev(ms, tz)
  const rel = formatRelativeTail(ms - now.getTime())
  return rel ? `clears ~${clock} ${abbrev} (${rel})` : `clears ~${clock} ${abbrev}`
}

function formatRelativeTail(deltaMs: number): string {
  if (deltaMs <= 0) return '~now'
  const totalMin = Math.round(deltaMs / 60_000)
  if (totalMin < 1) return '~in <1m'
  if (totalMin < 60) return `~in ${totalMin}m`
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours < 24) return mins > 0 ? `~in ${hours}h ${mins}m` : `~in ${hours}h`
  const days = Math.floor(hours / 24)
  const remH = hours % 24
  return remH > 0 ? `~in ${days}d ${remH}h` : `~in ${days}d`
}

/**
 * Render ONE clean card for a parsed LLM error. Action buttons for the
 * actionable kinds (auth → Reauth, quota_wall → Wait/switch). `agent` is used
 * in the callback_data (URL-encoded) and the headline; `tz` localizes the reset.
 */
export function renderLlmError(
  parsed: ParsedLlmError,
  agent: string,
  tz: string,
  now: Date = new Date(),
): RenderedLlmError {
  const safeAgent = escapeAgent(agent)
  const emoji = kindEmoji(parsed.kind)
  const lines: string[] = [`${emoji} ${parsed.coreText} (**${safeAgent}**)`]

  const resetLine = formatResetLocal(parsed.resetAt, tz, now)
  if (resetLine) lines.push(`_${resetLine}_`)

  if (parsed.model) lines.push(`_model: ${escapeAgent(parsed.model)}_`)

  const text = lines.join('\n')

  switch (parsed.kind) {
    case 'auth':
      return {
        text,
        keyboard: {
          inline_keyboard: [
            [
              { text: '🔐 Reauth now', callback_data: `op:reauth:${encodeURIComponent(agent)}` },
              { text: '❌ Dismiss', callback_data: `op:dismiss:${encodeURIComponent(agent)}` },
            ],
          ],
        },
      }
    case 'quota_wall':
      return {
        text,
        keyboard: {
          inline_keyboard: [
            [{ text: '⏳ Wait', callback_data: `op:dismiss:${encodeURIComponent(agent)}` }],
          ],
        },
      }
    default:
      return { text }
  }
}

function kindEmoji(kind: LlmErrorKind): string {
  switch (kind) {
    case 'rate_limit':
      return '🚦'
    case 'overload_529':
      return '🔥'
    case 'quota_wall':
      return '⚠️'
    case 'auth':
      return '🔑'
    case 'model_unavailable':
      return '🚧'
    case 'transient':
      return '🌐'
    case 'unknown':
      return '⚠️'
  }
}

/** Minimal markdown-safe agent rendering (mirrors operator-events escapeMarkdown intent). */
function escapeAgent(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1')
}

// ─── Cross-surface dedup: ErrorPresenceGate ──────────────────────────────────

/**
 * How long ONE terminal error owns the "already surfaced" claim across all
 * three surfaces. Distinct from — and additional to — the 5-minute per-kind
 * `shouldEmitOperatorEvent` cooldown (operator-events.ts): that debounces an
 * error STORM on one surface; this collapses ONE error's FAN-OUT across
 * surfaces within a single turn.
 */
export const ERROR_COLLAPSE_WINDOW_MS = 60_000

/**
 * A tiny in-memory dedup ledger. The FIRST surface to `claim(key)` within the
 * collapse window wins (returns true) and renders; every later surface loses
 * (returns false) and suppresses. Key preference: the Anthropic `request_id`
 * when present (exact), else a `${kind}:${agent}:${windowBucket}` coarse key so
 * two distinct-but-unlabelled errors of the same kind within 60s still collapse.
 */
export class ErrorPresenceGate {
  private readonly claims = new Map<string, number>()

  /** Build the dedup key for a parsed error + agent. */
  keyFor(parsed: Pick<ParsedLlmError, 'kind' | 'requestId'>, agent: string, now: number): string {
    if (parsed.requestId) return `rid:${parsed.requestId}`
    const bucket = Math.floor(now / ERROR_COLLAPSE_WINDOW_MS)
    return `${parsed.kind}:${agent}:${bucket}`
  }

  /**
   * Attempt to claim ownership of `key`. Returns true for the first caller
   * within the window, false for every subsequent caller. Expired claims are
   * pruned lazily on each call.
   */
  claim(key: string, now: number = Date.now()): boolean {
    this.prune(now)
    const existing = this.claims.get(key)
    if (existing != null && now - existing < ERROR_COLLAPSE_WINDOW_MS) {
      return false
    }
    this.claims.set(key, now)
    return true
  }

  /** True when `key` is currently claimed (does NOT claim). */
  isClaimed(key: string, now: number = Date.now()): boolean {
    const existing = this.claims.get(key)
    return existing != null && now - existing < ERROR_COLLAPSE_WINDOW_MS
  }

  private prune(now: number): void {
    for (const [k, at] of this.claims) {
      if (now - at >= ERROR_COLLAPSE_WINDOW_MS) this.claims.delete(k)
    }
  }

  /** Test-only: forget every claim. */
  reset(): void {
    this.claims.clear()
  }
}

/** The process-wide gate the three surfaces consult. */
export const errorPresenceGate = new ErrorPresenceGate()

/**
 * The single decision a surface makes before rendering a parsed LLM error.
 * Returns:
 *   - 'render'   — this surface owns the humanized card, render it.
 *   - 'suppress' — another surface already owns it (dedup) OR it is a
 *     transient error the harness is still auto-retrying — stay silent.
 *
 * ACTIONABLE kinds (auth / quota_wall) ALWAYS return 'render' — they are never
 * deduped away and never silenced mid-retry, because the operator must always
 * see (and be able to act on) a login/quota wall.
 */
export function decideErrorSurface(
  parsed: ParsedLlmError,
  agent: string,
  opts: { claim: boolean; now?: number; gate?: ErrorPresenceGate } = { claim: true },
): 'render' | 'suppress' {
  const now = opts.now ?? Date.now()
  const gate = opts.gate ?? errorPresenceGate

  if (isActionableKind(parsed.kind)) {
    // Always render — but still record the claim so a redundant transient
    // surface for the same key stays collapsed.
    if (opts.claim) gate.claim(gate.keyFor(parsed, agent, now), now)
    return 'render'
  }

  // Auto-retry silence: a transient error still being retried internally is
  // NOT surfaced on ANY surface until it goes terminal.
  if (parsed.autoRetrying && !parsed.terminal) return 'suppress'

  const key = gate.keyFor(parsed, agent, now)
  if (opts.claim) {
    return gate.claim(key, now) ? 'render' : 'suppress'
  }
  return gate.isClaimed(key, now) ? 'suppress' : 'render'
}

/**
 * True when `text` is a raw LLM-error line that a non-card surface (reply /
 * done-card recap) must NOT relay as the turn's answer. Thin re-export of the
 * `looksLikeRawApiError` anchors so the reply/recap paths share ONE detector.
 */
export function isRawLlmErrorText(text: string): boolean {
  return looksLikeRawApiError(text)
}
