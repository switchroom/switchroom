/**
 * Boot-card auth row formatter (RFC H §7.3).
 *
 * The old auth-dashboard exported `formatAccountQuotaLine` + an
 * `AccountSummary` shape that the boot card consumed for its
 * "Accounts (N)" section. Both source-of-truth and shape moved to
 * the auth-broker's `list-state` response. This module reformats that
 * response into the same one-line-per-account block the boot card
 * used to render — visual output unchanged, data source is now the
 * broker.
 *
 * Inputs: a `list-state` data shape (see
 * `src/auth/broker/protocol.ts` → `ListStateDataSchema`) plus the
 * caller agent's name.
 *
 * Output: an array of HTML-safe lines. Empty array when there's
 * nothing to show — preserves the boot-card's silent-when-healthy
 * default.
 */

import type { ListStateData, AccountState } from '../../src/auth/broker/client.js'

export type { ListStateData, AccountState }

/** Format a duration in ms as a short relative string ("1h 22m", "12s"). */
function formatRelativeMs(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

/**
 * Render the per-account quota inline for one account row. Returns
 * null when there's nothing quota-shaped to say (account is healthy
 * and we have no reset countdown to surface).
 */
export function formatAuthQuotaLine(acc: AccountState, now: number = Date.now()): string | null {
  if (acc.exhausted) {
    const until = acc.exhausted_until
    if (until != null && until > now) {
      return `_exhausted · resets in ${formatRelativeMs(until - now)}_`
    }
    return `_exhausted_`
  }
  return null
}

/**
 * Boot-card auth-row block.
 *
 * Strategy:
 *   1. Determine *which* account is active for `agentName` (per-agent
 *      override wins over fleet-active).
 *   2. Emit one row for that account marked with `▶` plus a
 *      best-effort quota suffix.
 *   3. Emit one row per other account in `fallback_order` marked with
 *      `↳` so the operator sees the rollover plan at a glance.
 *
 * Returns an empty array when `state` is empty (no accounts) — the
 * boot card's silent-when-healthy contract.
 */
export function renderAuthLine(
  state: ListStateData,
  agentName: string,
  now: number = Date.now(),
): string[] {
  if (!state || state.accounts.length === 0) return []

  const agentEntry = state.agents.find((a) => a.name === agentName)
  const activeLabel = agentEntry?.override ?? agentEntry?.account ?? state.active

  // Stable display order: active first, then `fallback_order` minus
  // the active label, then any remaining accounts (defensive — should
  // be empty in steady state) in account-list order.
  const seen = new Set<string>()
  const order: string[] = []
  if (activeLabel) {
    order.push(activeLabel)
    seen.add(activeLabel)
  }
  for (const label of state.fallback_order) {
    if (!seen.has(label)) {
      order.push(label)
      seen.add(label)
    }
  }
  for (const acc of state.accounts) {
    if (!seen.has(acc.label)) {
      order.push(acc.label)
      seen.add(acc.label)
    }
  }

  const byLabel = new Map(state.accounts.map((a) => [a.label, a]))
  const rows: string[] = []
  rows.push(`**Accounts (${state.accounts.length})**`)
  for (const label of order) {
    const acc = byLabel.get(label)
    if (!acc) continue
    const marker = label === activeLabel ? '▶' : '↳'
    const labelMd = `\`${acc.label}\``
    const quotaLine = formatAuthQuotaLine(acc, now)
    rows.push(quotaLine ? `${marker} ${labelMd}  ${quotaLine}` : `${marker} ${labelMd}`)
  }
  return rows
}
