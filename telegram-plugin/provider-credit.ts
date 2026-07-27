/**
 * provider-credit.ts — the ONE registry of "this paid third-party provider is
 * out of credit / its billing is blocked" signals, plus the pure classifier
 * both surfaces consult.
 *
 * WHY THIS EXISTS (the leak it closes)
 * ------------------------------------
 * Every quota/credit wording switchroom recognised was an ANTHROPIC wording
 * (`model-unavailable.ts`'s `quotaSignals`, `operator-events.ts`'s
 * `credit_balance_too_low` branch). OpenRouter — which serves the whole
 * `gpt-oss-20b` group and every `openrouter/*` model in
 * `docker/litellm-proxy/litellm-config.yaml` — answers an exhausted balance
 * with HTTP 402 `payment_required` / "insufficient credits", which matched
 * NONE of them. It fell through `classifyClaudeError` to `unknown-4xx`, and
 * `unknown-4xx` is NOT in `OPERATOR_ACTIONABLE_KINDS`, so the card (with the
 * raw provider error in a code span, and a "🔐 Reauth" button nobody can act
 * on) was BROADCAST to every allowlist chat — an end user included.
 *
 * Ken's standing product rule: a raw API/auth error that is OPERATOR-actionable
 * rather than USER-actionable must never reach an end user. So a provider
 * credit wall must classify to an operator-only kind.
 *
 * WHAT THIS MODULE IS AND IS NOT
 * ------------------------------
 * It is DATA (`PROVIDER_CREDIT_REGISTRY` + `CREDIT_EXHAUSTION_SIGNALS`) plus
 * two pure predicates over that data. It is deliberately NOT wired to the
 * Anthropic quota path: `detectModelUnavailable`'s `quota_exhausted` kind is
 * what fires `fireFleetAutoFallback` (swap the Anthropic ACCOUNT SLOT). An
 * OpenRouter balance of $0 says nothing about any Anthropic account, and
 * rotating Anthropic slots would not buy a single OpenRouter token — so
 * teaching the Anthropic detector these wordings would fire a bogus fleet
 * failover on every OpenRouter 402. See the explicit early-return for
 * `provider-credit-exhausted` in `resolveModelUnavailableFromOperatorEvent`.
 *
 * PROVENANCE of each wording (verified against live vendor docs 2026-07-28):
 *  - OpenRouter — https://openrouter.ai/docs/api-reference/errors:
 *    "402: Your account or API key has insufficient credits. Add more credits
 *    and retry the request." Typed error code `payment_required`. The limits
 *    page (https://openrouter.ai/docs/api-reference/limits) documents the same
 *    402 for both an exhausted ACCOUNT balance and an exhausted PER-KEY
 *    `limit_remaining`.
 *  - OpenAI — https://platform.openai.com/docs/guides/error-codes: 429 with
 *    `code: "insufficient_quota"`, message "You exceeded your current quota,
 *    please check your plan and billing details"; hard billing stop surfaces as
 *    `billing_hard_limit_reached`. NOTE the status is 429, NOT 402 — which is
 *    exactly why status alone is not a sufficient signal and the wording list
 *    carries its own weight.
 *  - Perplexity — https://docs.perplexity.ai/guides/usage-tiers: an exhausted
 *    balance answers 401/403 with "insufficient credits"/"credit balance"; the
 *    account is otherwise valid. Perplexity reaches switchroom through the MCP
 *    tool surface, not through LiteLLM, so this registry is consumed there too
 *    (`mcp-credential-failure.ts`) — one registry, both paths.
 *
 * Pure module: no IPC, no bot, no FS, no network. Trivially unit-testable.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProviderCreditEntry {
  /** Stable id — also the `mcp_servers.<name>` key where one exists. */
  id: string
  /** Human display name for the operator card. */
  label: string
  /**
   * The VAULT KEY NAME the operator must top up / re-issue. A NAME only —
   * this module never sees, reads, or renders a secret VALUE.
   */
  vaultKey: string
  /** Where the operator actually fixes it. */
  consoleUrl: string
  /** The one-line remedy sentence rendered on the operator card. */
  action: string
  /**
   * Lowercase substrings that ATTRIBUTE an error to this provider. Matched
   * against the raw error text. Deliberately specific (hostnames, route
   * prefixes, SDK exception names) so a passing mention can't misattribute.
   */
  markers: string[]
}

/**
 * The providers whose credit exhaustion switchroom can recognise. Adding a
 * provider is a DATA edit here — never a new conditional at a call site.
 */
export const PROVIDER_CREDIT_REGISTRY: readonly ProviderCreditEntry[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    vaultKey: 'openrouter/api-key',
    consoleUrl: 'https://openrouter.ai/credits',
    action: 'Top up the OpenRouter balance (or raise the key’s credit limit) in the OpenRouter console.',
    markers: ['openrouter', 'openrouter.ai'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    vaultKey: 'openai/api-key',
    consoleUrl: 'https://platform.openai.com/settings/organization/billing',
    action: 'Add credit / raise the billing limit in the OpenAI console.',
    markers: ['api.openai.com', 'openai.', 'openaiexception', 'openai_api'],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    vaultKey: 'perplexity/api-key',
    consoleUrl: 'https://www.perplexity.ai/settings/api',
    action: 'Top up the Perplexity API balance (or re-issue the key) in the Perplexity console.',
    markers: ['perplexity', 'api.perplexity.ai', 'pplx'],
  },
]

