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
  isLitellmProxyAuthMisconfig,
  parseResetTime,
} from './model-unavailable.js'
import { classify429Detail } from './throttle-tier.js'
import {
  PROVIDER_CREDIT_REGISTRY,
  attributeProvider,
  describeProviderCreditRemedy,
  type ProviderCreditEntry,
} from './provider-credit.js'
import { classifyClaudeError } from './operator-events.js'
import { isConnectionDropText } from './connection-drop.js'
import { stripRawErrorBytes, extractRequestId } from './raw-error-scrub.js'
import { fmtLocalClock, tzAbbrev } from './shared/local-time.js'

export { stripRawErrorBytes, extractRequestId } from './raw-error-scrub.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type LlmErrorKind =
  | 'rate_limit'
  | 'overload_529'
  | 'quota_wall'
  | 'auth'
  | 'infra_misconfig'
  /**
   * A THIRD-PARTY model provider (OpenRouter / OpenAI / Perplexity) is out of
   * credit. OPERATOR-actionable, never user-actionable — its `coreText` is a
   * deliberately diagnosis-free one-liner and its recommendation names the
   * vendor console, never `/auth`. Kept distinct from `quota_wall` (the
   * Anthropic subscription window, which resets on a clock and is addressed by
   * switching account slots); a vendor balance resets only when someone pays.
   */
  | 'provider_credit'
  | 'transient'
  | 'unknown'

export type LlmErrorSource =
  | 'anthropic'
  | 'litellm-local'
  /** A paid third-party model provider reached THROUGH the proxy (OpenRouter, OpenAI). */
  | 'external-provider'
  | 'network'

export interface ParsedLlmError {
  kind: LlmErrorKind
  /** Human, JSON-STRIPPED one-liner built from a per-kind template. Never raw. */
  coreText: string
  /** Parsed reset instant, when the source carried one. */
  resetAt?: Date
  /** Parsed retry-after window in ms, when the source carried one. */
  retryAfterMs?: number
  /** Resolved model id, when the source named one. */
  model?: string
  /** Anthropic `request_id`, when present — the strongest dedup key. */
  requestId?: string
  /**
   * Registry id of the third-party provider the error was attributed to
   * (`openrouter` / `openai` / `perplexity`), when `kind === 'provider_credit'`
   * and the raw text named one. An ID only — never raw error text, never a
   * credential — so the recommendation line can point at the right console
   * without this struct ever carrying the raw string it was parsed from.
   */
  providerId?: string
  source: LlmErrorSource
  /**
   * True when this error is a mid-stream connection / SSE drop (a transport
   * connection loss), per the canonical {@link isConnectionDropText} matcher.
   * Set consistently on BOTH classification paths (here and
   * `detectErrorInTranscriptLine`) so a later PR can gate auto-resume on ONE
   * reliable discriminator. Only ever true for the `transient`/`unknown`
   * families — never for a positively-identified auth/quota/overload/credit
   * wall (guarded below), so it can never trigger a wrong auto-resume of a
   * genuinely terminal error. Classification only in this PR; no consumer acts
   * on it yet.
   */
  connectionDrop: boolean
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

// ─── model extraction ────────────────────────────────────────────────────────

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
  // `provider_credit` joins the never-silenced set: an unpaid vendor balance
  // does not clear on its own, so collapsing it inside a dedup window would
  // hide the one signal that needs a human.
  return kind === 'auth' || kind === 'quota_wall' || kind === 'provider_credit'
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
  const providerId =
    kind === 'provider_credit' ? (attributeProvider(text)?.id ?? undefined) : undefined

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

  // Connection-drop discriminator. Gated to the transient/unknown families so a
  // positively-classified auth/quota/overload/credit wall is NEVER flagged as a
  // drop, even if its raw text coincidentally carries a drop wording (e.g. a
  // LiteLLM-wrapped 401 whose outer text says "fetch failed"). The gate mirrors
  // Path B's inclusion set (`transport-transient`/`unknown-*`), keeping the two
  // classifiers in agreement. `source==='network'` is not required: a drop
  // wording that `detectModelUnavailable` does not recognise (e.g. `EPIPE`)
  // lands on `unknown` here, and must still be identifiable as a drop.
  const connectionDrop =
    (kind === 'transient' || kind === 'unknown') && isConnectionDropText(text)

