/**
 * throttle-tier.ts — the 429 throttle tier (pure decision + notice rendering).
 *
 * Operator-approved behavior spec: "retry in place under 5 min, else mark +
 * failover, honest reset messaging."
 *
 * A terminal TRANSIENT 429 (a `rate_limit_error` whose wording explicitly
 * negates the account-quota reading — see `transientUpstreamSignals` in
 * model-unavailable.ts) used to take the fully calm path: no broker state, no
 * account attribution, a generic "🚦 Rate limited" card. That is right for a
 * few-second burst but wrong for the minutes-long per-account throttles
 * Anthropic emits with a "resets 8:50am (TZ)" hint: the fleet has no memory
 * that the account is throttled (cron fires walk straight into the same 429)
 * and the operator can't tell a throttle from a wall.
 *
 * This module owns the DECISION and the NOTICE TEXT; the gateway wires the
 * side effects (broker `mark-throttled`, the Telegram send, the delayed
 * retry nudge):
 *
 *   - reset parseable and ≤ threshold (default 5 min) → `throttle`: stay on
 *     the account, record `throttled_until` broker-side, notify once.
 *   - reset parseable and > threshold → `failover`: escalate to the existing
 *     mark-exhausted + fleet-failover machinery with the parsed reset as the
 *     mark expiry.
 *   - reset unparseable → `throttle` with a conservative now+60s wait.
 *
 * Wall wording ("You've hit your limit", out_of_credits) never reaches this
 * module — session-tail classifies those `quota-exhausted` and the gateway's
 * existing failover path handles them unchanged.
 *
 * PURE — no IPC, no bot, no clock except the injected `now`.
 */

import { escapeMarkdown } from './card-format.js'
import { formatResetRelative } from './quota-check.js'
import {
  isLitellmProxyLocal429,
  parseLitellmLimitDetail,
  parseResetTime,
} from './model-unavailable.js'
import type { RuntimeMetricEvent } from './runtime-metrics.js'

// ─── Account-scoped throttle wording ─────────────────────────────────────────

/**
 * ACCOUNT-AFFIRMING subset of `transientUpstreamSignals` (model-unavailable.ts).
 * The throttle tier takes ACCOUNT-level actions — broker `mark-throttled`,
 * per-account notice, retry nudge — so it must key on wording that affirms the
 * account's OWN rate limit ("would exceed your account's rate limit",
 * "not your account…"), NOT the server-side phrasings ("Server is temporarily
 * limiting requests (not your usage limit)", 529 overload wording). A
 * server-wide condition recorded as an account throttle would bench the wrong
 * thing and restart-nudge an agent straight back into the same server-side
 * wall. Server-side transients keep the existing calm rate-limited path
 * (Claude Code's internal retry) untouched.
 */
export const accountScopedThrottleSignals = [
  "would exceed your account's rate limit",
  'would exceed your account’s rate limit',
  // Covers both "not your account" and "not your account's" (substring).
  'not your account',
]

/** True when `text` carries an EXPLICIT account-affirming throttle marker.
 *  Never throws on weird input. */
export function isAccountScopedThrottle(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  const sample = text.length > 16_384 ? text.slice(0, 16_384) : text
  const lower = sample.toLowerCase()
  return accountScopedThrottleSignals.some((s) => lower.includes(s))
}

// ─── Three-way 429 classification ────────────────────────────────────────────

/**
 * Where a terminal 429-family failure originated:
 *   - `account-scoped`   — Anthropic throttled THIS account ("would exceed
 *     your account's rate limit"). Eligible for the throttle tier below
 *     (broker mark-throttled / failover).
 *   - `litellm-local`    — the LiteLLM proxy's OWN limiter tripped
 *     (`tpm_limit`/`rpm_limit` cap, router cooldown — see
 *     `litellmProxyLocal429Signals` in model-unavailable.ts). The request
 *     never reached Anthropic; account state must not be touched.
 *   - `generic-transient` — everything else in the rate-limit family
 *     (server-side 429/529 wording, bare `rate_limit_error`). Calm path.
 */
