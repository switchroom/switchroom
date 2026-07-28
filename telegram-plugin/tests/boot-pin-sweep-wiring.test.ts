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
  it('never dispatches runBootPinCleanupAndStalePinSweep() directly — only through the gate', () => {
    // The original bug shape, verbatim: a fire-and-forget call at module-eval
    // time. Any direct invocation (voided or awaited) bypasses the bot-ready
    // half of the precondition.
    const directCalls =
      gatewaySrc.match(/(?<!function\s)(?<![.\w])runBootPinCleanupAndStalePinSweep\s*\(/g) ?? []
    expect(directCalls).toEqual([])
  })

  it('passes the sweep to the gate as a reference, and arms it at both mutex sites', () => {
    expect(gatewaySrc).toContain('createBootSweepGate({ run: runBootPinCleanupAndStalePinSweep')
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

  it('runs the sweep steps through runBootPinSweepSteps, not a bare await chain', () => {
    // Salvage S2. The BEHAVIOUR (a throwing step must not strand the steps
    // behind it, and must never strand the DM-eligibility flip) is proven in
    // boot-sweep-gate.test.ts. This fence is what makes that proof apply to the
    // gateway: the reapers must reach the runner as injected steps, and nothing
    // may reintroduce the bare sequential chain that skipped the isolation.
    expect(gatewaySrc).toContain('return runBootPinSweepSteps({')
    const stepFns = ['statusPinBootCleanup', 'activityCardBootReaper', 'queuedCardBootReaper']
    for (const stepFn of stepFns) {
      // Passed BY REFERENCE as a step, never invoked inline in the sweep.
      expect(gatewaySrc).toContain(`: ${stepFn},`)
      const inlineAwaits = gatewaySrc.match(new RegExp(`await\\s+${stepFn}\\s*\\(`, 'g')) ?? []
      expect(inlineAwaits).toEqual([])
    }
    // The DM-eligibility flip is what a throw used to strand, so it must live
    // INSIDE the enableSweep step callback — not as a statement sequenced
    // after the reapers, where one rejection skips it for the whole session.
    const lines = gatewaySrc.split('\n')
    const flipIdxs = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*stalePinSweepEligible = true\s*$/.test(l))
      .map(({ i }) => i)
    expect(flipIdxs.length).toBe(1)
    expect(lines[flipIdxs[0] - 1]).toContain('enableSweep: () => {')
  })

  it('routes the pin API through the asserting seam, never a raw lockedBot.api pin', () => {
    // Salvage S1/S3: `statusPinApi()` must build on `createStatusPinApi`, which
    // asserts the bot exists and converts a send-gate SHED into a throw. A
    // hand-rolled `robustApiCall(() => lockedBot.api.pinChatMessage(...))`
    // anywhere in the gateway would bypass both invariants.
    expect(gatewaySrc).toContain('return createStatusPinApi(')
    // Every `status-pin.*` verb is now issued from status-pin-api.ts. A raw
    // `robustApiCall(() => lockedBot.api.unpinChatMessage(…), { verb:
    // 'status-pin.unpin' })` reappearing here would be a driver call that
    // skips assertBotReady + assertLanded.
    const statusPinVerbs = gatewaySrc.match(/verb:\s*['"`]status-pin\.(?:un)?pin['"`]/g) ?? []
    expect(statusPinVerbs).toEqual([])
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
