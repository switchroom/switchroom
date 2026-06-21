/**
 * M-1: SWITCHROOM_PERMISSION_CARD_ORIGIN_RECOVERY kill-switch — structural assertion.
 *
 * The permission-card origin-recovery feature (fixes the "marko Rentals-budget"
 * incident: permission cards fanning out to operator DMs instead of the forum
 * topic the operator is working in) must be gated by a kill switch so operators
 * can opt out of the recovery behaviour if it causes issues.
 *
 * Load-bearing constraint: the kill switch must use `!== '0'` semantics (default
 * ON — recovery is active unless explicitly disabled). This is a structural
 * assertion — pattern matches silence-liveness-wiring.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('M-1: SWITCHROOM_PERMISSION_CARD_ORIGIN_RECOVERY kill-switch', () => {
  it('kill-switch env var name is SWITCHROOM_PERMISSION_CARD_ORIGIN_RECOVERY', () => {
    expect(gatewaySrc).toContain('SWITCHROOM_PERMISSION_CARD_ORIGIN_RECOVERY')
  })

  it('kill-switch constant is defined with !== "0" semantic (default ON)', () => {
    expect(gatewaySrc).toMatch(
      /PERMISSION_CARD_ORIGIN_RECOVERY_ENABLED[\s\S]{0,10}=[\s\S]{0,10}process\.env\.SWITCHROOM_PERMISSION_CARD_ORIGIN_RECOVERY\s*!==\s*'0'/,
    )
  })

  it('kill-switch gates the origin-recovery call site in gateway.ts', () => {
    // There must be at least two occurrences: the const definition and the gate site.
    const matches = [...gatewaySrc.matchAll(/PERMISSION_CARD_ORIGIN_RECOVERY_ENABLED/g)]
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('kill-switch is checked with if (PERMISSION_CARD_ORIGIN_RECOVERY_ENABLED)', () => {
    expect(gatewaySrc).toMatch(/if\s*\(\s*PERMISSION_CARD_ORIGIN_RECOVERY_ENABLED\s*\)/)
  })
})
