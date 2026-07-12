/**
 * Structural pins for the session-scoped /model wiring in gateway.ts
 * (reference/rfcs/session-model-stickiness.md §0.1, rev 4 — consume-once).
 *
 * The behaviour lives in un-exported inline closures (buildModelDeps's
 * scheduleModelRelaunch/scheduleRestart, the typed/menu recorders, and the
 * boot re-hydration block inside the startup IIFE), so — mirroring the other
 * gateway-*.test.ts source-pins — we assert on the source structure. The
 * end-to-end boot behaviour is exercised in tests/scaffold.session-model.test.ts
 * (rendered start.sh), the file helpers in session-model-file.test.ts, and the
 * handler contract in model-command.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf8')

describe('gateway: the .relaunch-model-intent subsystem is retired (rev 4)', () => {
  it('gateway.ts no longer writes/clears/imports any relaunch-model intent', () => {
    expect(GATEWAY_SRC).not.toContain('writeRelaunchModelIntent')
    expect(GATEWAY_SRC).not.toContain('clearRelaunchModelIntent')
    expect(GATEWAY_SRC).not.toContain('intentForRestartReason')
    expect(GATEWAY_SRC).not.toContain('clearStaleGatewayShutdownIntent')
    expect(GATEWAY_SRC).not.toContain('GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX')
    expect(GATEWAY_SRC).not.toContain('.relaunch-model-intent')
  })

  it('triggerSelfRestart just signals — no intent stamp before the kill', () => {
    const fnIdx = GATEWAY_SRC.indexOf('function triggerSelfRestart(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 3000)
    expect(win).toContain("process.kill(1, 'SIGTERM')")
    expect(win).not.toContain('writeRelaunchModelIntent')
  })
})

describe('gateway: scheduleModelRelaunch dep (consume-once .session-model carrier)', () => {
  it('writes the carrier via writeSessionModelFile before dispatching the restart', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1800)
    const writeIdx = win.indexOf('writeSessionModelFile(')
    const restartIdx = win.indexOf('deps.scheduleRestart(reason)')
    expect(writeIdx).toBeGreaterThan(0)
    expect(restartIdx).toBeGreaterThan(writeIdx)
  })

  it('sets the in-memory session-model override before dispatching the restart', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 1800)
    const setIdx = win.indexOf('sessionModelSource.setOverride(model)')
    const restartIdx = win.indexOf('deps.scheduleRestart(reason)')
    expect(setIdx).toBeGreaterThan(0)
    expect(restartIdx).toBeGreaterThan(setIdx)
  })

  it('rolls back the prior carrier content (not just deletion) on a non-in-flight dispatch failure', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 1800)
    expect(win).toContain('const prevFileRaw = readSessionModelFileRaw(agentDir)')
    expect(win).toContain('restoreSessionModelFileRaw(agentDir, prevFileRaw)')
    expect(win).toContain("!== 'restart_in_flight'")
  })

  it('reuses the same scheduleRestart dispatch (not a bespoke restart path)', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 1800)
    expect(win).toContain('await deps.scheduleRestart(reason)')
  })
})

describe('gateway: menu callback carrier handling (session-scoped)', () => {
  it('a live Claude selection records the in-memory override but writes NO carrier', () => {
    const idx = GATEWAY_SRC.indexOf('function recordModelMenuSideEffects')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    // The first (live-switch) block sets the override but no longer persists.
    expect(win).toContain('sessionModelSource.setOverride(outcome.selectedModel)')
    const overrideIdx = win.indexOf('sessionModelSource.setOverride(outcome.selectedModel)')
    const nextClearIdx = win.indexOf('outcome.clearedDefault')
    const writeBetween = win.slice(overrideIdx, nextClearIdx)
    expect(writeBetween).not.toContain('writeSessionModelFile(')
  })

  it('a confirmed "Default" selection CLEARS the carrier', () => {
    const idx = GATEWAY_SRC.indexOf('function recordModelMenuSideEffects')
    const win = GATEWAY_SRC.slice(idx, idx + 2400)
    expect(win).toContain('outcome.clearedDefault')
    expect(win).toContain('clearSessionModelFile(smDir)')
  })

  it('the sr-* callback branch calls scheduleModelRelaunch, not inject', () => {
    const idx = GATEWAY_SRC.indexOf('const srLabel = escapeHtmlForTg(srFriendlyLabel(srName))')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1400)
    expect(win).toContain('modelDeps.scheduleModelRelaunch(srName')
    expect(win).toMatch(/scheduleModelRelaunch[\s\S]*?\n\s*return\n/)
  })

  it('the sr-to-claude transition (a relaunch) writes the carrier, and clears it on a Default tap', () => {
    const idx = GATEWAY_SRC.indexOf('isSrToClaudeTransition(prevSessionModel, outcome.selectedModel)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 3600)
    expect(win).toMatch(/writeSessionModelFile\(\s*agentDir,\s*token/)
    expect(win).toContain('clearSessionModelFile(agentDir)')
    expect(win).toContain("triggerSelfRestart(agentName, 'sr-to-claude-model-switch'")
  })
})

describe('gateway: typed /model is session-scoped (live Claude switch writes no carrier)', () => {
  it('the Claude path sets the in-memory override but never persists a carrier', () => {
    const idx = GATEWAY_SRC.indexOf('function recordTypedModelSwitch')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1400)
    expect(win).toContain('sessionModelSource.setOverride(reply.selectedModel)')
    // No durable carrier write on the live-switch path.
    expect(win).not.toContain('writeSessionModelFile(')
  })

  it('`/model default` clears the carrier + in-memory override (silent-switch path must not resurrect)', () => {
    const idx = GATEWAY_SRC.indexOf('function recordTypedModelSwitch')
    const win = GATEWAY_SRC.slice(idx, idx + 1400)
    expect(win).toContain("requested?.toLowerCase() === 'default'")
    expect(win).toContain('clearSessionModelFile(smDir)')
    expect(win).toContain('sessionModelSource.setOverride(null)')
    // The file-clear is not gated on a positive confirmation.
    const clearIdx = win.indexOf('if (smDir) clearSessionModelFile(smDir)')
    const gatedOverrideIdx = win.indexOf('if (reply.selectedModel) sessionModelSource.setOverride(null)')
    expect(clearIdx).toBeGreaterThan(0)
    expect(gatedOverrideIdx).toBeGreaterThan(clearIdx)
  })
})

describe('gateway boot: session-model re-hydration + alert relay', () => {
  it('re-hydrates the override from .active-session-model', () => {
    const idx = GATEWAY_SRC.indexOf("join(smAgentDir, '.active-session-model')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx - 200, idx + 1400)
    expect(win).toMatch(/launched\.length > 0 && launched !== configured \? launched : null/)
    expect(win).toContain('resolveMainModel(raw ?? undefined)')
  })

  it('consumes the .session-model-alert sentinel, notifies ALL operators, and deletes it', () => {
    const idx = GATEWAY_SRC.indexOf("join(smAgentDir, '.session-model-alert')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1100)
    expect(win).toContain('unlinkSync(alertPath)')
    expect(win).toContain('const operators = loadAccess().allowFrom')
    expect(win).toContain('for (const operator of operators)')
    expect(win).toContain('lockedBot.api')
    expect(win).toContain('.sendMessage(operator')
  })
})

describe('gateway: the legacy one-shot carrier is no longer written', () => {
  it('no gateway code writes .session-model-override anymore (start.sh migration shim only reads it)', () => {
    expect(GATEWAY_SRC).not.toMatch(/writeFileSync\([^)]*\.session-model-override/)
  })
})
