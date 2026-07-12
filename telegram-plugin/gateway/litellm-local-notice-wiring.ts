/**
 * litellm-local-notice-wiring.ts — side-effect runner for the debounced
 * litellm-local 429 notice.
 *
 * The state machine, notice text, config parsing, and metric payload live in
 * ../litellm-local-notice.ts (pure). This module owns the sequencing, with
 * every dependency injected so the wiring is unit-testable without importing
 * gateway.ts (same shape as throttle-tier-wiring.ts):
 *
 *   1. Guard — only the `litellm-local` classification is eligible
 *      (isLitellmLocalNoticeEligible). account-scoped keeps the throttle
 *      tier; generic-transient keeps the calm rate-limited card. The guard
 *      lives HERE (not in the caller) so "a notice never fires for
 *      non-litellm-local classifications" is mechanism, not discipline.
 *   2. Per-agent cooldown — evaluate against the resolved window
 *      (deps.windowMs(), re-read per event so an operator-tuned
 *      channels.telegram.litellm_notice.window_ms takes effect after
 *      apply+restart without re-creating the runner). Suppressed events are
 *      counted silently.
 *   3. ONE calm notice — broadcast to every authorized chat via the injected
 *      send (the gateway binds it to swallowingApiCall, the standard
 *      retry-wrapped path). The window is armed, the
 *      `litellm_local_429_notice` metric emitted, and "posted" logged ONLY
 *      when at least one send was actually ISSUED — an empty allowFrom or a
 *      send callback that throws for every chat leaves the state untouched,
 *      so the next event retries instead of silently claiming delivery.
 *
 * Deliberately NO broker calls, NO quota-ledger writes, NO failover, NO
 * retry nudge: the litellm-local calm path's invariant is that account state
 * is never touched (the request never reached Anthropic). Claude Code's own
 * retry handles the turn.
 */

import {
  buildLitellmLocalNoticeMetric,
  evaluateLitellmLocalNotice,
  initialLitellmLocalNoticeState,
  isLitellmLocalNoticeEligible,
  renderLitellmLocalNotice,
  type LitellmLocalNoticeState,
} from '../litellm-local-notice.js'
import type { RateLimit429Classification } from '../throttle-tier.js'
import type { RuntimeMetricEvent } from '../runtime-metrics.js'

/**
 * The user-facing surface decision for one terminal non-account-scoped
 * `rate-limited` operator event — the gateway's ordering contract with the
 * shared per-agent-per-kind card cooldown (shouldEmitOperatorEvent in
 * operator-events.ts), extracted so it is pinnable by tests:
 *
 *   - `litellm-local` resolves BEFORE the shared gate is consulted. Two
 *     load-bearing consequences: (a) it never ARMS `${agent}:rate-limited`
 *     (shouldEmitOperatorEvent's true-return records the timestamp), so a
 *     proxy-cap burst can't suppress a later genuine transient's card; and
 *     (b) it is never SUPPRESSED by a cooldown that a recent 529 / generic
 *     card armed — the notice runner owns its own per-agent debounce
 *     instead.
 *   - Every other classification consults (and on true, arms) the shared
 *     gate exactly once — the caller must NOT re-consult it downstream.
 */
export function decideRateLimitedSurface(opts: {
  classification: RateLimit429Classification
  agent: string
  /** The shared cooldown gate — gateway binds
   *  (a) => shouldEmitOperatorEvent(a, 'rate-limited'). Consulted (and on
   *  true, armed) only for non-litellm-local classifications. */
  shouldEmitCard: (agent: string) => boolean
}): 'litellm-local-notice' | 'generic-card' | 'cooldown-suppressed' {
  if (isLitellmLocalNoticeEligible(opts.classification)) return 'litellm-local-notice'
  return opts.shouldEmitCard(opts.agent) ? 'generic-card' : 'cooldown-suppressed'
}

export interface LitellmLocalNoticeRunnerDeps {
  /** Chats the notice broadcasts to (access.allowFrom, resolved per call). */
  listNoticeChats(): Array<string | number>
  /** Fire-and-forget rich send (gateway wraps swallowingApiCall). */
  sendNotice(chatId: string | number, markdown: string): void
  /** Resolved cooldown window (ms), re-read per event —
   *  parseLitellmNoticeWindowMs(loadAccess().litellmNoticeWindowMs). */
  windowMs(): number
  /** Runtime-metric sink (gateway binds emitRuntimeMetric). */
  emitMetric(event: RuntimeMetricEvent): void
  log(msg: string): void
  now?: () => number
}

