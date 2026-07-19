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
import { SESSION_MODEL_FILE } from '../gateway/session-model-file.js'
import {
  classifyModelSwitchConfirmation,
  formatModelRelaunchDiagLog,
  resolveModelSwitchBootNotice,
} from '../gateway/model-command.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODEL_COMMAND_SRC = readFileSync(
  resolve(__dirname, '../gateway/model-command.ts'),
  'utf8',
)
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
    // #2996 P6: the typed /model handler moved to bot-commands-model-effort.ts
    // (registerModelEffortCommands); scrape the extracted module instead.
    const MODULE_SRC = readFileSync(
      resolve(__dirname, '..', 'gateway', 'bot-commands-model-effort.ts'),
      'utf8',
    )
    const idx = MODULE_SRC.indexOf('const reply = await handleModelCommand(parsed, cmdDeps)')
    expect(idx).toBeGreaterThan(0)
    const win = MODULE_SRC.slice(idx, idx + 400)
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
    expect(win).toContain('sessionModelSource.setOverride(isApplyBoot ? launched : null, { verify: true })')
    expect(win).toContain('resolveMainModel(raw ?? undefined)')
  })

  it('logs the applied model for diagnosability (F1)', () => {
    expect(GATEWAY_SRC).toContain('formatModelRelaunchDiagLog')
    expect(GATEWAY_SRC).toContain('gw /model relaunch scheduled agent=')
    expect(MODEL_COMMAND_SRC).toContain('gw /model relaunch applied agent=')
  })

  // #3427 item 2: the following are BEHAVIORAL tests — they run the real
  // classifier → formatter/notice pipeline and assert the EMITTED outcome
  // (log line / card body), not that a string merely exists in the source.
  // The thin `wires …` test at the end pins that gateway.ts actually calls
  // this pipeline (the gateway boot IIFE cannot be unit-booted).

  it('emits the NOT-APPLIED log for a silent revert (classify → formatModelRelaunchDiagLog)', () => {
    const confirmation = classifyModelSwitchConfirmation({
      reason: 'user: /model fable (session-only relaunch, menu)',
      launched: 'claude-opus-4-8',
      configured: 'claude-opus-4-8',
    })
    expect(confirmation.kind).toBe('not-applied')
    const log = formatModelRelaunchDiagLog({
      agent: 'klanker',
      launched: 'claude-opus-4-8',
      configured: 'claude-opus-4-8',
      confirmation,
      isApplyBoot: false,
    })
    expect(log).toContain('gw /model relaunch NOT-APPLIED agent=klanker')
    expect(log).toContain('target=fable')
    expect(log).toContain('revertedTo=claude-opus-4-8')
  })

  it('emits outcome=applied for a landed switch and outcome=default for a revert', () => {
    const applied = classifyModelSwitchConfirmation({
      reason: 'user: /model claude-haiku-4-5 (session-only relaunch)',
      launched: 'claude-haiku-4-5',
      configured: 'claude-opus-4-8',
    })
    expect(
      formatModelRelaunchDiagLog({
        agent: 'a', launched: 'claude-haiku-4-5', configured: 'claude-opus-4-8',
        confirmation: applied, isApplyBoot: true,
      }),
    ).toContain('override=set outcome=applied')
    const dflt = classifyModelSwitchConfirmation({
      reason: 'user: /model default (revert relaunch)',
      launched: 'claude-opus-4-8',
      configured: 'claude-opus-4-8',
    })
    expect(
      formatModelRelaunchDiagLog({
        agent: 'a', launched: 'claude-opus-4-8', configured: 'claude-opus-4-8',
        confirmation: dflt, isApplyBoot: false,
      }),
    ).toContain('override=cleared outcome=default')
  })

  it('sends the green applied card for a landed switch, the default card for an intended revert (F1/N4)', () => {
    const applied = resolveModelSwitchBootNotice({
      agent: 'a',
      confirmation: classifyModelSwitchConfirmation({
        reason: 'user: /model fable (session-only relaunch)',
        launched: 'fable',
        configured: 'claude-opus-4-8',
      }),
      hasSessionModelAlert: false,
    })
    expect(applied.kind).toBe('card')
    if (applied.kind === 'card') {
      expect(applied.body).toContain('✅ Now running `fable`')
      expect(applied.body).toContain('session-only')
    }
    // N4: launched===configured on a /model default reason still confirms.
    const dflt = resolveModelSwitchBootNotice({
      agent: 'a',
      confirmation: classifyModelSwitchConfirmation({
        reason: 'user: /model default (revert relaunch)',
        launched: 'claude-opus-4-8',
        configured: 'claude-opus-4-8',
      }),
      hasSessionModelAlert: false,
    })
    expect(dflt.kind).toBe('card')
    if (dflt.kind === 'card') {
      expect(dflt.body).toContain('✅ Now running `claude-opus-4-8` (the configured default)')
    }
  })

  it('warns (⚠️, not a green ✅) when a non-default switch silently reverted to the default (silent-revert fix)', () => {
    const notice = resolveModelSwitchBootNotice({
      agent: 'a',
      confirmation: classifyModelSwitchConfirmation({
        reason: 'user: /model fable (session-only relaunch, menu)',
        launched: 'claude-opus-4-8',
        configured: 'claude-opus-4-8',
      }),
      hasSessionModelAlert: false,
    })
    expect(notice.kind).toBe('card')
    if (notice.kind === 'card') {
      expect(notice.body).toContain("⚠️ Your switch to `fable` didn't apply")
      expect(notice.body).toContain('reverted to `claude-opus-4-8`')
      // LOW-3: the re-issue hint keeps the target inside backticks.
      expect(notice.body).toContain('Re-issue `/model fable`')
      expect(notice.body).not.toContain('✅')
    }
  })

  it('suppresses ONLY the not-applied card when a tailored .session-model-alert is present (LOW-2)', () => {
    const reverted = classifyModelSwitchConfirmation({
      reason: 'user: /model fable (session-only relaunch)',
      launched: 'claude-opus-4-8',
      configured: 'claude-opus-4-8',
    })
    const suppressed = resolveModelSwitchBootNotice({
      agent: 'klanker',
      confirmation: reverted,
      hasSessionModelAlert: true,
    })
    expect(suppressed.kind).toBe('suppress')
    if (suppressed.kind === 'suppress') {
      expect(suppressed.log).toContain('suppressing not-applied confirmation')
      expect(suppressed.log).toContain('agent=klanker')
      expect(suppressed.log).toContain('target=fable')
    }
    // An APPLIED switch still confirms even when an (unrelated) alert exists.
    const applied = resolveModelSwitchBootNotice({
      agent: 'klanker',
      confirmation: classifyModelSwitchConfirmation({
        reason: 'user: /model fable (session-only relaunch)',
        launched: 'fable',
        configured: 'claude-opus-4-8',
      }),
      hasSessionModelAlert: true,
    })
    expect(applied.kind).toBe('card')
  })

  it('wires the pipeline into the boot rehydration (gateway calls classify → diag log → notice)', () => {
    const idx = GATEWAY_SRC.indexOf('const isApplyBoot = launched.length > 0')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 4200)
    expect(win).toContain('classifyModelSwitchConfirmation({')
    expect(win).toContain('formatModelRelaunchDiagLog')
    expect(win).toContain('if (confirmation != null)')
    expect(win).toContain('deliverModelSwitchBootNotice({')
    expect(win).toContain("existsSync(join(smAgentDir, '.session-model-alert'))")
    // Both notice arms (suppress → stderr, card → sendMessage) now live in
    // model-command.ts (deliverModelSwitchBootNotice — behaviorally tested in
    // model-command.test.ts); the gateway injects the shared boot-card deps
    // (stderr log sink + one raw thread-aware send closure).
    expect(win).toContain('...modelBootCardDeps')
    expect(win).toContain('log: (line) => process.stderr.write(line)')
    expect(win).toContain('lockedBot.api.sendMessage(chatId, body, opts)')
  })

  it('arms the #3427 requested-vs-served tripwire on an apply-boot (comparator + handler)', () => {
    // The source is constructed with the conservative comparator…
    expect(GATEWAY_SRC).toContain('createSessionModelSource({ servedMatchesRequested: servedModelMatchesRequested })')
    // …and the apply-boot rehydration verify-ARMS the override (H1: the ONLY
    // arming site) and registers the handler that logs + warns.
    const idx = GATEWAY_SRC.indexOf('const isApplyBoot = launched.length > 0')
    const win = GATEWAY_SRC.slice(idx, idx + 4500)
    expect(win).toContain('sessionModelSource.setOverride(isApplyBoot ? launched : null, { verify: true })')
    // The handler body lives in model-command.ts (buildServedModelDivergenceHandler,
    // behaviorally tested in model-command.test.ts — log line + operator card);
    // the gateway registers it ONLY on an apply-boot, fed by the shared deps.
    expect(win).toContain(
      'sessionModelSource.setDivergenceHandler(buildServedModelDivergenceHandler(modelBootCardDeps))',
    )
    const armIdx = win.indexOf('sessionModelSource.setDivergenceHandler(')
    expect(win.slice(0, armIdx)).toContain('if (isApplyBoot) {')
    // M2: the handler must NOT destroy the override record — a transient
    // fallback substitution self-corrects; freshness already fixes /status.
    // Structurally guaranteed post-extraction: the injected ModelBootCardDeps
    // surface (agent/chat/log/sendCard) carries NO handle to the source, so
    // the handler CANNOT call setOverride. Pin that the deps object stays free
    // of any source handle.
    const depsStart = win.indexOf('const modelBootCardDeps')
    expect(depsStart).toBeGreaterThan(0)
    const depsWin = win.slice(depsStart, win.indexOf('if (isApplyBoot)'))
    expect(depsWin).not.toContain('sessionModelSource')
  })

  it('H1 (#3437): the command-time relaunch record does NOT verify-arm the tripwire', () => {
    // scheduleModelRelaunch sets the pre-restart status-honesty override with a
    // BARE setOverride — arming it would let an OLD-model assistant line in the
    // pre-restart window false-accuse a valid NEW token. The behavioral guard
    // lives in session-model-source.test.ts; this pins the gateway call sites.
    const idx = GATEWAY_SRC.indexOf('scheduleModelRelaunch: async (model: string, reason: string)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 2600)
    expect(win).toContain('sessionModelSource.setOverride(model)')
    expect(win).not.toContain('verify')
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


describe('gateway SESSION_MODEL_FILE stays pinned to start.sh.hbs rev5 carrier', () => {
  it('hbs applies the same basename gateway writes (no rev4/rev5 name drift)', async () => {
    const { SESSION_MODEL_FILE } = await import('../gateway/session-model-file.js')
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    expect(SESSION_MODEL_FILE).toBe('.session-model')
    // Vitest may run with import.meta or __dirname depending on config.
    const here = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url))
    const hbs = readFileSync(
      resolve(here, '../../profiles/_base/start.sh.hbs'),
      'utf8',
    )
    // Bare file test on the rev5 carrier (not only -override/-alert siblings).
    expect(hbs).toMatch(/\[\s*-f\s+[^\]]*\/\.session-model["\s\]]/)
    expect(hbs).toContain('configuredDefaultAtWrite')
    // Legacy migration shim still converts leftover override → .session-model.
    expect(hbs).toContain('.session-model-override')
    expect(hbs).toMatch(/migrated legacy one-shot carrier/)
  })
})


describe('gateway: the legacy one-shot carrier is no longer written', () => {
  it('no gateway code writes .session-model-override anymore (start.sh migration shim only reads it)', () => {
    expect(GATEWAY_SRC).not.toMatch(/writeFileSync\([^)]*\.session-model-override/)
  })
})
