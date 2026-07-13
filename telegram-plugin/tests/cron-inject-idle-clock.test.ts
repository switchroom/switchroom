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
 * Two layers of guarantee, both of which FAIL against pre-fix main:
 *
 *   1. The pure identity predicate `isCronInjectFire` — classifies which
 *      inject fires warm the main clock. Did not exist on main → import fails.
 *
 *   2. A wiring pin over gateway.ts source — the inject-time stamp is now
 *      GATED on `!isCronInjectFire(...)`, while the genuine-human inbound path
 *      (`handleInbound`) still stamps unconditionally. On main the inject-time
 *      stamp was unconditional, so the "cron does not stamp, human does"
 *      assertion fails there.
 *
 * The wiring pin mirrors the established pattern for un-exported inline
 * gateway closures (see gateway-pending-command-wiring.test.ts): gateway.ts is
 * ~30k lines with import-time side effects, so nothing imports it directly —
 * the durable structural extraction of the idle bookkeeping is #3115's job,
 * explicitly out of scope here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
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

describe('#3114 gateway wiring — cron inject does not stamp, human inbound does', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const GATEWAY_SRC = readFileSync(
    resolve(__dirname, '..', 'gateway', 'gateway.ts'),
    'utf8',
  )

  it('onInjectInbound gates the idle stamp on !isCronInjectFire (was unconditional on main)', () => {
    const handlerIdx = GATEWAY_SRC.indexOf('onInjectInbound(_client: IpcClient, msg: InjectInboundMessage)')
    expect(handlerIdx).toBeGreaterThan(0)
    // Scope to the handler head — up to the promptKey extraction that follows
    // the stamp decision.
    const win = GATEWAY_SRC.slice(handlerIdx, handlerIdx + 1600)
    const promptKeyIdx = win.indexOf('const promptKey')
    expect(promptKeyIdx).toBeGreaterThan(0)
    const head = win.slice(0, promptKeyIdx)
    // The stamp is present but GUARDED by the cron-identity predicate…
    expect(head).toContain('isCronInjectFire(msg.inbound.meta)')
    expect(head).toContain('markIdleActivity()')
    // …and there is NO unconditional markIdleActivity() before the guard
    // (the pre-fix bug). The only occurrence sits behind the guard on one line.
    expect(head).toContain('if (!isCronInjectFire(msg.inbound.meta)) markIdleActivity()')
    const stampCount = (head.match(/markIdleActivity\(\)/g) ?? []).length
    expect(stampCount).toBe(1)
  })

  it('the genuine-human inbound path (handleInbound) still stamps unconditionally', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function handleInbound(')
    expect(fnIdx).toBeGreaterThan(0)
    const bodyStart = GATEWAY_SRC.indexOf('): Promise<void> {', fnIdx)
    expect(bodyStart).toBeGreaterThan(0)
    const head = GATEWAY_SRC.slice(bodyStart, bodyStart + 200)
    // Unconditional — not gated by any cron predicate: real human presence.
    expect(head).toContain('markIdleActivity()')
    expect(head).not.toContain('isCronInjectFire')
  })
})
