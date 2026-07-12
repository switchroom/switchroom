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
 *      retry-wrapped path), plus one `litellm_local_429_notice` runtime
 *      metric per SENT notice.
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

export interface LitellmLocalNoticeRunner {
  /**
   * Run the notice path for one terminal rate-limited operator event.
   * No-ops unless `classification` is `litellm-local`. Never throws.
   */
  onRateLimited(classification: RateLimit429Classification, agent: string): void
  /** Test/debug view of internal state. */
  inspect(): { state: LitellmLocalNoticeState }
}

export function createLitellmLocalNoticeRunner(
  deps: LitellmLocalNoticeRunnerDeps,
): LitellmLocalNoticeRunner {
  const now = deps.now ?? (() => Date.now())
  let state = initialLitellmLocalNoticeState()

  function onRateLimited(classification: RateLimit429Classification, agent: string): void {
    try {
      if (!isLitellmLocalNoticeEligible(classification)) return
      const windowMs = deps.windowMs()
      const verdict = evaluateLitellmLocalNotice(state, agent, now(), windowMs)
      state = verdict.next
      if (!verdict.send) {
        deps.log(
          `[litellm-local-notice] suppressed (cooldown) agent=${agent} ` +
            `suppressedSoFar=${state.suppressedCountByAgent[agent] ?? 0}`,
        )
        return
      }
      const markdown = renderLitellmLocalNotice({
        agent,
        suppressedSinceLastNotice: verdict.suppressedSinceLastNotice,
      })
      for (const chatId of deps.listNoticeChats()) {
        deps.sendNotice(chatId, markdown)
      }
      deps.emitMetric(
        buildLitellmLocalNoticeMetric({
          agent,
          suppressedCount: verdict.suppressedSinceLastNotice,
          windowMs,
        }),
      )
      deps.log(
        `[litellm-local-notice] posted agent=${agent} ` +
          `suppressedSinceLast=${verdict.suppressedSinceLastNotice} windowMs=${windowMs}`,
      )
    } catch (err) {
      // The notice is a courtesy surface — a failure here must never break
      // the operator-event path that invoked it.
      deps.log(
        `[litellm-local-notice] error agent=${agent}: ${(err as Error)?.message ?? err}`,
      )
    }
  }

  return {
    onRateLimited,
    inspect: () => ({ state }),
  }
}
