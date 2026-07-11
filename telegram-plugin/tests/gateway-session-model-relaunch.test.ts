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

  it('the non-in-flight rollback ALSO clears the keep-intent (a live intent with no restart coming would wrongly KEEP across a crash)', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 2400)
    const inFlightIdx = win.indexOf("!== 'restart_in_flight'")
    const clearIdx = win.indexOf('clearRelaunchModelIntent(agentDir)')
    expect(inFlightIdx).toBeGreaterThan(0)
    expect(clearIdx).toBeGreaterThan(inFlightIdx)
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
    const win = GATEWAY_SRC.slice(idx, idx + 3200)
    const keepIdx = win.indexOf("writeRelaunchModelIntent(smDir, 'keep', reason)")
    const dispatchIdx = win.indexOf("op: 'agent_restart'")
    expect(keepIdx).toBeGreaterThan(0)
    expect(dispatchIdx).toBeGreaterThan(keepIdx)
  })

  it('scheduleRestart clears the keep-intent when hostd refuses (failed dispatch → no live intent on disk)', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleRestart: async (reason: string)')
    const win = GATEWAY_SRC.slice(idx, idx + 3200)
    const failIdx = win.indexOf('hostd restart failed')
    const clearIdx = win.indexOf('clearRelaunchModelIntent(smDir)')
    expect(clearIdx).toBeGreaterThan(0)
    expect(failIdx).toBeGreaterThan(clearIdx) // cleared before the throw's message
    // And it sits in the same error branch as clearRestartMarker.
    const markerIdx = win.indexOf('clearRestartMarker()')
    expect(clearIdx).toBeGreaterThan(markerIdx)
  })

  it('/restart stamps a KEEP intent before dispatch (#3039: a restart is not "clear my model")', () => {
    const idx = GATEWAY_SRC.indexOf("stampUserRestartReason('user: /restart from chat')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    const keepIdx = win.indexOf("writeRelaunchModelIntent(smDir, 'keep', 'user: /restart from chat')")
    const dispatchIdx = win.indexOf("hostdRequestId('gw-restart')")
    expect(keepIdx).toBeGreaterThan(0)
    expect(dispatchIdx).toBeGreaterThan(keepIdx)
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
    // Recording extracted into recordModelMenuSideEffects (#3017) — shared by the
    // live dispatcher and the deferred (queued mid-turn) apply so both record
    // identically.
    const idx = GATEWAY_SRC.indexOf('function recordModelMenuSideEffects')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 2400)
    expect(win).toContain('outcome.selectedModelToken')
    expect(win).toMatch(/writeSessionModelFile\(\s*smDir,\s*outcome\.selectedModelToken/)
  })

  it('a confirmed "Default" selection CLEARS the sticky file', () => {
    const idx = GATEWAY_SRC.indexOf('function recordModelMenuSideEffects')
    const win = GATEWAY_SRC.slice(idx, idx + 2400)
    expect(win).toContain('outcome.clearedDefault')
    expect(win).toContain('clearSessionModelFile(smDir)')
  })

  it('the sr-* callback branch calls scheduleModelRelaunch, not inject', () => {
    // Anchor on the sr-* TARGET dispatcher branch specifically (a mid-turn
    // busy-gate #3017 also matches `if (data.startsWith(MODEL_CALLBACK_SR))`, so
    // anchor on the relaunch call that is unique to the idle apply branch).
    const idx = GATEWAY_SRC.indexOf('const srLabel = escapeHtmlForTg(srFriendlyLabel(srName))')
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
    // Recording extracted into recordTypedModelSwitch (#3017) — shared by the
    // live `bot.command('model')` handler and the deferred (queued mid-turn) apply.
    const idx = GATEWAY_SRC.indexOf('function recordTypedModelSwitch')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 2400)
    expect(win).toContain("requested?.toLowerCase() === 'default'")
    expect(win).toContain('sessionModelSource.setOverride(null)')
    expect(win).toContain('clearSessionModelFile(smDir)')
    // Non-default: the requested token (shape-gated, non-sr) is what persists.
    expect(win).toContain('isValidModelArg(requested) && !isSrModel(requested)')
    expect(win).toMatch(/writeSessionModelFile\(\s*smDir,\s*requested/)
  })

  it('`/model default` file-clear is NOT gated on a positive confirmation (silent-switch path must not resurrect)', () => {
    const idx = GATEWAY_SRC.indexOf('function recordTypedModelSwitch')
    const win = GATEWAY_SRC.slice(idx, idx + 2400)
    // The default branch clears the file unconditionally, and only the
    // in-memory override change is confirmation-gated inside it.
    const clearIdx = win.indexOf('if (smDir) clearSessionModelFile(smDir)')
    const gatedOverrideIdx = win.indexOf('if (reply.selectedModel) sessionModelSource.setOverride(null)')
    expect(clearIdx).toBeGreaterThan(0)
    expect(gatedOverrideIdx).toBeGreaterThan(clearIdx)
    // And the whole default branch is not nested in an `if (reply.selectedModel)` block:
    const between = win.slice(0, clearIdx)
    expect(between).not.toContain('if (reply.selectedModel) {')
  })

  it('a persist failure is surfaced ON THE REPLY, not just stderr (typed + menu paths)', () => {
    expect(GATEWAY_SRC.match(/won’t survive a relaunch/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    const typedIdx = GATEWAY_SRC.indexOf('persistWarning =')
    expect(typedIdx).toBeGreaterThan(0)
    expect(GATEWAY_SRC).toContain('reply.text + persistWarning')
    // Menu path appends onto the outgoing card text.
    expect(GATEWAY_SRC).toContain('outcome.reply.text +=')
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