export type RateLimit429Classification =
  | 'account-scoped'
  | 'litellm-local'
  | 'generic-transient'

/**
 * Classify a terminal `rate-limited` operator event's detail text.
 *
 * TIE-BREAK (both wordings present): account-scoped wins, and only on its
 * EXPLICIT wording. Rationale: LiteLLM never emits the account-affirming
 * strings itself, so when they co-occur with LiteLLM wording the detail is a
 * genuine upstream Anthropic account 429 that traversed (and was wrapped by)
 * the proxy — e.g. the pass-through's "litellm.RateLimitError: …would exceed
 * your account's rate limit…" exception mapping. Classifying that as
 * proxy-local would drop the broker throttle mark and walk every retry
 * straight back into the same account throttle. The reverse risk is nil: a
 * purely proxy-local 429 (limiter fired BEFORE any upstream call) cannot
 * contain Anthropic's account wording.
 *
 * BOUND: operator events forwarded over IPC carry `detail` truncated to
 * 1000 chars (bridge.ts `sendOperatorEvent`'s `.slice(0, 1000)`;
 * `OPERATOR_EVENT_DETAIL_MAX` in gateway/ipc-server.ts), so on that path the
 * tie-break sees only the first 1000 chars of the body. In practice both
 * wordings sit well inside that window (real Anthropic and LiteLLM bodies
 * are <400 chars), and a truncated-away account marker would merely
 * downgrade account-scoped → litellm-local/generic-transient — the calm
 * path, never a wrong account mark.
 *
 * Never throws on weird input (both matchers are total).
 */
export function classify429Detail(text: string): RateLimit429Classification {
  if (isAccountScopedThrottle(text)) return 'account-scoped'
  if (isLitellmProxyLocal429(text)) return 'litellm-local'
  return 'generic-transient'
}

/**
 * #failover-429-corroborate — does this terminal 429 classification warrant a
 * fire-and-forget broker corroboration probe (throttle-tier runner) IN ADDITION
 * to the calm rate-limited card?
 *
 * TRUE for `generic-transient` ONLY. That family (a bare `rate_limit_error`
 * body / novel wording that matches neither the account-scoped negation
 * strings nor litellm-local) used to drop on the calm-card floor with NO broker
 * contact — so a genuine 5h/7d wall hiding behind transient wording was never
 * probed, and the turn died with no failover. Routing it through the runner
 * lets the broker take ONE live quota probe (rate-bounded) and convert a real
 * wall into failover; a healthy probe leaves the calm path unchanged.
 *
 * FALSE (never corroborate) for:
 *   - `litellm-local` — INVARIANT: the request never reached Anthropic (the
 *     proxy's own tpm/rpm limiter tripped), so account state must not be
 *     touched. This mechanism, not discipline, keeps that path account-inert.
 *   - `account-scoped` — already runs its own throttle tier / failover path.
 *   - `null` — not a rate-limited event.
 */
export function classification429WarrantsCorroboration(
  classification: RateLimit429Classification | null,
): boolean {
  return classification === 'generic-transient'
}

/**
 * Build the `rate_limit_429_classified` runtime metric for one terminal
 * rate-limited operator event — the instrumentation that lets an operator
 * correlate Anthropic ACCOUNT 429s with fleet TPM (the prerequisite for
 * enabling LiteLLM `tpm_limit` caps; see docs/auth.md § LiteLLM-proxy-local
 * 429s). Pure builder so the payload shape is unit-testable; the gateway
 * emits the result via emitRuntimeMetric (PostHog + JSONL dual sink).
 *
 * `action` is what the gateway decided for this event:
 *   - `throttle` / `failover` — the account-scoped throttle tier's decision
 *   - `calm` — the existing calm rate-limited path (litellm-local and
 *     generic-transient always land here; no broker mark, no failover)
 *
 * Reset detail is best-effort: the Anthropic-shaped `parseResetTime` first,
 * then LiteLLM's own shapes ("Limit resets at: … UTC" / "Try again in Ns")
 * via `parseLitellmLimitDetail`. Limit fields parse only from LiteLLM
 * wording (Anthropic bodies carry no numeric limit).
 */
