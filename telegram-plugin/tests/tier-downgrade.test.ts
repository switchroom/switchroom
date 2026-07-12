/**
 * Unit tests for the MODEL-TIER downgrade failover (second recovery tier).
 *
 * The pure `decideTierDowngrade` owns the decision the gateway consults inside
 * the `all-blocked` branch of doFireFleetAutoFallback — i.e. AFTER account-swap
 * has been tried and found no account still serving the walled premium model.
 * `planTierDowngrade` then routes that decision + the resume-gate verdict into
 * what the gateway should DO (downgrade / suppress the give-up / fall through),
 * and `renderTierDowngradeNotice` owns the exact user-facing wording. All three
 * are pure so the decision, the concurrent-turn suppression (LOW-9a), and the
 * honesty of the broadcast (no "revert to the premium model" promise) are pinned
 * without a process restart.
 *
 * Contract (post loop-guard reconciliation, option b — the ceremonial
 * `.tier-downgrade-attempts` counter was REMOVED):
 *   - overload + the session is NOT on a premium model (override null, or the
 *     override resolves to the configured default) → NO downgrade ('skip'); the
 *     account-swap path already handled it or there is no lower tier to fall to.
 *     This is also the natural loop bound: after the downgrade boot the override
 *     is gone, so a re-entry lands on 'on-default' and never re-downgrades.
 *   - overload + a premium model walled across ALL accounts → 'downgrade' to the
 *     configured default.
 *   - a resume restart already armed in this process (gate 'skip-inflight') →
 *     'suppress': no give-up card, no re-downgrade (the armed restart resumes).
 *   - the downgrade broadcast states resume-on-default + manual re-issue and
 *     carries NO promise of an automatic revert to the premium model.
 */

import { describe, it, expect } from 'vitest'
import {
  decideTierDowngrade,
  planTierDowngrade,
  renderTierDowngradeNotice,
} from '../tier-downgrade.js'

// The gateway passes resolveMainModel; here a near-identity resolver (maps the
// unset/`default` sentinel to the switchroom default, exactly like the real one)
// is enough to exercise the canonicalization guard.
const resolve = (t: string): string =>
  t === '' || t === 'default' ? 'claude-sonnet-5' : t

describe('decideTierDowngrade — precedence + downgrade target', () => {
  it('NO downgrade when the session is on the configured default (override null)', () => {
    // Overload + account-swap all-blocked, but nothing premium is active — the
    // account-swap path owns this and there is no lower tier. => skip.
    const d = decideTierDowngrade({ sessionOverride: null, configuredDefault: 'opus', resolve })
    expect(d).toEqual({ action: 'skip', reason: 'on-default' })
  })

  it('NO downgrade when the override resolves to the configured default (alias vs id)', () => {
    // A premium-looking override that is actually the default in another spelling
    // must never read as a premium tier (that would loop). Same resolver both
    // sides → on-default.
    const d = decideTierDowngrade({
      sessionOverride: 'default',
      configuredDefault: 'claude-sonnet-5',
      resolve,
    })
    expect(d).toEqual({ action: 'skip', reason: 'on-default' })
  })

  it('NO downgrade (and no blind fall) when the configured default is unreadable', () => {
    const d = decideTierDowngrade({ sessionOverride: 'fable', configuredDefault: null, resolve })
    expect(d).toEqual({ action: 'skip', reason: 'unresolved' })
  })

  it('DOWNGRADES a walled premium model to the configured default', () => {
    const d = decideTierDowngrade({ sessionOverride: 'fable', configuredDefault: 'opus', resolve })
    expect(d).toEqual({ action: 'downgrade', toModel: 'opus', fromModel: 'fable' })
  })

  it('downgrade target is GENERAL — any premium model → the agent default (not hardcoded fable→opus)', () => {
    const d = decideTierDowngrade({
      sessionOverride: 'sr-x-ai/grok-4',
      configuredDefault: 'claude-sonnet-5',
      resolve,
    })
    expect(d).toEqual({ action: 'downgrade', toModel: 'claude-sonnet-5', fromModel: 'sr-x-ai/grok-4' })
  })
})

describe('renderTierDowngradeNotice — HONEST wording (no revert-to-premium promise)', () => {
  const notice = renderTierDowngradeNotice('fable', 'opus', 'klanker')

  it('states the turn resumes on the DEFAULT to keep working', () => {
    expect(notice).toContain('opus')
    expect(notice.toLowerCase()).toContain('resuming on the default')
  })

  it('tells the user to RE-ISSUE the premium /model themselves', () => {
    expect(notice).toContain('/model fable')
    expect(notice.toLowerCase()).toContain("won't switch back on its own")
  })

  it("carries NO promise of an automatic revert to the premium/fable model", () => {
    // The HIGH finding: the prior wording lied ("It reverts to `fable` on the
    // next restart"). Assert none of those false promises can creep back.
    const lower = notice.toLowerCase()
    expect(lower).not.toMatch(/reverts? to `?fable/)
    expect(lower).not.toContain('reverts to `fable`')
    expect(lower).not.toContain('on the next restart')
    expect(lower).not.toMatch(/revert(s|ing)? to the premium/)
    expect(lower).not.toMatch(/back to `?fable`? (on|at|after)/)
  })
})

describe('planTierDowngrade — routing (downgrade / suppress / skip)', () => {
  const skipDecision = { action: 'skip', reason: 'on-default' } as const
  const downgradeDecision = { action: 'downgrade', toModel: 'opus', fromModel: 'fable' } as const

  it("a 'skip' decision routes to 'skip' regardless of the gate verdict", () => {
    expect(planTierDowngrade(skipDecision, 'resume', 'ag').kind).toBe('skip')
    expect(planTierDowngrade(skipDecision, 'skip-inflight', 'ag').kind).toBe('skip')
    expect(planTierDowngrade(skipDecision, 'skip-stale', 'ag').kind).toBe('skip')
  })

  it("downgrade + gate 'resume' → 'downgrade' with the honest notice", () => {
    const plan = planTierDowngrade(downgradeDecision, 'resume', 'klanker')
    expect(plan.kind).toBe('downgrade')
    if (plan.kind === 'downgrade') {
      expect(plan.toModel).toBe('opus')
      expect(plan.fromModel).toBe('fable')
      // The plan carries EXACTLY the honest renderer output — no revert promise.
      expect(plan.notice).toBe(renderTierDowngradeNotice('fable', 'opus', 'klanker'))
      expect(plan.notice.toLowerCase()).not.toContain('on the next restart')
    }
  })

  it("LOW-9a: downgrade + gate 'skip-inflight' → 'suppress' (a resume restart is already armed, no give-up card)", () => {
    // Two turns hit all-blocked in the same pre-restart process. Turn 1 armed a
    // downgrade (or account-swap) restart. Turn 2 must NOT broadcast a "could
    // not be recovered" give-up — the armed restart resumes the interrupted turn.
    const plan = planTierDowngrade(downgradeDecision, 'skip-inflight', 'klanker')
    expect(plan.kind).toBe('suppress')
  })

  it("downgrade + gate 'skip-stale' → 'skip' (turn too old to resume; fall through to the all-blocked card)", () => {
    const plan = planTierDowngrade(downgradeDecision, 'skip-stale', 'klanker')
    expect(plan.kind).toBe('skip')
  })
})
