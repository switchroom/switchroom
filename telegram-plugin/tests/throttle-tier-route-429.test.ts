/**
 * Tests for the classify→route WIRING of the gateway's 429 corroboration path
 * (#failover-429-corroborate, follow-up switchroom#4379).
 *
 * The pure gate `classification429WarrantsCorroboration` is already unit-tested
 * (throttle-tier-probe-only.test.ts), and the runner's `fireProbeOnly` outcomes
 * are pinned there too. What was NOT covered is the WIRING that connects them:
 * the gateway callsite (gateway.ts, `handleOperatorEvent` rate-limited branch)
 * that decides whether to invoke `throttleTierRunner.fireProbeOnly(agent)` for a
 * given classification.
 *
 * gateway.ts is hard to unit-test in isolation and is under a hard line ratchet,
 * so rather than stand up a gateway harness the decision was extracted into a
 * pure, injectable seam — `routeRateLimit429(classification, runner, agent)` in
 * throttle-tier.ts — which the gateway callsite now calls verbatim. These tests
 * exercise that seam with a fake runner that records which entrypoint fired,
 * pinning the three routing outcomes the gateway promises:
 *
 *   - generic-transient → routes to fireProbeOnly (the probe fires)
 *   - litellm-local     → does NOT route to fireProbeOnly (account-inert by
 *                         mechanism: the request never reached Anthropic)
 *   - account-scoped    → does NOT route to fireProbeOnly (that classification
 *                         takes its own `fire` path, not the probe)
 */

import { describe, it, expect } from 'vitest'
import { routeRateLimit429, type RateLimit429ProbeRunner } from '../throttle-tier.js'

interface FakeRunner extends RateLimit429ProbeRunner {
  probeCalls: string[]
}

function makeFakeRunner(): FakeRunner {
  const probeCalls: string[] = []
  return {
    probeCalls,
    async fireProbeOnly(triggerAgent: string) {
      probeCalls.push(triggerAgent)
    },
  }
}

describe('routeRateLimit429 — gateway classify→route wiring (switchroom#4379)', () => {
  it('generic-transient → routes to fireProbeOnly', () => {
    const runner = makeFakeRunner()
    const fired = routeRateLimit429('generic-transient', runner, 'carrie')
    expect(fired).toBe(true)
    expect(runner.probeCalls).toEqual(['carrie'])
  })

  it('litellm-local → does NOT route to fireProbeOnly (stays account-inert)', () => {
    const runner = makeFakeRunner()
    const fired = routeRateLimit429('litellm-local', runner, 'carrie')
    expect(fired).toBe(false)
    expect(runner.probeCalls).toHaveLength(0)
  })

  it('account-scoped → does NOT route to fireProbeOnly (uses fire, not the probe)', () => {
    const runner = makeFakeRunner()
    const fired = routeRateLimit429('account-scoped', runner, 'carrie')
    expect(fired).toBe(false)
    expect(runner.probeCalls).toHaveLength(0)
  })

  it('null (not a rate-limited event) → does NOT route to fireProbeOnly', () => {
    const runner = makeFakeRunner()
    const fired = routeRateLimit429(null, runner, 'carrie')
    expect(fired).toBe(false)
    expect(runner.probeCalls).toHaveLength(0)
  })
})
