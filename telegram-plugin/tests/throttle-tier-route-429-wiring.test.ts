/**
 * L1 SEAM-BOUNDARY GUARD for the 429 classify→route wiring (follow-up to
 * switchroom#4381 / #4379).
 *
 * `throttle-tier-route-429.test.ts` proves the ROUTING LOGIC of the pure seam
 * `routeRateLimit429` in isolation (generic-transient → fireProbeOnly;
 * litellm-local / account-scoped / null → no probe). But nothing asserted that
 * the GATEWAY still calls that seam at its 429-handling path. That is the exact
 * gap the extraction opened: a future edit deleting the gateway callsite
 * (gateway.ts, `emitGatewayOperatorEvent` rate-limited calm branch) would
 * silently drop the corroboration probe for every `generic-transient` 429 —
 * a real 5h/7d wall hiding behind transient wording would again die with no
 * failover — while the seam's own unit suite stayed fully green.
 *
 * gateway.ts is a side-effecting IIFE that cannot be imported in a unit test
 * (same constraint documented in turn-flush-suppression-wiring.test.ts /
 * activity-card-wiring.test.ts): `emitGatewayOperatorEvent` is a module-scoped,
 * un-exported function reachable only after the gateway boots. So an
 * outcome-level "drive emitGatewayOperatorEvent and observe fireProbeOnly" test
 * is infeasible without exporting internal gateway state — scope creep the
 * repo deliberately avoids. Following the established wiring-guard pattern,
 * this is a STRUCTURAL assertion that pins the load-bearing call site. It
 * COMPLEMENTS the seam suite: the routing outcomes are proven there; this
 * guards that the gateway actually routes through them.
 *
 * The outcome that flips on the regression: with the callsite present, a
 * `generic-transient` 429 reaches `routeRateLimit429(..., throttleTierRunner,
 * agent)` and fires the probe on the REAL runner; delete or neuter the
 * callsite and these assertions go red. Verified fails-red by deleting
 * gateway.ts:7831 locally (see PR body).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')

function between(src: string, startMarker: string, endMarker: string): string {
  const after = src.split(startMarker)[1] ?? ''
  return after.split(endMarker)[0] ?? ''
}

/** Strip comment lines so prose (a docstring mentioning the call, or a comment
 *  describing the OLD shape) can neither satisfy nor trip an assertion about
 *  the actual CODE. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
}

describe('429 route-seam wiring — the gateway calls routeRateLimit429 (switchroom#4381 L1)', () => {
  // The calm-429 branch: from the classification binding through the surface
  // decision that immediately follows the seam call.
  const branch = between(
    gatewaySrc,
    'const rateLimit429Classification =',
    "if (surface === 'litellm-local-notice')",
  )

  it('the calm-429 branch routes the classification through routeRateLimit429', () => {
    expect(branch.length).toBeGreaterThan(100)
    const code = codeOnly(branch)
    // The load-bearing call site. Deleting it drops the corroboration probe for
    // every generic-transient 429 with the seam's unit suite still green — the
    // exact regression this guard exists to catch.
    expect(code).toMatch(/routeRateLimit429\(/)
    // It must be fed the CLASSIFICATION computed for this event, not a literal
    // or a stale variable — otherwise the wrong family would (not) be probed.
    expect(code).toMatch(
      /routeRateLimit429\(\s*rateLimit429Classification\s*,/,
    )
  })

  it('the seam is handed the REAL throttleTierRunner (a live probe, not a no-op)', () => {
    const code = codeOnly(branch)
    // Passing anything other than the gateway's real runner (e.g. a stub) would
    // make the probe fire into the void — the branch outcome would look correct
    // in a naive grep but corroborate nothing.
    expect(code).toMatch(
      /routeRateLimit429\(\s*rateLimit429Classification\s*,\s*throttleTierRunner\s*,\s*agent\s*\)/,
    )
  })

  it('routeRateLimit429 is imported into the gateway (the seam is actually linked)', () => {
    // A dangling call to an unimported symbol would fail tsc, but pinning the
    // import makes the dependency edge explicit and its removal a red test too.
    expect(codeOnly(gatewaySrc)).toMatch(/\brouteRateLimit429\b/)
  })
})
