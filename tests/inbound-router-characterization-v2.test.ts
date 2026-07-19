/**
 * P7 F-1 — the SAME inbound-router characterization harness re-run with
 * SWITCHROOM_INBOUND_ROUTER_V2=1 (the consolidated intercept-chain arm:
 * runPreTurnIntercepts / runPasteBackIntercepts in inbound-router.ts).
 *
 * Env flags are module-load consts (P7 F2), so the flag must be set BEFORE the
 * gateway import — hence a separate vitest worker file whose only job is to
 * pre-set the env and then load the base harness. Every characterization case
 * must pass IDENTICALLY under both flag settings: the base harness is the
 * PR-11 parity oracle (design F6 — v1 == v2 effects), so re-running its FULL
 * fixture set under the v2 arm is the merge gate for the cutover.
 *
 * This replaces the earlier hand-written 8-case v2-chain smoke suite, which
 * was a strict SUBSET of the base harness (P7 adversarial review F-1): it left
 * the v2 arm's INTERNAL intercept ordering unpinned — swapping auth-add/reauth
 * (or vault/reauth) order inside runPasteBackIntercepts kept every suite green.
 * Re-importing the base harness under the flag pulls the load-bearing ordering
 * cases (auth-add-before-reauth, TTL-expiry, cross-topic isolation, vault
 * secret-staging ORDER, fail-closed) onto the v2 arm, where they now RED on
 * those mutations — mirroring tests/turn-lifecycle-characterization-v2.test.ts.
 */
process.env.SWITCHROOM_INBOUND_ROUTER_V2 = '1'
await import('./inbound-router-characterization.test.js')

// Worker-level sanity: assert the flag actually captured ON in THIS worker, so
// a regression where the env fails to set can never silently re-run the legacy
// (v1) arm a second time and masquerade as v2 parity coverage.
import { describe, it, expect } from 'vitest'
describe('v2 worker — flag sanity', () => {
  it('this worker runs with INBOUND_ROUTER_V2 = true (env captured at import)', async () => {
    const router = await import('../telegram-plugin/gateway/inbound-router.js')
    expect(router.INBOUND_ROUTER_V2).toBe(true)
  })
})
