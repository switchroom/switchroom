/**
 * Structural contract tests for the durable "🔁 Always allow" handler
 * in gateway.ts, reworked for #1977 and the scoped-card split.
 *
 * The "Always…" flow is now TWO callback steps:
 *   - `behavior === 'always' | 'back'` — swaps the action row for the
 *     scope sub-menu (and back). Dispatches NO verdict and touches NO
 *     host config; it only edits the keyboard.
 *   - `behavior === 'asn' | 'asb'` — the operator picked a scope
 *     (narrow / broad). THIS is where the verdict fires and the durable
 *     persistence round-trip runs.
 *
 * Why structural: the handler lives inside a Grammy callback closure
 * that's not exported. Full-function invocation would require a complete
 * Grammy + hostd + switchroomExec harness. The behavioural pieces are
 * covered by the pure-function tests (permission-diff.test.ts,
 * permission-rule.test.ts) and the correlation handler tests
 * (always-allow-correlation.test.ts); this file pins the source-level
 * invariants of the orchestration block.
 *
 * Post-#1977 contract (now on the scope-commit `asn`/`asb` block):
 *   1. The in-flight Allow verdict fires IMMEDIATELY (before awaiting
 *      hostd) so the turn never blocks on host-config persistence.
 *   2. Durable persistence goes through hostd's `config_propose_edit`
 *      (synthesizeAllowRuleDiff → tryHostdDispatch).
 *   3. The legacy `switchroom agent grant` path is the
 *      not-configured fallback ONLY (not the primary path), and it
 *      still verifies via isRulePersisted with honest messaging.
 *   4. Failure text never falsely claims durable success.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

/**
 * Extract the scope-commit block (`behavior === 'asn' || behavior ===
 * 'asb'`) from the perm: callback dispatcher. The slice runs from that
 * guard up to (but not including) the `// Forward permission decision`
 * comment which opens the allow/deny branch.
 */
function sliceCommitBlock(): string {
  const start = gatewaySrc.indexOf("if (behavior === 'asn' || behavior === 'asb')")
  const end = gatewaySrc.indexOf('// Forward permission decision to connected bridges', start)
  if (start === -1 || end === -1) return ''
  return gatewaySrc.slice(start, end)
}

/**
 * Extract the keyboard-toggle block (`behavior === 'always' || behavior
 * === 'back'`), which must NOT dispatch a verdict.
 */
function sliceToggleBlock(): string {
  const start = gatewaySrc.indexOf("if (behavior === 'always' || behavior === 'back')")
  const end = gatewaySrc.indexOf("if (behavior === 'asn' || behavior === 'asb')", start)
  if (start === -1 || end === -1) return ''
  return gatewaySrc.slice(start, end)
}

const commitBlock = sliceCommitBlock()
const toggleBlock = sliceToggleBlock()

describe('always-allow — keyboard toggle block (no side effects)', () => {
  it('exists and only edits the reply markup', () => {
    expect(toggleBlock).not.toBe('')
    expect(toggleBlock).toContain('editMessageReplyMarkup')
  })

  it('dispatches NO verdict and runs NO host round-trip', () => {
    expect(toggleBlock).not.toContain('dispatchPermissionVerdict(')
    expect(toggleBlock).not.toContain('tryHostdDispatch(')
  })

  it('surfaces the scope choice only now (specific + broad-with-⚠️)', () => {
    expect(toggleBlock).toContain('choices.broad.buttonLabel')
    expect(toggleBlock).toContain('⚠️')
    expect(toggleBlock).toContain('perm:asn:')
    expect(toggleBlock).toContain('perm:asb:')
  })
})

describe('scope-commit — immediate verdict dispatch (turn must not block)', () => {
  it('dispatches the permission verdict BEFORE the hostd await', () => {
    const verdictIdx = commitBlock.indexOf('dispatchPermissionVerdict({')
    const hostdAwaitIdx = commitBlock.indexOf('await tryHostdDispatch(')
    expect(verdictIdx).toBeGreaterThan(-1)
    expect(hostdAwaitIdx).toBeGreaterThan(-1)
    expect(verdictIdx).toBeLessThan(hostdAwaitIdx)
  })

  it('carries the chosen scope rule on the verdict so the bridge caches it', () => {
    expect(commitBlock).toContain("behavior: 'allow'")
    expect(commitBlock).toContain('rule: chosen.rule')
  })

  it('resolves the chosen scope from the tapped button (asn=narrow, asb=broad)', () => {
    expect(commitBlock).toContain('resolveScopedAllowChoices(')
    expect(commitBlock).toContain("behavior === 'asn' ? (choices.specific ?? choices.broad) : choices.broad")
  })

  it('does NOT pass a synthInbound to finalizeCallback (verdict already fired)', () => {
    const finalizeIdx = commitBlock.indexOf('await finalizeCallback(ctx, {')
    const after = commitBlock.slice(finalizeIdx)
    expect(finalizeIdx).toBeGreaterThan(-1)
    expect(after).not.toContain('synthInbound')
  })
})

