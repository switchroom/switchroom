/**
 * litellm-local-notice.ts — debounced operator notice for LiteLLM-proxy-local
 * 429s (pure module: state machine + text + config parsing, no IPC, no bot,
 * no clock except the injected `now`).
 *
 * When an agent routes through the LiteLLM gateway and trips the proxy's OWN
 * `tpm_limit`/`rpm_limit` limiter, `classify429Detail` (throttle-tier.ts)
 * classifies the terminal 429 `litellm-local` and the gateway takes the calm
 * path — no broker mark, no failover, no throttle tier (the request never
 * reached Anthropic, so the condition says nothing about the account). But
 * pre-notice the user-facing surface was the GENERIC "🚦 Rate limited" card,
 * which reads like an Anthropic problem. This module owns the honest
 * replacement:
 *
 *   - ONE calm notice per agent per cooldown window (default 15 min,
 *     operator-tunable via channels.telegram.litellm_notice.window_ms in
 *     switchroom.yaml, projected into access.json by scaffold).
 *   - Further litellm-local 429s inside the window are counted SILENTLY;
 *     the first notice after the window expires carries "throttled N more
 *     times since the last notice".
 *   - A notice only ever fires on an actual throttle event — a quiet agent
 *     posts nothing (the state machine is evaluate-on-event, no timers).
 *
 * The copy must make clear this is the fleet token limiter (LiteLLM
 * `tpm_limit`/`rpm_limit`), NOT an Anthropic account limit, and that the
 * turn retries — no action needed.
 *
 * Side-effect sequencing lives in gateway/litellm-local-notice-wiring.ts.
 * This module MUST NOT change classification, failover, or quota-ledger
 * behavior — it only renders and debounces the notice.
 */

import { escapeMarkdown } from './card-format.js'
import type { RateLimit429Classification } from './throttle-tier.js'
import type { RuntimeMetricEvent } from './runtime-metrics.js'

// ─── Cooldown window config ──────────────────────────────────────────────────

/**
 * Default per-agent notice cooldown. 15 minutes: long enough that a sustained
 * burst produces a handful of notices per hour at most, short enough that the
 * operator still sees the limiter working while it's working.
 */
export const LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT = 15 * 60_000

/**
 * Resolve the cooldown window from the raw access-file value
 * (`access.litellmNoticeWindowMs`, projected by scaffold from
 * channels.telegram.litellm_notice.window_ms). Any non-finite, non-positive,
 * or non-number value falls back to the default — an operator typo must
 * never produce a zero-width window (notice storm) or a NaN comparison
 * (notices never fire again).
 */
export function parseLitellmNoticeWindowMs(raw: unknown): number {
  if (typeof raw !== 'number') return LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT
  if (!Number.isFinite(raw) || raw <= 0) return LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT
  return raw
}

// ─── Per-agent cooldown state machine ────────────────────────────────────────

export interface LitellmLocalNoticeState {
  /** agent → unix ms of the last notice sent for it. */
  lastSentAtMsByAgent: Record<string, number>
  /** agent → litellm-local 429s counted silently since the last notice. */
  suppressedCountByAgent: Record<string, number>
}

export function initialLitellmLocalNoticeState(): LitellmLocalNoticeState {
  return { lastSentAtMsByAgent: {}, suppressedCountByAgent: {} }
}

export interface LitellmLocalNoticeVerdict {
  send: boolean
  /** Silent throttle events since the previous notice (0 on the first). Only
   *  meaningful when `send` is true — the renderer adds the "N more times"
   *  line when > 0. */
  suppressedSinceLastNotice: number
  next: LitellmLocalNoticeState
}

/**
 * Evaluate one litellm-local 429 for `agent` at `now`.
 *
 *   - First event ever (or ≥ windowMs since the last notice) → send; the
 *     verdict carries the silently-counted events since the previous notice
 *     and the counter resets.
 *   - Inside the window → suppress; the counter increments.
 *
 * Boundary is INCLUSIVE on expiry (elapsed === windowMs sends), matching
 * `evaluateThrottleNotice` in throttle-tier.ts. Pure: returns the next
 * state, never mutates `prev`.
 */
