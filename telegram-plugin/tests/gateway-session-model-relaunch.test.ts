/**
 * Structural pins for the session-only model relaunch wiring in gateway.ts.
 *
 * The behaviour lives in un-exported inline closures (buildModelDeps's
 * scheduleModelRelaunch, the model-menu callback sr-* branch, and the boot
 * re-hydration / alert-sentinel block inside the startup IIFE), so — mirroring
 * the other gateway-*.test.ts source-pins — we assert on the source structure.
 * The end-to-end behaviour of the carrier itself is exercised in
 * tests/scaffold.session-model-override.test.ts (rendered start.sh) and the
 * handler contract in telegram-plugin/tests/model-command.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf8')

describe('gateway: scheduleModelRelaunch dep', () => {
  it('writes the carrier with exact "<model>\\n" bytes', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    expect(win).toMatch(/writeFileSync\(\s*join\(agentDir, '\.session-model-override'\),\s*`\$\{model\}\\n`/)
  })

  it('sets the in-memory activeSessionModelOverride before dispatching the restart', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    const setIdx = win.indexOf('activeSessionModelOverride = model')
    const restartIdx = win.indexOf('deps.scheduleRestart(reason)')
    expect(setIdx).toBeGreaterThan(0)
    expect(restartIdx).toBeGreaterThan(setIdx)
  })

  it('reuses the same scheduleRestart dispatch (not a bespoke restart path)', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    expect(win).toContain('await deps.scheduleRestart(reason)')
  })
})

describe('gateway: model-menu sr-* target relaunches via the carrier', () => {
  it('the sr-* callback branch calls scheduleModelRelaunch, not inject', () => {
    const idx = GATEWAY_SRC.indexOf('if (data.startsWith(MODEL_CALLBACK_SR))')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1400)
    expect(win).toContain('modelDeps.scheduleModelRelaunch(srName')
    // It must return before falling through to handleModelMenuCallback (which
    // would inject an sr-* id claude's picker rejects).
    expect(win).toMatch(/scheduleModelRelaunch[\s\S]*?\n\s*return\n/)
  })
})

describe('gateway boot: session-model re-hydration + LiteLLM-down alert', () => {
  it('re-hydrates activeSessionModelOverride from .active-session-model', () => {
    const idx = GATEWAY_SRC.indexOf("join(smAgentDir, '.active-session-model')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx - 200, idx + 1400)
    // Only an override when the launched model differs from the configured one.
    expect(win).toMatch(/launched\.length > 0 && launched !== configured \? launched : null/)
    // The configured value must be resolved through resolveMainModel (the SAME
    // resolver start.sh's scaffold uses) so an unset/`default` model config does
    // not get flagged as a phantom session override on an ordinary restart.
    expect(win).toContain('resolveMainModel(raw ?? undefined)')
  })

  it('consumes the .session-model-alert sentinel, notifies ALL operators, and deletes it', () => {
    const idx = GATEWAY_SRC.indexOf("join(smAgentDir, '.session-model-alert')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1100)
    expect(win).toContain('unlinkSync(alertPath)')
    // Broadcasts to every operator in allowFrom, not just allowFrom[0].
    expect(win).toContain('const operators = loadAccess().allowFrom')
    expect(win).toContain('for (const operator of operators)')
    expect(win).toContain('lockedBot.api')
    expect(win).toContain('.sendMessage(operator')
  })
})