/**
 * What one event produced:
 *   - `sent`       — a notice was issued to ≥1 chat (window armed, metric
 *                    emitted). The gateway records the event into the
 *                    operator-event history ONLY on this outcome, so a
 *                    suppressed low-stakes proxy throttle never overwrites a
 *                    more important most-recent event (e.g.
 *                    credentials-expired) in /status enrichment.
 *   - `suppressed` — inside the cooldown window; counted silently.
 *   - `skipped`    — ineligible classification, no authorized recipients,
 *                    every send failed synchronously, or an internal error
 *                    (logged). No debounce state change.
 */
export type LitellmLocalNoticeOutcome = 'sent' | 'suppressed' | 'skipped'

export interface LitellmLocalNoticeRunner {
  /**
   * Run the notice path for one terminal rate-limited operator event.
   * No-ops (returns 'skipped') unless `classification` is `litellm-local`.
   * Never throws.
   */
  onRateLimited(
    classification: RateLimit429Classification,
    agent: string,
  ): LitellmLocalNoticeOutcome
  /** Test/debug view of internal state. */
  inspect(): { state: LitellmLocalNoticeState }
}

export function createLitellmLocalNoticeRunner(
  deps: LitellmLocalNoticeRunnerDeps,
): LitellmLocalNoticeRunner {
  const now = deps.now ?? (() => Date.now())
  // In-memory only — the debounce resets on gateway restart, so a sustained
  // throttle can produce one extra notice per restart. Accepted trade-off:
  // persisting a courtesy-surface cooldown isn't worth state-file plumbing,
  // and the failure mode is one duplicate calm message, not a storm.
  let state = initialLitellmLocalNoticeState()

  function onRateLimited(
    classification: RateLimit429Classification,
    agent: string,
  ): LitellmLocalNoticeOutcome {
    try {
      if (!isLitellmLocalNoticeEligible(classification)) return 'skipped'
      const windowMs = deps.windowMs()
      const verdict = evaluateLitellmLocalNotice(state, agent, now(), windowMs)
      if (!verdict.send) {
        state = verdict.next
        deps.log(
          `[litellm-local-notice] suppressed (cooldown) agent=${agent} ` +
            `suppressedSoFar=${state.suppressedCountByAgent[agent] ?? 0}`,
        )
        return 'suppressed'
      }
      const chats = deps.listNoticeChats()
      const markdown = renderLitellmLocalNotice({
        agent,
        suppressedSinceLastNotice: verdict.suppressedSinceLastNotice,
      })
      let issued = 0
      for (const chatId of chats) {
        try {
          deps.sendNotice(chatId, markdown)
          issued++
        } catch (err) {
          deps.log(
            `[litellm-local-notice] send failed chat=${chatId} agent=${agent}: ` +
              `${(err as Error)?.message ?? err}`,
          )
        }
      }
      if (issued === 0) {
        // Nothing actually went out (no authorized chats, or every send
        // threw synchronously). Do NOT arm the window, emit the metric, or
        // claim "posted" — the next event retries instead of the debounce
        // silently absorbing events no one will ever hear about.
        deps.log(
          `[litellm-local-notice] no sends issued (chats=${chats.length}) agent=${agent} — ` +
            `window not armed, will retry on the next event`,
        )
        return 'skipped'
      }
      state = verdict.next
      deps.emitMetric(
        buildLitellmLocalNoticeMetric({
          agent,
          suppressedCount: verdict.suppressedSinceLastNotice,
          windowMs,
        }),
      )
      deps.log(
        `[litellm-local-notice] posted agent=${agent} chats=${issued} ` +
          `suppressedSinceLast=${verdict.suppressedSinceLastNotice} windowMs=${windowMs}`,
      )
      return 'sent'
    } catch (err) {
      // The notice is a courtesy surface — a failure here must never break
      // the operator-event path that invoked it. The log itself is wrapped
      // too: a dead stderr sink must not void the never-throws contract.
      try {
        deps.log(
          `[litellm-local-notice] error agent=${agent}: ${(err as Error)?.message ?? err}`,
        )
      } catch { /* sink dead — nothing left to do */ }
      return 'skipped'
    }
  }

  return {
    onRateLimited,
    inspect: () => ({ state }),
  }
}