// ─── Credit-exhaustion wording ───────────────────────────────────────────────

/**
 * Provider-agnostic markers of a CREDIT/BILLING wall — "there is no money
 * left", as distinct from "you are going too fast" (rate limit) or "your key
 * is wrong" (auth).
 *
 * Every entry is a multi-word phrase or an explicit vendor error CODE. A bare
 * `'402'` is deliberately ABSENT: a three-digit substring appears in model ids,
 * token counts, request ids and timestamps, and matching it would misclassify
 * unrelated errors as a billing wall. HTTP 402 is honoured only as a STRUCTURED
 * status field — see {@link isProviderCreditStatus}.
 */
export const CREDIT_EXHAUSTION_SIGNALS: readonly string[] = [
  // OpenRouter (402)
  'payment_required',
  'payment required',
  'insufficient credits',
  'insufficient_credits',
  'more credits are required',
  'requires more credits',
  'add more credits',
  'out of credits',
  // OpenAI (429 insufficient_quota / hard billing stop)
  'insufficient_quota',
  'exceeded your current quota',
  'billing_hard_limit_reached',
  'billing hard limit',
  // Cross-vendor balance wordings (Perplexity, Brevo, and the generic shape)
  'insufficient balance',
  'insufficient_balance',
  'credit balance is too low',
  'credit balance too low',
  'credit_balance_too_low',
  'no credits remaining',
  'quota exceeded for credits',
]

/** HTTP statuses that, on their own, mean "billing". Only 402 qualifies. */
export const CREDIT_EXHAUSTION_STATUSES: readonly number[] = [402]

const MAX_SCAN_CHARS = 16_384

function sample(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  return (text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text).toLowerCase()
}

/**
 * True when `status` is a structured HTTP status that means "out of credit".
 * Structured only — never inferred from a substring (see the note on
 * {@link CREDIT_EXHAUSTION_SIGNALS}).
 */
export function isProviderCreditStatus(status: unknown): boolean {
  return typeof status === 'number' && CREDIT_EXHAUSTION_STATUSES.includes(status)
}

/** True when `text` carries an explicit credit/billing-exhaustion wording. */
export function hasCreditExhaustionWording(text: unknown): boolean {
  const lower = sample(text)
  if (lower.length === 0) return false
  return CREDIT_EXHAUSTION_SIGNALS.some(s => lower.includes(s))
}

/**
 * Attribute an error string to a registered provider, or `null` when nothing
 * in the text names one. `null` is a legitimate, honest outcome: the card then
 * says "an upstream model provider" rather than guessing a vendor (and a wrong
 * vendor name would send the operator to the wrong console).
 */
export function attributeProvider(text: unknown): ProviderCreditEntry | null {
  const lower = sample(text)
  if (lower.length === 0) return null
  for (const entry of PROVIDER_CREDIT_REGISTRY) {
    if (entry.markers.some(m => lower.includes(m))) return entry
  }
  return null
}

export interface ProviderCreditDetection {
  /** The registry entry, when the text named a known provider. */
  provider: ProviderCreditEntry | null
  /** Which evidence fired — useful in logs and in the test assertions. */
  via: 'status' | 'wording'
}

/**
 * The single decision: is this error a THIRD-PARTY PROVIDER credit/billing
 * wall? Returns `null` when it is not — callers then fall through to their
 * existing classification unchanged.
 *
 * `status` is the structured HTTP status when the caller has one (an SDK throw,
 * a LiteLLM error body with `"status": 402`). Omit it and the decision rests on
 * wording alone.
 *
 * ANTHROPIC IS DELIBERATELY EXCLUDED. `credit_balance_too_low` is in the
 * wording list because it is a genuine cross-vendor balance phrase, but an
 * Anthropic-attributed credit wall already has its own `credit-exhausted` kind
 * with slot-switch advice (`/auth use`). Callers keep that branch FIRST; this
 * one only catches what that branch does not. See `classifyClaudeError`.
 */
export function detectProviderCreditExhaustion(
  text: unknown,
  status?: unknown,
): ProviderCreditDetection | null {
  if (isProviderCreditStatus(status)) {
    return { provider: attributeProvider(text), via: 'status' }
  }
  if (hasCreditExhaustionWording(text)) {
    return { provider: attributeProvider(text), via: 'wording' }
  }
  return null
}

/**
 * The operator-facing remedy line for a detection. Names the provider, the
 * VAULT KEY NAME (never a value) and the console to act in. Used by both the
 * operator-event card and the MCP credential alert so the two speak with one
 * voice.
 */
export function describeProviderCreditRemedy(provider: ProviderCreditEntry | null): string {
  if (provider == null) {
    return 'An upstream model provider reports no credit remaining. Check the provider console for the key the LiteLLM proxy uses.'
  }
  return `${provider.action} Vault key: \`${provider.vaultKey}\` → ${provider.consoleUrl}`
}
