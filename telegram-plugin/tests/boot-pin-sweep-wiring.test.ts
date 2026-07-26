/**
 * Boot pin sweep WIRING fence (#3664 Defect A).
 *
 * The behaviour lives in `boot-sweep-gate.test.ts`; this file pins the gateway
 * WIRING, because the regression was a wiring regression: `caa4d7568` (#3310)
 * moved the `lockedBot` assignment into `initGatewayBot()` and left the sweep's
 * kick-off at module-eval time. `tsc` stayed green (the `!` definite-assignment
 * assertion on `lockedBot` suppresses the error) and no test noticed, so every
 * boot-cleanup unpin threw `undefined is not an object` for a month.
 *
 * These are STRUCTURAL assertions (the gateway module can't be instantiated
 * in-process — same pattern as silence-liveness-wiring.test.ts) that fail if a
 * future refactor re-introduces a module-eval-time dispatch of the sweep.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')

describe('boot pin sweep wiring (#3664)', () => {
  it('never dispatches runBootPinCleanupAndDmSweep() directly — only through the gate', () => {
    // The original bug shape, verbatim: a fire-and-forget call at module-eval
    // time. Any direct invocation (voided or awaited) bypasses the bot-ready
    // half of the precondition.
    const directCalls =
      gatewaySrc.match(/(?<!function\s)(?<![.\w])runBootPinCleanupAndDmSweep\s*\(/g) ?? []
    expect(directCalls).toEqual([])
  })

  it('passes the sweep to the gate as a reference, and arms it at both mutex sites', () => {
    expect(gatewaySrc).toContain('createBootSweepGate({ run: runBootPinCleanupAndDmSweep')
    // Both startup-lock outcomes (mutex acquired, and the non-atomic
    // writePidFile fallback) arm — neither may dispatch on its own.
    const armSites = gatewaySrc.match(/bootPinSweepGate\.arm\(\)/g) ?? []
    expect(armSites.length).toBe(2)
  })

  it('signals botReady() only from initGatewayBot, AFTER lockedBot is assigned', () => {
    const readySites = gatewaySrc.match(/bootPinSweepGate\.botReady\(\)/g) ?? []
    expect(readySites.length).toBe(1)

    const initStart = gatewaySrc.indexOf('async function initGatewayBot()')
    const assignIdx = gatewaySrc.indexOf('lockedBot = chatLock.wrapBot(')
    const readyIdx = gatewaySrc.indexOf('bootPinSweepGate.botReady()')
    expect(initStart).toBeGreaterThan(-1)
    expect(assignIdx).toBeGreaterThan(initStart)
    expect(readyIdx).toBeGreaterThan(assignIdx)
  })

  it('arms only from inside the startup-mutex block, never at bare module scope', () => {
    // Every arm() site must be indented (i.e. nested inside the
    // `if (isGatewayMain) { … }` startup-lock block), never a top-level
    // statement that would run unconditionally on import.
    for (const line of gatewaySrc.split('\n')) {
      if (line.includes('bootPinSweepGate.arm()')) {
        expect(line.startsWith(' ')).toBe(true)
      }
    }
  })
})
