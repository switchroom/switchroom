import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Regression guard for the fail-closed contract on the secret-detect
 * pipeline in the gateway.
 *
 * If runPipeline throws inside the intercept, we must NOT fall through
 * to recordInbound() / ipcServer.broadcast() with the raw text — that
 * would stamp the secret into SQLite and emit it to the agent
 * unscrubbed. The catch block must drop the message (return) before
 * reaching either sink.
 *
 * The intercept moved from server.ts to gateway/gateway.ts in PR #54
 * (fix/secret-detect-on-gateway). server.ts's bot polling loses 409 to
 * the gateway and never runs in production, so the prior check on
 * server.ts was guarding dead code. These assertions are structural so
 * they don't depend on Bun-only runtime deps; they inspect the source
 * bytes directly.
 */
describe('secret-detect pipeline fail-closed contract (gateway)', () => {
  // P7 PR-9 (#2996): the pipeline intercept (incl. the fail-closed catch)
  // moved verbatim into gateway/inbound-interceptors.ts
  // (interceptSecretDetectPipeline). The catch now returns `{ handled: true }`
  // and the gateway call site early-returns on `handled` BEFORE the sinks —
  // the contract is unchanged, split across the seam.
  const gatewaySrc = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )
  const interceptorsSrc = readFileSync(
    new URL('../gateway/inbound-interceptors.ts', import.meta.url),
    'utf8',
  )
  const src = gatewaySrc + '\n' + interceptorsSrc

  it('has exactly one [secret-detect] pipeline error catch marker', () => {
    const matches = src.match(/\[secret-detect\] pipeline error/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('the catch block around runPipeline returns (does not fall through to recordInbound / broadcast)', () => {
    // Interceptor side: after the error marker, the catch must return
    // `{ handled: true }` (drop) — never fall out of the catch body.
    const idx = interceptorsSrc.indexOf('[secret-detect] pipeline error')
    expect(idx).toBeGreaterThan(0)
    const tail = interceptorsSrc.slice(idx, idx + 2000)
    expect(tail).toMatch(/\n\s*return \{ handled: true \}/)
    // Gateway side: the delegation early-returns on `handled` BEFORE both
    // sinks, so a dropped message can never reach them.
    const callIdx = gatewaySrc.indexOf('await interceptSecretDetectPipeline(')
    expect(callIdx).toBeGreaterThan(0)
    const afterCall = gatewaySrc.slice(callIdx)
    const handledReturn = afterCall.indexOf('if (secretOutcome.handled) return')
    const recordOffset = afterCall.indexOf('recordInbound(')
    const broadcastOffset = afterCall.indexOf('ipcServer.broadcast(inboundMsg)')
    expect(handledReturn).toBeGreaterThan(0)
    expect(recordOffset).toBeGreaterThan(handledReturn)
    expect(broadcastOffset).toBeGreaterThan(handledReturn)
  })

  it('catch body warns the user that the message was dropped', () => {
    const idx = src.indexOf('[secret-detect] pipeline error')
    const tail = src.slice(idx, idx + 2000)
    expect(tail).toMatch(/dropped|NOT stored|crash/i)
  })

  it('no path exists where recordInbound or broadcast is called with the raw effectiveText after a pipeline throw', () => {
    // Structural guarantee across the seam: the interceptor catch returns
    // handled:true, and the gateway adopts the scrubbed effectiveText only
    // on the handled:false path — there is no branch that reaches the sinks
    // after a throw. Pin: the catch body ends in `return { handled: true }`
    // with no intervening effectiveText pass-through.
    const catchIdx = interceptorsSrc.indexOf('[secret-detect] pipeline error')
    expect(catchIdx).toBeGreaterThan(0)
    const catchTail = interceptorsSrc.slice(catchIdx, catchIdx + 2000)
    const returnIdx = catchTail.search(/\n\s*return \{ handled: true \}/)
    expect(returnIdx).toBeGreaterThan(0)
    expect(catchTail.slice(0, returnIdx)).not.toMatch(/handled: false/)
  })

  it('server.ts no longer contains the secret-detect intercept', () => {
    // Defensive: ensure the dead intercept is not silently re-added to
    // server.ts later. If a future change ports it back, this test will
    // flag it so we don't end up with two parallel implementations.
    const serverSrc = readFileSync(
      new URL('../server.ts', import.meta.url),
      'utf8',
    )
    expect(serverSrc).not.toMatch(/\[secret-detect\] pipeline error/)
    expect(serverSrc).not.toMatch(/runPipeline\(/)
  })
})
