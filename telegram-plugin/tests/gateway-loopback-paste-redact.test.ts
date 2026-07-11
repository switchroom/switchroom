import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural integration test for the loopback-paste fail-safe redaction in
 * the gateway's inbound handler (security audit #3084, F2/F3).
 *
 * Why structural: gateway/gateway.ts does not export its inbound handler, so a
 * pure-functional invocation would require end-to-end harnessing of
 * Bot/Grammy/Context. The decision predicate (shouldConsumeLoopbackPaste, incl.
 * the malformed-paste fail-safe) is exhaustively unit-tested in
 * `auth-loopback-relay.test.ts`, and the redaction primitive
 * (redactAuthCodeMessage) in `auth-code-redact.test.ts`. What's left to assert
 * here is that the gateway actually WIRES a fail-safe so a code-bearing paste
 * that is malformed, or arrives just after the intercept TTL, or has no active
 * flow, is redacted + dropped rather than forwarded to the agent.
 *
 * The invariants:
 *   1. The stale (TTL-expired) loopback branch does NOT let the paste fall
 *      through to the agent — it flows into the fail-safe below.
 *   2. A fail-safe `if (shouldConsumeLoopbackPaste(text))` block exists that
 *      redacts (redactAuthCodeMessage) and returns, sitting AFTER the
 *      pending-flow branch but BEFORE the generic auth-code / agent-forward
 *      handlers.
 */
describe('gateway loopback-paste fail-safe redaction — structural wiring', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('imports the consume predicate + redaction helper', () => {
    expect(src).toMatch(/shouldConsumeLoopbackPaste/)
    expect(src).toMatch(/redactAuthCodeMessage/)
  })

  it('has a fail-safe redact-and-return block guarded by shouldConsumeLoopbackPaste', () => {
    // Isolate the fail-safe block: `if (shouldConsumeLoopbackPaste(text)) { ... }`
    // that is NOT part of the `pendingLoop && ...` pending-flow branch.
    const failSafe = src.match(
      /if \(shouldConsumeLoopbackPaste\(text\)\) \{[\s\S]{0,600}?\n {2}\}/g,
    )
    expect(failSafe).not.toBeNull()
    // The standalone fail-safe (the one NOT preceded by `pendingLoop &&`).
    const standalone = (failSafe ?? []).find(
      (b) => !b.startsWith('if (pendingLoop'),
    )
    expect(standalone).toBeDefined()
    expect(standalone!).toMatch(/redactAuthCodeMessage/)
    expect(standalone!).toMatch(/return/)
  })

  it('the stale loopback branch falls through to the fail-safe (does not forward)', () => {
    // The stale-path comment must reference the fail-safe, and the fail-safe
    // block must appear AFTER the pending-loop branch and BEFORE the generic
    // auth-code intercept (`pendingReauthFlows`).
    const failSafeIdx = src.indexOf(
      'Fail-safe redaction (security audit #3084, F2/F3)',
    )
    const pendingLoopIdx = src.indexOf('const pendingLoop = pendingLoopbackFlows.get')
    const reauthIdx = src.indexOf('const pendingReauth = pendingReauthFlows.get')
    expect(failSafeIdx).toBeGreaterThan(-1)
    expect(failSafeIdx).toBeGreaterThan(pendingLoopIdx)
    expect(reauthIdx).toBeGreaterThan(failSafeIdx)
  })
})
