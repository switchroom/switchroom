/**
 * Structural contract tests for the "🔁 Always allow" handler in
 * gateway.ts (the `behavior === 'always'` branch of the perm: callback
 * dispatcher).
 *
 * Why structural: the handler lives inside a Grammy callback closure
 * that's not exported. Full-function invocation would require a complete
 * Grammy + switchroomExec harness. Instead, we pin the source-level
 * invariants that were introduced to fix the silent-failure bug:
 *
 *   1. Loud failure text — the failure path must NOT read like success
 *      (`✅ Allowed …`). After the fix, both the toast (ackText) and the
 *      chat edit (editLabel) use the `⚠️` marker.
 *   2. Post-write verification — after `switchroomExec` returns success
 *      the handler MUST re-read the config and check that the rule is
 *      actually present in `tools.allow`. If the check fails it sets
 *      grantOk=false and surfaces the loud message.
 *   3. Success path unchanged — when `grantOk` is true the success
 *      strings (`🔁 Always allow …`, `restart agent for full effect`)
 *      are still present.
 *   4. Error reason capture — `grantFailReason` is declared and
 *      populated from `(err as Error).message` so the root cause can
 *      appear in logs; it is NOT silently swallowed into `message`-less
 *      stderr output.
 *
 * Slicing strategy: we extract the `if (behavior === 'always') {` block
 * from gateway.ts and run string assertions against that slice only —
 * so additions elsewhere in the 17k-line file don't produce false
 * positives or negatives.
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

describe('always-allow handler — loud failure invariants', () => {
  it('failure ackText uses the ⚠️ warning marker, not ✅', () => {
    // The failure path must be unambiguous. Before the fix, the failure
    // ackText started with "✅ Allowed …" which reads like success.
    expect(alwaysBlock).toContain(
      `⚠️ Allowed for now, but "always" did NOT save — it will ask again after restart. Check gateway log.`,
    )
    // Confirm the old misleading text is gone.
    expect(alwaysBlock).not.toContain('✅ Allowed (always-allow yaml edit failed')
  })

  it('failure editLabel uses the ⚠️ warning marker, not ✅', () => {
    // The inline-keyboard collapse edit also must NOT look like success.
    expect(alwaysBlock).toContain(
      `⚠️ <b>Allowed for now — "always" did NOT save.</b> It will ask again after restart. Check gateway log.`,
    )
    // Confirm the old misleading text is gone.
    expect(alwaysBlock).not.toContain('✅ <b>Allowed</b> (always-allow rule edit failed')
  })
})

describe('always-allow handler — success path unchanged', () => {
  it('success ackText still uses 🔁 and names the rule', () => {
    expect(alwaysBlock).toContain('`🔁 Always allow ${rule.label} for ${agentName}`')
  })

  it('success editLabel still uses 🔁 bold + restart hint', () => {
    expect(alwaysBlock).toContain('restart agent for full effect')
    expect(alwaysBlock).toContain('🔁 <b>Always allow')
  })
})

describe('always-allow handler — post-write verification', () => {
  it('reloads config after switchroomExec returns', () => {
    // The verification block must call loadSwitchroomConfig() AFTER
    // the switchroomExec call to confirm the rule landed in the
    // resolved tools.allow.
    const execIdx = alwaysBlock.indexOf("switchroomExec(['agent', 'grant'")
    const loadIdx = alwaysBlock.indexOf('loadSwitchroomConfig()', execIdx)
    expect(execIdx).toBeGreaterThan(-1)
    expect(loadIdx).toBeGreaterThan(execIdx)
  })

  it('calls resolveAgentConfig to obtain the merged tools.allow list', () => {
    const execIdx = alwaysBlock.indexOf("switchroomExec(['agent', 'grant'")
    const resolveIdx = alwaysBlock.indexOf('resolveAgentConfig(', execIdx)
    expect(resolveIdx).toBeGreaterThan(execIdx)
  })

  it('calls isRulePersisted(allowList, rule.rule) after the reload', () => {
    // The handler delegates the membership check to the extracted pure
    // helper so the behavioral test in always-allow-persist.test.ts can
    // cover the same code path.
    expect(alwaysBlock).toContain('isRulePersisted(allowList, rule.rule)')
  })

  it('sets grantOk=true only when isRulePersisted returns true', () => {
    // grantOk=true must be inside the `if (isRulePersisted(...))` branch,
    // not unconditionally after switchroomExec.
    const persistIdx = alwaysBlock.indexOf('isRulePersisted(allowList, rule.rule)')
    const grantOkIdx = alwaysBlock.indexOf('grantOk = true', persistIdx)
    expect(persistIdx).toBeGreaterThan(-1)
    expect(grantOkIdx).toBeGreaterThan(persistIdx)
    // Confirm grantOk=true does NOT appear before the persistence check
    // (i.e., not unconditionally on switchroomExec success as in the old code).
    const grantOkFirst = alwaysBlock.indexOf('grantOk = true')
    expect(grantOkFirst).toBeGreaterThanOrEqual(persistIdx)
  })

  it('logs a VERIFY FAILED message when the rule is absent after the write', () => {
    expect(alwaysBlock).toContain('always-allow VERIFY FAILED')
  })

  it('surfaces config-location drift as a failure reason', () => {
    expect(alwaysBlock).toContain('config location may have drifted')
  })
})

describe('always-allow handler — error reason capture', () => {
  it('declares grantFailReason to capture the root cause', () => {
    expect(alwaysBlock).toContain('let grantFailReason')
  })

  it('populates grantFailReason from the thrown error on switchroomExec failure', () => {
    // After the catch for switchroomExec, grantFailReason must be set
    // from the error object so log messages can show the actual cause.
    const catchIdx = alwaysBlock.lastIndexOf('} catch (err) {')
    const reasonIdx = alwaysBlock.indexOf('grantFailReason = (err as Error).message', catchIdx)
    expect(catchIdx).toBeGreaterThan(-1)
    expect(reasonIdx).toBeGreaterThan(catchIdx)
  })
})