describe('scope-commit — durable hostd persistence', () => {
  it('synthesizes a unified diff from the raw config text', () => {
    expect(commitBlock).toContain('synthesizeAllowRuleDiff({')
    expect(commitBlock).toContain("op: 'config_propose_edit'")
  })

  it('reads the RAW config bytes (readFileSync), not the parsed config', () => {
    expect(commitBlock).toContain('readFileSync(')
  })

  it('passes a 12-min timeout to tryHostdDispatch (apply+reconcile can take 5-10 min)', () => {
    expect(commitBlock).toContain('await tryHostdDispatch(agentName, req, 720_000)')
  })

  it('acks the tap BEFORE the hostd await (interim status, background persist)', () => {
    const interimAckIdx = commitBlock.indexOf('saving durably in background')
    const bgIdx = commitBlock.indexOf('void (async () => {')
    const hostdAwaitIdx = commitBlock.indexOf('await tryHostdDispatch(')
    expect(interimAckIdx).toBeGreaterThan(-1)
    expect(bgIdx).toBeGreaterThan(-1)
    expect(hostdAwaitIdx).toBeGreaterThan(-1)
    // interim ack fires before the background continuation opens, and the
    // slow hostd await lives INSIDE the background continuation.
    expect(interimAckIdx).toBeLessThan(bgIdx)
    expect(bgIdx).toBeLessThan(hostdAwaitIdx)
  })

  it('edits the card with the real outcome after the background persist', () => {
    const bgIdx = commitBlock.indexOf('void (async () => {')
    const outcomeEditIdx = commitBlock.indexOf('await ctx.editMessageText(', bgIdx)
    expect(outcomeEditIdx).toBeGreaterThan(bgIdx)
    // Outcome edit failure is logged, never thrown into the void continuation.
    expect(commitBlock).toContain('always-allow outcome card edit failed')
  })

  it('registers + cleans up the single-tap correlation entry', () => {
    expect(commitBlock).toContain('pendingAlwaysAllowCorrelations.set(correlationKey')
    const finallyIdx = commitBlock.indexOf('} finally {')
    const deleteIdx = commitBlock.indexOf('pendingAlwaysAllowCorrelations.delete(correlationKey)', finallyIdx)
    expect(finallyIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(finallyIdx)
  })

  it('treats E_CONFIG_EDIT_DISABLED specially (no legacy fallback, points at the flag)', () => {
    expect(commitBlock).toContain('E_CONFIG_EDIT_DISABLED')
    expect(commitBlock).toContain('hostd.config_edit_enabled')
  })
})

describe('scope-commit — legacy fallback ONLY when hostd not-configured', () => {
  it('falls back to switchroom agent grant only on not-configured', () => {
    const notConfiguredIdx = commitBlock.indexOf("resp === 'not-configured'")
    const grantIdx = commitBlock.indexOf("switchroomExec(['agent', 'grant'")
    expect(notConfiguredIdx).toBeGreaterThan(-1)
    expect(grantIdx).toBeGreaterThan(-1)
    expect(grantIdx).toBeGreaterThan(notConfiguredIdx)
  })

  it('emits the legacy-spawn deprecation warning on the not-configured path', () => {
    expect(commitBlock).toContain("warnLegacySpawnIfHostdDisabled('always-allow')")
  })

  it('verifies the legacy write landed via isRulePersisted', () => {
    expect(commitBlock).toContain('isRulePersisted(allowList, chosen.rule)')
    expect(commitBlock).toContain('resolveAgentConfig(')
  })

  it('legacy success messaging is honest about being the legacy path', () => {
    expect(commitBlock).toContain('(legacy path)')
  })
})

describe('scope-commit — loud failure invariants', () => {
  it('failure text uses the ⚠️ warning marker, never a false ✅ success', () => {
    expect(commitBlock).toContain('did NOT save')
    expect(commitBlock).not.toContain('✅ Allowed (always-allow yaml edit failed')
  })

  it('captures a failure reason for the gateway log', () => {
    expect(commitBlock).toContain('failReason')
    expect(commitBlock).toContain('(err as Error).message')
  })
})
