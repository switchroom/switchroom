/**
 * Structural contract tests for the durable "🔁 Always allow" handler
 * in gateway.ts (the `behavior === 'always'` branch of the perm:
 * callback dispatcher), reworked for #1977.
 *
 * Why structural: the handler lives inside a Grammy callback closure
 * that's not exported. Full-function invocation would require a complete
 * Grammy + hostd + switchroomExec harness. The behavioural pieces are
 * covered by the pure-function tests (permission-diff.test.ts) and the
 * correlation handler tests (always-allow-correlation.test.ts); this
 * file pins the source-level invariants of the orchestration block.
 *
 * Post-#1977 contract:
 *   1. The in-flight Allow verdict fires IMMEDIATELY (before awaiting
 *      hostd) so the turn never blocks on host-config persistence.
 *   2. Durable persistence goes through hostd's `config_propose_edit`
 *      (synthesizeAllowRuleDiff → tryHostdDispatch).
 *   3. The legacy `switchroom agent grant` path is the
 *      not-configured fallback ONLY (not the primary path), and it
 *      still verifies via isRulePersisted with honest messaging.
 *   4. Failure text never falsely claims durable success.
 *
 * Slicing strategy: we extract the `if (behavior === 'always') {` block
 * from gateway.ts and run string assertions against that slice only.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

/**
 * Extract the `behavior === 'always'` block from the perm: callback
 * dispatcher. The slice runs from the `if (behavior === 'always')` guard
 * up to (but not including) the next top-level `// Forward permission`
 * comment which opens the allow/deny branch.
 */
function sliceAlwaysBlock(): string {
  const start = gatewaySrc.indexOf("if (behavior === 'always')")
  const end = gatewaySrc.indexOf('// Forward permission decision to connected bridges', start)
  if (start === -1 || end === -1) return ''
  return gatewaySrc.slice(start, end)
}

const alwaysBlock = sliceAlwaysBlock()

describe('always-allow handler — immediate verdict dispatch (turn must not block)', () => {
  it('dispatches the permission verdict BEFORE the hostd await', () => {
    const verdictIdx = alwaysBlock.indexOf('dispatchPermissionVerdict({')
    const hostdAwaitIdx = alwaysBlock.indexOf('await tryHostdDispatch(')
    expect(verdictIdx).toBeGreaterThan(-1)
    expect(hostdAwaitIdx).toBeGreaterThan(-1)
    // The verdict fires first — independent of the durable persistence
    // round-trip.
    expect(verdictIdx).toBeLessThan(hostdAwaitIdx)
  })

  it('carries the resolved rule on the verdict so the bridge caches it', () => {
    expect(alwaysBlock).toContain("behavior: 'allow'")
    expect(alwaysBlock).toContain('rule: rule.rule')
  })

  it('does NOT pass a synthInbound to finalizeCallback (verdict already fired)', () => {
    // The verdict is dispatched directly above; finalizeCallback only
    // edits the card. A synthInbound here would double-fire.
    const finalizeIdx = alwaysBlock.indexOf('await finalizeCallback(ctx, {')
    const after = alwaysBlock.slice(finalizeIdx)
    expect(finalizeIdx).toBeGreaterThan(-1)
    expect(after).not.toContain('synthInbound')
  })
})

describe('always-allow handler — durable hostd persistence', () => {
  it('synthesizes a unified diff from the raw config text', () => {
    expect(alwaysBlock).toContain('synthesizeAllowRuleDiff({')
    expect(alwaysBlock).toContain("op: 'config_propose_edit'")
  })

  it('reads the RAW config bytes (readFileSync), not the parsed config', () => {
    // The diff context lines must byte-match the on-disk file, so we
    // read literal bytes rather than re-serialising loadSwitchroomConfig.
    expect(alwaysBlock).toContain('readFileSync(')
  })

  it('passes a long timeout to tryHostdDispatch (apply+reconcile blocks)', () => {
    expect(alwaysBlock).toContain('await tryHostdDispatch(agentName, req, 60_000)')
  })

  it('registers + cleans up the single-tap correlation entry', () => {
    expect(alwaysBlock).toContain('pendingAlwaysAllowCorrelations.set(correlationKey')
    // Cleanup in a finally so it can never be replayed.
    const finallyIdx = alwaysBlock.indexOf('} finally {')
    const deleteIdx = alwaysBlock.indexOf('pendingAlwaysAllowCorrelations.delete(correlationKey)', finallyIdx)
    expect(finallyIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(finallyIdx)
  })

  it('treats E_CONFIG_EDIT_DISABLED specially (no legacy fallback, points at the flag)', () => {
    expect(alwaysBlock).toContain('E_CONFIG_EDIT_DISABLED')
    expect(alwaysBlock).toContain('hostd.config_edit_enabled')
  })
})

describe('always-allow handler — legacy fallback ONLY when hostd not-configured', () => {
  it('falls back to switchroom agent grant only on not-configured', () => {
    const notConfiguredIdx = alwaysBlock.indexOf("resp === 'not-configured'")
    const grantIdx = alwaysBlock.indexOf("switchroomExec(['agent', 'grant'")
    expect(notConfiguredIdx).toBeGreaterThan(-1)
    expect(grantIdx).toBeGreaterThan(-1)
    // The grant shellout lives AFTER the not-configured branch sets
    // legacy=true (i.e. it is the fallback, not the primary path).
    expect(grantIdx).toBeGreaterThan(notConfiguredIdx)
  })

  it('emits the legacy-spawn deprecation warning on the not-configured path', () => {
    expect(alwaysBlock).toContain("warnLegacySpawnIfHostdDisabled('always-allow')")
  })

  it('verifies the legacy write landed via isRulePersisted', () => {
    expect(alwaysBlock).toContain('isRulePersisted(allowList, rule.rule)')
    expect(alwaysBlock).toContain('resolveAgentConfig(')
  })

  it('legacy success messaging is honest about being the legacy path', () => {
    expect(alwaysBlock).toContain('(legacy path)')
  })
})

describe('always-allow handler — loud failure invariants', () => {
  it('failure text uses the ⚠️ warning marker, never a false ✅ success', () => {
    expect(alwaysBlock).toContain('did NOT save')
    expect(alwaysBlock).not.toContain('✅ Allowed (always-allow yaml edit failed')
  })

  it('captures a failure reason for the gateway log', () => {
    expect(alwaysBlock).toContain('failReason')
    expect(alwaysBlock).toContain('(err as Error).message')
  })
})
