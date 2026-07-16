/**
 * Structural pins for the DETERMINISTIC /model wiring in gateway.ts
 * (reference/rfcs/session-model-stickiness.md §0.05, rev 5 — every switch
 * relaunches through the consume-once carrier; the inject/scrape path retired).
 *
 * The behaviour lives in un-exported inline closures (buildModelDeps's
 * scheduleModelRelaunch / scheduleModelDefaultRelaunch / scheduleRestart, and
 * the boot re-hydration block inside the startup IIFE), so — mirroring the other
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
    const win = GATEWAY_SRC.slice(idx, idx + 2600)
    const writeIdx = win.indexOf('writeSessionModelFile(')
    const restartIdx = win.indexOf('deps.scheduleRestart(reason)')
    expect(writeIdx).toBeGreaterThan(0)
    expect(restartIdx).toBeGreaterThan(writeIdx)
  })

  it('sets the in-memory session-model override before dispatching the restart', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 2600)
    const setIdx = win.indexOf('sessionModelSource.setOverride(model)')
    const restartIdx = win.indexOf('deps.scheduleRestart(reason)')
    expect(setIdx).toBeGreaterThan(0)
    expect(restartIdx).toBeGreaterThan(setIdx)
  })

  it('rolls back the prior carrier content (not just deletion) on a non-in-flight dispatch failure', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 2600)
    expect(win).toContain('const prevFileRaw = readSessionModelFileRaw(agentDir)')
    expect(win).toContain('restoreSessionModelFileRaw(agentDir, prevFileRaw)')
    expect(win).toContain("!== 'restart_in_flight'")
  })

  it('reuses the same scheduleRestart dispatch (not a bespoke restart path)', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async')
    const win = GATEWAY_SRC.slice(idx, idx + 2600)
    expect(win).toContain('await deps.scheduleRestart(reason)')
  })
})

describe('gateway: the retired scrape-recorders are GONE (rev 5 inversion)', () => {
  it('recordTypedModelSwitch and recordModelMenuSideEffects no longer exist', () => {
    // INVERTED from rev 4: these helpers recorded a scrape-derived selectedModel
    // and drove the sr-to-claude special case. Every switch now relaunches, so
    // they are deleted — their presence would mean the retired path survived.
    expect(GATEWAY_SRC).not.toContain('function recordTypedModelSwitch')
    expect(GATEWAY_SRC).not.toContain('function recordModelMenuSideEffects')
  })

  it('no isSrToClaudeTransition wiring (every switch relaunches — no distinct transition)', () => {
    expect(GATEWAY_SRC).not.toContain('isSrToClaudeTransition')
  })

  it('buildModelDeps wires neither the inject nor the select terminal-driver dep', () => {
    const idx = GATEWAY_SRC.indexOf('function buildModelDeps')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 4000)
    expect(win).not.toContain('inject: injectSlashCommandImpl')
    expect(win).not.toContain('select: (a, label) => selectModel')
  })
})

describe('gateway: scheduleModelDefaultRelaunch (G1 — clear + revert relaunch)', () => {
  it('clears the carrier + override and mirrors scheduleModelRelaunch rollback', () => {
    const idx = GATEWAY_SRC.indexOf('scheduleModelDefaultRelaunch: async')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 900)
    const clearIdx = win.indexOf('clearSessionModelFile(agentDir)')
    const overrideIdx = win.indexOf('sessionModelSource.setOverride(null)')
    const restartIdx = win.indexOf('deps.scheduleRestart(reason)')
    expect(clearIdx).toBeGreaterThan(0)
    expect(overrideIdx).toBeGreaterThan(clearIdx)
    expect(restartIdx).toBeGreaterThan(overrideIdx)
    // G1 rollback on a non-in-flight dispatch failure.
    expect(win).toContain('restoreSessionModelFileRaw(agentDir, prevFileRaw)')
    expect(win).toContain("!== 'restart_in_flight'")
  })
})

describe('gateway: the live callback dispatcher routes every switch tap to the handler', () => {
  it('calls handleModelMenuCallback and no longer post-processes a scrape outcome', () => {
    const idx = GATEWAY_SRC.indexOf('const outcome = await handleModelMenuCallback(data, modelDeps)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 600)
    expect(win).not.toContain('recordModelMenuSideEffects')
  })

  it('the typed dispatcher relays the handler reply directly (no recordTypedModelSwitch)', () => {
    const idx = GATEWAY_SRC.indexOf('const reply = await handleModelCommand(parsed, deps)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 400)
    expect(win).not.toContain('recordTypedModelSwitch')
    expect(win).toContain('switchroomReply(ctx, reply.text')
  })
})

describe('gateway boot: session-model re-hydration + confirmation + alert relay', () => {
  it('re-hydrates the override from .active-session-model (launched !== configured)', () => {
    const idx = GATEWAY_SRC.indexOf("join(smAgentDir, '.active-session-model')")
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx - 200, idx + 3200)
    // F1: `launched !== configured` is the deterministic apply-boot signal.
    expect(win).toContain('const isApplyBoot = launched.length > 0 && launched !== configured')
    expect(win).toContain('sessionModelSource.setOverride(isApplyBoot ? launched : null)')
    expect(win).toContain('resolveMainModel(raw ?? undefined)')
  })

  it('logs the applied model for diagnosability (F1)', () => {
    expect(GATEWAY_SRC).toContain('gw /model relaunch applied agent=')
    expect(GATEWAY_SRC).toContain('gw /model relaunch scheduled agent=')
  })

  it('sends ONE switch-confirmation from the ACTUAL launched model, keyed on the /model reason (F1/N4)', () => {
    const idx = GATEWAY_SRC.indexOf('const isApplyBoot = launched.length > 0')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 5200)
    // Keyed on the deterministic /model switch reason, so it also fires on a
    // launched===configured apply-boot (/model default) — N4. Never optimistic.
    expect(win).toContain('if (modelSwitchReason != null && modelSwitchMarkerChat)')
    expect(win).toContain('✅ Now running')
    // N4: the launched===configured branch still confirms.
    expect(win).toContain('(the configured default)')
  })

  it('warns instead of a green ✅ when a non-default switch silently reverted to the default (silent-revert fix)', () => {
    const idx = GATEWAY_SRC.indexOf('const isApplyBoot = launched.length > 0')
    const win = GATEWAY_SRC.slice(idx, idx + 5200)
    // The confirmation card is derived from the pure classifier, not an inline
    // isApplyBoot ternary — so a reverted non-default switch yields the ⚠️ card.
    expect(win).toContain('classifyModelSwitchConfirmation({')
    expect(win).toContain("confirmation.kind === 'applied'")
    expect(win).toContain("confirmation.kind === 'not-applied'")
    expect(win).toContain("⚠️ Your switch to")
    expect(win).toContain("didn't apply")
    // LOW-3: the re-issue hint interpolates the target inside backticks so a
    // token containing Markdown metachars can't italicize / 400 the send.
    expect(win).toContain('Re-issue \\`/model ${confirmation.target}\\`')
  })

  it('dedups the not-applied card against a tailored .session-model-alert (LOW-2)', () => {
    const idx = GATEWAY_SRC.indexOf('const isApplyBoot = launched.length > 0')
    const win = GATEWAY_SRC.slice(idx, idx + 5200)
    // When start.sh wrote a specific alert for this revert, the classifier's
    // generic not-applied card is suppressed (the alert relay is the message).
    expect(win).toContain("existsSync(join(smAgentDir, '.session-model-alert'))")
    expect(win).toContain("confirmation.kind === 'not-applied' && hasSessionModelAlert")
  })

  it('N4/reason: the /model switch reason is captured from the clean-shutdown marker', () => {
    expect(GATEWAY_SRC).toContain("cleanMarker.reason.startsWith('user: /model')")
    expect(GATEWAY_SRC).toContain('let modelSwitchReason: string | null = null')
  })

  it('N3: the generic boot card is suppressed on a /model apply-boot (one card per switch)', () => {
    const idx = GATEWAY_SRC.indexOf('const suppressBootCardForModelSwitch')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 800)
    expect(win).toContain('modelSwitchReason != null && modelSwitchMarkerChat != null')
    expect(win).toContain('else if (target)')
  })

  it('consumes the .session-model-alert sentinel, notifies ALL operators, and deletes it', () => {
    const idx = GATEWAY_SRC.indexOf("const alertPath = join(smAgentDir, '.session-model-alert')")
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
