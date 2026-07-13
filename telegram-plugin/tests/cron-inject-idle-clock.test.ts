/**
 * #3114 — a cron fire must NOT warm the MAIN session's idle-clear clock.
 *
 * Root cause (confirmed live): `onInjectInbound` stamped the main idle clock
 * UNCONDITIONALLY at inject time. A cron cadence shorter than
 * `idle_clear_after` re-armed the timer on every fire, so idle-clear was
 * permanently suppressed for any agent with a frequent scheduled task —
 * including cheap-cron fires routed to the derived `<agent>-cron` bridge,
 * whose session events never reach the main clock at all.
 *
 * This covers the pure identity predicate `isCronInjectFire` — which inject
 * fires warm the main clock. It did not exist on main → import fails there.
 *
 * The gateway WIRING (that `onInjectInbound` gates the stamp on
 * `!isCronInjectFire(...)`, that a cron cadence shorter than the window no
 * longer re-arms the clock, and that a human inbound still warms it) is now
 * covered BEHAVIOURALLY in `idle-clear.test.ts` — the
 * `IdleTracker #3114` block drives the REAL predicate + the REAL `IdleTracker`
 * through the exact gateway rule. #3115 extracted the idle bookkeeping into an
 * importable object, so that block replaces the brittle source-text wiring pin
 * this file used to carry (a regression in the real stamp logic now fails a
 * behavioural assertion, not just a string-match over gateway.ts).
 */

import { describe, it, expect } from 'vitest'
import { isCronInjectFire } from '../gateway/cron-session.js'

describe('#3114 isCronInjectFire — which inject fires warm the main idle clock', () => {
  it('a cheap-cron fire (routed to the derived <agent>-cron bridge) does NOT warm the clock', () => {
    // Tier-1: scheduler tags meta.session='cron' → resolveInjectTarget sends it
    // to `<agent>-cron`; its session events are dropped for the cron identity.
    expect(isCronInjectFire({ session: 'cron', source: 'cron' })).toBe(true)
    expect(isCronInjectFire({ session: 'cron' })).toBe(true)
  })

  it('a Tier-2 (main-session) cron fire does NOT warm the clock at inject time', () => {
    // Tier-2 lands on the main bridge but is still a scheduled fire — the
    // inject-time stamp is suppressed (its real turn stamps via session events;
    // that is the documented residual, not the inject-time path).
    expect(isCronInjectFire({ source: 'cron' })).toBe(true)
  })

  it('a genuine operator/session inject (reaction, vault grant, resume) DOES warm the clock', () => {
    expect(isCronInjectFire({ source: 'reaction' })).toBe(false)
    expect(isCronInjectFire({ source: 'vault_grant_approved' })).toBe(false)
    expect(isCronInjectFire({ source: 'resume' })).toBe(false)
  })

  it('a bare / manual inject with no cron marker DOES warm the clock', () => {
    expect(isCronInjectFire(undefined)).toBe(false)
    expect(isCronInjectFire({})).toBe(false)
    expect(isCronInjectFire({ prompt_key: 'x' })).toBe(false)
  })
})
