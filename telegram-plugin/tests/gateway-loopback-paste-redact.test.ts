import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural integration test for the loopback-paste fail-safe redaction in
 * the inbound intercept gauntlet (security audit #3084, F2/F3).
 *
 * Why structural: the decision predicate (shouldConsumeLoopbackPaste, incl.
 * the malformed-paste fail-safe) is exhaustively unit-tested in
 * `auth-loopback-relay.test.ts`, and the redaction primitive
 * (redactAuthCodeMessage) in `auth-code-redact.test.ts`. What's left to assert
 * here is that the intercept path actually WIRES a fail-safe so a code-bearing
 * paste that is malformed, or arrives just after the intercept TTL, or has no
 * active flow, is redacted + dropped rather than forwarded to the agent.
 *
 * P7 PR-6 (#2996): the intercept body (pending-flow branch + fail-safe tail)
 * moved verbatim into gateway/inbound-interceptors.ts
 * (`interceptLoopbackRelay`); gateway.ts keeps the ordered delegation. The
 * invariants are unchanged — only the file that owns each literal moved:
 *   1. The stale (TTL-expired) loopback branch does NOT let the paste fall
 *      through to the agent — it flows into the fail-safe below it.
 *   2. A fail-safe `if (shouldConsumeLoopbackPaste(p.text))` block exists that
 *      redacts (deps.redactAuthCode → redactAuthCodeMessage) and returns
 *      handled, sitting AFTER the pending-flow branch; the gateway invokes the
 *      loopback intercept BEFORE the generic auth-code / reauth intercept.
 */
describe('gateway loopback-paste fail-safe redaction — structural wiring', () => {
  const gatewaySrc = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )
  const interceptorsSrc = readFileSync(
    new URL('../gateway/inbound-interceptors.ts', import.meta.url),
    'utf8',
  )

  it('wires the consume predicate + redaction helper', () => {
    // The intercept module owns the predicate; the gateway binds the
    // redaction closure (deps.redactAuthCode → redactAuthCodeMessage).
    expect(interceptorsSrc).toMatch(/shouldConsumeLoopbackPaste/)
    expect(gatewaySrc).toMatch(/redactAuthCodeMessage/)
    expect(gatewaySrc).toMatch(/interceptLoopbackRelay\(/)
  })

  it('has a fail-safe redact-and-return block guarded by shouldConsumeLoopbackPaste', () => {
    // Isolate the fail-safe block: `if (shouldConsumeLoopbackPaste(p.text)) { ... }`
    // that is NOT part of the `pendingLoop && ...` pending-flow branch.
    const failSafe = interceptorsSrc.match(
      /if \(shouldConsumeLoopbackPaste\(p\.text\)\) \{[\s\S]{0,700}?\n {2}\}/g,
    )
    expect(failSafe).not.toBeNull()
    // The standalone fail-safe (the one NOT preceded by `pendingLoop &&`).
    const standalone = (failSafe ?? []).find(
      (b) => !b.startsWith('if (pendingLoop'),
    )
    expect(standalone).toBeDefined()
    expect(standalone!).toMatch(/deps\.redactAuthCode/)
    expect(standalone!).toMatch(/return \{ handled: true \}/)
  })

  it('the stale loopback branch falls through to the fail-safe (does not forward)', () => {
    // The fail-safe block must appear AFTER the pending-loop branch inside the
    // intercept module; and the gateway must invoke the loopback intercept
    // BEFORE the generic auth-code intercept (`pendingReauthFlows`).
    const failSafeIdx = interceptorsSrc.indexOf(
      'Fail-safe redaction (security audit #3084, F2/F3)',
    )
    const pendingLoopIdx = interceptorsSrc.indexOf(
      'const pendingLoop = pendingLoopbackFlows.get',
    )
    expect(failSafeIdx).toBeGreaterThan(-1)
    expect(failSafeIdx).toBeGreaterThan(pendingLoopIdx)

    const loopbackCallIdx = gatewaySrc.indexOf('interceptLoopbackRelay(')
    const reauthIdx = gatewaySrc.indexOf('const pendingReauth = pendingReauthFlows.get')
    expect(loopbackCallIdx).toBeGreaterThan(-1)
    expect(reauthIdx).toBeGreaterThan(loopbackCallIdx)
  })
})
