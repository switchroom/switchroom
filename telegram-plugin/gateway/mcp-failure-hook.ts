/**
 * mcp-failure-hook.ts — the gateway-side wiring that turns a blocked PAID MCP
 * DEPENDENCY into an operator alert.
 *
 * Ken: "If perplexity fails for any agent we should have hard warning via
 * message here per other failures."
 *
 * MCP providers (Perplexity, Eraser, Brevo, Postiz, Meta/Google Ads,
 * Cloudflare) never touch LiteLLM, so the operator-event path that catches an
 * OpenRouter 402 never sees them — an expired Perplexity key would otherwise
 * die as a transient red step in the live feed and nobody would learn the fleet
 * had lost a paid capability.
 *
 * This tees the SAME `emitGatewayOperatorEvent` path (redact → per-kind
 * cooldown → operator-only audience via `OPERATOR_ACTIONABLE_KINDS` → brief
 * user notice), so there is ONE operator-alert mechanism in switchroom, not
 * two. All the policy — what counts as a key problem, what stays silent, the
 * 6-hour re-notify cadence — lives in `../mcp-credential-failure.ts`; this file
 * is only the seam.
 *
 * Extracted from `gateway.ts` rather than inlined there, per the
 * switchroom#2996 anti-inflation ratchet (`scripts/check-gateway-line-ratchet.mjs`).
 */

import type { SessionEvent } from '../session-tail.js'
import type { OperatorEvent } from '../operator-events.js'
import { McpFailureWatcher, renderMcpFailureDetail } from '../mcp-credential-failure.js'

export interface McpFailureHookDeps {
  agent: string
  emit: (event: OperatorEvent) => void
  now?: () => number
}

/**
 * Build the `handleSessionEvent` side-hook. One watcher per gateway process,
 * captured in the closure.
 *
 * Silent by default: only a credit/credential/quota class raises anything, and
 * only once per (server, class) per re-notify window. A bad query, a 404, a
 * timeout, a transient 429 or a successful call all return without emitting.
 *
 * Never throws — alerting is a side channel and must not break the live feed.
 */
export function createMcpFailureHook(deps: McpFailureHookDeps): (ev: SessionEvent) => void {
  const watcher = new McpFailureWatcher()
  const clock = deps.now ?? (() => Date.now())
  return function noteMcpDependencyFailure(ev: SessionEvent): void {
    try {
      if (ev.kind === 'tool_use') {
        watcher.onToolUse(ev.toolUseId, ev.toolName)
        return
      }
      if (ev.kind !== 'tool_result') return
      const alert = watcher.onToolResult({
        toolUseId: ev.toolUseId,
        isError: ev.isError,
        errorText: ev.errorText,
        agent: deps.agent,
        now: clock(),
      })
      if (alert == null) return
      deps.emit({
        kind: 'mcp-dependency-blocked',
        agent: deps.agent,
        detail: renderMcpFailureDetail(alert),
        suggestedActions: [],
        firstSeenAt: new Date(clock()),
      })
    } catch {
      // Side channel — never let alerting break the live feed.
    }
  }
}
