/**
 * Pure renderer for the agent-initiated vault-access approval card (#1012).
 *
 * Extracted from gateway.ts so it can be unit-tested without dragging in the
 * whole gateway module. The card is sent via the rich-message path (GFM
 * markdown), so:
 *
 *   - Non-code-span interpolations (`**agent**`, `_why_`) are markdown-escaped
 *     via `escapeHtmlForTg` so a stray `*`/`_`/`[` in the agent name or reason
 *     can't break the surrounding emphasis.
 *   - Code-span interpolations (`key`, `scope`, `duration`) are LITERAL inside
 *     the span, so they must NOT be markdown-escaped (that would leak visible
 *     backslashes, e.g. `openai/OPENAI\_API\_KEY`). The only char that can
 *     prematurely close a code span is a backtick, so `codeSpanSafe` defuses
 *     just that one (mirrors approval-card.ts's scope span, #2669). Without
 *     this, a key whose value closes the span early lets the following
 *     `_why_` / `_footer_` markdown pair against stray delimiters and the card
 *     renders on top of itself.
 */

import { escapeHtmlForTg } from '../shared/bot-runtime.js'
import { codeSpanSafe } from './approval-card.js'

/** Minimal shape the card needs — a subset of PendingVaultRequestAccess. */
export interface VaultRequestAccessCardInput {
  agent: string
  key: string
  scope: string
  reason?: string
  ttl_seconds: number
}

export function renderVaultRequestAccessCard(
  req: VaultRequestAccessCardInput,
): string {
  const lines: string[] = []
  const scopeLabel = req.scope === 'write' ? 'write' : 'read'
  const days = Math.round(req.ttl_seconds / 86400)
  const durationLabel =
    days >= 1 ? `${days}d` : `${Math.round(req.ttl_seconds / 3600)}h`
  lines.push(`🔐 **${escapeHtmlForTg(req.agent)}** wants vault access`)
  // Code-span content is literal — defuse only the backtick, never
  // markdown-escape (see file header).
  lines.push(`key: \`${codeSpanSafe(req.key)}\``)
  lines.push(
    `scope: \`${codeSpanSafe(scopeLabel)}\` · duration: \`${codeSpanSafe(durationLabel)}\``,
  )
  // #1790 — always render the why-line, even when the agent omitted `reason`.
  // Rendering "not provided" makes a missing rationale visibly an agent-side
  // failure rather than a card-template choice.
  if (req.reason && req.reason.length > 0) {
    lines.push(`why: _${escapeHtmlForTg(req.reason)}_`)
  } else {
    lines.push(`why: _not provided_`)
  }
  lines.push('')
  lines.push(
    `_Tap Approve to mint a scoped grant token (same flow as \`switchroom vault grant\`). Tap Deny to refuse — the agent will receive a denial result._`,
  )
  return lines.join('\n')
}