  return {
    kind,
    coreText: buildCoreText(kind, source),
    ...(resetAt != null ? { resetAt } : {}),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    ...(model != null ? { model } : {}),
    ...(requestId != null ? { requestId } : {}),
    ...(providerId != null ? { providerId } : {}),
    source,
    connectionDrop,
    autoRetrying,
    terminal,
  }
}

function classifyKindAndSource(text: string): { kind: LlmErrorKind; source: LlmErrorSource } {
  const lower = text.toLowerCase()

  // 0. LiteLLM-proxy AUTH misconfig — checked BEFORE the auth branch. The
  //    proxy's internal fallback re-dispatched WITHOUT the OAuth header onto a
  //    keyless deployment, so Anthropic 401'd it ("x-api-key header is
  //    required"). This is an OPERATOR-only infra fault, NOT an end-user login
  //    wall — never the user-facing 'auth' kind (which renders a re-auth card a
  //    non-operator user cannot act on). Source is the local proxy, not
  //    Anthropic. See isLitellmProxyAuthMisconfig for provenance.
  if (isLitellmProxyAuthMisconfig(text)) {
    return { kind: 'infra_misconfig', source: 'litellm-local' }
  }

  // 1. Auth — always terminal, always actionable.
  const claudeKind = classifyClaudeError({ message: text, type: text })
  // 1b. THIRD-PARTY provider credit wall. Placed immediately after the auth
  //     resolution and BEFORE isLitellmProxyLocal429 / detectModelUnavailable:
  //     OpenAI reports an exhausted balance as HTTP 429 `insufficient_quota`,
  //     and the 429 matchers below would otherwise swallow it as a transient
  //     "retrying automatically" — the single most misleading thing to tell
  //     someone whose provider has no money left.
  if (claudeKind === 'provider-credit-exhausted') {
    return { kind: 'provider_credit', source: 'external-provider' }
  }
  if (claudeKind === 'proxy-misconfig') {
    return { kind: 'infra_misconfig', source: 'litellm-local' }
  }
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
  // NOTE: we deliberately do NOT map the taxonomy's `unknown-5xx` to
  // `overload_529` here. `classifyClaudeError` is called above with only
  // {message, type} (no HTTP status), so `unknown-5xx` at this point is the
  // taxonomy's neutral no-status DEFAULT — not evidence of a genuine 529/5xx.
  // A real Anthropic overload/5xx always carries recognizable wording and is
  // resolved earlier by detectModelUnavailable (step 3). Fabricating
  // "Anthropic is overloaded (529) — retrying automatically" for an
  // unrecognized error would be a false diagnosis, so it falls through to the
  // honest `unknown` kind.
  return { kind: 'unknown', source: 'anthropic' }
}

