/**
 * Boot card per-account quota rendering — issue #708.
 *
 * Verifies:
 *   - When `accounts` is absent / empty, the card stays silent (today's
 *     contract — no accounts section).
 *   - When `accounts` is present, the card appends an "Accounts (N)"
 *     header and one line per account with 5h % / 7d % / nearest reset.
 *   - The ▶ marker tags the active-for-this-agent account; ↳ tags the
 *     rest.
 *   - HTML escaping on account labels.
 *   - Account with no quota fields (label only) renders the row without
 *     any percent / reset suffix.
 */

import { describe, it, expect } from 'vitest'
import {
  renderBootCard,
  renderAccountRows,
} from '../gateway/boot-card.js'
import type { AccountSummary } from '../auth-dashboard.js'

const NOW = new Date('2026-05-05T10:00:00Z')

function mk(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    label: 'pixsoul@gmail.com',
    health: 'healthy',
    enabledHere: true,
    activeForThisAgent: false,
    fiveHourPct: 10,
    sevenDayPct: 79,
    fiveHourResetAt: NOW.getTime() + 2 * 3600_000 + 14 * 60_000,
    sevenDayResetAt: NOW.getTime() + 5 * 86_400_000,
    ...overrides,
  }
}

describe('renderBootCard — per-account quota (issue #708)', () => {
  it('omits the accounts section when accounts is undefined', () => {
    const out = renderBootCard({ agentName: 'clerk', version: 'v0.7.0' })
    expect(out).not.toContain('Accounts')
  })

  it('omits the accounts section when accounts is empty', () => {
    const out = renderBootCard({
      agentName: 'clerk',
      version: 'v0.7.0',
      accounts: [],
    })
    expect(out).not.toContain('Accounts')
  })

  it('renders the active account with ▶ and inline 5h / 7d / reset', () => {
    const out = renderBootCard({
      agentName: 'clerk',
      version: 'v0.7.0',
      accounts: [mk({ activeForThisAgent: true })],
      now: NOW,
    })
    expect(out).toContain('Accounts (1)')
    expect(out).toContain('▶')
    expect(out).toContain('pixsoul@gmail.com')
    expect(out).toContain('10%')
    expect(out).toContain('79%')
    expect(out).toContain('5h resets in')
  })

  it('renders fallback accounts with ↳', () => {
    const out = renderBootCard({
      agentName: 'clerk',
      version: 'v0.7.0',
      now: NOW,
      accounts: [
        mk({ activeForThisAgent: true }),
        mk({ label: 'ken+work@example.com', activeForThisAgent: false }),
      ],
    })
    expect(out).toContain('Accounts (2)')
    expect(out).toMatch(/↳ <code>ken\+work@example\.com<\/code>/)
  })

  it('escapes HTML in labels', () => {
    const out = renderAccountRows(
      [mk({ label: 'evil<script>', activeForThisAgent: true })],
      NOW,
    )
    expect(out.join('\n')).toContain('evil&lt;script&gt;')
    expect(out.join('\n')).not.toContain('<script>')
  })

  it('renders a row with no quota numbers as label-only', () => {
    const summary: AccountSummary = {
      label: 'just-added',
      health: 'healthy',
      enabledHere: true,
      activeForThisAgent: false,
    }
    const out = renderAccountRows([summary], NOW)
    expect(out).toHaveLength(2)
    expect(out[1]).toBe('↳ <code>just-added</code>')
  })

  it('shows 7d reset when 5h reset is missing', () => {
    const out = renderAccountRows(
      [
        mk({
          activeForThisAgent: true,
          fiveHourPct: 0,
          sevenDayPct: 99,
          fiveHourResetAt: undefined,
          sevenDayResetAt: NOW.getTime() + 86_400_000 + 3 * 3600_000,
        }),
      ],
      NOW,
    )
    expect(out.join('\n')).toContain('7d resets in')
  })

  it('drops the reset suffix once the reset timestamp has elapsed', () => {
    const out = renderAccountRows(
      [
        mk({
          activeForThisAgent: true,
          fiveHourPct: 0,
          sevenDayPct: 0,
          fiveHourResetAt: NOW.getTime() - 60_000,
          sevenDayResetAt: undefined,
        }),
      ],
      NOW,
    )
    // Past-reset timestamps return "" from formatNearestAccountResetSuffix,
    // so the line should not contain "resets in" at all.
    expect(out.join('\n')).not.toContain('resets in')
  })
})