export function evaluateLitellmLocalNotice(
  prev: LitellmLocalNoticeState,
  agent: string,
  now: number,
  windowMs: number = LITELLM_LOCAL_NOTICE_WINDOW_MS_DEFAULT,
): LitellmLocalNoticeVerdict {
  const last = prev.lastSentAtMsByAgent[agent]
  if (last == null || now - last >= windowMs) {
    return {
      send: true,
      suppressedSinceLastNotice: prev.suppressedCountByAgent[agent] ?? 0,
      next: {
        lastSentAtMsByAgent: { ...prev.lastSentAtMsByAgent, [agent]: now },
        suppressedCountByAgent: { ...prev.suppressedCountByAgent, [agent]: 0 },
      },
    }
  }
  return {
    send: false,
    suppressedSinceLastNotice: 0,
    next: {
      lastSentAtMsByAgent: prev.lastSentAtMsByAgent,
      suppressedCountByAgent: {
        ...prev.suppressedCountByAgent,
        [agent]: (prev.suppressedCountByAgent[agent] ?? 0) + 1,
      },
    },
  }
}

// ─── Notice rendering ────────────────────────────────────────────────────────

/**
 * The ONE calm notice for a litellm-local 429. Markdown (not HTML) per the
 * card-format.ts convention. Copy contract (operator spec):
 *   - names the fleet token limiter (LiteLLM `tpm_limit`/`rpm_limit`)
 *   - explicitly NOT an Anthropic account limit — nothing exhausted, no
 *     account touched
 *   - the turn retries automatically; no action needed
 *   - after a window with silent suppressions, says "throttled N more
 *     time(s) since the last notice"
 */
export function renderLitellmLocalNotice(opts: {
  agent: string
  /** Silent litellm-local 429s since the previous notice (0 on the first). */
  suppressedSinceLastNotice: number
}): string {
  const agent = escapeMarkdown(opts.agent)
  const n = opts.suppressedSinceLastNotice
  const lines = [
    `🚦 **Fleet token limiter engaged** — **${agent}** hit the local LiteLLM proxy cap (\`tpm_limit\`/\`rpm_limit\`).`,
    `This is switchroom's own fleet limiter smoothing a burst, not an Anthropic account limit — nothing is exhausted and no account was touched.`,
  ]
  if (n > 0) {
    lines.push(`Throttled ${n} more ${n === 1 ? 'time' : 'times'} since the last notice.`)
  }
  lines.push(`_The turn retries automatically — no action needed._`)
  return lines.join('\n')
}

// ─── Metric builder ──────────────────────────────────────────────────────────

/**
 * Build the `litellm_local_429_notice` runtime metric for one SENT notice.
 * Distinct from `rate_limit_429_classified` (which fires on EVERY classified
 * event): this one fires only when a notice actually posts, and carries how
 * many events the window silently absorbed — the debounce's effectiveness in
 * one number. Pure builder so the payload shape is unit-testable; the wiring
 * emits the result via emitRuntimeMetric (PostHog + JSONL dual sink).
 */
export function buildLitellmLocalNoticeMetric(opts: {
  agent: string
  suppressedCount: number
  windowMs: number
}): Extract<RuntimeMetricEvent, { kind: 'litellm_local_429_notice' }> {
  return {
    kind: 'litellm_local_429_notice',
    agent: opts.agent,
    suppressed_count: opts.suppressedCount,
    window_ms: opts.windowMs,
  }
}

// ─── Classification guard ────────────────────────────────────────────────────

/**
 * True only for the `litellm-local` classification. The wiring runs this
 * guard so "a notice never fires for non-litellm-local classifications" is a
 * deterministic mechanism, not caller discipline — account-scoped 429s keep
 * the throttle tier, generic transients keep the calm rate-limited card.
 */
export function isLitellmLocalNoticeEligible(
  classification: RateLimit429Classification | null | undefined,
): classification is 'litellm-local' {
  return classification === 'litellm-local'
}
