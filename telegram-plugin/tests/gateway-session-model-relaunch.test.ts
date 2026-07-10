/**
 * Structural pins for the session-model stickiness wiring in gateway.ts
 * (reference/rfcs/session-model-stickiness.md).
 *
 * The behaviour lives in un-exported inline closures (buildModelDeps's
 * scheduleModelRelaunch/scheduleRestart, triggerSelfRestart, the /restart and
 * /new handlers, the model-menu callback branches, and the boot re-hydration
 * block inside the startup IIFE), so — mirroring the other gateway-*.test.ts
 * source-pins — we assert on the source structure. The end-to-end behaviour
 * of the boot resolver is exercised in tests/scaffold.session-model.test.ts
 * (rendered start.sh), the file helpers in session-model-file.test.ts, and
 * the handler contract in model-command.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf8')

describe('gateway: triggerSelfRestart stamps relaunch-model intent BEFORE the kill', () => {
  it('docker branch: writeRelaunchModelIntent(intentForRestartReason(reason)) precedes the SIGTERM scheduling', () => {
    const fnIdx = GATEWAY_SRC.indexOf('function triggerSelfRestart(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 3000)
    const writeIdx = win.indexOf('writeRelaunchModelIntent(smDir, intentForRestartReason(reason), reason)')
    const killIdx = win.indexOf("process.kill(1, 'SIGTERM')")
    // Write-before-kill invariant: boot default is REVERT, so the intent must
    // be on disk synchronously before the SIGTERM is even scheduled.
    expect(writeIdx).toBeGreaterThan(0)
    expect(killIdx).toBeGreaterThan(writeIdx)
    // And before the setTimeout that schedules it.
    const timeoutIdx = win.indexOf('setTimeout(')
    expect(timeoutIdx).toBeGreaterThan(writeIdx)
  })

  it('legacy systemd branch stamps intent too (self-target only)', () => {
    const fnIdx = GATEWAY_SRC.indexOf('function triggerSelfRestart(')
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 4200)
    const legacyIdx = win.indexOf('// Legacy systemd path.')
    expect(legacyIdx).toBeGreaterThan(0)
    const legacyWin = win.slice(legacyIdx)
    expect(legacyWin).toContain('writeRelaunchModelIntent(smDir, intentForRestartReason(reason), reason)')
    expect(legacyWin.indexOf('writeRelaunchModelIntent')).toBeLessThan(legacyWin.indexOf('spawn('))
  })
})

describe('gateway: scheduleModelRelaunch dep (durable .session-model)', () => {
  it('writes the durable file via writeSessionModelFile before dispatching the restart', () => {
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

  it('rolls back the prior file content (not just deletion) on a non-in-flight dispatch failure', () => {
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

describe('gateway: intent writers on the restart verbs', () => {
  it('model-switch scheduleRestart stamps keep-intent before the hostd dispatch', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleRestart: async (reason: string)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 2600)
    const keepIdx = win.indexOf("writeRelaunchModelIntent(smDir, 'keep', reason)")
    const dispatchIdx = win.indexOf("op: 'agent_restart'")
    expect(keepIdx).toBeGreaterThan(0)
    expect(dispatchIdx).toBeGreaterThan(keepIdx)
  })

  it('/restart stamps an explicit revert intent (reason honesty) before dispatch', () => {
    const idx = GATEWAY_SRC.indexOf("stampUserRestartReason('user: /restart from chat')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    const revertIdx = win.indexOf("writeRelaunchModelIntent(smDir, 'revert', 'user: /restart from chat')")
    const dispatchIdx = win.indexOf("hostdRequestId('gw-restart')")
    expect(revertIdx).toBeGreaterThan(0)
    expect(dispatchIdx).toBeGreaterThan(revertIdx)
  })

  it('/new and /reset stamp keep-intent (fresh conversation, same model — contract row 7)', () => {
    const idx = GATEWAY_SRC.indexOf('stampUserRestartReason(`user: /${kind} from chat`)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 700)
    const keepIdx = win.indexOf("writeRelaunchModelIntent(agentDir, 'keep', `user: /${kind} from chat`)")
    const dispatchIdx = win.indexOf('tryHostdDispatch')
    expect(keepIdx).toBeGreaterThan(0)
    expect(dispatchIdx).toBeGreaterThan(keepIdx)
  })
})

describe('gateway: model-menu callback persists the sticky override', () => {
  it('a confirmed selection persists the canonical token (selectedModelToken), never the display label', () => {
    const idx = GATEWAY_SRC.indexOf('const outcome = await handleModelMenuCallback(data, modelDeps)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1600)
    expect(win).toContain('outcome.selectedModelToken')
    expect(win).toMatch(/writeSessionModelFile\(\s*smDir,\s*outcome\.selectedModelToken/)
  })

  it('a confirmed "Default" selection CLEARS the sticky file', () => {
    const idx = GATEWAY_SRC.indexOf('const outcome = await handleModelMenuCallback(data, modelDeps)')
    const win = GATEWAY_SRC.slice(idx, idx + 1800)
    expect(win).toContain('outcome.clearedDefault')
    expect(win).toContain('clearSessionModelFile(smDir)')
  })

  it('the sr-* callback branch calls scheduleModelRelaunch, not inject', () => {
    const idx = GATEWAY_SRC.indexOf('if (data.startsWith(MODEL_CALLBACK_SR))')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1400)
    expect(win).toContain('modelDeps.scheduleModelRelaunch(srName')
    expect(win).toMatch(/scheduleModelRelaunch[\s\S]*?\n\s*return\n/)
  })

  it('the sr-to-claude transition writes the durable file (and clears it on a Default tap)', () => {
    const idx = GATEWAY_SRC.indexOf('isSrToClaudeTransition(prevSessionModel, outcome.selectedModel)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 3600)
    expect(win).toMatch(/writeSessionModelFile\(\s*agentDir,\s*token/)
    expect(win).toContain('clearSessionModelFile(agentDir)')
    // Restart rides triggerSelfRestart with a keep-classified reason.
    expect(win).toContain("triggerSelfRestart(agentName, 'sr-to-claude-model-switch'")
  })
})

describe('gateway: typed /model persists the REQUESTED canonical token', () => {
  it('persists expandSrAlias(parsed.model), and `/model default` clears file + in-memory override', () => {
    const idx = GATEWAY_SRC.indexOf("const requested = parsed.kind === 'set' ? expandSrAlias(parsed.model) : null")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1800)
    expect(win).toContain("requested?.toLowerCase() === 'default'")
    expect(win).toContain('sessionModelSource.setOverride(null)')
    expect(win).toContain('clearSessionModelFile(smDir)')
    // Non-default: the requested token (shape-gated, non-sr) is what persists.
    expect(win).toContain('isValidModelArg(requested) && !isSrModel(requested)')
    expect(win).toMatch(/writeSessionModelFile\(\s*smDir,\s*requested/)
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