export function build429ClassifiedMetric(opts: {
  agent: string
  detail: string
  classification: RateLimit429Classification
  action: 'throttle' | 'failover' | 'calm'
  now: number
}): Extract<RuntimeMetricEvent, { kind: 'rate_limit_429_classified' }> {
  const detail = typeof opts.detail === 'string' ? opts.detail : ''
  const litellm = parseLitellmLimitDetail(detail, new Date(opts.now))
  const anthropicResetMs = parseResetTime(detail, new Date(opts.now))?.getTime() ?? null
  const resetAtMs = anthropicResetMs ?? litellm.resetAtMs
  return {
    kind: 'rate_limit_429_classified',
    agent: opts.agent,
    classification: opts.classification,
    action: opts.action,
    reset_at_ms: resetAtMs,
    reset_in_ms: resetAtMs != null ? Math.max(0, resetAtMs - opts.now) : null,
    limit_type: litellm.limitType,
    limit: litellm.limit,
    current_usage: litellm.currentUsage,
  }
}

/**
 * Default retry-in-place ceiling: a transient 429 whose reset is within this
 * window waits on the account instead of failing the fleet over. Override
 * with SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS.
 */
export const THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT = 5 * 60_000

/**
 * Wait applied when a transient 429 carries NO parseable reset. Anthropic's
 * burst throttles clear in seconds; 60s is comfortably past the common case
 * without benching the account for long on a misread.
 */
export const THROTTLE_DEFAULT_WAIT_MS = 60_000

/** Resolve the retry-in-place threshold from env (ms), else the default. */
export function throttleRetryInPlaceMaxMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SWITCHROOM_THROTTLE_RETRY_IN_PLACE_MAX_MS
  if (raw == null || raw === '') return THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : THROTTLE_RETRY_IN_PLACE_MAX_MS_DEFAULT
}

export type ThrottleTierDecision =
  /** Not a transient per-account 429 — caller falls through to its
   *  existing handling (calm card / quota path). */
  | { action: 'none' }
  /** Stay on the account; record throttled_until broker-side; notify once. */
  | { action: 'throttle'; throttledUntilMs: number; resetParsed: boolean }
  /** Reset is beyond the retry-in-place threshold — escalate to the
   *  existing mark-exhausted + fleet-failover machinery. */
  | { action: 'failover'; resetAtMs: number }

/**
 * THE throttle-tier decision for a terminal `rate-limited` operator event.
 * `detail` is the user-facing error text from the transcript (the source of
 * both the transient-negation wording and the "resets …" prose).
 */
export function decideThrottleTier(opts: {
  detail: string
  now: number
  /** Retry-in-place ceiling (ms). Callers pass throttleRetryInPlaceMaxMs(). */
  thresholdMs: number
}): ThrottleTierDecision {
  const { detail, now, thresholdMs } = opts
  // Account-affirming wording ONLY — the wider transient list includes
  // server-side phrasings (529 / "server is temporarily limiting requests")
  // for which an account-scoped throttle would be the wrong action.
  if (!isAccountScopedThrottle(detail)) return { action: 'none' }
  const resetAt = parseResetTime(detail, new Date(now))
  const resetAtMs = resetAt?.getTime()
  if (resetAtMs == null || !Number.isFinite(resetAtMs) || resetAtMs <= now) {
    // No usable reset — wait the conservative default in place.
    return {
      action: 'throttle',
      throttledUntilMs: now + THROTTLE_DEFAULT_WAIT_MS,
      resetParsed: false,
    }
  }
  if (resetAtMs - now <= thresholdMs) {
    return { action: 'throttle', throttledUntilMs: resetAtMs, resetParsed: true }
  }
  return { action: 'failover', resetAtMs }
}