/** Resolve a registry entry from a persisted `providerId`, or null. */
function providerById(id: string | undefined): ProviderCreditEntry | null {
  if (id == null) return null
  return PROVIDER_CREDIT_REGISTRY.find(p => p.id === id) ?? null
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
    case 'infra_misconfig':
      return 'Local model-gateway auth misconfig (proxy fallback dropped the OAuth header).'
    case 'provider_credit':
      // Diagnosis-free by design — this string is the ceiling on what a
      // non-operator may ever be told about a vendor billing wall.
      return 'An upstream model provider is out of credit — the operator has been notified.'
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
 * A short local-tz clock+abbrev for a reset instant (`4:52pm AEST`), or '' when
 * there is no finite reset to name. Used to embed the reset in the recommendation
 * line. Shares the same tz-formatting primitives as {@link formatResetLocal}, so
 * an invalid IANA tz throws here too (guarded by {@link renderLlmErrorSafe}).
 */
function formatResetClock(resetAt: Date | undefined, tz: string): string {
  if (resetAt == null) return ''
  const ms = resetAt.getTime()
  if (!Number.isFinite(ms)) return ''
  return `${fmtLocalClock(ms, tz)} ${tzAbbrev(ms, tz)}`
}

/**
 * The plain-text "what to DO" line for the actionable error classes. Replaces
 * the former dead action buttons (auth → Reauth, quota_wall → Wait): those
 * inline_keyboard callbacks were only ever exercised in tests — the gateway
 * wiring routes renderLlmError solely for the transient rate_limit/overload_529
 * kinds, so the auth/quota buttons were unreachable in production (Ken, CPO,
 * 2026-07: drop the buttons, recommend in text). Transient kinds return undefined
 * — their coreText already says "retrying automatically", no operator action.
 */
function buildRecommendation(parsed: ParsedLlmError, tz: string): string | undefined {
  switch (parsed.kind) {
    case 'auth':
      return '→ Re-authenticate this account to continue.'
    case 'infra_misconfig':
      // Operator-facing — NO re-auth wording (the login is fine). Points at the
      // real remedy: the local LiteLLM proxy fallback config.
      return '→ Fix the LiteLLM proxy fallback config (deployment missing OAuth passthrough).'
    case 'provider_credit':
      // Operator-facing. NO `/auth` wording: the credential is valid, the
      // balance is empty, and rotating an Anthropic slot changes nothing.
      return `→ ${describeProviderCreditRemedy(providerById(parsed.providerId))}`
    case 'quota_wall': {
      const reset = formatResetClock(parsed.resetAt, tz)
      return reset
        ? `→ Switch to another account, or wait for the quota to reset at ${reset}.`
        : '→ Switch to another account, or wait for the quota to reset.'
    }
    default:
      return undefined
  }
}

/**
 * Render ONE clean card for a parsed LLM error. No action buttons — the
 * actionable kinds (auth, quota_wall) carry a plain-text recommendation line
 * instead (see {@link buildRecommendation}). `agent` is the headline label; `tz`
 * localizes the reset. Throws if `tz` is an invalid IANA zone AND a reset is
 * present (Intl.DateTimeFormat rejects the zone at construction) — call
 * {@link renderLlmErrorSafe} from any crash-sensitive surface.
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

  const recommendation = buildRecommendation(parsed, tz)
  if (recommendation) lines.push(recommendation)

  return { text: lines.join('\n') }
}

/**
 * Crash-guarded wrapper around {@link renderLlmError}. An invalid IANA timezone
 * makes Intl.DateTimeFormat throw a RangeError at construction time — the
 * local-time.ts "never throws" contract does NOT cover construction-time zone
 * validation, so a bad `SWITCHROOM_TIMEZONE`/`TZ` would otherwise crash the
 * operator-event turn. On ANY formatting failure, degrade to a minimal, tz-free
 * safe line built only from the JSON-stripped coreText + agent. Total — never
 * throws.
 */
export function renderLlmErrorSafe(
  parsed: ParsedLlmError,
  agent: string,
  tz: string,
  now: Date = new Date(),
): RenderedLlmError {
  try {
    return renderLlmError(parsed, agent, tz, now)
  } catch {
    const safeAgent = escapeAgent(agent)
    return { text: `${kindEmoji(parsed.kind)} ${parsed.coreText} (**${safeAgent}**)` }
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
    case 'infra_misconfig':
      return '🛠️'
    case 'provider_credit':
      return '💳'
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
  // NOT surfaced on ANY surface until it goes terminal. NOTE: in the current
  // production wiring the operator surface reaches here only AFTER session-tail
  // (readNew → `errEvent.terminal || !errEvent.transient`) has already dropped
  // in-flight transients, and the gateway calls `parseLlmError(detail)` with no
  // retryState (the raw retry annotations don't survive the IPC hop) — so a
  // production `parsed.autoRetrying` is always false here. This branch is the
  // module's own guarantee for ANY caller that DOES pass retryState (unit-tested
  // as such); prod silence is owned upstream at session-tail, not re-derived here.
  if (parsed.autoRetrying && !parsed.terminal) return 'suppress'

  const key = gate.keyFor(parsed, agent, now)
  if (opts.claim) {
    return gate.claim(key, now) ? 'render' : 'suppress'
  }
  return gate.isClaimed(key, now) ? 'suppress' : 'render'
}