// ─── Per-account notice cooldown ─────────────────────────────────────────────

/**
 * Cooldown for the lightweight throttle notice, PER ACCOUNT. A burst of
 * transient 429s (session-tail forwards every terminal error line) must
 * produce ONE notice, not a stream — same shape and rationale as the
 * failure-notice / all-blocked cooldowns in auto-fallback-fleet.ts. Keyed by
 * account (not agent): the throttle is account-scoped, so every agent riding
 * the same throttled account shares one window.
 */
export const THROTTLE_NOTICE_COOLDOWN_MS = 10 * 60_000

export interface ThrottleNoticeState {
  /** account label → unix ms of the last notice sent for it. */
  lastSentAtMsByAccount: Record<string, number>
}

export function evaluateThrottleNotice(
  prev: ThrottleNoticeState,
  account: string,
  now: number,
  cooldownMs: number = THROTTLE_NOTICE_COOLDOWN_MS,
): { send: boolean; next: ThrottleNoticeState } {
  const last = prev.lastSentAtMsByAccount[account] ?? 0
  if (now - last >= cooldownMs) {
    return {
      send: true,
      next: {
        lastSentAtMsByAccount: {
          ...prev.lastSentAtMsByAccount,
          [account]: now,
        },
      },
    }
  }
  return { send: false, next: prev }
}

// ─── Notice rendering ────────────────────────────────────────────────────────

/**
 * The ONE lightweight operator notice for the throttle path. Deliberately not
 * the ⚠️ model-unavailable card: nothing is exhausted and nothing failed
 * over — the point is to say so, name the account, and name the reset.
 */
export function renderThrottleNotice(opts: {
  /** Account label from the broker's mark-throttled response; null when the
   *  broker was unreachable and the account could not be attributed. */
  account: string | null
  agent: string
  throttledUntilMs: number
  /** True when the reset came from parsed "resets …" prose (vs the 60s default). */
  resetParsed: boolean
  now?: Date
}): string {
  const now = opts.now ?? new Date()
  // "resets in 3m" — same countdown dialect /usage speaks.
  const resetStr = formatResetRelative(new Date(opts.throttledUntilMs), now)
  const acct = opts.account ? `\`${escapeMarkdown(opts.account)}\`` : 'the active account'
  const lines = [
    `🚦 **Rate-limited, staying put** — ${acct} hit a transient rate limit on **${escapeMarkdown(opts.agent)}**.`,
    `This is a short throttle, not a quota wall — ${
      opts.resetParsed ? resetStr : `no reset given, retrying in ~60s`
    }.`,
    `_Staying on ${acct}; no failover needed. The turn retries automatically after the reset._`,
  ]
  return lines.join('\n')
}

/**
 * Notice for the broker's ESCALATION outcome: repeated transient 429s on one
 * account were corroborated by a live probe as a genuine wall, so the broker
 * ran the standard mark-exhausted + roll. The gateway that raised the
 * mark-throttled announces it (the reactive-path doctrine — same reason the
 * plain mark-exhausted path announces gateway-side rather than via
 * `last_fleet_roll`), which also covers PINNED (non-fleet-active) accounts.
 */
export function renderThrottleEscalationNotice(opts: {
  account: string | null
  agent: string
  /** The account the fleet/agents rolled to; null = every fallback blocked. */
  rolledTo: string | null
}): string {
  const acct = opts.account ? `\`${escapeMarkdown(opts.account)}\`` : 'the active account'
  const head =
    `⛔️ **Rate limit was actually a wall** — repeated 429s on ${acct} ` +
    `(trigger: **${escapeMarkdown(opts.agent)}**) were corroborated by a live quota probe.`
  const tail = opts.rolledTo
    ? `Marked exhausted and rolled to \`${escapeMarkdown(opts.rolledTo)}\`.`
    : `Marked exhausted — no fallback account had quota (all blocked). ` +
      `Use \`/auth add <label>\` to attach another subscription.`
  return `${head}\n${tail}`
}
